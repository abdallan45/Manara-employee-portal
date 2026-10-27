import type { INestApplication } from '@nestjs/common';
import { addDays } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, DAY, futureSunday, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, today } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let catalog: Awaited<ReturnType<typeof seedRequestCatalog>>;
let people: Awaited<ReturnType<typeof seedPeople>>;
beforeEach(async () => {
  await resetDb();
  catalog = await seedRequestCatalog();
  people = await seedPeople(app);
});

const yearOf = (d: string) => Number(d.slice(0, 4));
const fullDays = (startDate: string, endDate: string, leaveTypeId = catalog.annual.id) =>
  ({ leaveTypeId, mode: 'FULL_DAY', startDate, endDate, reason: 'Family visit' });

describe('leave balances (ledger)', () => {
  it('opens the year with a yearly accrual once, lists only types that keep a balance', async () => {
    const year = yearOf(today());
    const res = await people.http.emp.get(`/api/v1/leave/me/balances?year=${year}`);
    expect(res.status).toBe(200);
    const codes = res.body.map((b: { leaveType: { code: string } }) => b.leaveType.code).sort();
    expect(codes).toEqual(['ANNUAL', 'HOURLY', 'SICK', 'STUDY']); // UNPAID has no balance
    const annual = res.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
    expect(annual).toMatchObject({ year, accrued: 14 * DAY, carriedOver: 0, used: 0, balance: 14 * DAY, pending: 0, available: 14 * DAY });

    await people.http.emp.get(`/api/v1/leave/me/balances?year=${year}`);
    const rows = await prisma.leaveTransaction.findMany({ where: { employeeId: people.users.emp.employeeId, leaveTypeId: catalog.annual.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ACCRUAL', minutes: 14 * DAY, year });
  });

  it('prorates the hire year and carries over the unused balance up to the cap', async () => {
    const year = yearOf(today());
    const empId = people.users.emp.employeeId;
    await prisma.employee.update({ where: { id: empId }, data: { hireDate: new Date(`${year - 1}-07-02T00:00:00Z`) } });
    // Last year: opened, accrued, 2 days used -> 12 days left; cap is 7 days.
    await prisma.leaveBalance.create({ data: { employeeId: empId, leaveTypeId: catalog.annual.id, year: year - 1 } });
    await prisma.leaveTransaction.createMany({
      data: [
        { employeeId: empId, leaveTypeId: catalog.annual.id, year: year - 1, minutes: 14 * DAY, kind: 'ACCRUAL' },
        { employeeId: empId, leaveTypeId: catalog.annual.id, year: year - 1, minutes: -2 * DAY, kind: 'USAGE' },
      ],
    });
    const res = await people.http.emp.get(`/api/v1/leave/me/balances?year=${year}`);
    const annual = res.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
    expect(annual).toMatchObject({ accrued: 14 * DAY, carriedOver: 7 * DAY, balance: 21 * DAY });
    expect(await auditActions(`${empId}:ANNUAL:${year}`)).toEqual(['LEAVE_BALANCE_OPEN']);

    // A new hire's first year is prorated.
    const emp2 = people.users.emp2.employeeId;
    await prisma.employee.update({ where: { id: emp2 }, data: { hireDate: new Date(`${year}-07-02T00:00:00Z`) } });
    const res2 = await people.http.emp2.get(`/api/v1/leave/me/balances?year=${year}`);
    const prorated = res2.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL');
    expect(prorated.accrued).toBeLessThan(14 * DAY);
    expect(prorated.accrued).toBeGreaterThan(6 * DAY);
  });

  it('HR adjustments go through the ledger; managers and employees cannot adjust', async () => {
    const year = yearOf(today());
    const body = { employeeId: people.users.emp.employeeId, leaveTypeId: catalog.annual.id, year, minutes: DAY, note: 'Opening balance' };
    expect((await people.http.mgr.post('/api/v1/leave/adjustments').send(body)).status).toBe(403);
    expect((await people.http.emp.post('/api/v1/leave/adjustments').send(body)).status).toBe(403);
    const res = await people.http.hr.post('/api/v1/leave/adjustments').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ adjusted: DAY, balance: 15 * DAY });
    const bal = await people.http.mgr.get(`/api/v1/leave/employees/${people.users.emp.employeeId}/balances?year=${year}`);
    expect(bal.status).toBe(200);
    // Sensitive types stay hidden from the manager.
    expect(bal.body.map((b: { leaveType: { code: string } }) => b.leaveType.code)).not.toContain('SICK');
    expect((await people.http.opsMgr.get(`/api/v1/leave/employees/${people.users.emp.employeeId}/balances`)).status).toBe(404);
  });
});

describe('leave requests', () => {
  it('previews, creates, holds the balance and blocks overlaps and overdrafts', async () => {
    const sun = futureSunday();
    const preview = await people.http.emp.post('/api/v1/leave/requests/preview').send(fullDays(sun, addDays(sun, 6)));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ workdays: 5, minutes: 5 * DAY, available: 14 * DAY, sufficient: true, overlaps: [] });

    const created = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, addDays(sun, 2)));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'PENDING', currentLevel: 1, approvalSteps: ['MANAGER'], minutes: 3 * DAY, mode: 'FULL_DAY', startDate: sun, endDate: addDays(sun, 2) });
    expect(await auditActions(created.body.id)).toEqual(['LEAVE_REQUEST_CREATE']);
    // The department manager is told; HR is not needed at level 1.
    const mgrNotes = await notificationsOf(people.users.mgr.userId);
    expect(mgrNotes.map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    expect(await notificationsOf(people.users.hr.userId)).toHaveLength(0);

    const bal = await people.http.emp.get(`/api/v1/leave/me/balances?year=${yearOf(sun)}`);
    expect(bal.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL')).toMatchObject({ balance: 14 * DAY, pending: 3 * DAY, available: 11 * DAY });

    const overlap = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.hourly.id, mode: 'HOURLY', startDate: addDays(sun, 1), startTime: '09:00', endTime: '10:00', reason: 'Dentist' });
    expect(overlap.status).toBe(409);
    expectErrorEnvelope(overlap.body, 'LEAVE_OVERLAP');
    expect(overlap.body.error.details.requests[0].id).toBe(created.body.id);

    const later = futureSunday(21);
    const tooMuch = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(later, addDays(later, 18))); // 15 workdays
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({ code: 'LEAVE_BALANCE_INSUFFICIENT', details: { available: 11 * DAY, requested: 15 * DAY } });

    // Untracked types (unpaid) are not limited by a balance.
    const unpaid = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(later, addDays(later, 18), catalog.unpaid.id));
    expect(unpaid.status).toBe(201);
  });

  it('validates modes per unit, weekends-only ranges and cross-year ranges', async () => {
    const sun = futureSunday();
    const halfOnHourly = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.hourly.id, mode: 'HALF_DAY', startDate: sun, half: 'FIRST', reason: 'Errand' });
    expect(halfOnHourly.status).toBe(400);
    const weekend = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(addDays(sun, 5), addDays(sun, 6)));
    expect(weekend.status).toBe(400);
    const year = yearOf(today()) + 1;
    const crossYear = await people.http.emp.post('/api/v1/leave/requests').send(fullDays(`${year}-12-28`, `${year + 1}-01-02`));
    expect(crossYear.status).toBe(400);
    const managerOnly = await people.http.hr.post('/api/v1/leave/requests').send(fullDays(sun, sun));
    expect(managerOnly.status).toBe(201); // HR are employees too
  });

  it('manager approval debits the ledger, notifies the employee and shows ON_LEAVE in attendance', async () => {
    const sun = futureSunday();
    const req = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, addDays(sun, 1)))).body;

    // Out of scope / no permission / employee themself.
    expect((await people.http.opsMgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).status).toBe(403);
    expect((await people.http.emp2.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).status).toBe(403);
    expect((await people.http.emp.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).status).toBe(403);

    const ok = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({ comment: 'Enjoy' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ kind: 'LEAVE', status: 'APPROVED', canAct: false });
    expect(ok.body.leave.approvals).toEqual([expect.objectContaining({ level: 1, decision: 'APPROVED', comment: 'Enjoy', approver: expect.objectContaining({ username: 'mgr' }) })]);

    const usage = await prisma.leaveTransaction.findMany({ where: { requestId: req.id } });
    expect(usage).toEqual([expect.objectContaining({ kind: 'USAGE', minutes: -2 * DAY })]);
    expect(await auditActions(req.id)).toEqual(['LEAVE_REQUEST_CREATE', 'LEAVE_REQUEST_APPROVE']);
    expect((await notificationsOf(people.users.emp.userId)).map((n) => n.type)).toEqual(['REQUEST_APPROVED']);

    const again = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(again.status).toBe(409);
    expectErrorEnvelope(again.body, 'REQUEST_NOT_PENDING');

    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${sun}&to=${addDays(sun, 2)}`);
    expect(days.body.map((d: { status: string }) => d.status)).toEqual(['ON_LEAVE', 'ON_LEAVE', expect.not.stringMatching('ON_LEAVE')]);
    expect(days.body[0].requiredMinutes).toBe(0);
  });

  it('hourly leave lowers that day’s required minutes', async () => {
    const day = futureSunday();
    const req = (await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.hourly.id, mode: 'HOURLY', startDate: day, startTime: '09:00', endTime: '11:00', reason: 'Dentist' })).body;
    expect(req.minutes).toBe(120);
    await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${day}&to=${day}`);
    expect(days.body[0].requiredMinutes).toBe(DAY - 120);
  });

  it('two-level types go to the manager, then HR; nobody approves twice', async () => {
    const sun = futureSunday();
    const req = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, sun, catalog.twoLevel.id))).body;
    expect(req).toMatchObject({ currentLevel: 1, approvalSteps: ['MANAGER', 'HR_ADMIN'], skippedLevels: [] });

    const level1 = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(level1.body).toMatchObject({ status: 'PENDING', leave: { currentLevel: 2 } });
    expect(await prisma.leaveTransaction.count({ where: { requestId: req.id } })).toBe(0);
    expect((await notificationsOf(people.users.emp.userId)).map((n) => n.type)).toEqual(['REQUEST_LEVEL_APPROVED']);
    expect((await notificationsOf(people.users.hr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);

    const managerAgain = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(managerAgain.status).toBe(403);
    expectErrorEnvelope(managerAgain.body, 'APPROVAL_NOT_ALLOWED');

    const final = await people.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(final.body).toMatchObject({ status: 'APPROVED' });
    expect(final.body.leave.approvals.map((a: { level: number; step: string }) => [a.level, a.step])).toEqual([[1, 'MANAGER'], [2, 'HR_ADMIN']]);
    expect(await auditActions(req.id)).toEqual(['LEAVE_REQUEST_CREATE', 'LEAVE_REQUEST_APPROVE_LEVEL', 'LEAVE_REQUEST_APPROVE']);
  });

  it('a manager’s own leave skips the manager step and cannot be self-approved', async () => {
    const sun = futureSunday();
    const own = (await people.http.mgr.post('/api/v1/leave/requests').send(fullDays(sun, sun, catalog.twoLevel.id))).body;
    expect(own.currentLevel).toBe(2); // no other Engineering manager
    expect(own.skippedLevels).toEqual([1]);
    const self = await people.http.mgr.post(`/api/v1/approvals/leave/${own.id}/approve`).send({});
    expect(self.status).toBe(403);
    expectErrorEnvelope(self.body, 'SELF_APPROVAL_FORBIDDEN');
    expect((await people.http.hr.post(`/api/v1/approvals/leave/${own.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('sensitive leave is routed to HR and hidden from the manager', async () => {
    const sun = futureSunday();
    const req = (await people.http.emp.post('/api/v1/leave/requests').send({ ...fullDays(sun, sun, catalog.sick.id), reason: 'Medical appointment' })).body;
    expect(await notificationsOf(people.users.mgr.userId)).toHaveLength(0);
    expect((await notificationsOf(people.users.hr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);

    const asManager = await people.http.mgr.get(`/api/v1/leave/requests/${req.id}`);
    expect(asManager.status).toBe(200);
    expect(asManager.body).toMatchObject({ confidential: true, leaveType: null, reason: null });
    const inbox = await people.http.mgr.get('/api/v1/approvals?tab=PENDING');
    expect(inbox.body.items.map((i: { id: string }) => i.id)).not.toContain(req.id);
    const decide = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(decide.status).toBe(403);

    const asHr = await people.http.hr.get(`/api/v1/leave/requests/${req.id}`);
    expect(asHr.body).toMatchObject({ confidential: false, leaveType: { code: 'SICK' }, reason: 'Medical appointment' });
    expect((await people.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
    // The manager still sees the day as ON_LEAVE (attendance), without the type.
    const days = await people.http.mgr.get(`/api/v1/attendance/employees/${people.users.emp.employeeId}/days?from=${sun}&to=${sun}`);
    expect(days.body[0].status).toBe('ON_LEAVE');
  });

  it('rejection needs a reason and leaves the balance alone', async () => {
    const sun = futureSunday();
    const req = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, sun))).body;
    const noReason = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/reject`).send({});
    expect(noReason.status).toBe(400);
    const res = await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/reject`).send({ comment: 'Release week' });
    expect(res.body).toMatchObject({ status: 'REJECTED', leave: { rejectionReason: 'Release week' } });
    expect(await prisma.leaveTransaction.count({ where: { requestId: req.id } })).toBe(0);
    const [note] = await notificationsOf(people.users.emp.userId);
    expect(note).toMatchObject({ type: 'REQUEST_REJECTED', body: 'Release week' });
    expect(await auditActions(req.id)).toEqual(['LEAVE_REQUEST_CREATE', 'LEAVE_REQUEST_REJECT']);
  });

  it('cancellation: pending, approved future (credited back), started (HR only)', async () => {
    const sun = futureSunday();
    const pending = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(sun, sun))).body;
    expect((await people.http.emp2.post(`/api/v1/leave/requests/${pending.id}/cancel`)).status).toBe(404);
    expect((await people.http.emp.post(`/api/v1/leave/requests/${pending.id}/cancel`)).body.status).toBe('CANCELLED');

    const approved = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(addDays(sun, 1), addDays(sun, 2)))).body;
    await people.http.mgr.post(`/api/v1/approvals/leave/${approved.id}/approve`).send({});
    const cancelled = await people.http.emp.post(`/api/v1/leave/requests/${approved.id}/cancel`);
    expect(cancelled.body.status).toBe('CANCELLED');
    const ledger = await prisma.leaveTransaction.findMany({ where: { requestId: approved.id }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((l) => [l.kind, l.minutes])).toEqual([['USAGE', -2 * DAY], ['CANCELLATION', 2 * DAY]]);
    const bal = await people.http.emp.get(`/api/v1/leave/me/balances?year=${yearOf(sun)}`);
    expect(bal.body.find((b: { leaveType: { code: string } }) => b.leaveType.code === 'ANNUAL').available).toBe(14 * DAY);
    expect((await people.http.emp.post(`/api/v1/leave/requests/${approved.id}/cancel`)).status).toBe(409);

    // Past leave (e.g. sick leave filed afterwards) that has been approved: only HR can cancel.
    const past = pastWorkday(3);
    const started = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(past, past))).body;
    await people.http.mgr.post(`/api/v1/approvals/leave/${started.id}/approve`).send({});
    const denied = await people.http.emp.post(`/api/v1/leave/requests/${started.id}/cancel`);
    expect(denied.status).toBe(409);
    expectErrorEnvelope(denied.body, 'LEAVE_ALREADY_STARTED');
    expect((await people.http.hr.post(`/api/v1/leave/requests/${started.id}/cancel`)).body.status).toBe('CANCELLED');
    expect(await auditActions(started.id)).toEqual(['LEAVE_REQUEST_CREATE', 'LEAVE_REQUEST_APPROVE', 'LEAVE_REQUEST_CANCEL']);
  });

  it('dashboard counts approved leave as ON_LEAVE, not absent', async () => {
    const past = pastWorkday(2);
    const req = (await people.http.emp.post('/api/v1/leave/requests').send(fullDays(past, past))).body;
    await people.http.mgr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    const live = await people.http.hr.get(`/api/v1/dashboard/live?date=${past}&pageSize=50`);
    expect(live.status).toBe(200);
    const row = live.body.items.find((r: { employeeId: string }) => r.employeeId === people.users.emp.employeeId);
    expect(row.metrics.status).toBe('ON_LEAVE');
    const summary = await people.http.hr.get(`/api/v1/dashboard/summary?date=${past}`);
    expect(summary.body.kpis.onLeave).toBe(1);
  });
});

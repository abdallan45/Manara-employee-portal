import type { INestApplication } from '@nestjs/common';
import { addDays } from '../src/common/time';
import { createTestApp, prisma, resetDb } from './helpers';
import { futureSunday, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents } from './request-fixtures';

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

/** One request of each kind from an Engineering employee, a leave request from Operations and a sensitive one. */
async function inbox() {
  const sun = futureSunday();
  const day = pastWorkday(2);
  const leave = (await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Trip' })).body;
  await sessionWithEvents(people.users.emp.employeeId, day, 8 * 60, 18 * 60, 'CLOSED');
  const overtime = (await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' })).body;
  const missing = await sessionWithEvents(people.users.emp2.employeeId, day, 8 * 60, null, 'MISSING_CHECKOUT');
  const correction = (await people.http.emp2.post('/api/v1/corrections/requests').send({ kind: 'MISSING_CHECK_OUT', workSessionId: missing.id, proposedTime: `${day}T16:00`, reason: 'Forgot' })).body;
  const opsLeave = (await people.http.opsEmp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Trip' })).body;
  const sick = (await people.http.emp2.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.sick.id, mode: 'FULL_DAY', startDate: addDays(sun, 1), endDate: addDays(sun, 1), reason: 'Clinic' })).body;
  for (const r of [leave, overtime, correction, opsLeave, sick]) expect(r.id).toBeDefined();
  return { leave, overtime, correction, opsLeave, sick };
}

const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id).sort();

describe('Approval Center', () => {
  it('managers see their departments (never sensitive leave or their own requests); HR sees everything', async () => {
    const r = await inbox();
    const own = (await people.http.mgr.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: futureSunday(14), endDate: futureSunday(14), reason: 'Trip' })).body;

    const mgr = await people.http.mgr.get('/api/v1/approvals?tab=PENDING');
    expect(mgr.status).toBe(200);
    expect(ids(mgr.body)).toEqual([r.leave.id, r.overtime.id, r.correction.id].sort());
    expect(mgr.body.items.every((i: { canAct: boolean }) => i.canAct)).toBe(true);
    expect(mgr.body.items.find((i: { kind: string }) => i.kind === 'OVERTIME').overtime.estimate.compensatedMinutes).toBe(75);

    const hr = await people.http.hr.get('/api/v1/approvals?tab=PENDING&pageSize=50');
    expect(ids(hr.body)).toEqual([r.leave.id, r.overtime.id, r.correction.id, r.opsLeave.id, r.sick.id, own.id].sort());
    expect(hr.body.items.find((i: { id: string }) => i.id === r.sick.id).leave.leaveType.code).toBe('SICK');

    const summary = await people.http.mgr.get('/api/v1/approvals/summary');
    expect(summary.body).toEqual({ pending: { leave: 1, overtime: 1, correction: 1, total: 3 } });
    const kindFilter = await people.http.hr.get('/api/v1/approvals?tab=PENDING&kind=LEAVE&pageSize=50');
    expect(kindFilter.body.items.every((i: { kind: string }) => i.kind === 'LEAVE')).toBe(true);
    expect(kindFilter.body.total).toBe(4);

    const page = await people.http.hr.get('/api/v1/approvals?tab=PENDING&page=2&pageSize=4');
    expect(page.body).toMatchObject({ total: 6, page: 2, pageSize: 4 });
    expect(page.body.items).toHaveLength(2);

    expect((await people.http.emp.get('/api/v1/approvals')).status).toBe(403);
    expect((await people.http.emp.get('/api/v1/approvals/summary')).status).toBe(403);
  });

  it('bulk approve applies each item on its own and reports failures', async () => {
    const r = await inbox();
    const res = await people.http.mgr.post('/api/v1/approvals/bulk-approve').send({
      items: [
        { kind: 'LEAVE', id: r.leave.id },
        { kind: 'OVERTIME', id: r.overtime.id },
        { kind: 'CORRECTION', id: r.correction.id },
        { kind: 'LEAVE', id: r.opsLeave.id }, // other department
        { kind: 'LEAVE', id: r.sick.id }, // sensitive
      ],
      comment: 'Batch OK',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 3, failed: 2 });
    expect(res.body.results.filter((x: { ok: boolean }) => !x.ok).map((x: { error: string }) => x.error)).toEqual(['FORBIDDEN', 'APPROVAL_NOT_ALLOWED']);

    const approved = await people.http.mgr.get('/api/v1/approvals?tab=APPROVED');
    expect(ids(approved.body)).toEqual([r.leave.id, r.overtime.id, r.correction.id].sort());
    expect(approved.body.total).toBe(3);
    expect(approved.body.items.every((i: { canAct: boolean; decidedAt: string | null }) => !i.canAct && i.decidedAt)).toBe(true);
    expect((await people.http.mgr.get('/api/v1/approvals/summary')).body.pending.total).toBe(0);

    const notes = await prisma.notification.findMany({ where: { type: 'REQUEST_APPROVED' } });
    expect(notes.map((n) => n.userId).sort()).toEqual([people.users.emp.userId, people.users.emp.userId, people.users.emp2.userId].sort());
    const audits = await prisma.auditLog.findMany({ where: { action: { in: ['LEAVE_REQUEST_APPROVE', 'OVERTIME_REQUEST_APPROVE', 'CORRECTION_REQUEST_APPROVE'] } } });
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actorUserId === people.users.mgr.userId)).toBe(true);

    const invalid = await people.http.mgr.post('/api/v1/approvals/bulk-approve').send({ items: [] });
    expect(invalid.status).toBe(400);
  });

  it('rejected tab, rejection comments, unknown kinds', async () => {
    const r = await inbox();
    expect((await people.http.hr.post(`/api/v1/approvals/leave/${r.opsLeave.id}/reject`).send({ comment: '  ' })).status).toBe(400);
    const res = await people.http.hr.post(`/api/v1/approvals/leave/${r.opsLeave.id}/reject`).send({ comment: 'Team already short' });
    expect(res.body).toMatchObject({ status: 'REJECTED', leave: { rejectionReason: 'Team already short', approvals: [expect.objectContaining({ decision: 'REJECTED', comment: 'Team already short' })] } });
    const rejected = await people.http.hr.get('/api/v1/approvals?tab=REJECTED');
    expect(ids(rejected.body)).toEqual([r.opsLeave.id]);
    expect((await people.http.opsMgr.get('/api/v1/approvals?tab=REJECTED')).body.total).toBe(1);
    expect((await people.http.mgr.get('/api/v1/approvals?tab=REJECTED')).body.total).toBe(0);
    expect((await people.http.hr.post(`/api/v1/approvals/payroll/${r.opsLeave.id}/approve`).send({})).status).toBe(404);
  });
});

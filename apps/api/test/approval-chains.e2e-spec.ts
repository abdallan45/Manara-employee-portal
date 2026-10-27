import type { INestApplication } from '@nestjs/common';
import { addDays } from '../src/common/time';
import { as, createDepartment, createUser, expectErrorEnvelope, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import {
  auditActions, futureSunday, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents, today, workdayFrom,
} from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * Project department without a department manager: a project manager supervises pe1 and pe2 (not pe3);
 * a general manager and the HR / admin people of seedPeople.
 */
async function seedProject() {
  const catalog = await seedRequestCatalog();
  const people = await seedPeople(app);
  const prj = await createDepartment('PRJ', 'Projects');
  const [pm, gm, pe1, pe2, pe3] = await Promise.all([
    createUser({ username: 'pm', roles: ['PROJECT_MANAGER'], departmentId: prj.id }),
    createUser({ username: 'gm', roles: ['GENERAL_MANAGER'], departmentId: null }),
    createUser({ username: 'pe1', roles: ['EMPLOYEE'], departmentId: prj.id }),
    createUser({ username: 'pe2', roles: ['EMPLOYEE'], departmentId: prj.id }),
    createUser({ username: 'pe3', roles: ['EMPLOYEE'], departmentId: prj.id }),
  ]);
  await prisma.employeeSupervisor.createMany({
    data: [pe1, pe2].map((e) => ({ supervisorUserId: pm.userId, employeeId: e.employeeId })),
  });
  const login = async (u: { username: string }) => as(app, await webLogin(app, u.username));
  const [pmS, gmS, pe1S, pe2S, pe3S] = await Promise.all([pm, gm, pe1, pe2, pe3].map(login));
  return {
    catalog, people, prj,
    users: { ...people.users, pm, gm, pe1, pe2, pe3 },
    http: { ...people.http, pm: pmS, gm: gmS, pe1: pe1S, pe2: pe2S, pe3: pe3S },
  };
}

let s: Awaited<ReturnType<typeof seedProject>>;
beforeEach(async () => {
  await resetDb();
  s = await seedProject();
});

const fullDays = (start: string, end: string, leaveTypeId: string) => ({ leaveTypeId, mode: 'FULL_DAY', startDate: start, endDate: end, reason: 'Trip' });
const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id).sort();

describe('project manager scope', () => {
  it('sees only the supervised employees (employees, attendance, reports, approvals); others answer 404', async () => {
    const { pm } = s.http;
    const list = await pm.get('/api/v1/employees?pageSize=100');
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { id: string }) => e.id).sort()).toEqual([s.users.pe1.employeeId, s.users.pe2.employeeId].sort());
    expect((await pm.get(`/api/v1/employees/${s.users.pe1.employeeId}`)).status).toBe(200);
    expect((await pm.get(`/api/v1/employees/${s.users.pe3.employeeId}`)).status).toBe(404);
    expect((await pm.get(`/api/v1/employees/${s.users.emp.employeeId}`)).status).toBe(404);

    const day = pastWorkday(2);
    expect((await pm.get(`/api/v1/attendance/employees/${s.users.pe2.employeeId}/days?from=${day}&to=${day}`)).status).toBe(200);
    expect((await pm.get(`/api/v1/attendance/employees/${s.users.pe3.employeeId}/days?from=${day}&to=${day}`)).status).toBe(404);

    const report = await pm.get(`/api/v1/reports/attendance?from=${day}&to=${day}`);
    expect(report.status).toBe(200);
    expect(report.body.rows.map((r: { employee: { id: string } }) => r.employee.id).sort()).toEqual([s.users.pe1.employeeId, s.users.pe2.employeeId].sort());
    expect((await pm.get(`/api/v1/reports/attendance?employeeId=${s.users.pe3.employeeId}`)).status).toBe(404);
    const byDept = await pm.get(`/api/v1/reports/attendance?from=${day}&to=${day}&departmentId=${s.prj.id}`);
    expect(byDept.body.rows).toHaveLength(2);

    const dash = await pm.get('/api/v1/dashboard/summary');
    expect(dash.status).toBe(200);

    const sun = futureSunday();
    const mine = (await s.http.pe1.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.annual.id))).body;
    const other = (await s.http.pe3.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.annual.id))).body;
    const inbox = await pm.get('/api/v1/approvals?tab=PENDING');
    expect(ids(inbox.body)).toEqual([mine.id]);
    expect(inbox.body.items[0]).toMatchObject({ canAct: true, currentStep: 'MANAGER', currentLevel: 1, totalLevels: 1 });
    expect((await pm.post(`/api/v1/approvals/leave/${other.id}/approve`).send({})).status).toBe(403);
    expect((await pm.get(`/api/v1/leave/requests/${other.id}`)).status).toBe(404);
  });

  it('cannot add or edit employees, nor see settings or roles management', async () => {
    const { pm } = s.http;
    const create = await pm.post('/api/v1/employees').send({ employeeCode: 'X-1', fullName: 'New', username: 'newbie', password: 'a-long-password-1' });
    expect(create.status).toBe(403);
    expect((await pm.patch(`/api/v1/employees/${s.users.pe1.employeeId}`).send({ fullName: 'Renamed' })).status).toBe(403);
    expect((await pm.post(`/api/v1/employees/${s.users.pe1.employeeId}/deactivate`)).status).toBe(403);
    expect((await pm.get('/api/v1/settings')).status).toBe(403);
    expect((await pm.post('/api/v1/roles').send({ key: 'X_ROLE', name: 'X', permissions: [] })).status).toBe(403);
    expect(await prisma.employee.count({ where: { employeeCode: 'X-1' } })).toBe(0);
  });

  it('a supervisor assigned by HR takes effect at once for the signed-in project manager', async () => {
    expect((await s.http.pm.get(`/api/v1/employees/${s.users.pe3.employeeId}`)).status).toBe(404);
    const res = await s.http.admin.patch(`/api/v1/employees/${s.users.pe3.employeeId}`).send({ supervisorUserIds: [s.users.pm.userId] });
    expect(res.status).toBe(200);
    expect(res.body.supervisors).toEqual([expect.objectContaining({ userId: s.users.pm.userId, username: 'pm' })]);
    expect((await s.http.pm.get(`/api/v1/employees/${s.users.pe3.employeeId}`)).status).toBe(200);
  });
});

describe('approval chains', () => {
  it('MANAGER then HR: the project manager approves step 1 with a note, HR the last step; the balance is debited once', async () => {
    const sun = futureSunday();
    const req = (await s.http.pe1.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.twoLevel.id))).body;
    expect(req).toMatchObject({ currentLevel: 1, approvalSteps: ['MANAGER', 'HR_ADMIN'] });
    expect((await notificationsOf(s.users.pm.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    expect(await notificationsOf(s.users.hr.userId)).toHaveLength(0);

    // HR cannot take the manager's step; the GM is not part of this chain.
    const early = await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect(early.status).toBe(403);
    expectErrorEnvelope(early.body, 'APPROVAL_NOT_ALLOWED');
    expect((await s.http.hr.get('/api/v1/approvals/summary')).body.pending.leave).toBe(0);

    const step1 = await s.http.pm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({ comment: 'Covered by the team' });
    expect(step1.status).toBe(200);
    expect(step1.body).toMatchObject({ status: 'PENDING', currentStep: 'HR_ADMIN', currentLevel: 2, totalLevels: 2, canAct: false });
    expect(step1.body.leave.approvals).toEqual([expect.objectContaining({ level: 1, step: 'MANAGER', decision: 'APPROVED', comment: 'Covered by the team' })]);
    expect(await prisma.leaveTransaction.count({ where: { requestId: req.id, kind: 'USAGE' } })).toBe(0);
    const [levelNote] = await notificationsOf(s.users.pe1.userId);
    expect(levelNote).toMatchObject({ type: 'REQUEST_LEVEL_APPROVED', body: 'Covered by the team' });
    expect(levelNote.data).toMatchObject({ level: 1, totalLevels: 2, nextStep: 'HR_ADMIN', comment: 'Covered by the team' });
    expect((await notificationsOf(s.users.hr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    expect((await s.http.hr.get('/api/v1/approvals/summary')).body.pending.leave).toBe(1);

    const again = await s.http.pm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expectErrorEnvelope(again.body, 'APPROVAL_NOT_ALLOWED');

    const final = await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({ comment: 'Enjoy' });
    expect(final.body).toMatchObject({ status: 'APPROVED' });
    expect(final.body.leave.approvals.map((a: { step: string; comment: string }) => [a.step, a.comment])).toEqual([['MANAGER', 'Covered by the team'], ['HR_ADMIN', 'Enjoy']]);
    expect(await prisma.leaveTransaction.count({ where: { requestId: req.id, kind: 'USAGE' } })).toBe(1);
    expect(await auditActions(req.id)).toEqual(['LEAVE_REQUEST_CREATE', 'LEAVE_REQUEST_APPROVE_LEVEL', 'LEAVE_REQUEST_APPROVE']);

    // Both deciders find it in their history; the employee sees the notes on their own request.
    expect(ids((await s.http.pm.get('/api/v1/approvals?tab=APPROVED')).body)).toEqual([req.id]);
    const own = await s.http.pe1.get(`/api/v1/leave/requests/${req.id}`);
    expect(own.body.approvals.map((a: { comment: string }) => a.comment)).toEqual(['Covered by the team', 'Enjoy']);
  });

  it('rejection at step 2 needs a reason, which the employee sees; nothing is debited', async () => {
    const sun = futureSunday();
    const req = (await s.http.pe1.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.twoLevel.id))).body;
    await s.http.pm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    const noReason = await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/reject`).send({ comment: ' ' });
    expect(noReason.status).toBe(400);
    const res = await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/reject`).send({ comment: 'Audit week' });
    expect(res.body).toMatchObject({ status: 'REJECTED', leave: { rejectionReason: 'Audit week', skippedLevels: [] } });
    expect(res.body.leave.approvals.map((a: { level: number; decision: string; comment: string | null }) => [a.level, a.decision, a.comment]))
      .toEqual([[1, 'APPROVED', null], [2, 'REJECTED', 'Audit week']]);
    expect(await prisma.leaveTransaction.count({ where: { requestId: req.id } })).toBe(0);
    const notes = await notificationsOf(s.users.pe1.userId);
    expect(notes.map((n) => [n.type, n.body])).toEqual([['REQUEST_LEVEL_APPROVED', 'It now waits for the next approval.'], ['REQUEST_REJECTED', 'Audit week']]);
  });

  it('the same person never decides two steps of one request', async () => {
    // pmhr supervises pe2 and is also HR; another HR person exists.
    const pmhr = await createUser({ username: 'pmhr', roles: ['PROJECT_MANAGER', 'HR_ADMIN'] });
    await prisma.employeeSupervisor.create({ data: { supervisorUserId: pmhr.userId, employeeId: s.users.pe2.employeeId } });
    const http = as(app, await webLogin(app, 'pmhr'));
    const sun = futureSunday();
    const req = (await s.http.pe2.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.twoLevel.id))).body;
    expect((await http.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.leave.currentLevel).toBe(2);
    const twice = await http.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expectErrorEnvelope(twice.body, 'APPROVAL_NOT_ALLOWED');
    expect((await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('a GENERAL_MANAGER step is decided by the general manager only', async () => {
    const patched = await s.http.admin.patch(`/api/v1/leave/types/${s.catalog.twoLevel.id}`).send({ approvalSteps: ['MANAGER', 'GENERAL_MANAGER'] });
    expect(patched.status).toBe(200);
    const sun = futureSunday();
    const req = (await s.http.pe1.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.twoLevel.id))).body;
    await s.http.pm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({});
    expect((await notificationsOf(s.users.gm.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    expectErrorEnvelope((await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body, 'APPROVAL_NOT_ALLOWED');
    const gmInbox = await s.http.gm.get('/api/v1/approvals?tab=PENDING');
    expect(gmInbox.body.items.find((i: { id: string }) => i.id === req.id)).toMatchObject({ canAct: true, currentStep: 'GENERAL_MANAGER' });
    const done = await s.http.gm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({ comment: 'Approved by GM' });
    expect(done.body.status).toBe('APPROVED');

    // The type's chain is a snapshot: changing it later does not move requests already submitted.
    const req2 = (await s.http.pe2.post('/api/v1/leave/requests').send(fullDays(addDays(sun, 7), addDays(sun, 7), s.catalog.twoLevel.id))).body;
    await s.http.admin.patch(`/api/v1/leave/types/${s.catalog.twoLevel.id}`).send({ approvalSteps: ['HR_ADMIN'] });
    expect((await s.http.pe2.get(`/api/v1/leave/requests/${req2.id}`)).body.approvalSteps).toEqual(['MANAGER', 'GENERAL_MANAGER']);
  });

  it('the MANAGER step is skipped when nobody manages or supervises the employee; a chain left empty goes to HR', async () => {
    const sun = futureSunday();
    const two = (await s.http.pe3.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.twoLevel.id))).body;
    expect(two).toMatchObject({ currentLevel: 2, approvalSteps: ['MANAGER', 'HR_ADMIN'], skippedLevels: [1] });
    const one = (await s.http.pe3.post('/api/v1/leave/requests').send(fullDays(addDays(sun, 7), addDays(sun, 7), s.catalog.annual.id))).body;
    expect(one).toMatchObject({ currentLevel: 2, approvalSteps: ['MANAGER', 'ANY_APPROVER'], skippedLevels: [1] });
    expect((await notificationsOf(s.users.hr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL', 'REQUEST_PENDING_APPROVAL']);
    const hrInbox = await s.http.hr.get('/api/v1/approvals?tab=PENDING&pageSize=50');
    expect(hrInbox.body.items.find((i: { id: string }) => i.id === one.id)).toMatchObject({ canAct: true, currentStep: 'ANY_APPROVER', currentLevel: 2, totalLevels: 2 });
    expect((await s.http.hr.post(`/api/v1/approvals/leave/${one.id}/approve`).send({})).body.status).toBe('APPROVED');
    const approved = await s.http.pe3.get(`/api/v1/leave/requests/${one.id}`);
    expect(approved.body).toMatchObject({ status: 'APPROVED', skippedLevels: [1] });
  });

  it('sensitive leave skips the MANAGER step and stays hidden from the project manager', async () => {
    const sun = futureSunday();
    const req = (await s.http.pe1.post('/api/v1/leave/requests').send({ ...fullDays(sun, sun, s.catalog.sick.id), reason: 'Clinic' })).body;
    expect(req).toMatchObject({ approvalSteps: ['MANAGER', 'ANY_APPROVER'], currentLevel: 2 });
    expect(await notificationsOf(s.users.pm.userId)).toHaveLength(0);
    expect(ids((await s.http.pm.get('/api/v1/approvals?tab=PENDING')).body)).not.toContain(req.id);
    expect((await s.http.pm.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).status).toBe(403);
    const asPm = await s.http.pm.get(`/api/v1/leave/requests/${req.id}`);
    expect(asPm.body).toMatchObject({ confidential: true, approvalSteps: null, skippedLevels: [] });
    expect((await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('overtime follows the chain in settings (MANAGER then HR); direct approval by the manager is refused', async () => {
    const bad = await s.http.admin.patch('/api/v1/settings/approvals.overtimeSteps').send({ value: ['MANAGER', 'CFO'] });
    expect(bad.status).toBe(400);
    expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
    expect((await s.http.admin.patch('/api/v1/settings/approvals.overtimeSteps').send({ value: [] })).status).toBe(400);
    expect((await s.http.admin.patch('/api/v1/settings/approvals.overtimeSteps').send({ value: ['MANAGER', 'HR_ADMIN'] })).status).toBe(200);

    const workDate = workdayFrom(addDays(today(), 3));
    const req = (await s.http.pe1.post('/api/v1/overtime/requests').send({ workDate, minutes: 90, reason: 'Go-live' })).body;
    expect(req).toMatchObject({ status: 'PENDING', currentLevel: 1, approvalSteps: ['MANAGER', 'HR_ADMIN'] });

    const direct = await s.http.pm.post('/api/v1/overtime/direct').send({ items: [{ employeeId: s.users.pe1.employeeId, workDate, minutes: 90 }] });
    expect(direct.body.results[0]).toMatchObject({ ok: false, error: 'APPROVAL_NOT_ALLOWED' });

    const step1 = await s.http.pm.post(`/api/v1/approvals/overtime/${req.id}/approve`).send({ comment: 'Needed' });
    expect(step1.body).toMatchObject({ status: 'PENDING', currentStep: 'HR_ADMIN', overtime: { currentLevel: 2, approvedMinutes: null } });
    const final = await s.http.hr.post(`/api/v1/approvals/overtime/${req.id}/approve`).send({});
    expect(final.body.overtime).toMatchObject({ status: 'APPROVED', approvedMinutes: 90 });
    expect(final.body.overtime.approvals.map((a: { step: string; comment: string | null }) => [a.step, a.comment])).toEqual([['MANAGER', 'Needed'], ['HR_ADMIN', null]]);
    expect(await auditActions(req.id)).toEqual(['OVERTIME_REQUEST_CREATE', 'OVERTIME_REQUEST_APPROVE_LEVEL', 'OVERTIME_REQUEST_APPROVE']);
  });

  it('corrections follow the chain in settings and are applied only on the last approval', async () => {
    expect((await s.http.admin.patch('/api/v1/settings/approvals.correctionSteps').send({ value: ['MANAGER', 'GENERAL_MANAGER'] })).status).toBe(200);
    const day = pastWorkday(2);
    const session = await sessionWithEvents(s.users.pe1.employeeId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const req = (await s.http.pe1.post('/api/v1/corrections/requests').send({ kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:00`, reason: 'Forgot' })).body;
    expect(req).toMatchObject({ status: 'PENDING', currentLevel: 1, approvalSteps: ['MANAGER', 'GENERAL_MANAGER'], approvals: [] });

    const step1 = await s.http.pm.post(`/api/v1/approvals/correction/${req.id}/approve`).send({ comment: 'I saw them leave at 4' });
    expect(step1.body).toMatchObject({ status: 'PENDING', correction: { currentLevel: 2, appliedEventId: null } });
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('MISSING_CHECKOUT');
    expectErrorEnvelope((await s.http.hr.post(`/api/v1/approvals/correction/${req.id}/approve`).send({})).body, 'APPROVAL_NOT_ALLOWED');

    const final = await s.http.gm.post(`/api/v1/approvals/correction/${req.id}/approve`).send({ comment: 'OK' });
    expect(final.body.correction).toMatchObject({ status: 'APPROVED', decisionComment: 'OK', appliedEventId: expect.any(String) });
    expect(final.body.correction.approvals.map((a: { step: string; comment: string }) => [a.step, a.comment])).toEqual([['MANAGER', 'I saw them leave at 4'], ['GENERAL_MANAGER', 'OK']]);
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('CLOSED');
  });

  it('bulk approve stores the note on every decision', async () => {
    const sun = futureSunday();
    const a = (await s.http.pe1.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.annual.id))).body;
    const b = (await s.http.pe2.post('/api/v1/leave/requests').send(fullDays(sun, sun, s.catalog.annual.id))).body;
    const res = await s.http.pm.post('/api/v1/approvals/bulk-approve').send({ items: [{ kind: 'LEAVE', id: a.id }, { kind: 'LEAVE', id: b.id }], comment: 'Have fun' });
    expect(res.body).toMatchObject({ approved: 2, failed: 0 });
    const rows = await prisma.leaveApproval.findMany({ where: { requestId: { in: [a.id, b.id] } } });
    expect(rows.map((r) => r.comment)).toEqual(['Have fun', 'Have fun']);
  });
});

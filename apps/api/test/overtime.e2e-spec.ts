import type { INestApplication } from '@nestjs/common';
import { addDays, weekdayOf } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents, today, workdayFrom } from './request-fixtures';

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

/** 08:00–18:00 on a Sun–Thu workday (built-in 8h schedule) -> 120 extra minutes in calc.ts. */
const workedLate = (employeeId: string, date: string) => sessionWithEvents(employeeId, date, 8 * 60, 18 * 60, 'CLOSED');

const nextWeekend = () => {
  let d = addDays(today(), 1);
  while (weekdayOf(d) !== 5) d = addDays(d, 1); // Friday
  return d;
};

describe('overtime requests', () => {
  it('exposes the configured policy', async () => {
    const res = await people.http.emp.get('/api/v1/overtime/policy');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ regularMultiplier: '1.25', weekendMultiplier: '1.50', holidayMultiplier: '2.00', minimumMinutes: 15 });
  });

  it('retrospective: capped by calc.ts extra minutes, with a compensation estimate from the policy', async () => {
    const day = pastWorkday(2);
    await workedLate(people.users.emp.employeeId, day);

    const tooMuch = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 150, reason: 'Release' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({ code: 'OVERTIME_EXCEEDS_RECORDED', details: { recordedExtraMinutes: 120 } });

    const small = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 10, reason: 'Release' });
    expect(small.status).toBe(400);
    expectErrorEnvelope(small.body, 'OVERTIME_BELOW_MINIMUM');

    const res = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 90, reason: 'Release', compensation: 'TIME_OFF' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PENDING', kind: 'REGULAR', isPreApproval: false, compensation: 'TIME_OFF', recordedExtraMinutes: 120,
      estimate: { baseMinutes: 90, multiplier: '1.25', compensatedMinutes: 113 }, // 112.5 rounds up
    });
    expect(await auditActions(res.body.id)).toEqual(['OVERTIME_REQUEST_CREATE']);
    expect((await notificationsOf(people.users.mgr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);

    const dup = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 30, reason: 'More' });
    expect(dup.status).toBe(409);
    expectErrorEnvelope(dup.body, 'DUPLICATE_REQUEST');

    // A day without recorded extra time cannot be claimed.
    const otherDay = pastWorkday(9);
    const none = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: otherDay, minutes: 30, reason: 'Release' });
    expect(none.body.error.code).toBe('OVERTIME_EXCEEDS_RECORDED');
  });

  it('pre-approval for a future day; weekends use the weekend multiplier', async () => {
    const fri = nextWeekend();
    const res = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: fri, minutes: 240, reason: 'Event setup' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isPreApproval: true, kind: 'WEEKEND', recordedExtraMinutes: null, estimate: { multiplier: '1.50', compensatedMinutes: 360 } });
    const approved = await people.http.mgr.post(`/api/v1/approvals/overtime/${res.body.id}/approve`).send({});
    expect(approved.body).toMatchObject({ status: 'APPROVED', overtime: { approvedMinutes: 240 } });
  });

  it('policy without retro approval rejects retrospective requests; policy edits are audited and need settings.manage', async () => {
    const policyId = catalog.policy.id;
    expect((await people.http.hr.patch(`/api/v1/overtime/policies/${policyId}`).send({ allowRetroApproval: false })).status).toBe(403);
    const bad = await people.http.admin.patch(`/api/v1/overtime/policies/${policyId}`).send({ regularMultiplier: '0.5' });
    expect(bad.status).toBe(400);
    const res = await people.http.admin.patch(`/api/v1/overtime/policies/${policyId}`).send({ allowRetroApproval: false });
    expect(res.status).toBe(200);
    expect(await auditActions(policyId)).toEqual(['OVERTIME_POLICY_UPDATE']);

    const day = pastWorkday(2);
    await workedLate(people.users.emp.employeeId, day);
    const retro = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' });
    expect(retro.status).toBe(409);
    expectErrorEnvelope(retro.body, 'OVERTIME_RETRO_NOT_ALLOWED');
  });

  it('requests keep the multiplier they were made with', async () => {
    const day = workdayFrom(addDays(today(), 3));
    const req = (await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' })).body;
    await people.http.admin.patch(`/api/v1/overtime/policies/${catalog.policy.id}`).send({ regularMultiplier: '2' });
    const mine = await people.http.emp.get('/api/v1/overtime/me/requests');
    expect(mine.body.find((r: { id: string }) => r.id === req.id).estimate).toEqual({ baseMinutes: 60, multiplier: '1.25', compensatedMinutes: 75 });
    const fresh = (await people.http.emp2.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' })).body;
    expect(fresh.estimate.multiplier).toBe('2.00');
  });

  it('approval: scope, self-approval, rejection reason, approved minutes capped at recorded extra', async () => {
    const day = pastWorkday(2);
    await workedLate(people.users.emp.employeeId, day);
    const req = (await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 120, reason: 'Release' })).body;

    expect((await people.http.opsMgr.post(`/api/v1/approvals/overtime/${req.id}/approve`).send({})).status).toBe(403);
    expect((await people.http.emp2.post(`/api/v1/approvals/overtime/${req.id}/approve`).send({})).status).toBe(403);

    // Attendance changed after the request (e.g. a correction): approval re-reads calc.ts.
    const session = await prisma.workSession.findFirstOrThrow({ where: { employeeId: people.users.emp.employeeId } });
    await prisma.workSession.update({ where: { id: session.id }, data: { endedAt: new Date(session.endedAt!.getTime() - 60 * 60_000) } });
    const ok = await people.http.mgr.post(`/api/v1/approvals/overtime/${req.id}/approve`).send({ comment: 'Thanks' });
    expect(ok.status).toBe(200);
    expect(ok.body.overtime).toMatchObject({ status: 'APPROVED', minutes: 120, approvedMinutes: 60, estimate: { baseMinutes: 60, compensatedMinutes: 75 } });
    expect(await auditActions(req.id)).toEqual(['OVERTIME_REQUEST_CREATE', 'OVERTIME_REQUEST_APPROVE']);
    expect((await notificationsOf(people.users.emp.userId)).map((n) => n.type)).toEqual(['REQUEST_APPROVED']);

    // The manager's own request.
    const mgrDay = pastWorkday(3);
    await workedLate(people.users.mgr.employeeId, mgrDay);
    const own = (await people.http.mgr.post('/api/v1/overtime/requests').send({ workDate: mgrDay, minutes: 60, reason: 'Release' })).body;
    const self = await people.http.mgr.post(`/api/v1/approvals/overtime/${own.id}/approve`).send({});
    expectErrorEnvelope(self.body, 'SELF_APPROVAL_FORBIDDEN');
    // No other Engineering manager -> HR was notified instead.
    expect((await notificationsOf(people.users.hr.userId)).map((n) => n.type)).toContain('REQUEST_PENDING_APPROVAL');
    expect((await people.http.hr.post(`/api/v1/approvals/overtime/${own.id}/reject`).send({})).status).toBe(400);
    const rejected = await people.http.hr.post(`/api/v1/approvals/overtime/${own.id}/reject`).send({ comment: 'Not agreed in advance' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', overtime: { approvedMinutes: null } });
  });

  it('employees cancel their own pending requests only', async () => {
    const day = workdayFrom(addDays(today(), 3));
    const req = (await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' })).body;
    expect((await people.http.emp2.post(`/api/v1/overtime/requests/${req.id}/cancel`)).status).toBe(404);
    expect((await people.http.emp.post(`/api/v1/overtime/requests/${req.id}/cancel`)).body.status).toBe('CANCELLED');
    expect((await people.http.emp.post(`/api/v1/overtime/requests/${req.id}/cancel`)).status).toBe(409);
    // Cancelled requests do not block a new one for the same date.
    expect((await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 30, reason: 'Release' })).status).toBe(201);
  });
});

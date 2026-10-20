import type { INestApplication } from '@nestjs/common';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

let people: Awaited<ReturnType<typeof seedPeople>>;
beforeEach(async () => {
  await resetDb();
  await seedRequestCatalog();
  people = await seedPeople(app);
});

/** 08:00–18:00 on the built-in 8 h schedule: 120 extra minutes. */
const late = (employeeId: string, date: string) => sessionWithEvents(employeeId, date, 8 * 60, 18 * 60, 'CLOSED');

describe('overtime approved without a request', () => {
  it('lists days with extra time in scope and approves them directly, capped at the recorded time', async () => {
    const day = pastWorkday(2);
    const { emp, emp2, opsEmp } = people.users;
    await Promise.all([late(emp.employeeId, day), late(emp2.employeeId, day), late(opsEmp.employeeId, day)]);

    const mine = await people.http.mgr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}`);
    expect(mine.status).toBe(200);
    expect(mine.body.map((c: { employee: { id: string } }) => c.employee.id).sort()).toEqual([emp.employeeId, emp2.employeeId].sort());
    expect(mine.body[0]).toMatchObject({ workDate: day, extraMinutes: 120, kind: 'REGULAR', request: null, canApprove: true });

    const res = await people.http.mgr.post('/api/v1/overtime/direct').send({
      items: [{ employeeId: emp.employeeId, workDate: day }, { employeeId: emp2.employeeId, workDate: day, minutes: 300 }, { employeeId: opsEmp.employeeId, workDate: day }],
      comment: 'Stock count',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 2, failed: 1 });
    expect(res.body.results).toEqual([
      expect.objectContaining({ employeeId: emp.employeeId, ok: true, approvedMinutes: 120 }),
      expect.objectContaining({ employeeId: emp2.employeeId, ok: true, approvedMinutes: 120 }), // capped at the recorded 120
      expect.objectContaining({ employeeId: opsEmp.employeeId, ok: false, error: 'APPROVAL_NOT_ALLOWED' }),
    ]);

    const empRequests = await people.http.emp.get('/api/v1/overtime/me/requests');
    expect(empRequests.body[0]).toMatchObject({ workDate: day, status: 'APPROVED', approvedMinutes: 120, estimate: { multiplier: '1.25', compensatedMinutes: 150 } });
    expect(await auditActions(res.body.results[0].requestId)).toEqual(['OVERTIME_DIRECT_APPROVE']);
    expect((await notificationsOf(emp.userId)).map((n) => n.data)).toEqual([expect.objectContaining({ kind: 'OVERTIME', directOvertime: true })]);

    // Approved days are no longer approvable and a second approval is refused.
    const after = await people.http.mgr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}`);
    expect(after.body.find((c: { employee: { id: string } }) => c.employee.id === emp.employeeId)).toMatchObject({ canApprove: false, request: { status: 'APPROVED' } });
    const again = await people.http.mgr.post('/api/v1/overtime/direct').send({ items: [{ employeeId: emp.employeeId, workDate: day }] });
    expect(again.body.results[0]).toMatchObject({ ok: false, error: 'DUPLICATE_REQUEST' });

    // The attendance report counts only approved overtime.
    const report = await people.http.hr.get(`/api/v1/reports/attendance?from=${day}&to=${day}`);
    const row = report.body.rows.find((r: { employee: { id: string } }) => r.employee.id === emp.employeeId);
    expect(row.totals).toMatchObject({ overtimeApprovedMinutes: 120, overtimeCompensatedMinutes: 150 });
  });

  it('approves a pending request of the day instead of creating another; no self-approval; employees cannot', async () => {
    const day = pastWorkday(3);
    await late(people.users.emp.employeeId, day);
    const req = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 90, reason: 'Release' });
    expect(req.status).toBe(201);
    const res = await people.http.hr.post('/api/v1/overtime/direct').send({ items: [{ employeeId: people.users.emp.employeeId, workDate: day, minutes: 60 }], compensation: 'TIME_OFF' });
    expect(res.body.results[0]).toMatchObject({ ok: true, requestId: req.body.id, approvedMinutes: 60 });
    expect(await prisma.overtimeRequest.count({ where: { employeeId: people.users.emp.employeeId } })).toBe(1);
    expect(await auditActions(req.body.id)).toEqual(['OVERTIME_REQUEST_CREATE', 'OVERTIME_REQUEST_APPROVE']);

    await late(people.users.mgr.employeeId, day);
    const self = await people.http.mgr.post('/api/v1/overtime/direct').send({ items: [{ employeeId: people.users.mgr.employeeId, workDate: day }] });
    expect(self.body.results[0]).toMatchObject({ ok: false, error: 'SELF_APPROVAL_FORBIDDEN' });
    expect((await people.http.emp.post('/api/v1/overtime/direct').send({ items: [{ employeeId: people.users.emp2.employeeId, workDate: day }] })).status).toBe(403);
    expect((await people.http.emp.get('/api/v1/overtime/candidates')).status).toBe(403);

    // Days without extra time fall below the policy minimum.
    const quiet = pastWorkday(5);
    const none = await people.http.hr.post('/api/v1/overtime/direct').send({ items: [{ employeeId: people.users.emp2.employeeId, workDate: quiet }] });
    expect(none.body.results[0]).toMatchObject({ ok: false, error: 'OVERTIME_BELOW_MINIMUM' });
  });
});

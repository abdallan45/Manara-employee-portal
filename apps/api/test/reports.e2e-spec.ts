import type { INestApplication } from '@nestjs/common';
import { addDays } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

/** Adds a permission to a built-in role (the DB is reset before every test). */
async function grantToRole(roleKey: string, permissionKey: string) {
  const [role, permission] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { key: roleKey } }),
    prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } }),
  ]);
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
}
import { DAY, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents } from './request-fixtures';

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

interface Row { employee: { id: string; employeeCode: string }; totals: Record<string, number | null>; days?: unknown[] }
const rowOf = (body: { rows: Row[] }, employeeId: string) => body.rows.find((r) => r.employee.id === employeeId)!;

describe('attendance report', () => {
  it('totals presence, absence, extra time and approved overtime per employee', async () => {
    const day = pastWorkday(2);
    const { emp, emp2, opsEmp } = people.users;
    await sessionWithEvents(emp.employeeId, day, 8 * 60, 18 * 60, 'CLOSED'); // 10 h → 120 extra minutes
    const ot = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 90, reason: 'Release' });
    await people.http.mgr.post(`/api/v1/approvals/overtime/${ot.body.id}/approve`).send({});

    const res = await people.http.hr.get(`/api/v1/reports/attendance?from=${day}&to=${day}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ from: day, to: day });
    expect(rowOf(res.body, emp.employeeId).totals).toMatchObject({
      scheduledDays: 1, presentDays: 1, absentDays: 0, netWorkMinutes: 600, requiredMinutes: DAY, extraMinutes: 120,
      overtimeApprovedMinutes: 90, overtimeCompensatedMinutes: 113, overtimePendingMinutes: 0, attendanceRate: 1,
    });
    expect(rowOf(res.body, emp2.employeeId).totals).toMatchObject({ presentDays: 0, absentDays: 1, missingMinutes: DAY, attendanceRate: 0 });
    expect(rowOf(res.body, opsEmp.employeeId)).toBeDefined();
    expect(res.body.totals.presentDays).toBe(1);
    expect(res.body.totals.absentDays).toBe(res.body.rows.length - 1);
    expect(rowOf(res.body, emp.employeeId).days).toBeUndefined();
  });

  it('counts work on a rest day separately from presence on scheduled days', async () => {
    let friday = pastWorkday(2);
    while (new Date(`${friday}T12:00:00Z`).getUTCDay() !== 5) friday = addDays(friday, -1);
    await sessionWithEvents(people.users.emp.employeeId, friday, 9 * 60, 12 * 60, 'CLOSED');
    const res = await people.http.hr.get(`/api/v1/reports/attendance?from=${friday}&to=${friday}&employeeId=${people.users.emp.employeeId}`);
    expect(res.body.rows[0].totals).toMatchObject({ scheduledDays: 0, presentDays: 0, restDaysWorked: 1, extraMinutes: 180, attendanceRate: null });
  });

  it('counts approved leave as leave, not absence, and ignores days after today', async () => {
    const day = pastWorkday(3);
    const { emp2 } = people.users;
    const leave = await people.http.emp2.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: day, endDate: day, reason: 'Family visit' });
    expect(leave.status).toBe(201);
    await people.http.mgr.post(`/api/v1/approvals/leave/${leave.body.id}/approve`).send({});

    const to = addDays(day, 20);
    const res = await people.http.hr.get(`/api/v1/reports/attendance?from=${day}&to=${to}&employeeId=${emp2.employeeId}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.totals.leaveDays).toBe(1);
    expect(row.days).toHaveLength(21);
    expect(row.days[0]).toMatchObject({ workDate: day, status: 'ON_LEAVE' });
    // Absences only up to today: every scheduled day so far except the leave day.
    expect(row.totals.absentDays).toBe(row.totals.scheduledDays - 1);
  });

  it('detail=true adds daily figures for every row and the request records, masking sensitive leave for managers', async () => {
    const day = pastWorkday(2);
    const sickDay = pastWorkday(4);
    const { emp, emp2 } = people.users;
    await sessionWithEvents(emp.employeeId, day, 8 * 60, 18 * 60, 'CLOSED');
    const ot = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: day, minutes: 60, reason: 'Release' });
    await people.http.mgr.post(`/api/v1/approvals/overtime/${ot.body.id}/approve`).send({});
    const sick = await people.http.emp2.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.sick.id, mode: 'FULL_DAY', startDate: sickDay, endDate: sickDay, reason: 'Flu' });
    expect(sick.status).toBe(201);

    const from = sickDay;
    const hr = await people.http.hr.get(`/api/v1/reports/attendance?from=${from}&to=${day}&detail=true`);
    expect(hr.status).toBe(200);
    expect(hr.body.rows.every((r: Row) => Array.isArray(r.days) && r.days.length === hr.body.rows[0].days!.length)).toBe(true);
    expect(hr.body.details.overtime).toEqual([
      expect.objectContaining({ employeeId: emp.employeeId, workDate: day, minutes: 60, status: 'APPROVED', multiplier: '1.25', compensatedMinutes: 75 }),
    ]);
    expect(hr.body.details.leave).toEqual([
      expect.objectContaining({ employeeId: emp2.employeeId, startDate: sickDay, status: 'PENDING', confidential: false, reason: 'Flu', leaveType: expect.objectContaining({ code: 'SICK' }) }),
    ]);
    expect(hr.body.details.corrections).toEqual([]);

    // detail=true is export data: managers need reports.export, which the default role lacks.
    expect((await people.http.mgr.get(`/api/v1/reports/attendance?from=${from}&to=${day}&detail=true`)).status).toBe(403);
    await grantToRole('DEPARTMENT_MANAGER', 'reports.export');
    const mgr = await people.http.mgr.get(`/api/v1/reports/attendance?from=${from}&to=${day}&detail=true`);
    expect(mgr.status).toBe(200);
    expect(mgr.body.details.leave).toEqual([expect.objectContaining({ confidential: true, leaveType: null, reason: null, attachments: 0 })]);
    // Without detail the multi-employee report stays light.
    const plain = await people.http.hr.get(`/api/v1/reports/attendance?from=${from}&to=${day}`);
    expect(plain.body.details).toBeUndefined();
    expect(plain.body.rows[0].days).toBeUndefined();
  });

  it('scopes managers to their departments and refuses employees', async () => {
    const day = pastWorkday(2);
    const mine = await people.http.mgr.get(`/api/v1/reports/attendance?from=${day}&to=${day}`);
    expect(mine.status).toBe(200);
    const codes = mine.body.rows.map((r: Row) => r.employee.id);
    expect(codes).toEqual(expect.arrayContaining([people.users.emp.employeeId, people.users.emp2.employeeId]));
    expect(codes).not.toContain(people.users.opsEmp.employeeId);

    const otherDept = await people.http.mgr.get(`/api/v1/reports/attendance?departmentId=${people.ops.id}`);
    expect(otherDept.status).toBe(403);
    const otherEmp = await people.http.mgr.get(`/api/v1/reports/attendance?employeeId=${people.users.opsEmp.employeeId}`);
    expect(otherEmp.status).toBe(404); // same answer as a missing employee
    expect((await people.http.emp.get('/api/v1/reports/attendance')).status).toBe(403);
  });

  it('validates the range', async () => {
    const tooLong = await people.http.hr.get('/api/v1/reports/attendance?from=2026-01-01&to=2026-06-30');
    expect(tooLong.status).toBe(400);
    expectErrorEnvelope(tooLong.body, 'VALIDATION_FAILED');
    expect((await people.http.hr.get('/api/v1/reports/attendance?from=2026-05-10&to=2026-05-01')).status).toBe(400);
    expect((await people.http.hr.get('/api/v1/reports/attendance?from=10-05-2026')).status).toBe(400);
  });
});

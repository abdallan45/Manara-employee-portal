import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { as, createDepartment, createUser, expectErrorEnvelope, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, futureSunday, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog } from './request-fixtures';

let app: INestApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * Projects department without a department manager or any explicit supervisor rows: lead (PROJECT_MANAGER),
 * lead2 (DEPARTMENT_MANAGER without a managed department), plain (EMPLOYEE, no approve permission) and
 * three employees r1..r3; r1 reports directly to lead.
 */
async function seed() {
  const catalog = await seedRequestCatalog();
  const people = await seedPeople(app);
  const prj = await createDepartment('PRJ', 'Projects');
  const [lead, lead2, plain, r1, r2, r3] = await Promise.all([
    createUser({ username: 'lead', roles: ['PROJECT_MANAGER'], departmentId: prj.id }),
    createUser({ username: 'lead2', roles: ['DEPARTMENT_MANAGER'], departmentId: prj.id }),
    createUser({ username: 'plain', roles: ['EMPLOYEE'], departmentId: prj.id }),
    createUser({ username: 'r1', roles: ['EMPLOYEE'], departmentId: prj.id }),
    createUser({ username: 'r2', roles: ['EMPLOYEE'], departmentId: prj.id }),
    createUser({ username: 'r3', roles: ['EMPLOYEE'], departmentId: prj.id }),
  ]);
  await prisma.employee.update({ where: { id: r1.employeeId }, data: { managerId: lead.employeeId } });
  const login = async (u: { username: string }) => as(app, await webLogin(app, u.username));
  const [leadS, lead2S, plainS, r1S, r2S] = await Promise.all([lead, lead2, plain, r1, r2].map(login));
  return {
    catalog, people, prj,
    users: { ...people.users, lead, lead2, plain, r1, r2, r3 },
    http: { ...people.http, lead: leadS, lead2: lead2S, plain: plainS, r1: r1S, r2: r2S },
  };
}

let s: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  await resetDb();
  s = await seed();
});

const fullDays = (day: string, leaveTypeId: string) => ({ leaveTypeId, mode: 'FULL_DAY', startDate: day, endDate: day, reason: 'Trip' });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('the direct manager supervises automatically', () => {
  it('sees the report and approves the MANAGER step without any supervisor row', async () => {
    expect(await prisma.employeeSupervisor.count()).toBe(0);
    const day = pastWorkday(2);
    expect((await s.http.lead.get(`/api/v1/attendance/employees/${s.users.r1.employeeId}/days?from=${day}&to=${day}`)).status).toBe(200);
    expect((await s.http.lead.get(`/api/v1/attendance/employees/${s.users.r2.employeeId}/days?from=${day}&to=${day}`)).status).toBe(404);
    const list = await s.http.lead.get('/api/v1/employees?pageSize=100');
    expect(ids(list.body.items)).toEqual([s.users.r1.employeeId]);

    const shown = await s.http.admin.get(`/api/v1/employees/${s.users.r1.employeeId}`);
    expect(shown.body).toMatchObject({ supervisors: [], directManagerSupervisor: { userId: s.users.lead.userId, username: 'lead', name: 'Test lead' } });

    const sun = futureSunday();
    const req = (await s.http.r1.post('/api/v1/leave/requests').send(fullDays(sun, s.catalog.annual.id))).body;
    expect(req).toMatchObject({ currentLevel: 1, approvalSteps: ['MANAGER'], skippedLevels: [] });
    expect((await notificationsOf(s.users.lead.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    const inbox = await s.http.lead.get('/api/v1/approvals?tab=PENDING');
    expect(inbox.body.items).toEqual([expect.objectContaining({ id: req.id, canAct: true, currentStep: 'MANAGER' })]);
    expect((await s.http.lead.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('changing the direct manager moves the access with it', async () => {
    const res = await s.http.admin.patch(`/api/v1/employees/${s.users.r1.employeeId}`).send({ managerId: s.users.lead2.employeeId });
    expect(res.status).toBe(200);
    expect(res.body.directManagerSupervisor).toMatchObject({ userId: s.users.lead2.userId });
    const day = pastWorkday(2);
    expect((await s.http.lead.get(`/api/v1/attendance/employees/${s.users.r1.employeeId}/days?from=${day}&to=${day}`)).status).toBe(404);
    expect((await s.http.lead.get(`/api/v1/employees/${s.users.r1.employeeId}`)).status).toBe(404);
    expect((await s.http.lead2.get(`/api/v1/attendance/employees/${s.users.r1.employeeId}/days?from=${day}&to=${day}`)).status).toBe(200);

    const sun = futureSunday();
    const req = (await s.http.r1.post('/api/v1/leave/requests').send(fullDays(sun, s.catalog.annual.id))).body;
    expect(await notificationsOf(s.users.lead.userId)).toHaveLength(0);
    expect((await notificationsOf(s.users.lead2.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);
    expect((await s.http.lead.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).status).toBe(403);
    expect((await s.http.lead2.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('a direct manager without approve permission is skipped; the request goes on to HR', async () => {
    await prisma.employee.update({ where: { id: s.users.r2.employeeId }, data: { managerId: s.users.plain.employeeId } });
    const sun = futureSunday();
    const req = (await s.http.r2.post('/api/v1/leave/requests').send(fullDays(sun, s.catalog.twoLevel.id))).body;
    expect(req).toMatchObject({ currentLevel: 2, approvalSteps: ['MANAGER', 'HR_ADMIN'], skippedLevels: [1] });
    expect(await notificationsOf(s.users.plain.userId)).toHaveLength(0);
    expect((await s.http.hr.post(`/api/v1/approvals/leave/${req.id}/approve`).send({})).body.status).toBe('APPROVED');
  });

  it('listing the direct manager as a supervisor is redundant and dropped; a new manager loses the explicit row', async () => {
    const res = await s.http.admin.patch(`/api/v1/employees/${s.users.r1.employeeId}`).send({ supervisorUserIds: [s.users.lead.userId, s.users.lead2.userId] });
    expect(res.status).toBe(200);
    expect(res.body.supervisors.map((x: { userId: string }) => x.userId)).toEqual([s.users.lead2.userId]);
    const moved = await s.http.admin.patch(`/api/v1/employees/${s.users.r1.employeeId}`).send({ managerId: s.users.lead2.employeeId });
    expect(moved.body).toMatchObject({ supervisors: [], directManagerSupervisor: { userId: s.users.lead2.userId } });
  });

  it('refuses a reporting line that loops', async () => {
    const res = await s.http.admin.patch(`/api/v1/employees/${s.users.lead.employeeId}`).send({ managerId: s.users.r1.employeeId });
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
  });
});

describe('GET / PUT /employees/:id/team', () => {
  it('replaces direct reports and supervised employees from the manager page', async () => {
    const lead = s.users.lead.employeeId;
    const put = await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({
      directReportIds: [s.users.r2.employeeId], supervisedEmployeeIds: [s.users.r1.employeeId, s.users.r3.employeeId],
    });
    expect(put.status).toBe(200);
    expect(ids(put.body.directReports)).toEqual([s.users.r2.employeeId]);
    expect(ids(put.body.supervised)).toEqual([s.users.r1.employeeId, s.users.r3.employeeId].sort());
    expect(put.body.hasUser).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: s.users.r1.employeeId } })).managerId).toBeNull();
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: s.users.r2.employeeId } })).managerId).toBe(lead);
    expect(await auditActions(lead)).toEqual(['EMPLOYEE_TEAM_UPDATE']);

    // The signed-in lead sees all three at once.
    const list = await s.http.lead.get('/api/v1/employees?pageSize=100');
    expect(ids(list.body.items)).toEqual([s.users.r1.employeeId, s.users.r2.employeeId, s.users.r3.employeeId].sort());

    // A supervised employee made a direct report loses the explicit row; ids already direct reports are ignored.
    const again = await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({
      directReportIds: [s.users.r2.employeeId, s.users.r3.employeeId], supervisedEmployeeIds: [s.users.r2.employeeId, s.users.r3.employeeId],
    });
    expect(ids(again.body.directReports)).toEqual([s.users.r2.employeeId, s.users.r3.employeeId].sort());
    expect(again.body.supervised).toEqual([]);
    expect(await prisma.employeeSupervisor.count({ where: { supervisorUserId: s.users.lead.userId } })).toBe(0);

    const got = await s.http.admin.get(`/api/v1/employees/${lead}/team`);
    expect(got.status).toBe(200);
    expect(ids(got.body.directReports)).toEqual([s.users.r2.employeeId, s.users.r3.employeeId].sort());
    // A team reader sees the team of someone in their scope.
    const asMgr = await s.http.mgr.get(`/api/v1/employees/${s.users.emp.employeeId}/team`);
    expect(asMgr.body).toEqual({ directReports: [], supervised: [], hasUser: true });
  });

  it('needs employees.manage to change and employees.read in scope to view', async () => {
    const lead = s.users.lead.employeeId;
    expect((await s.http.lead.put(`/api/v1/employees/${lead}/team`).send({ directReportIds: [] })).status).toBe(403);
    expect((await s.http.r1.get(`/api/v1/employees/${lead}/team`)).status).toBe(403);
    expect((await s.http.mgr.get(`/api/v1/employees/${lead}/team`)).status).toBe(404);
  });

  it('rejects an employee without a login, the employee themselves and a loop', async () => {
    const lead = s.users.lead.employeeId;
    const nologin = await prisma.employee.create({ data: { employeeCode: 'NL-1', fullName: 'No login' } });
    const noUser = await s.http.admin.put(`/api/v1/employees/${nologin.id}/team`).send({ supervisedEmployeeIds: [s.users.r2.employeeId] });
    expect(noUser.status).toBe(400);
    expectErrorEnvelope(noUser.body, 'VALIDATION_FAILED');
    // Direct reports need no login.
    const reports = await s.http.admin.put(`/api/v1/employees/${nologin.id}/team`).send({ directReportIds: [s.users.r3.employeeId] });
    expect(reports.body).toMatchObject({ hasUser: false, supervised: [] });

    expect((await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({ directReportIds: [lead] })).status).toBe(400);
    expect((await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({ supervisedEmployeeIds: [lead] })).status).toBe(400);
    // lead2 -> lead -> r1: lead2 cannot become r1's report.
    await prisma.employee.update({ where: { id: lead }, data: { managerId: s.users.lead2.employeeId } });
    const loop = await s.http.admin.put(`/api/v1/employees/${s.users.r1.employeeId}/team`).send({ directReportIds: [s.users.lead2.employeeId] });
    expect(loop.status).toBe(400);
    expectErrorEnvelope(loop.body, 'VALIDATION_FAILED');
    const inactive = await prisma.employee.create({ data: { employeeCode: 'IN-1', fullName: 'Gone', isActive: false } });
    expect((await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({ supervisedEmployeeIds: [inactive.id] })).status).toBe(400);
    expect((await s.http.admin.put(`/api/v1/employees/${lead}/team`).send({ directReportIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: s.users.r1.employeeId } })).managerId).toBe(lead);
  });
});

describe('migration 20261029090000_direct_manager_supervises', () => {
  it('deletes only the rows naming the current direct manager', async () => {
    await prisma.employeeSupervisor.createMany({
      data: [
        { supervisorUserId: s.users.lead.userId, employeeId: s.users.r1.employeeId },
        { supervisorUserId: s.users.lead2.userId, employeeId: s.users.r1.employeeId },
        { supervisorUserId: s.users.lead.userId, employeeId: s.users.r2.employeeId },
      ],
    });
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261029090000_direct_manager_supervises/migration.sql'), 'utf8');
    await prisma.$executeRawUnsafe(sql.split('\n').filter((l) => !l.startsWith('--')).join('\n'));
    const left = await prisma.employeeSupervisor.findMany({ select: { supervisorUserId: true, employeeId: true } });
    expect(left).toEqual(expect.arrayContaining([
      { supervisorUserId: s.users.lead2.userId, employeeId: s.users.r1.employeeId },
      { supervisorUserId: s.users.lead.userId, employeeId: s.users.r2.employeeId },
    ]));
    expect(left).toHaveLength(2);
  });
});

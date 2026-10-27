import type { INestApplication } from '@nestjs/common';
import { ALL_PERMISSIONS } from '@workforce/shared';
import { ensureRbac } from '../prisma/rbac';
import { as, createUser, expectErrorEnvelope, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, seedPeople, seedRequestCatalog } from './request-fixtures';

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

const roleId = async (key: string) => (await prisma.role.findUniqueOrThrow({ where: { key } })).id;
const site = { key: 'SITE_SUPERVISOR', name: 'Site supervisor', nameAr: 'مشرف موقع', description: 'Approves leave on site', permissions: ['attendance.self', 'leave.self', 'leave.approve'] };

describe('roles & permissions', () => {
  it('lists built-in roles with Arabic names, permissions and user counts', async () => {
    const res = await people.http.admin.get('/api/v1/roles');
    expect(res.status).toBe(200);
    const byKey = new Map(res.body.map((r: { key: string }) => [r.key, r]));
    for (const key of ['SUPER_ADMIN', 'HR_ADMIN', 'GENERAL_MANAGER', 'DEPARTMENT_MANAGER', 'PROJECT_MANAGER', 'EMPLOYEE']) expect(byKey.get(key)).toBeDefined();
    expect(byKey.get('PROJECT_MANAGER')).toMatchObject({ nameAr: 'مدير مشروع', isSystem: true, userCount: 0 });
    expect(byKey.get('PROJECT_MANAGER')).toMatchObject({ permissions: expect.not.arrayContaining(['employees.manage']) });
    expect(byKey.get('DEPARTMENT_MANAGER')).toMatchObject({ userCount: 2 });
    expect((byKey.get('SUPER_ADMIN') as { permissions: string[] }).permissions).toHaveLength(ALL_PERMISSIONS.length);
    // Readable for the employee dialog and the settings chain editors; not for plain employees.
    expect((await people.http.hr.get('/api/v1/roles')).status).toBe(200);
    expect((await people.http.emp.get('/api/v1/roles')).status).toBe(403);
  });

  it('creates, edits and deletes custom roles (roles.manage only), audited', async () => {
    expect((await people.http.hr.post('/api/v1/roles').send(site)).status).toBe(403);
    const created = await people.http.admin.post('/api/v1/roles').send(site);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ key: 'SITE_SUPERVISOR', nameAr: 'مشرف موقع', isSystem: false, userCount: 0, permissions: ['attendance.self', 'leave.approve', 'leave.self'] });

    expectErrorEnvelope((await people.http.admin.post('/api/v1/roles').send(site)).body, 'CONFLICT');
    for (const bad of [{ ...site, key: 'lower' }, { ...site, key: 'MANAGER' }, { ...site, key: 'ANY_APPROVER' }, { ...site, key: 'NEW_ONE', permissions: ['payroll.run'] }, { ...site, key: 'NEW_TWO', name: ' ' }]) {
      const res = await people.http.admin.post('/api/v1/roles').send(bad);
      expect(res.status).toBe(400);
    }

    const patched = await people.http.admin.patch(`/api/v1/roles/${created.body.id}`).send({ name: 'Site lead', permissions: ['attendance.self', 'attendance.read.team'] });
    expect(patched.body).toMatchObject({ name: 'Site lead', key: 'SITE_SUPERVISOR', permissions: ['attendance.read.team', 'attendance.self'] });
    expect((await people.http.hr.patch(`/api/v1/roles/${created.body.id}`).send({ name: 'X' })).status).toBe(403);

    expect((await people.http.admin.delete(`/api/v1/roles/${created.body.id}`)).status).toBe(204);
    expect(await auditActions(created.body.id)).toEqual(['ROLE_CREATE', 'ROLE_UPDATE', 'ROLE_DELETE']);
  });

  it('SUPER_ADMIN keeps every permission; built-in roles cannot be deleted', async () => {
    const superId = await roleId('SUPER_ADMIN');
    const cut = await people.http.admin.patch(`/api/v1/roles/${superId}`).send({ permissions: ['attendance.self'] });
    expect(cut.status).toBe(403);
    expect(await prisma.rolePermission.count({ where: { roleId: superId } })).toBe(ALL_PERMISSIONS.length);
    expect((await people.http.admin.patch(`/api/v1/roles/${superId}`).send({ nameAr: 'المدير الأعلى' })).body.nameAr).toBe('المدير الأعلى');
    expect((await people.http.admin.delete(`/api/v1/roles/${await roleId('PROJECT_MANAGER')}`)).status).toBe(403);
  });

  it('a role in use cannot be deleted: assigned to users or named in an approval chain', async () => {
    const role = (await people.http.admin.post('/api/v1/roles').send(site)).body;
    const holder = await createUser({ username: 'sup', roles: ['SITE_SUPERVISOR'] });
    const assigned = await people.http.admin.delete(`/api/v1/roles/${role.id}`);
    expect(assigned.status).toBe(409);
    expect(assigned.body.error.details).toMatchObject({ reason: 'ASSIGNED', users: 1 });

    await prisma.userRole.deleteMany({ where: { userId: holder.userId, roleId: role.id } });
    await people.http.admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ approvalSteps: ['MANAGER', 'SITE_SUPERVISOR'] });
    const inChain = await people.http.admin.delete(`/api/v1/roles/${role.id}`);
    expect(inChain.status).toBe(409);
    expect(inChain.body.error.details).toMatchObject({ reason: 'IN_APPROVAL_CHAIN', uses: ['leaveType:ANNUAL'] });

    await people.http.admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ approvalSteps: ['MANAGER'] });
    await people.http.admin.patch('/api/v1/settings/approvals.correctionSteps').send({ value: ['SITE_SUPERVISOR'] });
    expect((await people.http.admin.delete(`/api/v1/roles/${role.id}`)).body.error.details).toMatchObject({ uses: ['approvals.correctionSteps'] });
    await people.http.admin.patch('/api/v1/settings/approvals.correctionSteps').send({ value: ['MANAGER'] });
    expect((await people.http.admin.delete(`/api/v1/roles/${role.id}`)).status).toBe(204);
  });

  it('a permission change applies to a session that is already signed in', async () => {
    const role = (await people.http.admin.post('/api/v1/roles').send({ ...site, permissions: ['attendance.self'] })).body;
    await createUser({ username: 'sup', roles: ['SITE_SUPERVISOR'] });
    const sup = as(app, await webLogin(app, 'sup'));
    expect((await sup.get('/api/v1/employees')).status).toBe(403);
    await people.http.admin.patch(`/api/v1/roles/${role.id}`).send({ permissions: ['attendance.self', 'employees.read'] });
    const now = await sup.get('/api/v1/employees');
    expect(now.status).toBe(200);
    expect(now.body.items).toEqual([]); // team scope, and nobody assigned to them
    expect((await sup.get('/api/v1/auth/me')).body.permissions).toContain('employees.read');
    await people.http.admin.patch(`/api/v1/roles/${role.id}`).send({ permissions: ['attendance.self'] });
    expect((await sup.get('/api/v1/employees')).status).toBe(403);
  });

  it('granting privileged roles (incl. GENERAL_MANAGER) needs roles.manage; PROJECT_MANAGER does not', async () => {
    const base = { fullName: 'New person', password: 'a-long-password-1' };
    const gm = await people.http.hr.post('/api/v1/employees').send({ ...base, employeeCode: 'N-1', username: 'newgm', roleKeys: ['GENERAL_MANAGER'] });
    expect(gm.status).toBe(403);
    const pm = await people.http.hr.post('/api/v1/employees').send({ ...base, employeeCode: 'N-2', username: 'newpm', roleKeys: ['EMPLOYEE', 'PROJECT_MANAGER'] });
    expect(pm.status).toBe(201);
    const byAdmin = await people.http.admin.post('/api/v1/employees').send({ ...base, employeeCode: 'N-3', username: 'newgm', roleKeys: ['GENERAL_MANAGER'] });
    expect(byAdmin.status).toBe(201);
    // HR cannot edit an account holding a privileged role either.
    expect((await people.http.hr.patch(`/api/v1/employees/${byAdmin.body.id}`).send({ fullName: 'Renamed' })).status).toBe(403);
  });

  it('re-seeding does not give back permissions the admin removed', async () => {
    const hrId = await roleId('HR_ADMIN');
    const current = (await people.http.admin.get('/api/v1/roles')).body.find((r: { key: string }) => r.key === 'HR_ADMIN').permissions as string[];
    await people.http.admin.patch(`/api/v1/roles/${hrId}`).send({ permissions: current.filter((p) => p !== 'reports.export') });
    await ensureRbac(prisma);
    const after = await prisma.rolePermission.findMany({ where: { roleId: hrId }, include: { permission: true } });
    expect(after.map((r) => r.permission.key)).not.toContain('reports.export');
    expect(after).toHaveLength(current.length - 1);
  });
});

describe('employee supervisors and personal hours', () => {
  it('are saved, validated and returned; null clears', async () => {
    const pmUser = await createUser({ username: 'pm', roles: ['PROJECT_MANAGER'] });
    const id = people.users.emp.employeeId;
    const res = await people.http.admin.patch(`/api/v1/employees/${id}`).send({ supervisorUserIds: [pmUser.userId], dailyRequiredMinutes: 480, includedBreakMinutes: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dailyRequiredMinutes: 480, includedBreakMinutes: 30, supervisors: [{ userId: pmUser.userId, username: 'pm', name: 'Test pm', nameAr: null }] });
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'EMPLOYEE_UPDATE' }, orderBy: { seq: 'desc' } });
    expect(audit?.after).toMatchObject({ supervisors: [expect.objectContaining({ userId: pmUser.userId })] });

    for (const bad of [{ dailyRequiredMinutes: 20 }, { dailyRequiredMinutes: 2000 }, { includedBreakMinutes: 300 }, { includedBreakMinutes: 1.5 }, { supervisorUserIds: [people.users.emp.userId] }, { supervisorUserIds: ['00000000-0000-4000-8000-000000000000'] }]) {
      const r = await people.http.admin.patch(`/api/v1/employees/${id}`).send(bad);
      expect(r.status).toBe(400);
    }
    const cleared = await people.http.admin.patch(`/api/v1/employees/${id}`).send({ supervisorUserIds: [], dailyRequiredMinutes: null, includedBreakMinutes: null });
    expect(cleared.body).toMatchObject({ dailyRequiredMinutes: null, includedBreakMinutes: null, supervisors: [] });

    const created = await people.http.admin.post('/api/v1/employees').send({
      employeeCode: 'N-9', fullName: 'Newcomer', username: 'newcomer', password: 'a-long-password-1', supervisorUserIds: [pmUser.userId], dailyRequiredMinutes: 420,
    });
    expect(created.body).toMatchObject({ dailyRequiredMinutes: 420, includedBreakMinutes: null, supervisors: [expect.objectContaining({ userId: pmUser.userId })] });
  });
});

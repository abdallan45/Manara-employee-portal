import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, createDepartment, createUser, expectErrorEnvelope, WebSession, webLogin } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

describe('employees & departments (e2e)', () => {
  let app: INestApplication;
  let eng: { id: string };
  let ops: { id: string };
  let hr: WebSession;
  let admin: WebSession;
  let adminUserId: string;

  beforeAll(async () => {
    await resetDb();
    app = await createTestApp();
    eng = await createDepartment('ENG', 'Engineering');
    ops = await createDepartment('OPS', 'Operations');
    adminUserId = (await createUser({ username: 'root', roles: ['SUPER_ADMIN'], departmentId: ops.id })).userId;
    await createUser({ username: 'hruser', roles: ['HR_ADMIN', 'EMPLOYEE'], departmentId: ops.id });
    await createUser({ username: 'boss', roles: ['DEPARTMENT_MANAGER', 'EMPLOYEE'], departmentId: eng.id, manages: [eng.id] });
    await createUser({ username: 'dev', roles: ['EMPLOYEE'], departmentId: eng.id });
    await createUser({ username: 'opsguy', roles: ['EMPLOYEE'], departmentId: ops.id });
    hr = await webLogin(app, 'hruser');
    admin = await webLogin(app, 'root');
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('forbids plain employees from listing employees', async () => {
    const s = await webLogin(app, 'dev');
    const res = await as(app, s).get('/api/v1/employees');
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'FORBIDDEN');
  });

  it('scopes department managers to the departments they manage', async () => {
    const s = await webLogin(app, 'boss');
    const res = await as(app, s).get('/api/v1/employees?pageSize=100');
    expect(res.status).toBe(200);
    const names = res.body.items.map((e: { user: { username: string } }) => e.user.username).sort();
    expect(names).toEqual(['boss', 'dev']);
    expect(res.body.items.every((e: { departmentId: string }) => e.departmentId === eng.id)).toBe(true);

    const opsEmployee = await prisma.employee.findFirstOrThrow({ where: { user: { username: 'opsguy' } } });
    const hidden = await as(app, s).get(`/api/v1/employees/${opsEmployee.id}`);
    expect(hidden.status).toBe(404);

    const write = await as(app, s).post('/api/v1/employees').send({});
    expect(write.status).toBe(403);
  });

  it('lets HR see everyone, search and paginate', async () => {
    const all = await as(app, hr).get('/api/v1/employees?pageSize=2&page=1');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(5);
    expect(all.body.items).toHaveLength(2);
    expect(all.body).toMatchObject({ page: 1, pageSize: 2 });

    const search = await as(app, hr).get('/api/v1/employees?search=OPSG');
    expect(search.body.items.map((e: { user: { username: string } }) => e.user.username)).toEqual(['opsguy']);
    const byDept = await as(app, hr).get(`/api/v1/employees?departmentId=${eng.id}`);
    expect(byDept.body.total).toBe(2);
    const bad = await as(app, hr).get('/api/v1/employees?pageSize=1000');
    expect(bad.status).toBe(400);
    expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
  });

  describe('HR employee lifecycle', () => {
    let employeeId: string;
    const payload = () => ({
      employeeCode: 'EMP-9001', fullName: 'New Hire', fullNameAr: 'موظف جديد', email: 'new.hire@example.test',
      departmentId: eng.id, hireDate: '2026-10-01', username: 'newhire', password: 'initial-pass-1',
      jobTitle: 'Engineer',
    });

    it('creates an employee with a login and default role, audited without secrets', async () => {
      const res = await as(app, hr).post('/api/v1/employees').send(payload());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        employeeCode: 'EMP-9001', fullName: 'New Hire', departmentId: eng.id, departmentName: 'Engineering',
        hireDate: '2026-10-01', isActive: true,
        user: { username: 'newhire', isActive: true, roles: [{ key: 'EMPLOYEE', departmentId: null }], lastLoginAt: null },
      });
      employeeId = res.body.id;
      const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'EMPLOYEE_CREATE', entityId: employeeId } });
      expect(JSON.stringify(auditRow.after)).not.toMatch(/initial-pass-1|passwordHash|argon2/);
      expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: 'newhire', password: 'initial-pass-1' })).status).toBe(200);
    });

    it('returns specific 409 codes for duplicate code and username', async () => {
      const dupCode = await as(app, hr).post('/api/v1/employees').send({ ...payload(), username: 'other1' });
      expect(dupCode.status).toBe(409);
      expectErrorEnvelope(dupCode.body, 'EMPLOYEE_CODE_TAKEN');
      const dupUser = await as(app, hr).post('/api/v1/employees').send({ ...payload(), employeeCode: 'EMP-9002' });
      expect(dupUser.status).toBe(409);
      expectErrorEnvelope(dupUser.body, 'USERNAME_TAKEN');
      const patchDup = await as(app, hr).patch(`/api/v1/employees/${employeeId}`).send({ username: 'dev' });
      expect(patchDup.status).toBe(409);
      expectErrorEnvelope(patchDup.body, 'USERNAME_TAKEN');
    });

    it('validates input', async () => {
      const res = await as(app, hr).post('/api/v1/employees').send({ ...payload(), employeeCode: 'EMP-9003', username: 'Bad Name!', password: 'short' });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
      const fields = (res.body.error.details as { field: string }[]).map((d) => d.field).sort();
      expect(fields).toEqual(['password', 'username']);
      const unknownRole = await as(app, hr).post('/api/v1/employees').send({ ...payload(), employeeCode: 'EMP-9004', username: 'x-role', roleKeys: ['WIZARD'] });
      expect(unknownRole.status).toBe(400);
    });

    it('edits an employee; a password change revokes that user\'s sessions', async () => {
      const userSession = await webLogin(app, 'newhire', 'initial-pass-1');
      expect((await as(app, userSession).get('/api/v1/auth/me')).status).toBe(200);

      const res = await as(app, hr).patch(`/api/v1/employees/${employeeId}`).send({ jobTitle: 'Senior Engineer', phone: '', password: 'changed-pass-2' });
      expect(res.status).toBe(200);
      expect(res.body.jobTitle).toBe('Senior Engineer');
      expect(res.body.phone).toBeNull();
      expect((await as(app, userSession).get('/api/v1/auth/me')).status).toBe(401);
      await webLogin(app, 'newhire', 'changed-pass-2');

      const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'EMPLOYEE_UPDATE', entityId: employeeId } });
      expect(auditRow.before).toMatchObject({ jobTitle: 'Engineer' });
      expect(auditRow.after).toMatchObject({ jobTitle: 'Senior Engineer', passwordChanged: true });
      expect(JSON.stringify(auditRow.after)).not.toContain('changed-pass-2');
    });

    it('deactivates (sessions stop working, login refused) and re-activates', async () => {
      const userSession = await webLogin(app, 'newhire', 'changed-pass-2');
      const off = await as(app, hr).post(`/api/v1/employees/${employeeId}/deactivate`);
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ isActive: false, user: { isActive: false } });
      expect((await as(app, userSession).get('/api/v1/auth/me')).status).toBe(401);
      expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: 'newhire', password: 'changed-pass-2' })).status).toBe(401);

      const listed = await as(app, hr).get('/api/v1/employees?status=inactive');
      expect(listed.body.items.map((e: { id: string }) => e.id)).toEqual([employeeId]);

      const on = await as(app, hr).post(`/api/v1/employees/${employeeId}/activate`);
      expect(on.status).toBe(200);
      expect(on.body.isActive).toBe(true);
      await webLogin(app, 'newhire', 'changed-pass-2');
    });
  });

  describe('privilege rules', () => {
    it('only ROLES_MANAGE holders may grant HR_ADMIN or SUPER_ADMIN', async () => {
      const base = { fullName: 'Priv Test', password: 'priv-pass-123' };
      const byHr = await as(app, hr).post('/api/v1/employees').send({ ...base, employeeCode: 'P-1', username: 'priv1', roleKeys: ['HR_ADMIN'] });
      expect(byHr.status).toBe(403);
      expectErrorEnvelope(byHr.body, 'FORBIDDEN');
      const byAdmin = await as(app, admin).post('/api/v1/employees').send({ ...base, employeeCode: 'P-1', username: 'priv1', roleKeys: ['HR_ADMIN', 'EMPLOYEE'] });
      expect(byAdmin.status).toBe(201);

      // HR cannot edit another administrator's account (e.g. reset their password).
      const resetOther = await as(app, hr).patch(`/api/v1/employees/${byAdmin.body.id}`).send({ password: 'takeover-123' });
      expect(resetOther.status).toBe(403);
    });

    it('lets HR grant department-scoped manager roles', async () => {
      const res = await as(app, hr).post('/api/v1/employees').send({
        employeeCode: 'M-1', fullName: 'Ops Lead', username: 'opslead', password: 'opslead-pass-1',
        departmentId: ops.id, roleKeys: ['DEPARTMENT_MANAGER', 'EMPLOYEE'], managedDepartmentIds: [ops.id],
      });
      expect(res.status).toBe(201);
      expect(res.body.user.roles).toEqual(expect.arrayContaining([{ key: 'DEPARTMENT_MANAGER', departmentId: ops.id }]));
      const s = await webLogin(app, 'opslead', 'opslead-pass-1');
      // A password set by HR must be replaced before anything else works.
      expect((await as(app, s).get('/api/v1/employees?pageSize=100')).status).toBe(403);
      expect((await as(app, s).post('/api/v1/auth/me/password').send({ currentPassword: 'opslead-pass-1', newPassword: 'opslead-own-pass-2' })).status).toBe(204);
      const list = await as(app, s).get('/api/v1/employees?pageSize=100');
      expect(list.body.items.every((e: { departmentId: string }) => e.departmentId === ops.id)).toBe(true);
    });

    it('prevents self-deactivation and removing your own SUPER_ADMIN', async () => {
      const me = await prisma.employee.findFirstOrThrow({ where: { user: { id: adminUserId } } });
      const deactivate = await as(app, admin).post(`/api/v1/employees/${me.id}/deactivate`);
      expect(deactivate.status).toBe(403);
      const demote = await as(app, admin).patch(`/api/v1/employees/${me.id}`).send({ roleKeys: ['EMPLOYEE'] });
      expect(demote.status).toBe(403);
      const keep = await as(app, admin).patch(`/api/v1/employees/${me.id}`).send({ jobTitle: 'Admin' });
      expect(keep.status).toBe(200);
    });
  });

  describe('departments', () => {
    it('lists departments with active employee counts', async () => {
      const res = await as(app, hr).get('/api/v1/departments');
      expect(res.status).toBe(200);
      const engRow = res.body.find((d: { code: string }) => d.code === 'ENG');
      expect(engRow).toMatchObject({ name: 'Engineering', employeeCount: 3 });
      const dev = await webLogin(app, 'dev');
      expect((await as(app, dev).get('/api/v1/departments')).status).toBe(403);
    });

    it('creates, renames and soft-deletes; refuses delete with active employees; audits', async () => {
      const created = await as(app, hr).post('/api/v1/departments').send({ code: 'cre', name: 'Creative Studio', nameAr: 'الاستوديو' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'CRE', employeeCount: 0 });
      const dup = await as(app, hr).post('/api/v1/departments').send({ code: 'CRE', name: 'Again' });
      expect(dup.status).toBe(409);
      expectErrorEnvelope(dup.body, 'CONFLICT');

      const renamed = await as(app, hr).patch(`/api/v1/departments/${created.body.id}`).send({ name: 'Creative' });
      expect(renamed.body.name).toBe('Creative');
      const cycle = await as(app, hr).patch(`/api/v1/departments/${created.body.id}`).send({ parentId: created.body.id });
      expect(cycle.status).toBe(400);

      const busy = await as(app, hr).delete(`/api/v1/departments/${eng.id}`);
      expect(busy.status).toBe(409);
      expectErrorEnvelope(busy.body, 'CONFLICT');

      const del = await as(app, hr).delete(`/api/v1/departments/${created.body.id}`);
      expect(del.status).toBe(204);
      const after = await as(app, hr).get('/api/v1/departments');
      expect(after.body.some((d: { id: string }) => d.id === created.body.id)).toBe(false);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: created.body.id }, orderBy: { seq: 'asc' } })).map((a) => a.action);
      expect(actions).toEqual(['DEPARTMENT_CREATE', 'DEPARTMENT_UPDATE', 'DEPARTMENT_DELETE']);
    });
  });

  it('lists roles for users with EMPLOYEES_READ', async () => {
    const res = await as(app, hr).get('/api/v1/roles');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { key: string }) => r.key).sort()).toEqual(['DEPARTMENT_MANAGER', 'EMPLOYEE', 'GENERAL_MANAGER', 'HR_ADMIN', 'PROJECT_MANAGER', 'SUPER_ADMIN']);
    const dev = await webLogin(app, 'dev');
    expect((await as(app, dev).get('/api/v1/roles')).status).toBe(403);
  });
});

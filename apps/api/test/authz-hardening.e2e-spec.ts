// Authorization hardening: self-dealing on leave balances, confidential leave masking, 404 for
// out-of-scope employees, scoped schedule assignments, export permission and paging limits.
import type { INestApplication } from '@nestjs/common';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { DAY, pastWorkday, seedPeople, seedRequestCatalog, today } from './request-fixtures';

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

const year = () => Number(today().slice(0, 4));
const MISSING = '00000000-0000-4000-8000-000000000000';

async function grantToRole(roleKey: string, permissionKey: string) {
  const [role, permission] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { key: roleKey } }),
    prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } }),
  ]);
  await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
}

describe('HR cannot change their own leave balance', () => {
  it('adjustments: own balance → 403 SELF_APPROVAL_FORBIDDEN, another employee still works', async () => {
    const { hr, emp } = people.users;
    const body = { leaveTypeId: catalog.annual.id, year: year(), minutes: 10 * DAY, note: 'Bonus days' };
    const self = await people.http.hr.post('/api/v1/leave/adjustments').send({ ...body, employeeId: hr.employeeId });
    expect(self.status).toBe(403);
    expectErrorEnvelope(self.body, 'SELF_APPROVAL_FORBIDDEN');
    expect(self.body.error.message).toMatch(/another HR member/);
    expect(await prisma.leaveTransaction.count({ where: { employeeId: hr.employeeId, kind: 'ADJUSTMENT' } })).toBe(0);

    expect((await people.http.hr.post('/api/v1/leave/adjustments').send({ ...body, employeeId: emp.employeeId })).status).toBe(201);
    // Another HR member (here the admin) may adjust the HR user's balance.
    expect((await people.http.admin.post('/api/v1/leave/adjustments').send({ ...body, employeeId: hr.employeeId })).status).toBe(201);
  });

  it('entitlements: own (single or inside a bulk call) → 403 for the whole call; removal of own → 403', async () => {
    const { hr, emp, emp2 } = people.users;
    const body = { leaveTypeId: catalog.annual.id, fromYear: year(), annualEntitlementMinutes: 30 * DAY, note: 'Seniority' };

    const single = await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: [hr.employeeId] });
    expect(single.status).toBe(403);
    expectErrorEnvelope(single.body, 'SELF_APPROVAL_FORBIDDEN');

    const bulk = await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: [emp.employeeId, hr.employeeId, emp2.employeeId] });
    expect(bulk.status).toBe(403);
    expectErrorEnvelope(bulk.body, 'SELF_APPROVAL_FORBIDDEN');
    expect(bulk.body.error.details).toEqual({ employeeId: hr.employeeId });
    // Rejected as a whole: nobody got the entitlement.
    expect(await prisma.leaveEntitlement.count()).toBe(0);

    const others = await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: [emp.employeeId, emp2.employeeId] });
    expect(others.status).toBe(200);
    expect(others.body.updated).toBe(2);

    // The admin gives HR an entitlement; HR may not remove it, the admin may.
    expect((await people.http.admin.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: [hr.employeeId] })).status).toBe(200);
    const own = await prisma.leaveEntitlement.findFirstOrThrow({ where: { employeeId: hr.employeeId } });
    const remove = await people.http.hr.delete(`/api/v1/leave/entitlements/${own.id}`);
    expect(remove.status).toBe(403);
    expectErrorEnvelope(remove.body, 'SELF_APPROVAL_FORBIDDEN');
    expect((await people.http.admin.delete(`/api/v1/leave/entitlements/${own.id}`)).status).toBe(204);
    // Removing another employee's entitlement still works for HR.
    const empRow = await prisma.leaveEntitlement.findFirstOrThrow({ where: { employeeId: emp.employeeId } });
    expect((await people.http.hr.delete(`/api/v1/leave/entitlements/${empRow.id}`)).status).toBe(204);
  });
});

describe('cancelling started leave', () => {
  it('HR cannot cancel their own started leave (409) but can cancel an employee\'s', async () => {
    const past = pastWorkday(3);
    const body = { leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: past, endDate: past, reason: 'Family visit' };

    const own = await people.http.hr.post('/api/v1/leave/requests').send(body);
    expect(own.status).toBe(201);
    expect((await people.http.admin.post(`/api/v1/approvals/leave/${own.body.id}/approve`).send({})).body.status).toBe('APPROVED');
    const denied = await people.http.hr.post(`/api/v1/leave/requests/${own.body.id}/cancel`);
    expect(denied.status).toBe(409);
    expectErrorEnvelope(denied.body, 'LEAVE_ALREADY_STARTED');
    expect(await prisma.leaveTransaction.count({ where: { requestId: own.body.id, kind: 'CANCELLATION' } })).toBe(0);
    // Another HR member can.
    expect((await people.http.admin.post(`/api/v1/leave/requests/${own.body.id}/cancel`)).body.status).toBe('CANCELLED');

    const emp = await people.http.emp.post('/api/v1/leave/requests').send(body);
    await people.http.mgr.post(`/api/v1/approvals/leave/${emp.body.id}/approve`).send({});
    const byHr = await people.http.hr.post(`/api/v1/leave/requests/${emp.body.id}/cancel`);
    expect(byHr.status).toBe(200);
    expect(byHr.body.status).toBe('CANCELLED');
  });
});

describe('confidential leave seen by a manager', () => {
  it('hides the rejection reason, the level count and the approval steps', async () => {
    const past = pastWorkday(3);
    const req = (await people.http.emp.post('/api/v1/leave/requests').send({
      leaveTypeId: catalog.sick.id, mode: 'FULL_DAY', startDate: past, endDate: past, reason: 'Clinic visit',
    })).body;
    const rejected = await people.http.hr.post(`/api/v1/approvals/leave/${req.id}/reject`).send({ comment: 'Sick note missing' });
    expect(rejected.status).toBe(200);

    const asMgr = await people.http.mgr.get(`/api/v1/leave/requests/${req.id}`);
    expect(asMgr.status).toBe(200);
    expect(asMgr.body).toMatchObject({
      confidential: true, leaveType: null, reason: null, rejectionReason: null, approvalLevels: null, approvals: [], documents: [], status: 'REJECTED',
    });

    const asHr = await people.http.hr.get(`/api/v1/leave/requests/${req.id}`);
    expect(asHr.body).toMatchObject({ confidential: false, rejectionReason: 'Sick note missing', approvalLevels: 1 });
    const asOwner = await people.http.emp.get(`/api/v1/leave/requests/${req.id}`);
    expect(asOwner.body).toMatchObject({ confidential: false, rejectionReason: 'Sick note missing', approvalLevels: 1 });
  });
});

describe('out-of-scope employees answer 404', () => {
  it('attendance, leave and schedule reads: 404 out of scope (like a missing id), 403 without the permission', async () => {
    const { emp } = people.users;
    for (const path of [
      `/api/v1/attendance/employees/${emp.employeeId}/events`,
      `/api/v1/attendance/employees/${emp.employeeId}/days`,
      `/api/v1/leave/employees/${emp.employeeId}/balances`,
      `/api/v1/leave/employees/${emp.employeeId}/ledger`,
      `/api/v1/schedules/employees/${emp.employeeId}/current`,
      `/api/v1/reports/attendance?employeeId=${emp.employeeId}`,
    ]) {
      const outside = await people.http.opsMgr.get(path);
      expect([path, outside.status]).toEqual([path, 404]);
      expectErrorEnvelope(outside.body, 'NOT_FOUND');
      const missing = await people.http.opsMgr.get(path.replace(emp.employeeId, MISSING));
      expect([path, missing.status, missing.body.error.message]).toEqual([path, 404, outside.body.error.message]);
      expect([path, (await people.http.mgr.get(path)).status]).toEqual([path, 200]);
    }
    // No permission at all is still 403.
    expect((await people.http.emp2.get(`/api/v1/attendance/employees/${emp.employeeId}/days`)).status).toBe(403);
    expect((await people.http.emp2.get(`/api/v1/leave/employees/${emp.employeeId}/balances`)).status).toBe(403);
    expect((await people.http.emp2.get(`/api/v1/reports/attendance?employeeId=${emp.employeeId}`)).status).toBe(403);
  });
});

describe('schedule assignments of a schedule', () => {
  it('are limited to the manager\'s departments and their employees', async () => {
    const schedule = (await people.http.hr.post('/api/v1/schedules').send({
      name: 'Shift', type: 'FIXED',
      days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => weekday < 5
        ? { weekday, isWorkday: true, startMinute: 480, endMinute: 960, requiredMinutes: 480 }
        : { weekday, isWorkday: false, requiredMinutes: 0 }),
    })).body;
    const validFrom = today();
    const assign = async (target: Record<string, string>) =>
      (await people.http.hr.post(`/api/v1/schedules/${schedule.id}/assignments`).send({ ...target, validFrom })).body.id as string;
    const engDept = await assign({ departmentId: people.eng.id });
    const opsDept = await assign({ departmentId: people.ops.id });
    const emp2 = await assign({ employeeId: people.users.emp2.employeeId });
    const opsEmp = await assign({ employeeId: people.users.opsEmp.employeeId });

    const ids = (body: { id: string }[]) => body.map((a) => a.id).sort();
    const hr = await people.http.hr.get(`/api/v1/schedules/${schedule.id}/assignments`);
    expect(ids(hr.body)).toEqual([engDept, opsDept, emp2, opsEmp].sort());
    const mgr = await people.http.mgr.get(`/api/v1/schedules/${schedule.id}/assignments`);
    expect(mgr.status).toBe(200);
    expect(ids(mgr.body)).toEqual([engDept, emp2].sort());
    const opsMgr = await people.http.opsMgr.get(`/api/v1/schedules/${schedule.id}/assignments`);
    expect(ids(opsMgr.body)).toEqual([opsDept, opsEmp].sort());
  });
});

describe('report exports need reports.export', () => {
  it('detail=true and export=true are refused without it; the on-screen report is not', async () => {
    const day = pastWorkday(2);
    const q = `/api/v1/reports/attendance?from=${day}&to=${day}`;
    expect((await people.http.mgr.get(q)).status).toBe(200);
    expect((await people.http.mgr.get(`${q}&employeeId=${people.users.emp.employeeId}`)).status).toBe(200);
    for (const flag of ['detail=true', 'export=true', 'detail=true&export=true']) {
      const res = await people.http.mgr.get(`${q}&${flag}`);
      expect([flag, res.status]).toEqual([flag, 403]);
      expectErrorEnvelope(res.body, 'FORBIDDEN');
      expect([flag, (await people.http.hr.get(`${q}&${flag}`)).status]).toEqual([flag, 200]);
    }
    // export=true alone does not change the payload.
    const exported = await people.http.hr.get(`${q}&export=true`);
    expect(exported.body.details).toBeUndefined();

    await grantToRole('DEPARTMENT_MANAGER', 'reports.export');
    expect((await people.http.mgr.get(`${q}&export=true`)).status).toBe(200);
    expect((await people.http.mgr.get(`${q}&detail=true`)).status).toBe(200);
  });
});

describe('paging limits', () => {
  it('rejects absurd page numbers with 400 instead of failing', async () => {
    const { emp } = people.users;
    expect((await people.http.emp.get('/api/v1/attendance/me/events?page=100001')).status).toBe(400);
    expect((await people.http.emp.get('/api/v1/attendance/me/events?page=99999999999999')).status).toBe(400);
    expect((await people.http.hr.get(`/api/v1/attendance/employees/${emp.employeeId}/events?page=100001`)).status).toBe(400);
    const last = await people.http.emp.get('/api/v1/attendance/me/events?page=100000');
    expect(last.status).toBe(200);
    expect(last.body.items).toEqual([]);
    expect((await people.http.hr.get('/api/v1/approvals?page=100001')).status).toBe(400);
  });
});

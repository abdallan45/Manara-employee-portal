import type { INestApplication } from '@nestjs/common';
import { dateOnly } from '../src/common/time';
import { yearlyAccrual } from '../src/modules/requests/leave-math';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, DAY, seedPeople, seedRequestCatalog, today } from './request-fixtures';

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
type Balance = { leaveType: { code: string }; accrued: number; balance: number };
const annualOf = (body: Balance[]) => body.find((b) => b.leaveType.code === 'ANNUAL')!;

describe('personal leave entitlements', () => {
  it('a group gets a different yearly amount; an already-open year is corrected in the ledger at once', async () => {
    const { emp, emp2 } = people.users;
    // emp's year is open with the default 14 days; emp2's is not opened yet.
    expect(annualOf((await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`)).body).accrued).toBe(14 * DAY);

    const res = await people.http.hr.post('/api/v1/leave/entitlements').send({
      employeeIds: [emp.employeeId, emp2.employeeId], leaveTypeId: catalog.annual.id, fromYear: year(), annualEntitlementMinutes: 21 * DAY, note: 'Seniority',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, ledgerCorrections: 1 });

    expect(annualOf((await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`)).body)).toMatchObject({ accrued: 21 * DAY, balance: 21 * DAY });
    expect(annualOf((await people.http.emp2.get(`/api/v1/leave/me/balances?year=${year()}`)).body).accrued).toBe(21 * DAY);
    // Others keep the default.
    expect(annualOf((await people.http.opsEmp.get(`/api/v1/leave/me/balances?year=${year()}`)).body).accrued).toBe(14 * DAY);

    const list = await people.http.hr.get(`/api/v1/leave/entitlements?year=${year()}&employeeId=${emp.employeeId}`);
    expect(list.status).toBe(200);
    expect(list.body[0].entitlements.find((e: { leaveTypeId: string }) => e.leaveTypeId === catalog.annual.id)).toMatchObject({
      defaultMinutes: 14 * DAY, effectiveMinutes: 21 * DAY, custom: { fromYear: year(), minutes: 21 * DAY, note: 'Seniority' },
    });
    // Types without a balance (unpaid) are not listed; the previous year still shows the default.
    expect(list.body[0].entitlements.map((e: { leaveTypeId: string }) => e.leaveTypeId)).not.toContain(catalog.unpaid.id);
    const before = await people.http.hr.get(`/api/v1/leave/entitlements?year=${year() - 1}&employeeId=${emp.employeeId}`);
    expect(before.body[0].entitlements.find((e: { leaveTypeId: string }) => e.leaveTypeId === catalog.annual.id)).toMatchObject({ effectiveMinutes: 14 * DAY, custom: null });
  });

  it('keeps the hiring-year proration for someone who joined mid-year', async () => {
    const hire = `${year()}-07-01`;
    await prisma.employee.update({ where: { id: people.users.emp.employeeId }, data: { hireDate: dateOnly.toDb(hire) } });
    await people.http.hr.post('/api/v1/leave/entitlements').send({
      employeeIds: [people.users.emp.employeeId], leaveTypeId: catalog.annual.id, fromYear: year(), annualEntitlementMinutes: 24 * DAY,
    });
    const annual = annualOf((await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`)).body);
    expect(annual.accrued).toBe(yearlyAccrual(24 * DAY, year(), hire));
    expect(annual.accrued).toBeLessThan(13 * DAY);
  });

  it('removing it returns to the default and posts the difference back; updates and removals are audited', async () => {
    const { emp } = people.users;
    await people.http.emp.get(`/api/v1/leave/me/balances?year=${year()}`);
    const body = { employeeIds: [emp.employeeId], leaveTypeId: catalog.annual.id, fromYear: year(), annualEntitlementMinutes: 20 * DAY };
    await people.http.hr.post('/api/v1/leave/entitlements').send(body);
    await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, annualEntitlementMinutes: 18 * DAY });
    expect(annualOf((await people.http.emp.get('/api/v1/leave/me/balances')).body).accrued).toBe(18 * DAY);

    const row = await prisma.leaveEntitlement.findFirstOrThrow({ where: { employeeId: emp.employeeId } });
    expect((await people.http.hr.delete(`/api/v1/leave/entitlements/${row.id}`)).status).toBe(204);
    expect(annualOf((await people.http.emp.get('/api/v1/leave/me/balances')).body).accrued).toBe(14 * DAY);
    expect(await auditActions(row.id)).toEqual(['LEAVE_ENTITLEMENT_SET', 'LEAVE_ENTITLEMENT_SET', 'LEAVE_ENTITLEMENT_DELETE']);

    // A future year's entitlement leaves this year alone.
    await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, fromYear: year() + 1, annualEntitlementMinutes: 30 * DAY });
    expect(annualOf((await people.http.emp.get('/api/v1/leave/me/balances')).body).accrued).toBe(14 * DAY);
  });

  it('is HR only and validates the type and amounts', async () => {
    const body = { employeeIds: [people.users.emp.employeeId], leaveTypeId: catalog.annual.id, fromYear: year(), annualEntitlementMinutes: 20 * DAY };
    expect((await people.http.mgr.post('/api/v1/leave/entitlements').send(body)).status).toBe(403);
    expect((await people.http.emp.post('/api/v1/leave/entitlements').send(body)).status).toBe(403);
    expect((await people.http.mgr.get('/api/v1/leave/entitlements')).status).toBe(403);
    const unpaid = await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, leaveTypeId: catalog.unpaid.id });
    expect(unpaid.status).toBe(400);
    expectErrorEnvelope(unpaid.body, 'VALIDATION_FAILED');
    expect((await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, annualEntitlementMinutes: -5 })).status).toBe(400);
    expect((await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: [] })).status).toBe(400);
    expect((await people.http.hr.post('/api/v1/leave/entitlements').send({ ...body, employeeIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
  });
});

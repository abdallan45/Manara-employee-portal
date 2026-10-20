// Employee page (hub) API: per-employee filters on the Approval Center and overtime candidates, and the
// leave ledger history. Fictional people only.
import type { INestApplication } from '@nestjs/common';
import { addDays, localDateTime } from '../src/common/time';
import { createTestApp, prisma, resetDb } from './helpers';
import { DAY, futureSunday, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents, today } from './request-fixtures';

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
type Item = { kind: string; id: string; employee: { id: string } };
type Entry = { kind: string; minutes: number; note: string | null; period: string | null; leaveTypeId: string; actor: { username: string } | null };

describe('GET /approvals?employeeId=', () => {
  it("returns only that employee's requests, of every kind, within the viewer's scope", async () => {
    const { emp, emp2, opsEmp, hr } = people.users;
    const sun = futureSunday(14);
    const leave = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.unpaid.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Family visit' });
    expect(leave.status).toBe(201);
    const other = await people.http.emp2.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.unpaid.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Family visit' });
    expect(other.status).toBe(201);
    const overtime = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: addDays(today(), 1), minutes: 60, reason: 'Release deadline' });
    expect(overtime.status).toBe(201);
    const day = pastWorkday(1);
    const session = await sessionWithEvents(emp.employeeId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const correction = await people.http.emp.post('/api/v1/corrections/requests').send({
      kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: localDateTime(day, 16 * 60).toISOString(), reason: 'Forgot to check out',
    });
    expect(correction.status).toBe(201);
    await people.http.opsEmp.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.unpaid.id, mode: 'FULL_DAY', startDate: sun, endDate: sun, reason: 'Family visit' });

    const all = await people.http.hr.get('/api/v1/approvals?tab=PENDING');
    expect(all.body.total).toBe(5);

    const mine = await people.http.hr.get(`/api/v1/approvals?tab=PENDING&employeeId=${emp.employeeId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(3);
    expect(mine.body.items.every((i: Item) => i.employee.id === emp.employeeId)).toBe(true);
    expect(mine.body.items.map((i: Item) => i.kind).sort()).toEqual(['CORRECTION', 'LEAVE', 'OVERTIME']);

    const onlyLeave = await people.http.hr.get(`/api/v1/approvals?tab=PENDING&kind=LEAVE&employeeId=${emp.employeeId}`);
    expect(onlyLeave.body.items.map((i: Item) => i.id)).toEqual([leave.body.id]);

    // The department manager keeps their scope: another department's employee shows nothing.
    expect((await people.http.mgr.get(`/api/v1/approvals?tab=PENDING&employeeId=${emp2.employeeId}`)).body.items.map((i: Item) => i.id)).toEqual([other.body.id]);
    expect((await people.http.mgr.get(`/api/v1/approvals?tab=PENDING&employeeId=${opsEmp.employeeId}`)).body.total).toBe(0);
    // Never the viewer's own requests.
    expect((await people.http.hr.get(`/api/v1/approvals?tab=PENDING&employeeId=${hr.employeeId}`)).body.total).toBe(0);

    // Decided tabs filter the same way.
    expect((await people.http.mgr.post(`/api/v1/approvals/leave/${leave.body.id}/approve`).send({})).status).toBe(200);
    const approved = await people.http.hr.get(`/api/v1/approvals?tab=APPROVED&employeeId=${emp.employeeId}`);
    expect(approved.body).toMatchObject({ total: 1, items: [{ id: leave.body.id, status: 'APPROVED' }] });
    expect((await people.http.hr.get(`/api/v1/approvals?tab=APPROVED&employeeId=${emp2.employeeId}`)).body.total).toBe(0);

    expect((await people.http.hr.get('/api/v1/approvals?employeeId=not-a-uuid')).status).toBe(400);
  });
});

describe('GET /overtime/candidates?employeeId=', () => {
  it('lists only that employee, still within scope', async () => {
    const day = pastWorkday(2);
    const { emp, emp2, opsEmp } = people.users;
    await Promise.all([emp, emp2, opsEmp].map((u) => sessionWithEvents(u.employeeId, day, 8 * 60, 18 * 60, 'CLOSED')));

    const both = await people.http.mgr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}`);
    expect(both.body).toHaveLength(2);
    const one = await people.http.mgr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}&employeeId=${emp.employeeId}`);
    expect(one.status).toBe(200);
    expect(one.body.map((c: { employee: { id: string } }) => c.employee.id)).toEqual([emp.employeeId]);
    expect(one.body[0]).toMatchObject({ workDate: day, extraMinutes: 120 });
    expect((await people.http.mgr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}&employeeId=${opsEmp.employeeId}`)).body).toEqual([]);
    expect((await people.http.hr.get(`/api/v1/overtime/candidates?from=${day}&to=${day}&employeeId=${opsEmp.employeeId}`)).body).toHaveLength(1);
  });
});

describe('GET /leave/employees/:id/ledger', () => {
  it('shows accruals, HR adjustments and entitlement corrections with the reason and who posted them', async () => {
    const { emp } = people.users;
    const y = year();
    const adjusted = await people.http.hr.post('/api/v1/leave/adjustments').send({
      employeeId: emp.employeeId, leaveTypeId: catalog.annual.id, year: y, minutes: 2 * DAY, note: 'Opening balance',
    });
    expect(adjusted.status).toBe(201);
    const ent = await people.http.hr.post('/api/v1/leave/entitlements').send({
      employeeIds: [emp.employeeId], leaveTypeId: catalog.annual.id, fromYear: y, annualEntitlementMinutes: 21 * DAY, note: 'Seniority: 5+ years',
    });
    expect(ent.body).toEqual({ updated: 1, ledgerCorrections: 1 });

    const res = await people.http.hr.get(`/api/v1/leave/employees/${emp.employeeId}/ledger?year=${y}`);
    expect(res.status).toBe(200);
    const annual = (res.body as Entry[]).filter((e) => e.leaveTypeId === catalog.annual.id);
    // Newest first: the entitlement correction, the adjustment, then the yearly grant.
    expect(annual.map((e) => e.kind)).toEqual(['ENTITLEMENT_CORRECTION', 'ADJUSTMENT', 'ACCRUAL']);
    expect(annual[0]).toMatchObject({ minutes: 7 * DAY, note: 'Seniority: 5+ years', actor: { username: 'hr' } });
    expect(annual[1]).toMatchObject({ minutes: 2 * DAY, note: 'Opening balance', actor: { username: 'hr' }, year: y });
    expect(annual[2]).toMatchObject({ minutes: 14 * DAY, note: null, period: String(y), actor: null });

    // The balance agrees with the ledger: 14 + 2 + 7 days.
    const balances = await people.http.hr.get(`/api/v1/leave/employees/${emp.employeeId}/balances?year=${y}`);
    expect(balances.body.find((b: { leaveType: { id: string } }) => b.leaveType.id === catalog.annual.id)).toMatchObject({ balance: 23 * DAY, adjusted: 2 * DAY });

    // HR sees sensitive types; the department manager does not.
    expect((res.body as Entry[]).some((e) => e.leaveTypeId === catalog.sick.id)).toBe(true);
    const mgr = await people.http.mgr.get(`/api/v1/leave/employees/${emp.employeeId}/ledger?year=${y}`);
    expect(mgr.status).toBe(200);
    expect((mgr.body as Entry[]).some((e) => e.leaveTypeId === catalog.sick.id)).toBe(false);
    expect((mgr.body as Entry[]).some((e) => e.kind === 'ADJUSTMENT' && e.note === 'Opening balance')).toBe(true);
  });

  it('refuses viewers outside the employee scope', async () => {
    const { emp } = people.users;
    const outside = await people.http.opsMgr.get(`/api/v1/leave/employees/${emp.employeeId}/ledger`);
    expect(outside.status).toBe(404); // same answer as a missing employee
    expect((await people.http.emp2.get(`/api/v1/leave/employees/${emp.employeeId}/ledger`)).status).toBe(403);
    expect((await people.http.hr.get(`/api/v1/leave/employees/${emp.employeeId}/ledger?year=1999`)).status).toBe(400);
  });
});

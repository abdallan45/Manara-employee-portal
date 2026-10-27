// Alternating Saturdays: department / employee groups, the rota start setting, day figures, overtime and leave.
import type { INestApplication } from '@nestjs/common';
import type { DayMetrics } from '@workforce/shared';
import { addDays, weekdayOf } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { DAY, futureSunday, seedPeople, seedRequestCatalog, sessionWithEvents, today } from './request-fixtures';

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

const setStart = (value: string | null) => people.http.admin.patch('/api/v1/settings/attendance.saturdayRotaStart').send({ value });
/** Engineering works group A; emp2 is moved to group B, opsEmp (Operations) has no rota. */
async function groups() {
  await prisma.department.update({ where: { id: people.eng.id }, data: { saturdayGroup: 'A' } });
  await prisma.employee.update({ where: { id: people.users.emp2.employeeId }, data: { saturdayGroup: 'B' } });
}
/** The Saturday on or before a date. */
const saturdayOnOrBefore = (date: string) => addDays(date, -((weekdayOf(date) + 1) % 7));

describe('Saturday rota setup', () => {
  it('departments take a group A, B or none (departments.manage)', async () => {
    const created = await people.http.admin.post('/api/v1/departments').send({ code: 'SALES', name: 'Sales', saturdayGroup: 'B' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'SALES', saturdayGroup: 'B' });
    const plain = await people.http.admin.post('/api/v1/departments').send({ code: 'LEGAL', name: 'Legal' });
    expect(plain.body.saturdayGroup).toBeNull();

    const bad = await people.http.admin.patch(`/api/v1/departments/${created.body.id}`).send({ saturdayGroup: 'C' });
    expect(bad.status).toBe(400);
    expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
    expect((await people.http.admin.patch(`/api/v1/departments/${created.body.id}`).send({ saturdayGroup: 'A' })).body.saturdayGroup).toBe('A');
    expect((await people.http.admin.patch(`/api/v1/departments/${created.body.id}`).send({ name: 'Sales team' })).body.saturdayGroup).toBe('A');
    expect((await people.http.admin.patch(`/api/v1/departments/${created.body.id}`).send({ saturdayGroup: null })).body.saturdayGroup).toBeNull();
    expect((await people.http.emp.patch(`/api/v1/departments/${created.body.id}`).send({ saturdayGroup: 'A' })).status).toBe(403);
    const listed = await people.http.admin.get('/api/v1/departments');
    expect(listed.body.find((d: { code: string }) => d.code === 'ENG')).toMatchObject({ saturdayGroup: null });
  });

  it('employees inherit the department group, can have their own or opt out (NONE)', async () => {
    await prisma.department.update({ where: { id: people.eng.id }, data: { saturdayGroup: 'A' } });
    const id = people.users.emp.employeeId;
    const inherited = await people.http.hr.get(`/api/v1/employees/${id}`);
    expect(inherited.body).toMatchObject({ saturdayGroup: null, effectiveSaturdayGroup: 'A' });

    const own = await people.http.hr.patch(`/api/v1/employees/${id}`).send({ saturdayGroup: 'B' });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ saturdayGroup: 'B', effectiveSaturdayGroup: 'B' });
    const out = await people.http.hr.patch(`/api/v1/employees/${id}`).send({ saturdayGroup: 'NONE' });
    expect(out.body).toMatchObject({ saturdayGroup: 'NONE', effectiveSaturdayGroup: null });
    const back = await people.http.hr.patch(`/api/v1/employees/${id}`).send({ saturdayGroup: null });
    expect(back.body).toMatchObject({ saturdayGroup: null, effectiveSaturdayGroup: 'A' });

    const bad = await people.http.hr.patch(`/api/v1/employees/${id}`).send({ saturdayGroup: 'C' });
    expect(bad.status).toBe(400);
    expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
    expect((await people.http.emp.patch(`/api/v1/employees/${id}`).send({ saturdayGroup: 'A' })).status).toBe(403);

    const created = await people.http.hr.post('/api/v1/employees').send({
      employeeCode: 'T-SAT', fullName: 'Test Saturday', departmentId: people.eng.id, saturdayGroup: 'NONE', username: 'sat.user', password: 'a-long-password-1',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ saturdayGroup: 'NONE', effectiveSaturdayGroup: null });
  });

  it('the rota start must be null or a Saturday', async () => {
    for (const value of ['2026-10-30', '2026-02-30', '31/10/2026', 20261031, true]) {
      const res = await setStart(value as string);
      expect({ value, status: res.status }).toEqual({ value, status: 400 });
      expectErrorEnvelope(res.body, 'VALIDATION_FAILED');
    }
    expect((await people.http.admin.patch('/api/v1/settings/attendance.saturdayRotaStart').send({})).status).toBe(400);
    const ok = await setStart('2026-10-31');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ key: 'attendance.saturdayRotaStart', value: '2026-10-31' });
    expect((await setStart(null)).body.value).toBeNull();
    expect((await people.http.emp.patch('/api/v1/settings/attendance.saturdayRotaStart').send({ value: '2026-10-31' })).status).toBe(403);
    const list = await people.http.admin.get('/api/v1/settings');
    expect(list.body.find((s: { key: string }) => s.key === 'attendance.saturdayRotaStart')).toMatchObject({ value: null });
  });
});

describe('Saturday rota days', () => {
  it('alternates working Saturdays between groups A and B from the start date', async () => {
    await groups();
    await setStart('2026-10-31');
    const days = async (who: 'emp' | 'emp2' | 'opsEmp') => {
      const res = await people.http[who].get('/api/v1/attendance/me/days?from=2026-10-24&to=2026-11-14');
      expect(res.status).toBe(200);
      const list = res.body as DayMetrics[];
      return (date: string) => list.find((d) => d.workDate === date)!;
    };
    const a = await days('emp');
    const b = await days('emp2');
    const none = await days('opsEmp');
    const working = { saturdayRota: 'WORKING', requiredMinutes: DAY, scheduled: expect.objectContaining({ isWorkday: true, start: '08:00', end: '17:00' }) };
    const off = { saturdayRota: 'OFF', requiredMinutes: 0, missingMinutes: 0, extraMinutes: 0, status: 'NOT_SCHEDULED', scheduled: expect.objectContaining({ isWorkday: false }) };
    expect(a('2026-10-31')).toMatchObject(working);
    expect(a('2026-11-07')).toMatchObject(off);
    expect(a('2026-11-14')).toMatchObject(working);
    expect(b('2026-10-31')).toMatchObject(off);
    expect(b('2026-11-07')).toMatchObject(working);
    expect(b('2026-11-14')).toMatchObject(off);
    for (const d of ['2026-10-31', '2026-11-07', '2026-11-14']) {
      expect(none(d)).toMatchObject({ saturdayRota: null, requiredMinutes: 0, scheduled: expect.objectContaining({ isWorkday: false }) });
    }
    // Before the start date Saturday follows the schedule; Fridays and Sundays are untouched.
    expect(a('2026-10-24')).toMatchObject({ saturdayRota: null, requiredMinutes: 0 });
    expect(a('2026-11-06')).toMatchObject({ saturdayRota: null, requiredMinutes: 0 });
    expect(a('2026-11-08')).toMatchObject({ saturdayRota: null, requiredMinutes: DAY });

    // The employee's schedule view tells the group and the next working Saturday.
    const current = await people.http.emp2.get(`/api/v1/schedules/employees/${people.users.emp2.employeeId}/current?date=2026-11-01`);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ saturdayGroup: 'B', saturdayRotaStart: '2026-10-31', nextWorkingSaturday: '2026-11-07' });
  });

  it('a past Saturday off is not absence and gives no extra time or overtime; the working group is absent if missing', async () => {
    await groups();
    const sat = saturdayOnOrBefore(addDays(today(), -7));
    await setStart(sat); // group A works `sat`, group B is off
    const { emp, emp2, opsEmp } = people.users;
    await Promise.all([emp, emp2].map((u) => sessionWithEvents(u.employeeId, sat, 8 * 60, 18 * 60, 'CLOSED')));

    const dayOf = async (who: 'emp' | 'emp2' | 'opsEmp') => (await people.http[who].get(`/api/v1/attendance/me/days?from=${sat}&to=${sat}`)).body[0] as DayMetrics;
    expect(await dayOf('emp')).toMatchObject({ saturdayRota: 'WORKING', status: 'CHECKED_OUT', requiredMinutes: DAY, netWorkMinutes: 600, extraMinutes: 120 });
    expect(await dayOf('emp2')).toMatchObject({ saturdayRota: 'OFF', status: 'CHECKED_OUT', requiredMinutes: 0, netWorkMinutes: 600, extraMinutes: 0, lateMinutes: 0 });
    expect(await dayOf('opsEmp')).toMatchObject({ saturdayRota: null, status: 'NOT_SCHEDULED' });

    // Next Saturday the groups swap: B missing is absent, A missing is not.
    const next = addDays(sat, 7);
    if (next < today()) {
      const a = (await people.http.emp.get(`/api/v1/attendance/me/days?from=${next}&to=${next}`)).body[0];
      const b = (await people.http.emp2.get(`/api/v1/attendance/me/days?from=${next}&to=${next}`)).body[0];
      expect(a).toMatchObject({ saturdayRota: 'OFF', status: 'NOT_SCHEDULED', missingMinutes: 0 });
      expect(b).toMatchObject({ saturdayRota: 'WORKING', status: 'ABSENT', missingMinutes: DAY });
    }

    // Overtime: refused on the Saturday off, an ordinary workday on the working Saturday.
    const refused = await people.http.emp2.post('/api/v1/overtime/requests').send({ workDate: sat, minutes: 60, reason: 'Stock count' });
    expect(refused.status).toBe(409);
    expectErrorEnvelope(refused.body, 'OVERTIME_CONTRACT_DAY');
    const accepted = await people.http.emp.post('/api/v1/overtime/requests').send({ workDate: sat, minutes: 60, reason: 'Stock count' });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ kind: 'REGULAR' });

    const candidates = await people.http.hr.get(`/api/v1/overtime/candidates?from=${sat}&to=${sat}`);
    expect(candidates.status).toBe(200);
    expect(candidates.body.map((c: { employee: { id: string } }) => c.employee.id)).toEqual([emp.employeeId]);
    const direct = await people.http.hr.post('/api/v1/overtime/direct').send({ items: [{ employeeId: emp2.employeeId, workDate: sat, minutes: 60 }] });
    expect(direct.body.results[0]).toMatchObject({ ok: false, error: 'OVERTIME_CONTRACT_DAY' });
    expect(await prisma.overtimeRequest.count({ where: { employeeId: emp2.employeeId } })).toBe(0);

    // Reports: the Saturday off is neither scheduled nor absent and brings no extra time.
    const report = await people.http.hr.get(`/api/v1/reports/attendance?from=${sat}&to=${sat}`);
    const row = (id: string) => report.body.rows.find((r: { employee: { id: string } }) => r.employee.id === id).totals;
    expect(row(emp2.employeeId)).toMatchObject({ scheduledDays: 0, absentDays: 0, extraMinutes: 0, restDaysWorked: 1 });
    expect(row(emp.employeeId)).toMatchObject({ scheduledDays: 1, presentDays: 1, extraMinutes: 120 });
    expect(row(opsEmp.employeeId)).toMatchObject({ scheduledDays: 0, absentDays: 0 });
  });

  it('leave costs a working Saturday like any workday and nothing on a Saturday off', async () => {
    await groups();
    const sun = futureSunday();
    const sat = addDays(sun, 6);
    await setStart(sat); // group A works the Saturday of that week
    const week = { leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: sun, endDate: sat, reason: 'Family visit' };

    const a = await people.http.emp.post('/api/v1/leave/requests/preview').send(week);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ workdays: 6, minutes: 6 * DAY });
    const b = await people.http.emp2.post('/api/v1/leave/requests/preview').send(week);
    expect(b.body).toMatchObject({ workdays: 5, minutes: 5 * DAY });

    const created = await people.http.emp.post('/api/v1/leave/requests').send(week);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ minutes: 6 * DAY });
  });
});

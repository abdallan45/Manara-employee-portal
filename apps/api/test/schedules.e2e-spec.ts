import type { INestApplication } from '@nestjs/common';
import { addDays } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, futureSunday, pastWorkday, seedPeople, today } from './request-fixtures';

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
  people = await seedPeople(app);
});

const SUN_THU = [0, 1, 2, 3, 4];
const fixed = (name: string, start: number, end: number) => ({
  name, type: 'FIXED',
  days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => SUN_THU.includes(weekday)
    ? { weekday, isWorkday: true, startMinute: start, endMinute: end, requiredMinutes: end - start }
    : { weekday, isWorkday: false, requiredMinutes: 0 }),
});

describe('schedule assignments', () => {
  it('department and employee assignments decide the schedule in force; managers see their team only', async () => {
    const early = (await people.http.hr.post('/api/v1/schedules').send(fixed('Early 07:00–15:00', 420, 900))).body;
    const late = (await people.http.hr.post('/api/v1/schedules').send(fixed('Late 10:00–18:00', 600, 1080))).body;
    const from = addDays(today(), -30);
    expect((await people.http.hr.post(`/api/v1/schedules/${early.id}/assignments`).send({ departmentId: people.eng.id, validFrom: from })).status).toBe(201);
    expect((await people.http.hr.post(`/api/v1/schedules/${late.id}/assignments`).send({ employeeId: people.users.emp2.employeeId, validFrom: from })).status).toBe(201);

    const emp = await people.http.mgr.get(`/api/v1/schedules/employees/${people.users.emp.employeeId}/current`);
    expect(emp.status).toBe(200);
    expect(emp.body).toMatchObject({ scheduleId: early.id, scheduleName: 'Early 07:00–15:00', source: 'DEPARTMENT', validTo: null });
    const emp2 = await people.http.hr.get(`/api/v1/schedules/employees/${people.users.emp2.employeeId}/current`);
    expect(emp2.body).toMatchObject({ scheduleId: late.id, source: 'EMPLOYEE' });
    const ops = await people.http.hr.get(`/api/v1/schedules/employees/${people.users.opsEmp.employeeId}/current`);
    expect(ops.body).toMatchObject({ scheduleId: null, source: 'BUILT_IN' });
    // Out of scope answers like a missing employee (no existence oracle).
    expect((await people.http.mgr.get(`/api/v1/schedules/employees/${people.users.opsEmp.employeeId}/current`)).status).toBe(404);
    // Employees may look up their own schedule, nobody else's.
    expect((await people.http.emp.get(`/api/v1/schedules/employees/${people.users.emp.employeeId}/current`)).status).toBe(200);
    expect((await people.http.emp.get(`/api/v1/schedules/employees/${people.users.emp2.employeeId}/current`)).status).toBe(404);

    const all = await people.http.hr.get('/api/v1/schedules/assignments');
    expect(all.status).toBe(200);
    expect(all.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheduleName: 'Early 07:00–15:00', department: { name: 'Engineering', nameAr: null }, employee: null }),
      expect.objectContaining({ scheduleName: 'Late 10:00–18:00', employee: expect.objectContaining({ employeeCode: expect.any(String) }) }),
    ]));
    expect((await people.http.mgr.get('/api/v1/schedules/assignments')).status).toBe(403);

    // The schedule drives the daily figures: 8 h required on a Sun–Thu day of the early schedule.
    const day = pastWorkday(3);
    const days = await people.http.hr.get(`/api/v1/attendance/employees/${people.users.emp.employeeId}/days?from=${day}&to=${day}`);
    expect(days.body[0].scheduled).toMatchObject({ type: 'FIXED', start: '07:00', end: '15:00', requiredMinutes: 480 });
  });

  it('ending an assignment keeps the past; only assignments that have not started can be deleted', async () => {
    const early = (await people.http.hr.post('/api/v1/schedules').send(fixed('Early', 420, 900))).body;
    const current = (await people.http.hr.post(`/api/v1/schedules/${early.id}/assignments`).send({ departmentId: people.eng.id, validFrom: addDays(today(), -10) })).body;
    const yesterday = addDays(today(), -1);

    const ended = await people.http.hr.patch(`/api/v1/schedules/assignments/${current.id}`).send({ validTo: yesterday });
    expect(ended.status).toBe(200);
    expect(ended.body.validTo).toBe(yesterday);
    expect((await people.http.hr.get(`/api/v1/schedules/employees/${people.users.emp.employeeId}/current`)).body.source).toBe('BUILT_IN');
    expect((await people.http.hr.get(`/api/v1/schedules/employees/${people.users.emp.employeeId}/current?date=${yesterday}`)).body.source).toBe('DEPARTMENT');
    expect((await people.http.hr.patch(`/api/v1/schedules/assignments/${current.id}`).send({ validTo: addDays(today(), -20) })).status).toBe(400);

    const inEffect = await people.http.hr.delete(`/api/v1/schedules/assignments/${current.id}`);
    expect(inEffect.status).toBe(409);
    expectErrorEnvelope(inEffect.body, 'CONFLICT');

    const future = (await people.http.hr.post(`/api/v1/schedules/${early.id}/assignments`).send({ departmentId: people.eng.id, validFrom: futureSunday() })).body;
    expect((await people.http.hr.delete(`/api/v1/schedules/assignments/${future.id}`)).status).toBe(204);
    expect(await auditActions(current.id)).toEqual(['SCHEDULE_ASSIGN', 'SCHEDULE_ASSIGNMENT_UPDATE']);
    expect(await auditActions(future.id)).toEqual(['SCHEDULE_ASSIGN', 'SCHEDULE_ASSIGNMENT_DELETE']);
    expect((await people.http.mgr.patch(`/api/v1/schedules/assignments/${current.id}`).send({ validTo: null })).status).toBe(403);
  });
});

describe('holidays', () => {
  it('adds a multi-day holiday in one go, refuses overlaps, renames, and the days stop being required', async () => {
    const from = pastWorkday(5);
    const to = addDays(from, 2);
    const res = await people.http.hr.post('/api/v1/holidays/range').send({ from, to, name: 'Eid al-Fitr', nameAr: 'عيد الفطر' });
    expect(res.status).toBe(201);
    expect(res.body.map((h: { date: string }) => h.date)).toEqual([from, addDays(from, 1), to]);

    const overlap = await people.http.hr.post('/api/v1/holidays/range').send({ from: to, to: addDays(to, 1), name: 'Again' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.details).toEqual({ dates: [to] });
    expect((await people.http.hr.post('/api/v1/holidays/range').send({ from, to: addDays(from, 40), name: 'Too long' })).status).toBe(400);
    expect((await people.http.mgr.post('/api/v1/holidays/range').send({ from: addDays(to, 5), to: addDays(to, 6), name: 'X' })).status).toBe(403);

    const renamed = await people.http.hr.patch(`/api/v1/holidays/${res.body[0].id}`).send({ name: 'Eid al-Fitr (day 1)', isPaid: true });
    expect(renamed.body).toMatchObject({ name: 'Eid al-Fitr (day 1)', nameAr: 'عيد الفطر' });
    expect(await auditActions(res.body[0].id)).toEqual(['HOLIDAY_CREATE', 'HOLIDAY_UPDATE']);

    const days = await people.http.hr.get(`/api/v1/attendance/employees/${people.users.emp.employeeId}/days?from=${from}&to=${from}`);
    expect(days.body[0]).toMatchObject({ requiredMinutes: 0, status: 'NOT_SCHEDULED' });
    expect(days.body[0].scheduled.isWorkday).toBe(false);
  });
});

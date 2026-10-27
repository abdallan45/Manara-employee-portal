import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { localDate } from '../src/common/time';
import { hashPassword } from '../src/modules/auth/password';
import { GeofenceService } from '../src/modules/offices/geofence.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { AT_OFFICE, FAR_AWAY, makeBreakType, makeEmployee, makeOffice, OFFICE } from './attendance-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

const PASSWORD = 'correct-horse-battery-1';
let app: INestApplication;
let passwordHash: string;

beforeAll(async () => {
  app = await createTestApp();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  app.get(GeofenceService).invalidate();
  app.get(SettingsService).invalidate();
});

const http = () => request(app.getHttpServer());

async function login(role: 'EMPLOYEE' | 'HR_ADMIN' = 'EMPLOYEE') {
  const { user, employee } = await makeEmployee({ name: 'Samir Lakeview', role, passwordHash });
  const res = await http().post('/api/v1/auth/login').send({ username: user.username, password: PASSWORD, client: 'MOBILE' });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken as string, employee };
}

const setUpOffice = async () => {
  const office = await makeOffice({ name: 'Amman HQ' });
  app.get(GeofenceService).invalidate();
  return office;
};

describe('attendance over HTTP', () => {
  it('status, check-in, break, check-out at the office (bearer client → MOBILE source)', async () => {
    const office = await setUpOffice();
    const { token, employee } = await login();
    const coffee = await makeBreakType('COFFEE');
    const auth = { Authorization: `Bearer ${token}` };

    const status = await http().get('/api/v1/attendance/me/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'OFF', timezone: 'Asia/Amman', location: { enforcement: 'ENFORCE', maxAccuracyMeters: 150, remote: false } });
    expect(status.body.location.offices).toEqual([{ id: office.id, name: 'Amman HQ', ...OFFICE }]);
    expect(status.body.breakTypes.map((b: { code: string }) => b.code)).toEqual(['COFFEE']);

    const checkIn = await http().post('/api/v1/attendance/me/check-in').set(auth).send({ idempotencyKey: randomUUID(), location: AT_OFFICE });
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.state).toBe('WORKING');
    const breakStart = await http().post('/api/v1/attendance/me/break/start').set(auth).send({ idempotencyKey: randomUUID(), breakTypeId: coffee.id });
    expect(breakStart.body.state).toBe('ON_BREAK');
    const out = await http().post('/api/v1/attendance/me/check-out').set(auth).send({ idempotencyKey: randomUUID(), location: AT_OFFICE });
    expect(out.status).toBe(200);
    expect(out.body.state).toBe('OFF');

    const events = await http().get('/api/v1/attendance/me/events').set(auth);
    expect(events.status).toBe(200);
    expect(events.body.total).toBe(4);
    expect(events.body.items.every((e: { source: string }) => e.source === 'MOBILE')).toBe(true);
    const checkOut = events.body.items.find((e: { type: string }) => e.type === 'CHECK_OUT');
    expect(checkOut).toMatchObject({ locationVerified: true, latitude: AT_OFFICE.latitude, longitude: AT_OFFICE.longitude, accuracyMeters: 10, distanceMeters: 0, officeName: 'Amman HQ' });
    expect(await prisma.attendanceEvent.count({ where: { employeeId: employee.id } })).toBe(4);

    const days = await http().get('/api/v1/attendance/me/days').set(auth);
    expect(days.status).toBe(200);
    expect(days.body[days.body.length - 1].status).toBe('CHECKED_OUT');
  });

  it('403 LOCATION_* when not at the office or no office is set up, 400 on a bad idempotency key', async () => {
    const { token } = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const checkIn = (body: object) => http().post('/api/v1/attendance/me/check-in').set(auth).send({ idempotencyKey: randomUUID(), ...body });
    const notConfigured = await checkIn({ location: AT_OFFICE });
    expect(notConfigured.status).toBe(403);
    expect(notConfigured.body.error.code).toBe('LOCATION_NOT_CONFIGURED');

    await setUpOffice();
    const denied = await checkIn({ location: FAR_AWAY });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('LOCATION_OUTSIDE_OFFICE');
    expect(denied.body.error.details).toMatchObject({ radiusMeters: 150, officeName: 'Amman HQ', accuracyMeters: 10, maxAccuracyMeters: 150 });
    expect((await checkIn({})).body.error.code).toBe('LOCATION_REQUIRED');
    expect((await checkIn({ location: { ...AT_OFFICE, accuracy: 500 } })).body.error.code).toBe('LOCATION_INACCURATE');
    expect(await prisma.auditLog.count({ where: { action: 'ATTENDANCE_DENIED_LOCATION' } })).toBe(4);

    const bad = await http().post('/api/v1/attendance/me/check-in').set(auth).send({ idempotencyKey: 'nope', location: AT_OFFICE });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('400 on malformed location bodies', async () => {
    await setUpOffice();
    const { token, employee } = await login();
    const auth = { Authorization: `Bearer ${token}` };
    for (const location of [
      { ...AT_OFFICE, latitude: 91 },
      { ...AT_OFFICE, longitude: -181 },
      { ...AT_OFFICE, accuracy: -1 },
      { ...AT_OFFICE, latitude: '31.9539' },
      { ...AT_OFFICE, accuracy: 'precise' },
      { latitude: AT_OFFICE.latitude, longitude: AT_OFFICE.longitude },
      'here',
    ]) {
      const res = await http().post('/api/v1/attendance/me/check-in').set(auth).send({ idempotencyKey: randomUUID(), location });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await prisma.attendanceEvent.count({ where: { employeeId: employee.id } })).toBe(0);
  });

  it('an employee cannot read the dashboard or other employees; HR can', async () => {
    const { token } = await login();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await http().get('/api/v1/dashboard/summary').set(auth)).status).toBe(403);
    expect((await http().get('/api/v1/dashboard/live').set(auth)).status).toBe(403);
    expect((await http().post('/api/v1/offices').set(auth).send({ name: 'x', ...OFFICE })).status).toBe(403);

    const hr = await login('HR_ADMIN');
    const hrAuth = { Authorization: `Bearer ${hr.token}` };
    const summary = await http().get('/api/v1/dashboard/summary?date=2026-10-12').set(hrAuth);
    expect(summary.status).toBe(200);
    expect(summary.body.kpis.totalEmployees).toBe(2);
    const live = await http().get('/api/v1/dashboard/live?sort=name&order=desc&page=1&pageSize=1').set(hrAuth);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect((await http().get('/api/v1/dashboard/live?sort=salary').set(hrAuth)).status).toBe(400);

    expect((await http().get(`/api/v1/attendance/employees/${hr.employee.id}/days`).set(auth)).status).toBe(403);
    const hrView = await http().get(`/api/v1/attendance/employees/${hr.employee.id}/days?from=2026-10-01&to=2026-10-07`).set(hrAuth);
    expect(hrView.status).toBe(200);
    expect(hrView.body).toHaveLength(7);
  });

  it('notifications endpoints for the current user', async () => {
    const { token, employee } = await login();
    const auth = { Authorization: `Bearer ${token}` };
    const user = await prisma.user.findFirstOrThrow({ where: { employeeId: employee.id } });
    await prisma.notification.createMany({ data: [
      { userId: user.id, type: 'ATTENDANCE_BREAK_OVERDUE', title: 'A', body: 'a' },
      { userId: user.id, type: 'ATTENDANCE_BREAK_OVERDUE', title: 'B', body: 'b' },
    ] });
    expect((await http().get('/api/v1/notifications/unread-count').set(auth)).body).toEqual({ count: 2 });
    const list = await http().get('/api/v1/notifications?unread=true').set(auth);
    expect(list.body.total).toBe(2);
    const read = await http().post(`/api/v1/notifications/${list.body.items[0].id}/read`).set(auth);
    expect(read.status).toBe(200);
    expect(read.body.readAt).not.toBeNull();
    expect((await http().post('/api/v1/notifications/read-all').set(auth)).body).toEqual({ updated: 1 });
    expect((await http().get('/api/v1/notifications/unread-count').set(auth)).body).toEqual({ count: 0 });
  });

  it('daily hours: 9 h incl. 1 h break by default, employee override, company rule', async () => {
    const admin = await makeEmployee({ name: 'Hala Root', role: 'SUPER_ADMIN', passwordHash });
    const res = await http().post('/api/v1/auth/login').send({ username: admin.user.username, password: PASSWORD, client: 'MOBILE' });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    // Every day a workday, so "today" is scheduled whatever the date; the schedule's own hours are ignored.
    await prisma.workSchedule.create({
      data: {
        name: 'Every day', type: 'FIXED', isDefault: true, weeklyRequiredMinutes: 0, includedBreakMinutes: 0,
        days: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isWorkday: true, startMinute: 0, endMinute: 1439, requiredMinutes: 300 })) },
      },
    });
    const today = async () => (await http().get('/api/v1/attendance/me/status').set(auth)).body.today;

    expect(await today()).toMatchObject({ requiredMinutes: 540, includedBreakMinutes: 60, breakAllowanceLeftMinutes: 60, scheduled: { requiredMinutes: 540 } });

    const effectiveFrom = localDate(new Date());
    expect((await http().post('/api/v1/settings/work-hours').set(auth).send({ effectiveFrom, dailyRequiredMinutes: 20, includedBreakMinutes: 0 })).status).toBe(400);
    expect((await http().post('/api/v1/settings/work-hours').set(auth).send({ effectiveFrom, dailyRequiredMinutes: 600, includedBreakMinutes: 45 })).status).toBe(201);
    expect(await today()).toMatchObject({ requiredMinutes: 600, includedBreakMinutes: 45, breakAllowanceLeftMinutes: 45 });

    await prisma.employee.update({ where: { id: admin.employee.id }, data: { dailyRequiredMinutes: 480, includedBreakMinutes: 30 } });
    expect(await today()).toMatchObject({ requiredMinutes: 480, includedBreakMinutes: 30, breakAllowanceLeftMinutes: 30 });
    await prisma.employee.update({ where: { id: admin.employee.id }, data: { dailyRequiredMinutes: 420, includedBreakMinutes: null } });
    expect(await today()).toMatchObject({ requiredMinutes: 420, includedBreakMinutes: 45 });
  });

  it('manages offices, schedules and holidays with validation and audit', async () => {
    const admin = await makeEmployee({ name: 'Hala Root', role: 'SUPER_ADMIN', passwordHash });
    const res = await http().post('/api/v1/auth/login').send({ username: admin.user.username, password: PASSWORD, client: 'MOBILE' });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };

    expect((await http().post('/api/v1/offices').set(auth).send({ name: 'Bad', ...OFFICE, latitude: 95 })).status).toBe(400);
    const office = await http().post('/api/v1/offices').set(auth).send({ name: 'HQ', ...OFFICE });
    expect(office.status).toBe(201);
    expect(office.body).toMatchObject({ name: 'HQ', ...OFFICE, isActive: true });
    const status = await http().get('/api/v1/attendance/me/status').set(auth);
    expect(status.body.location.offices.map((o: { id: string }) => o.id)).toEqual([office.body.id]);

    const schedule = await http().post('/api/v1/schedules').set(auth).send({
      name: 'Flex core', type: 'FLEXIBLE', coreStartMinute: 600, coreEndMinute: 840, isDefault: true,
      days: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, isWorkday: true, requiredMinutes: 480 })),
    });
    expect(schedule.status).toBe(201);
    expect(schedule.body).toMatchObject({ weeklyRequiredMinutes: 2400, isDefault: true });
    expect(schedule.body.days).toHaveLength(7);
    const patched = await http().patch(`/api/v1/schedules/${schedule.body.id}`).set(auth).send({ graceMinutes: 5 });
    expect(patched.body.graceMinutes).toBe(5);
    const assign = await http().post(`/api/v1/schedules/${schedule.body.id}/assignments`).set(auth)
      .send({ employeeId: admin.employee.id, validFrom: '2026-10-01', validTo: '2026-09-01' });
    expect(assign.status).toBe(400);

    const holiday = await http().post('/api/v1/holidays').set(auth).send({ date: '2026-12-25', name: 'Winter Day' });
    expect(holiday.status).toBe(201);
    expect((await http().post('/api/v1/holidays').set(auth).send({ date: '2026-12-25', name: 'Again' })).status).toBe(409);
    expect((await http().get('/api/v1/holidays?year=2026').set(auth)).body).toHaveLength(1);
    expect((await http().delete(`/api/v1/holidays/${holiday.body.id}`).set(auth)).status).toBe(200);

    const actions = (await prisma.auditLog.findMany({ orderBy: { seq: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['OFFICE_CREATE', 'SCHEDULE_CREATE', 'SCHEDULE_UPDATE', 'HOLIDAY_CREATE', 'HOLIDAY_DELETE']));
  });
});

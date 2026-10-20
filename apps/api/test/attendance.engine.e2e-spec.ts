import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { localDateTime } from '../src/common/time';
import { AttendanceService } from '../src/modules/attendance/attendance.service';
import { DashboardService } from '../src/modules/dashboard/dashboard.service';
import { AttendanceAlertsJob } from '../src/modules/notifications/attendance-alerts.job';
import { GeofenceService } from '../src/modules/offices/geofence.service';
import { ScheduleResolver } from '../src/modules/schedules/schedule-resolver';
import { SettingsService } from '../src/modules/settings/settings.service';
import { AT_OFFICE, authUser, FAR_AWAY, makeBreakType, makeDepartment, makeEmployee, makeOffice, makeSession, OFFICE } from './attendance-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';

let app: INestApplication;
let attendance: AttendanceService;
let geofence: GeofenceService;
let settings: SettingsService;

beforeAll(async () => {
  app = await createTestApp();
  attendance = app.get(AttendanceService);
  geofence = app.get(GeofenceService);
  settings = app.get(SettingsService);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await makeOffice({ name: 'Office' });
  geofence.invalidate();
  settings.invalidate();
});

const key = () => randomUUID();
const counts = async (employeeId: string) => ({
  events: await prisma.attendanceEvent.count({ where: { employeeId } }),
  sessions: await prisma.workSession.count({ where: { employeeId } }),
  breaks: await prisma.breakSession.count({ where: { employeeId } }),
});

async function employeeFixture() {
  const { employee, user } = await makeEmployee({ name: 'Rami Testwood' });
  return { employee, user, me: authUser(user, employee.id) };
}

describe('attendance state machine', () => {
  it('runs the full OFF → WORKING → ON_BREAK → WORKING → OFF flow with audit entries', async () => {
    const { employee, me } = await employeeFixture();
    const coffee = await makeBreakType('COFFEE', { isPaid: true, maxMinutes: 15 });

    let s = await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    expect(s.state).toBe('WORKING');
    expect(s.openSession).not.toBeNull();
    expect(s.location).toMatchObject({ enforcement: 'ENFORCE', maxAccuracyMeters: 150, remote: false });
    expect(s.location.offices).toEqual([{ id: expect.any(String), name: 'Office', ...OFFICE }]);
    s = await attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: coffee.id });
    expect(s.state).toBe('ON_BREAK');
    expect(s.openBreak?.breakType.code).toBe('COFFEE');
    s = await attendance.perform(me, { action: 'BREAK_END', idempotencyKey: key() });
    expect(s.state).toBe('WORKING');
    s = await attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: AT_OFFICE });
    expect(s.state).toBe('OFF');
    expect(s.today.status).toBe('CHECKED_OUT');

    expect(await counts(employee.id)).toEqual({ events: 4, sessions: 1, breaks: 1 });
    const session = await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(session.status).toBe('CLOSED');
    expect(session.locationVerified).toBe(true);
    const events = await prisma.attendanceEvent.findMany({ where: { employeeId: employee.id }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT']);
    expect(session.startedAt).toEqual(events[0].occurredAt);
    expect(session.endedAt).toEqual(events[3].occurredAt);
    expect(events.every((e) => e.source === 'WEB' && e.workSessionId === session.id)).toBe(true);
    const office = await prisma.location.findFirstOrThrow();
    for (const e of [events[0], events[3]]) {
      expect(e).toMatchObject({ locationVerified: true, latitude: AT_OFFICE.latitude, longitude: AT_OFFICE.longitude, accuracyMeters: 10, distanceMeters: 0, officeId: office.id });
      expect(e.metadata).toEqual({});
    }
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: 'ATTENDANCE_' } }, orderBy: { seq: 'asc' } });
    expect(audits.map((a) => a.action)).toEqual(['ATTENDANCE_CHECK_IN', 'ATTENDANCE_BREAK_START', 'ATTENDANCE_BREAK_END', 'ATTENDANCE_CHECK_OUT']);
  });

  it('rejects every invalid transition with 409 ATTENDANCE_INVALID_TRANSITION and the current state', async () => {
    const { employee, me } = await employeeFixture();
    const bt = await makeBreakType('LUNCH');
    const expectInvalid = async (action: 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_START' | 'BREAK_END', state: string) => {
      await expect(attendance.perform(me, { action, idempotencyKey: key(), breakTypeId: bt.id, location: AT_OFFICE }))
        .rejects.toMatchObject({ code: 'ATTENDANCE_INVALID_TRANSITION', status: 409, details: expect.objectContaining({ state, action }) });
    };
    await expectInvalid('CHECK_OUT', 'OFF');
    await expectInvalid('BREAK_START', 'OFF');
    await expectInvalid('BREAK_END', 'OFF');
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    await expectInvalid('CHECK_IN', 'WORKING');
    await expectInvalid('BREAK_END', 'WORKING');
    await attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: bt.id });
    await expectInvalid('CHECK_IN', 'ON_BREAK');
    await expectInvalid('BREAK_START', 'ON_BREAK');
    expect(await counts(employee.id)).toEqual({ events: 2, sessions: 1, breaks: 1 });
  });

  it('rejects inactive break types and users without an employee record', async () => {
    const { me } = await employeeFixture();
    const old = await makeBreakType('OLD', { isActive: false });
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    await expect(attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: old.id }))
      .rejects.toMatchObject({ code: 'BREAK_TYPE_INACTIVE' });
    await expect(attendance.perform({ ...me, employeeId: null }, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE }))
      .rejects.toMatchObject({ code: 'NOT_AN_EMPLOYEE', status: 403 });
  });

  it('replays an idempotency key without new rows and rejects reuse for another action', async () => {
    const { employee, me } = await employeeFixture();
    const k = key();
    const first = await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: k, location: AT_OFFICE });
    const again = await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: k, location: AT_OFFICE });
    expect(again.state).toBe('WORKING');
    expect(again.openSession?.id).toBe(first.openSession?.id);
    expect(await counts(employee.id)).toEqual({ events: 1, sessions: 1, breaks: 0 });
    const auditsBefore = await prisma.auditLog.count();
    await expect(attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: k, location: AT_OFFICE }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    expect(await counts(employee.id)).toEqual({ events: 1, sessions: 1, breaks: 0 });
    expect(await prisma.auditLog.count()).toBe(auditsBefore);
  });

  it('serialises 5 concurrent CHECK_INs: exactly one session and one event', async () => {
    const { employee, me } = await employeeFixture();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      expect(r.reason).toMatchObject({ code: 'ATTENDANCE_INVALID_TRANSITION' });
    }
    expect(await counts(employee.id)).toEqual({ events: 1, sessions: 1, breaks: 0 });
  });

  it('ENFORCE: denies a check-in from outside the office, writes only the audit entry', async () => {
    const { employee, me } = await employeeFixture();
    await expect(attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: FAR_AWAY }))
      .rejects.toMatchObject({
        code: 'LOCATION_OUTSIDE_OFFICE', status: 403,
        details: { distanceMeters: expect.any(Number), radiusMeters: 150, officeName: 'Office', accuracyMeters: 10, maxAccuracyMeters: 150 },
      });
    expect(await counts(employee.id)).toEqual({ events: 0, sessions: 0, breaks: 0 });
    const audits = await prisma.auditLog.findMany();
    expect(audits.map((a) => a.action)).toEqual(['ATTENDANCE_DENIED_LOCATION']);
    expect(audits[0].ipAddress).toBe('10.1.2.3');
    expect(audits[0].after).toMatchObject({ action: 'CHECK_IN', problem: 'LOCATION_OUTSIDE_OFFICE', location: FAR_AWAY, officeName: 'Office' });
    const distance = (audits[0].after as { distanceMeters: number }).distanceMeters;
    expect(distance).toBeGreaterThan(4900);
    expect(distance).toBeLessThan(5100);
  });

  it('ENFORCE: requires a location, refuses an imprecise one, and refuses everything when no office is set up', async () => {
    const { employee, me } = await employeeFixture();
    await expect(attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'LOCATION_REQUIRED', status: 403, details: { distanceMeters: null, officeName: null, accuracyMeters: null } });
    await expect(attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: { ...AT_OFFICE, accuracy: 151 } }))
      .rejects.toMatchObject({ code: 'LOCATION_INACCURATE', status: 403, details: { accuracyMeters: 151, maxAccuracyMeters: 150, officeName: 'Office' } });

    await prisma.systemSetting.create({ data: { key: 'attendance.maxLocationAccuracyMeters', value: 200 } });
    settings.invalidate();
    expect((await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: { ...AT_OFFICE, accuracy: 151 } })).state).toBe('WORKING');

    await prisma.location.updateMany({ data: { isActive: false } });
    geofence.invalidate();
    await expect(attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: AT_OFFICE }))
      .rejects.toMatchObject({ code: 'LOCATION_NOT_CONFIGURED', status: 403 });
    expect(await counts(employee.id)).toEqual({ events: 1, sessions: 1, breaks: 0 });
    const denied = await prisma.auditLog.findMany({ where: { action: 'ATTENDANCE_DENIED_LOCATION' }, orderBy: { seq: 'asc' } });
    expect(denied.map((a) => (a.after as { problem: string }).problem)).toEqual(['LOCATION_REQUIRED', 'LOCATION_INACCURATE', 'LOCATION_NOT_CONFIGURED']);
  });

  it('ENFORCE: a check-out from outside the office is denied and the session stays open; breaks need no location', async () => {
    const { employee, me } = await employeeFixture();
    const bt = await makeBreakType('COFFEE');
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    expect((await attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: bt.id })).state).toBe('ON_BREAK');
    expect((await attendance.perform(me, { action: 'BREAK_END', idempotencyKey: key() })).state).toBe('WORKING');
    await expect(attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: FAR_AWAY }))
      .rejects.toMatchObject({ code: 'LOCATION_OUTSIDE_OFFICE', status: 403 });
    await expect(attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'LOCATION_REQUIRED', status: 403 });
    const session = await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(session).toMatchObject({ status: 'OPEN', endedAt: null, locationVerified: true });
    expect(await counts(employee.id)).toEqual({ events: 3, sessions: 1, breaks: 1 });
    expect((await attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: AT_OFFICE })).state).toBe('OFF');
    expect(await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } })).toMatchObject({ status: 'CLOSED', locationVerified: true });
  });

  it('FLAG: accepts check-in and check-out from outside the office and flags the events and session', async () => {
    const { employee, me } = await employeeFixture();
    await prisma.systemSetting.create({ data: { key: 'attendance.locationEnforcement', value: 'FLAG' } });
    settings.invalidate();
    const s = await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: FAR_AWAY });
    expect(s.state).toBe('WORKING');
    expect(s.location).toMatchObject({ enforcement: 'FLAG', remote: false });
    const office = await prisma.location.findFirstOrThrow();
    const ev = await prisma.attendanceEvent.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(ev).toMatchObject({ locationVerified: false, latitude: FAR_AWAY.latitude, longitude: FAR_AWAY.longitude, accuracyMeters: 10, officeId: office.id });
    expect(ev.distanceMeters).toBeGreaterThan(4900);
    expect(ev.metadata).toEqual({ locationProblem: 'LOCATION_OUTSIDE_OFFICE' });
    expect((await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } })).locationVerified).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'ATTENDANCE_DENIED_LOCATION' } })).toBe(0);

    const out = await attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key() });
    expect(out.state).toBe('OFF');
    const checkOut = await prisma.attendanceEvent.findFirstOrThrow({ where: { employeeId: employee.id, type: 'CHECK_OUT' } });
    expect(checkOut).toMatchObject({ locationVerified: false, latitude: null, longitude: null, accuracyMeters: null, distanceMeters: null, officeId: null });
    expect(checkOut.metadata).toEqual({ locationProblem: 'LOCATION_REQUIRED' });
  });

  it('FLAG: a verified check-in followed by an unverified check-out leaves the session unverified', async () => {
    const { employee, me } = await employeeFixture();
    await prisma.systemSetting.create({ data: { key: 'attendance.locationEnforcement', value: 'FLAG' } });
    settings.invalidate();
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    expect((await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } })).locationVerified).toBe(true);
    await attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: FAR_AWAY });
    expect(await prisma.workSession.findFirstOrThrow({ where: { employeeId: employee.id } })).toMatchObject({ status: 'CLOSED', locationVerified: false });
  });

  it('turns a stale open session into MISSING_CHECKOUT on the next CHECK_IN, never inventing time', async () => {
    const { employee, me } = await employeeFixture();
    const bt = await makeBreakType('PRAYER');
    const startedAt = new Date(Date.now() - 20 * 3_600_000);
    const stale = await makeSession(employee.id, '2026-01-01', startedAt, null, 'OPEN');
    const breakStart = new Date(startedAt.getTime() + 3_600_000);
    const openBreak = await prisma.breakSession.create({
      data: { workSessionId: stale.id, employeeId: employee.id, breakTypeId: bt.id, startedAt: breakStart, startEventId: randomUUID() },
    });

    await expect(attendance.perform(me, { action: 'BREAK_END', idempotencyKey: key() }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_INVALID_TRANSITION', details: expect.objectContaining({ reason: 'STALE_SESSION', sessionId: stale.id }) });
    await expect(attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: AT_OFFICE }))
      .rejects.toMatchObject({ code: 'ATTENDANCE_INVALID_TRANSITION', details: expect.objectContaining({ reason: 'STALE_SESSION' }) });

    const s = await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    expect(s.state).toBe('WORKING');
    const old = await prisma.workSession.findUniqueOrThrow({ where: { id: stale.id } });
    expect(old.status).toBe('MISSING_CHECKOUT');
    expect(old.endedAt).toBeNull();
    const closedBreak = await prisma.breakSession.findUniqueOrThrow({ where: { id: openBreak.id } });
    expect(closedBreak.autoClosed).toBe(true);
    expect(closedBreak.endedAt).toEqual(breakStart);
    expect(s.openSession?.id).not.toBe(stale.id);
    expect(await prisma.auditLog.count({ where: { action: 'ATTENDANCE_MISSING_CHECKOUT', entityId: stale.id } })).toBe(1);
  });

  it('CHECK_OUT during a break auto-ends the break at the same instant', async () => {
    const { employee, me } = await employeeFixture();
    const bt = await makeBreakType('LUNCH');
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    await attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: bt.id });
    const s = await attendance.perform(me, { action: 'CHECK_OUT', idempotencyKey: key(), location: AT_OFFICE });
    expect(s.state).toBe('OFF');
    const events = await prisma.attendanceEvent.findMany({ where: { employeeId: employee.id, type: { in: ['BREAK_END', 'CHECK_OUT'] } } });
    const auto = events.find((e) => e.type === 'BREAK_END')!;
    const out = events.find((e) => e.type === 'CHECK_OUT')!;
    expect(auto.metadata).toMatchObject({ auto: true });
    expect(auto.occurredAt).toEqual(out.occurredAt);
    const brk = await prisma.breakSession.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(brk.endedAt).toEqual(out.occurredAt);
    expect(brk.endEventId).toBe(auto.id);
  });

  it('attendance_events is append-only at the database level', async () => {
    const { employee, me } = await employeeFixture();
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    await expect(prisma.$executeRaw`UPDATE attendance_events SET occurred_at = occurred_at - interval '1 hour' WHERE employee_id = ${employee.id}::uuid`)
      .rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM attendance_events WHERE employee_id = ${employee.id}::uuid`).rejects.toThrow();
    expect(await prisma.attendanceEvent.count()).toBe(1);
  });

  it('lists my events and days with break type names', async () => {
    const { me } = await employeeFixture();
    const bt = await makeBreakType('COFFEE');
    await attendance.perform(me, { action: 'CHECK_IN', idempotencyKey: key(), location: AT_OFFICE });
    await attendance.perform(me, { action: 'BREAK_START', idempotencyKey: key(), breakTypeId: bt.id });
    const page = await attendance.events(me.employeeId!, { pageSize: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: 'BREAK_START', breakTypeName: 'Coffee', ipAddress: '10.1.2.3' });
    const checkIn = (await attendance.events(me.employeeId!, {})).items.find((e) => e.type === 'CHECK_IN');
    expect(checkIn).toMatchObject({
      locationVerified: true, latitude: AT_OFFICE.latitude, longitude: AT_OFFICE.longitude, accuracyMeters: 10, distanceMeters: 0, officeName: 'Office',
    });
    await expect(attendance.days(me.employeeId!, '2026-01-01', '2026-06-01')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('geofence verification', () => {
  it('prefers an office the device is inside over a nearer one, and ignores inactive offices and offices without coordinates', async () => {
    // 'Office' has a 150 m radius; 'Campus' is about 1.1 km east with a 1.5 km radius; 'Closed' is about 570 m west.
    await makeOffice({ name: 'Campus', longitude: OFFICE.longitude + 0.0117, radiusMeters: 1500 });
    await makeOffice({ name: 'Closed', longitude: OFFICE.longitude - 0.006, radiusMeters: 300, isActive: false });
    await makeOffice({ name: 'Unmapped', latitude: null, longitude: null });
    geofence.invalidate();
    expect((await geofence.offices()).map((o) => o.name)).toEqual(['Office', 'Campus']);

    const at = (dLon: number, accuracy = 10) => ({ latitude: OFFICE.latitude, longitude: OFFICE.longitude + dLon, accuracy });
    // About 300 m east: nearest to 'Office' but outside its radius, inside 'Campus'.
    const east = await geofence.verify(at(0.0032), 150);
    expect(east).toMatchObject({ verified: true, problem: null, office: { name: 'Campus' } });
    expect(east.distance).toBeGreaterThan(750);
    expect(await geofence.verify(at(0), 150)).toMatchObject({ verified: true, office: { name: 'Office' }, distance: 0 });
    expect(await geofence.verify(at(-0.006), 150)).toMatchObject({ verified: false, problem: 'LOCATION_OUTSIDE_OFFICE', office: { name: 'Office' } });
    expect(await geofence.verify(at(0, 200), 150)).toMatchObject({ verified: false, problem: 'LOCATION_INACCURATE', office: { name: 'Office' } });
    expect(await geofence.verify(null, 150)).toMatchObject({ verified: false, problem: 'LOCATION_REQUIRED', office: null, distance: null });

    await prisma.location.deleteMany();
    expect(await geofence.offices()).toHaveLength(2);
    geofence.invalidate();
    expect(await geofence.verify(AT_OFFICE, 150)).toMatchObject({ verified: false, problem: 'LOCATION_NOT_CONFIGURED' });
  });
});

describe('schedule resolution', () => {
  it('employee assignment > department assignment > default schedule > built-in', async () => {
    const resolver = app.get(ScheduleResolver);
    const dept = await makeDepartment('Ops');
    const { employee } = await makeEmployee({ name: 'Lina Fieldstone', departmentId: dept.id });
    const day = (n: number) => ({ weekday: n, isWorkday: n <= 4, startMinute: n <= 4 ? 540 : null, endMinute: n <= 4 ? 1020 : null, requiredMinutes: n <= 4 ? 480 : 0 });
    const mk = (name: string, isDefault = false) => prisma.workSchedule.create({
      data: { name, type: 'FIXED', weeklyRequiredMinutes: 2400, isDefault, days: { create: [0, 1, 2, 3, 4, 5, 6].map(day) } },
    });
    const date = '2026-10-15';
    expect((await resolver.resolve(employee.id, dept.id, date)).source).toBe('BUILT_IN');
    const def = await mk('Default', true);
    expect((await resolver.resolve(employee.id, dept.id, date)).rule.scheduleId).toBe(def.id);
    const deptSchedule = await mk('Dept');
    await prisma.scheduleAssignment.create({ data: { scheduleId: deptSchedule.id, departmentId: dept.id, validFrom: new Date('2026-01-01') } });
    expect((await resolver.resolve(employee.id, dept.id, date)).rule.scheduleId).toBe(deptSchedule.id);
    const own = await mk('Own');
    await prisma.scheduleAssignment.create({ data: { scheduleId: own.id, employeeId: employee.id, validFrom: new Date('2026-10-01'), validTo: new Date('2026-10-31') } });
    const r = await resolver.resolve(employee.id, dept.id, date);
    expect(r).toMatchObject({ source: 'EMPLOYEE', isHoliday: false });
    expect(r.rule.scheduleId).toBe(own.id);
    expect((await resolver.resolve(employee.id, dept.id, '2026-11-02')).source).toBe('DEPARTMENT');
    await prisma.holiday.create({ data: { date: new Date('2026-10-15'), name: 'Founders Day' } });
    expect(await resolver.resolve(employee.id, dept.id, date)).toMatchObject({ isHoliday: true, holidayName: 'Founders Day' });
  });
});

describe('dashboard', () => {
  it('summarises a small fixture and respects department scope', async () => {
    const dashboard = app.get(DashboardService);
    const ops = await makeDepartment('Ops');
    const sales = await makeDepartment('Sales');
    const date = '2026-10-12'; // Monday, a workday on the built-in Sun–Thu schedule
    const at = (hh: number, mm = 0) => localDateTime(date, hh * 60 + mm);
    const a = await makeEmployee({ name: 'Aya Northfield', departmentId: ops.id });
    const b = await makeEmployee({ name: 'Basil Quarry', departmentId: ops.id });
    await makeEmployee({ name: 'Celine Marsh', departmentId: sales.id });
    const d = await makeEmployee({ name: 'Dorian Vale', departmentId: sales.id });
    await makeSession(a.employee.id, date, at(8), at(16, 30), 'CLOSED');
    await makeSession(b.employee.id, date, at(8, 30), at(16), 'CLOSED');
    await makeSession(d.employee.id, date, at(7, 55), null, 'MISSING_CHECKOUT');
    const admin = await makeEmployee({ name: 'Hana Admin', role: 'SUPER_ADMIN' });
    await prisma.employee.update({ where: { id: admin.employee.id }, data: { isActive: false } });

    const summary = await dashboard.summary(authUser(admin.user, null, { role: 'SUPER_ADMIN' }), date);
    expect(summary.kpis).toEqual({
      totalEmployees: 4, currentlyWorking: 0, onBreak: 0, checkedOut: 2, absent: 1, onLeave: 0, late: 1, missingCheckouts: 1,
      totalWorkMinutes: 510 + 450, extraMinutes: 30, attendanceRate: 0.75,
    });
    expect(summary.trend).toHaveLength(14);
    expect(summary.trend[13]).toEqual({ date, present: 3, scheduled: 4, late: 1, workMinutes: 960 });
    expect(summary.departments).toEqual([
      { departmentId: ops.id, name: 'Ops', nameAr: null, present: 2, scheduled: 2, workMinutes: 960 },
      { departmentId: sales.id, name: 'Sales', nameAr: null, present: 1, scheduled: 2, workMinutes: 0 },
    ]);

    const manager = await makeEmployee({ name: 'Omar Keystone', role: 'DEPARTMENT_MANAGER', managedDepartmentId: sales.id });
    const scoped = await dashboard.summary(authUser(manager.user, manager.employee.id, { role: 'DEPARTMENT_MANAGER', managed: [sales.id] }), date);
    expect(scoped.kpis.totalEmployees).toBe(2);
    expect(scoped.kpis.absent).toBe(1);

    const live = await dashboard.live(authUser(admin.user, null, { role: 'SUPER_ADMIN' }), { date, sort: 'late', order: 'desc', pageSize: 2 });
    expect(live.total).toBe(5); // includes the manager, who has no sessions
    expect(live.items[0]).toMatchObject({ fullName: 'Basil Quarry', scheduleType: 'FIXED', state: 'OFF' });
    expect(live.items[0].metrics.lateMinutes).toBe(20);
    const absent = await dashboard.live(authUser(admin.user, null, { role: 'SUPER_ADMIN' }), { date, status: 'ABSENT' });
    expect(absent.items.map((r) => r.fullName).sort()).toEqual(['Celine Marsh', 'Omar Keystone']);
    const search = await dashboard.live(authUser(admin.user, null, { role: 'SUPER_ADMIN' }), { date, search: 'vale' });
    expect(search.items.map((r) => r.metrics.status)).toEqual(['MISSING_PUNCH']);
  });
});

describe('alerts job', () => {
  it('closes stale sessions, notifies employee + supervisors, and dedupes overdue-break alerts', async () => {
    const job = app.get(AttendanceAlertsJob);
    const ops = await makeDepartment('Ops');
    const worker = await makeEmployee({ name: 'Yusuf Ember', departmentId: ops.id });
    const sleeper = await makeEmployee({ name: 'Nadia Rook', departmentId: ops.id });
    const admin = await makeEmployee({ name: 'Hana Admin', role: 'SUPER_ADMIN' });
    const manager = await makeEmployee({ name: 'Omar Keystone', role: 'DEPARTMENT_MANAGER', managedDepartmentId: ops.id });
    const otherManager = await makeEmployee({ name: 'Rania Other', role: 'DEPARTMENT_MANAGER', managedDepartmentId: (await makeDepartment('Sales')).id });

    const smoke = await makeBreakType('SMOKE', { notifyAfterMinutes: 10 });
    const live = await makeSession(worker.employee.id, '2026-10-17', new Date(Date.now() - 3_600_000), null, 'OPEN');
    const brk = await prisma.breakSession.create({
      data: { workSessionId: live.id, employeeId: worker.employee.id, breakTypeId: smoke.id, startedAt: new Date(Date.now() - 15 * 60_000), startEventId: randomUUID() },
    });
    const stale = await makeSession(sleeper.employee.id, '2026-10-16', new Date(Date.now() - 19 * 3_600_000), null, 'OPEN');

    const first = await job.run();
    expect(first).toEqual({ staleSessionsClosed: 1, missingCheckoutNotifications: 3, breakNotifications: 1 });
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('MISSING_CHECKOUT');
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('OPEN');
    const recipients = async (type: string) =>
      (await prisma.notification.findMany({ where: { type } })).map((n) => n.userId).sort();
    expect(await recipients('ATTENDANCE_MISSING_CHECKOUT')).toEqual([sleeper.user.id, admin.user.id, manager.user.id].sort());
    expect(await recipients('ATTENDANCE_BREAK_OVERDUE')).toEqual([worker.user.id]);
    expect(await prisma.notification.count({ where: { userId: otherManager.user.id } })).toBe(0);
    const n = await prisma.notification.findFirstOrThrow({ where: { type: 'ATTENDANCE_BREAK_OVERDUE' } });
    expect(n.data).toMatchObject({ breakSessionId: brk.id, breakTypeCode: 'SMOKE', notifyAfterMinutes: 10 });

    const second = await job.run();
    expect(second).toEqual({ staleSessionsClosed: 0, missingCheckoutNotifications: 0, breakNotifications: 0 });
    expect(await prisma.notification.count()).toBe(4);
  });
});


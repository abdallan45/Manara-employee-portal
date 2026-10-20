import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { addDays, startOfLocalDay, weekdayOf } from '../src/common/time';
import { GeofenceService } from '../src/modules/offices/geofence.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { FAR_AWAY, makeBreakType, makeOffice } from './attendance-fixtures';
import { expectErrorEnvelope } from './core-fixtures';
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
let remote: { id: string };
beforeEach(async () => {
  await resetDb();
  // Check-ins below come from about 5 km away from the only office (ENFORCE is the default).
  await makeOffice();
  app.get(GeofenceService).invalidate();
  app.get(SettingsService).invalidate();
  catalog = await seedRequestCatalog();
  people = await seedPeople(app);
  remote = await prisma.leaveType.create({ data: { code: 'REMOTE_WORK', name: 'Remote work', nameAr: 'عمل عن بعد', unit: 'DAY', accrual: 'NONE', isRemoteWork: true } });
});

/** An approved (or pending) request covering today, inserted directly so the test also runs on a weekend. */
const coverToday = (employeeId: string, leaveTypeId: string, status: 'APPROVED' | 'PENDING' = 'APPROVED') =>
  prisma.leaveRequest.create({
    data: {
      employeeId, leaveTypeId, status, mode: 'FULL_DAY', minutes: DAY, reason: 'Fixture',
      startAt: startOfLocalDay(today()), endAt: startOfLocalDay(addDays(today(), 1)),
    },
  });

const previousWorkday = (d: string) => {
  let x = addDays(d, -1);
  while (weekdayOf(x) > 4) x = addDays(x, -1);
  return x;
};

describe('remote work', () => {
  it('accepts check-in, breaks and check-out away from the office only on an approved remote-work day', async () => {
    const { emp, emp2 } = people.users;
    const coffee = await makeBreakType('COFFEE');
    const key = () => ({ idempotencyKey: randomUUID(), location: FAR_AWAY });

    const denied = await people.http.emp.post('/api/v1/attendance/me/check-in').send(key());
    expect(denied.status).toBe(403);
    expectErrorEnvelope(denied.body, 'LOCATION_OUTSIDE_OFFICE');

    // Ordinary leave does not waive the location rule, and neither does a remote request that is still pending.
    await coverToday(emp.employeeId, catalog.unpaid.id);
    await coverToday(emp2.employeeId, remote.id, 'PENDING');
    expect((await people.http.emp.post('/api/v1/attendance/me/check-in').send(key())).status).toBe(403);
    expect((await people.http.emp2.post('/api/v1/attendance/me/check-in').send(key())).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: 'ATTENDANCE_DENIED_LOCATION' } })).toBe(3);

    await prisma.leaveRequest.deleteMany({ where: { employeeId: emp.employeeId } });
    await coverToday(emp.employeeId, remote.id);
    const status = await people.http.emp.get('/api/v1/attendance/me/status');
    expect(status.body.location).toMatchObject({ enforcement: 'ENFORCE', remote: true });
    expect((await people.http.emp2.get('/api/v1/attendance/me/status')).body.location.remote).toBe(false);

    const checkIn = await people.http.emp.post('/api/v1/attendance/me/check-in').send(key());
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.state).toBe('WORKING');
    expect((await people.http.emp.post('/api/v1/attendance/me/break/start').send({ ...key(), breakTypeId: coffee.id })).body.state).toBe('ON_BREAK');
    const out = await people.http.emp.post('/api/v1/attendance/me/check-out').send({ idempotencyKey: randomUUID() }); // auto-ends the break
    expect(out.status).toBe(200);
    expect(out.body.state).toBe('OFF');

    const events = await prisma.attendanceEvent.findMany({ where: { employeeId: emp.employeeId }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.type).sort()).toEqual(['BREAK_END', 'BREAK_START', 'CHECK_IN', 'CHECK_OUT']);
    for (const e of events) expect(e.locationVerified).toBe(false);
    for (const e of events.filter((x) => x.type !== 'BREAK_START')) expect(e.metadata).toMatchObject({ remote: true });
    const checkInEvent = events.find((e) => e.type === 'CHECK_IN')!;
    expect(checkInEvent).toMatchObject({ latitude: FAR_AWAY.latitude, longitude: FAR_AWAY.longitude, accuracyMeters: 10 });
    expect(checkInEvent.distanceMeters).toBeGreaterThan(4900);
    expect(events.find((e) => e.type === 'CHECK_OUT')).toMatchObject({ latitude: null, longitude: null });
    expect((await prisma.workSession.findFirstOrThrow({ where: { employeeId: emp.employeeId } })).locationVerified).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ATTENDANCE_CHECK_IN', actorUserId: emp.userId } });
    expect(audit.after).toMatchObject({ locationVerified: false, remote: true });
    expect(await prisma.auditLog.count({ where: { action: 'ATTENDANCE_DENIED_LOCATION' } })).toBe(3);
  });

  it('FLAG mode: events on other days stay unverified without the remote mark', async () => {
    await prisma.systemSetting.create({ data: { key: 'attendance.locationEnforcement', value: 'FLAG' } });
    app.get(SettingsService).invalidate();
    const res = await people.http.emp.post('/api/v1/attendance/me/check-in').send({ idempotencyKey: randomUUID(), location: FAR_AWAY });
    expect(res.status).toBe(200);
    const ev = await prisma.attendanceEvent.findFirstOrThrow({ where: { employeeId: people.users.emp.employeeId } });
    expect(ev.locationVerified).toBe(false);
    expect(ev.metadata).toEqual({ locationProblem: 'LOCATION_OUTSIDE_OFFICE' });
  });

  it('a remote day keeps the schedule: present with hours, absent without a check-in, never leave', async () => {
    const { emp } = people.users;
    const worked = pastWorkday(3);
    const missed = previousWorkday(worked);
    for (const d of [missed, worked]) {
      const req = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: remote.id, mode: 'FULL_DAY', startDate: d, endDate: d, reason: 'Working from home' });
      expect(req.status).toBe(201);
      expect((await people.http.mgr.post(`/api/v1/approvals/leave/${req.body.id}/approve`).send({})).status).toBe(200);
    }
    await sessionWithEvents(emp.employeeId, worked, 8 * 60, 16 * 60, 'CLOSED');

    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${missed}&to=${worked}`);
    expect(days.status).toBe(200);
    const byDate = new Map(days.body.map((d: { workDate: string }) => [d.workDate, d]));
    expect(byDate.get(worked)).toMatchObject({ status: 'CHECKED_OUT', remote: true, requiredMinutes: DAY, netWorkMinutes: DAY, missingMinutes: 0 });
    expect(byDate.get(missed)).toMatchObject({ status: 'ABSENT', remote: true, requiredMinutes: DAY, missingMinutes: DAY });

    const report = await people.http.hr.get(`/api/v1/reports/attendance?from=${missed}&to=${worked}&employeeId=${emp.employeeId}`);
    expect(report.status).toBe(200);
    expect(report.body.rows[0].totals).toMatchObject({
      scheduledDays: 2, presentDays: 1, remoteDays: 1, absentDays: 1, leaveDays: 0, requiredMinutes: 2 * DAY, netWorkMinutes: DAY, attendanceRate: 0.5,
    });
    const all = await people.http.hr.get(`/api/v1/reports/attendance?from=${missed}&to=${worked}`);
    expect(all.body.totals).toMatchObject({ remoteDays: 1, leaveDays: 0 });

    // Leave on another employee's day is still leave: it is not counted as remote.
    const annual = await people.http.emp2.post('/api/v1/leave/requests').send({ leaveTypeId: catalog.annual.id, mode: 'FULL_DAY', startDate: worked, endDate: worked, reason: 'Family' });
    await people.http.mgr.post(`/api/v1/approvals/leave/${annual.body.id}/approve`).send({});
    const emp2Row = (await people.http.hr.get(`/api/v1/reports/attendance?from=${worked}&to=${worked}&employeeId=${people.users.emp2.employeeId}`)).body.rows[0];
    expect(emp2Row.totals).toMatchObject({ leaveDays: 1, remoteDays: 0 });
  });

  it('uses no leave balance', async () => {
    const sun = futureSunday();
    const req = await people.http.emp.post('/api/v1/leave/requests').send({ leaveTypeId: remote.id, mode: 'FULL_DAY', startDate: sun, endDate: addDays(sun, 4), reason: 'Home office week' });
    expect(req.status).toBe(201);
    expect(req.body.leaveType).toMatchObject({ code: 'REMOTE_WORK', isRemoteWork: true, tracksBalance: false });
    expect((await people.http.mgr.post(`/api/v1/approvals/leave/${req.body.id}/approve`).send({})).status).toBe(200);

    const balances = await people.http.emp.get(`/api/v1/leave/me/balances?year=${sun.slice(0, 4)}`);
    expect(balances.body.map((b: { leaveType: { code: string } }) => b.leaveType.code)).not.toContain('REMOTE_WORK');
    expect(await prisma.leaveTransaction.count({ where: { leaveTypeId: remote.id } })).toBe(0);
    expect(await prisma.leaveBalance.count({ where: { leaveTypeId: remote.id } })).toBe(0);
  });

  it('leave type settings: the flag is editable and requires a type without a balance', async () => {
    const list = await people.http.admin.get('/api/v1/leave/types?includeInactive=true');
    expect(list.body.find((t: { code: string }) => t.code === 'REMOTE_WORK')).toMatchObject({ isRemoteWork: true });
    expect(list.body.find((t: { code: string }) => t.code === 'ANNUAL')).toMatchObject({ isRemoteWork: false });

    const bad = await people.http.admin.patch(`/api/v1/leave/types/${remote.id}`).send({ accrual: 'YEARLY', annualEntitlementMinutes: 10 * DAY });
    expect(bad.status).toBe(400);
    expectErrorEnvelope(bad.body, 'VALIDATION_FAILED');
    expect((await people.http.admin.patch(`/api/v1/leave/types/${catalog.annual.id}`).send({ isRemoteWork: true })).status).toBe(400);

    const off = await people.http.admin.patch(`/api/v1/leave/types/${remote.id}`).send({ isRemoteWork: false });
    expect(off.status).toBe(200);
    expect(off.body.isRemoteWork).toBe(false);
    const created = await people.http.admin.post('/api/v1/leave/types').send({ code: 'WFH', name: 'Work from home', unit: 'DAY', accrual: 'NONE', isRemoteWork: true });
    expect(created.status).toBe(201);
    expect(created.body.isRemoteWork).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'LEAVE_TYPE_UPDATE', entityId: remote.id } });
    expect(audit.before).toMatchObject({ isRemoteWork: true });
    expect(audit.after).toMatchObject({ isRemoteWork: false });
  });
});

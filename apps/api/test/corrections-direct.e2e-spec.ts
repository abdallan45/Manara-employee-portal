import type { INestApplication } from '@nestjs/common';
import { localDateTime } from '../src/common/time';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents } from './request-fixtures';

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
  await seedRequestCatalog();
  people = await seedPeople(app);
});

const eventsOf = (employeeId: string) => prisma.attendanceEvent.findMany({ where: { employeeId }, orderBy: { createdAt: 'asc' } });
const DIRECT = '/api/v1/corrections/direct';

describe('direct HR attendance corrections', () => {
  it('missing check-out: applied at once, recorded as approved, audited, employee notified, originals untouched', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const before = await eventsOf(empId);

    const listed = await people.http.hr.get(`/api/v1/corrections/employees/${empId}/sessions`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: session.id, status: 'MISSING_CHECKOUT' })]);

    const res = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:30`, reason: 'Forgot to check out, confirmed by manager',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'APPROVED', direct: true, kind: 'MISSING_CHECK_OUT', eventType: 'CHECK_OUT', workSessionId: session.id,
      decidedBy: { username: 'hr' }, reason: 'Forgot to check out, confirmed by manager',
    });

    const after = await eventsOf(empId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after[after.length - 1];
    expect(added).toMatchObject({
      type: 'CHECK_OUT', source: 'ADMIN_CORRECTION', actorUserId: people.users.hr.userId, workSessionId: session.id,
      metadata: { correctionId: res.body.id, kind: 'MISSING_CHECK_OUT' },
    });
    expect(added.occurredAt.toISOString()).toBe(localDateTime(day, 16 * 60 + 30).toISOString());
    expect(res.body.appliedEventId).toBe(added.id);
    expect(await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'CLOSED', endEventId: added.id });

    const row = await prisma.attendanceCorrection.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ requestedById: people.users.hr.userId, decidedById: people.users.hr.userId, status: 'APPROVED' });

    expect(await auditActions(res.body.id)).toEqual(['CORRECTION_DIRECT_APPLY']);
    expect(await auditActions(session.id)).toEqual(['ATTENDANCE_CORRECTION_APPLIED']);
    const notes = await notificationsOf(people.users.emp.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'REQUEST_APPROVED', data: expect.objectContaining({ requestId: res.body.id, direct: true }) });

    // Shows in the employee's history and the HR history list.
    const mine = await people.http.emp.get('/api/v1/corrections/me/requests');
    expect(mine.body).toEqual([expect.objectContaining({ id: res.body.id, status: 'APPROVED', direct: true })]);
    const hist = await people.http.hr.get(`/api/v1/corrections/employees/${empId}/requests`);
    expect(hist.body.map((c: { id: string }) => c.id)).toEqual([res.body.id]);

    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${day}&to=${day}`);
    expect(days.body[0]).toMatchObject({ status: 'CHECKED_OUT', missingPunch: false });
  });

  it('missing check-in: creates a closed session from two appended events', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(3);
    const res = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_IN', proposedTime: `${day}T08:00`, proposedEndTime: `${day}T16:00`, reason: 'Worked on site, no punch',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'APPROVED', direct: true, kind: 'MISSING_CHECK_IN' });
    const events = await eventsOf(empId);
    expect(events.map((e) => [e.type, e.source])).toEqual([['CHECK_IN', 'ADMIN_CORRECTION'], ['CHECK_OUT', 'ADMIN_CORRECTION']]);
    const session = await prisma.workSession.findUniqueOrThrow({ where: { id: res.body.workSessionId } });
    expect(session).toMatchObject({ status: 'CLOSED', startEventId: events[0].id, endEventId: events[1].id });
    expect(res.body.session).toMatchObject({ workDate: day, status: 'CLOSED' });
  });

  it('wrong check-out time: appends a superseding event and keeps the original', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, 20 * 60, 'CLOSED');
    const original = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: session.endEventId! } });

    const res = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'WRONG_TIME', workSessionId: session.id, eventType: 'CHECK_OUT', proposedTime: `${day}T17:00`, reason: 'Checked out late from home',
    });
    expect(res.status).toBe(201);
    const repaired = await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(repaired.endedAt!.toISOString()).toBe(localDateTime(day, 17 * 60).toISOString());
    expect(repaired.endEventId).not.toBe(original.id);
    expect(await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    const added = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: repaired.endEventId! } });
    expect(added).toMatchObject({ source: 'ADMIN_CORRECTION', metadata: { supersedesEventId: original.id } });
  });

  it('wrong check-in time on the check-in', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 10 * 60, 17 * 60, 'CLOSED');
    const res = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'WRONG_TIME', workSessionId: session.id, eventType: 'CHECK_IN', proposedTime: `${day}T08:00`, reason: 'Arrived at 8',
    });
    expect(res.status).toBe(201);
    const repaired = await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(repaired.startedAt.toISOString()).toBe(localDateTime(day, 8 * 60).toISOString());
    expect(await prisma.attendanceEvent.count({ where: { employeeId: empId } })).toBe(3);
  });

  it('refuses managers and employees (403), and HR correcting their own attendance', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const body = { employeeId: empId, kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:30`, reason: 'Forgot' };

    for (const who of ['mgr', 'emp'] as const) {
      expect((await people.http[who].post(DIRECT).send(body)).status).toBe(403);
      expect((await people.http[who].get(`/api/v1/corrections/employees/${empId}/sessions`)).status).toBe(403);
      expect((await people.http[who].get(`/api/v1/corrections/employees/${empId}/requests`)).status).toBe(403);
    }

    const hrId = people.users.hr.employeeId;
    const own = await sessionWithEvents(hrId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const self = await people.http.hr.post(DIRECT).send({ ...body, employeeId: hrId, workSessionId: own.id });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    expect(await prisma.attendanceCorrection.count()).toBe(0);
    expect(await prisma.attendanceEvent.count({ where: { source: 'ADMIN_CORRECTION' } })).toBe(0);
  });

  it('refuses overlaps, invalid times, a missing reason and unknown employees without writing anything', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    await sessionWithEvents(empId, day, 9 * 60, 17 * 60, 'CLOSED');
    const closed = await prisma.workSession.findFirstOrThrow({ where: { employeeId: empId } });
    const before = await eventsOf(empId);

    const overlap = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_IN', proposedTime: `${day}T08:00`, proposedEndTime: `${day}T10:00`, reason: 'Overlapping',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('CORRECTION_INVALID');

    const backwards = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'WRONG_TIME', workSessionId: closed.id, eventType: 'CHECK_OUT', proposedTime: `${day}T08:00`, reason: 'Before check-in',
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('VALIDATION_FAILED');

    const notMissing = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_OUT', workSessionId: closed.id, proposedTime: `${day}T18:00`, reason: 'Already closed',
    });
    expect(notMissing.status).toBe(409);
    expect(notMissing.body.error.code).toBe('CORRECTION_INVALID');

    const future = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_IN', proposedTime: '2099-01-01T08:00', proposedEndTime: '2099-01-01T16:00', reason: 'Future',
    });
    expect(future.status).toBe(400);

    const noReason = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_IN', proposedTime: `${pastWorkday(4)}T08:00`, proposedEndTime: `${pastWorkday(4)}T16:00`,
    });
    expect(noReason.status).toBe(400);
    const blankReason = await people.http.hr.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_IN', proposedTime: `${pastWorkday(4)}T08:00`, proposedEndTime: `${pastWorkday(4)}T16:00`, reason: '     ',
    });
    expect(blankReason.status).toBe(400);

    const unknown = await people.http.hr.post(DIRECT).send({
      employeeId: '00000000-0000-4000-8000-000000000000', kind: 'MISSING_CHECK_IN', proposedTime: `${day}T06:00`, proposedEndTime: `${day}T07:00`, reason: 'Nobody',
    });
    expect(unknown.status).toBe(404);
    expect((await people.http.hr.get('/api/v1/corrections/employees/00000000-0000-4000-8000-000000000000/sessions')).status).toBe(404);

    expect(await eventsOf(empId)).toEqual(before);
    expect(await prisma.attendanceCorrection.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { in: ['CORRECTION_DIRECT_APPLY', 'ATTENDANCE_CORRECTION_APPLIED'] } } })).toBe(0);
  });

  it('super admin can correct too, and the correction shows in the Approval Center approved tab', async () => {
    const empId = people.users.opsEmp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const res = await people.http.admin.post(DIRECT).send({
      employeeId: empId, kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:00`, reason: 'Fixed by admin',
    });
    expect(res.status).toBe(201);
    const approved = await people.http.hr.get('/api/v1/approvals?tab=APPROVED&kind=CORRECTION');
    expect(approved.body.items.map((i: { id: string }) => i.id)).toContain(res.body.id);
  });
});

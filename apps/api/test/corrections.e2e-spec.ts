import type { INestApplication } from '@nestjs/common';
import { addDays, localDateTime } from '../src/common/time';
import { expectErrorEnvelope } from './core-fixtures';
import { createTestApp, prisma, resetDb } from './helpers';
import { auditActions, notificationsOf, pastWorkday, seedPeople, seedRequestCatalog, sessionWithEvents, today } from './request-fixtures';

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

describe('attendance corrections', () => {
  it('missing check-out: appends an ADMIN_CORRECTION event and closes the session without touching existing events', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const before = await eventsOf(empId);

    const listed = await people.http.emp.get('/api/v1/corrections/me/sessions');
    expect(listed.body).toEqual([expect.objectContaining({ id: session.id, status: 'MISSING_CHECKOUT', pendingCorrection: false })]);

    const body = { kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:30`, reason: 'Phone battery died' };
    const req = await people.http.emp.post('/api/v1/corrections/requests').send(body);
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'PENDING', kind: 'MISSING_CHECK_OUT', eventType: 'CHECK_OUT', proposedTime: localDateTime(day, 16 * 60 + 30).toISOString() });
    expect((await people.http.emp.post('/api/v1/corrections/requests').send(body)).body.error.code).toBe('DUPLICATE_REQUEST');
    expect((await people.http.emp.get('/api/v1/corrections/me/sessions')).body[0].pendingCorrection).toBe(true);
    expect((await notificationsOf(people.users.mgr.userId)).map((n) => n.type)).toEqual(['REQUEST_PENDING_APPROVAL']);

    const ok = await people.http.mgr.post(`/api/v1/approvals/correction/${req.body.id}/approve`).send({ comment: 'Confirmed with the team' });
    expect(ok.status).toBe(200);
    expect(ok.body.correction).toMatchObject({ status: 'APPROVED', decisionComment: 'Confirmed with the team', decidedBy: { username: 'mgr' } });

    const after = await eventsOf(empId);
    expect(after).toHaveLength(before.length + 1);
    // Existing rows are byte-for-byte the same.
    expect(after.slice(0, before.length)).toEqual(before);
    const added = after[after.length - 1];
    expect(added).toMatchObject({ type: 'CHECK_OUT', source: 'ADMIN_CORRECTION', actorUserId: people.users.mgr.userId, workSessionId: session.id, metadata: { correctionId: req.body.id, kind: 'MISSING_CHECK_OUT' } });
    expect(added.occurredAt.toISOString()).toBe(localDateTime(day, 16 * 60 + 30).toISOString());

    const repaired = await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(repaired).toMatchObject({ status: 'CLOSED', endEventId: added.id });
    expect(ok.body.correction.appliedEventId).toBe(added.id);

    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${day}&to=${day}`);
    expect(days.body[0]).toMatchObject({ status: 'CHECKED_OUT', missingPunch: false, netWorkMinutes: 510 });

    expect(await auditActions(req.body.id)).toEqual(['CORRECTION_REQUEST_CREATE', 'CORRECTION_REQUEST_APPROVE']);
    expect(await auditActions(session.id)).toEqual(['ATTENDANCE_CORRECTION_APPLIED']);
    expect((await notificationsOf(people.users.emp.userId)).map((n) => n.type)).toEqual(['REQUEST_APPROVED']);
  });

  it('wrong check-in time: the original event stays, the session points at the correction', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 10 * 60, 17 * 60, 'CLOSED');
    const original = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: session.startEventId } });

    const req = (await people.http.emp.post('/api/v1/corrections/requests').send({
      kind: 'WRONG_TIME', workSessionId: session.id, eventType: 'CHECK_IN', proposedTime: localDateTime(day, 8 * 60).toISOString(), reason: 'Checked in late on the app, arrived at 8',
    })).body;
    expect(req.status).toBe('PENDING');
    await people.http.mgr.post(`/api/v1/approvals/correction/${req.id}/approve`).send({});

    const repaired = await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(repaired.startedAt.toISOString()).toBe(localDateTime(day, 8 * 60).toISOString());
    expect(repaired.startEventId).not.toBe(original.id);
    expect(await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    const correction = await prisma.attendanceEvent.findUniqueOrThrow({ where: { id: repaired.startEventId } });
    expect(correction).toMatchObject({ type: 'CHECK_IN', source: 'ADMIN_CORRECTION', metadata: { supersedesEventId: original.id } });
    const days = await people.http.emp.get(`/api/v1/attendance/me/days?from=${day}&to=${day}`);
    expect(days.body[0]).toMatchObject({ netWorkMinutes: 540, lateMinutes: 0 });
  });

  it('missing check-in creates the whole session; overlaps are refused at request and at approval time', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const body = { kind: 'MISSING_CHECK_IN', proposedTime: `${day}T08:00`, proposedEndTime: `${day}T16:00`, reason: 'Forgot to punch at all' };
    const req = (await people.http.emp.post('/api/v1/corrections/requests').send(body)).body;
    expect(req).toMatchObject({ status: 'PENDING', kind: 'MISSING_CHECK_IN', session: null });

    const ok = await people.http.mgr.post(`/api/v1/approvals/correction/${req.id}/approve`).send({});
    expect(ok.body.correction.session).toMatchObject({ workDate: day, status: 'CLOSED' });
    const sessions = await prisma.workSession.findMany({ where: { employeeId: empId } });
    expect(sessions).toHaveLength(1);
    expect((await eventsOf(empId)).map((e) => [e.type, e.source])).toEqual([['CHECK_IN', 'ADMIN_CORRECTION'], ['CHECK_OUT', 'ADMIN_CORRECTION']]);

    const clash = await people.http.emp.post('/api/v1/corrections/requests').send({ ...body, proposedTime: `${day}T15:00`, proposedEndTime: `${day}T18:00` });
    expect(clash.status).toBe(409);
    expectErrorEnvelope(clash.body, 'CORRECTION_INVALID');

    // Records change between request and approval -> approval re-validates.
    const other = pastWorkday(5);
    const pending = (await people.http.emp.post('/api/v1/corrections/requests').send({ ...body, proposedTime: `${other}T08:00`, proposedEndTime: `${other}T16:00` })).body;
    await sessionWithEvents(empId, other, 9 * 60, 12 * 60, 'CLOSED');
    const stale = await people.http.mgr.post(`/api/v1/approvals/correction/${pending.id}/approve`).send({});
    expect(stale.status).toBe(409);
    expectErrorEnvelope(stale.body, 'CORRECTION_INVALID');
    expect((await prisma.attendanceCorrection.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING');
  });

  it('validation: wrong session state, future times, other employees’ sessions, check-out before a break', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const closed = await sessionWithEvents(empId, day, 8 * 60, 16 * 60, 'CLOSED');
    const notMissing = await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'MISSING_CHECK_OUT', workSessionId: closed.id, proposedTime: `${day}T17:00`, reason: 'Left at five' });
    expect(notMissing.status).toBe(409);
    expectErrorEnvelope(notMissing.body, 'CORRECTION_INVALID');

    const future = await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'WRONG_TIME', workSessionId: closed.id, eventType: 'CHECK_OUT', proposedTime: `${addDays(today(), 2)}T17:00`, reason: 'Left at five' });
    expect(future.status).toBe(400);

    const foreign = await people.http.emp2.post('/api/v1/corrections/requests').send({ kind: 'WRONG_TIME', workSessionId: closed.id, eventType: 'CHECK_OUT', proposedTime: `${day}T17:00`, reason: 'Left at five' });
    expect(foreign.status).toBe(404);

    const lunch = await prisma.breakType.create({ data: { code: 'LUNCH', name: 'Lunch' } });
    await prisma.breakSession.create({
      data: { workSessionId: closed.id, employeeId: empId, breakTypeId: lunch.id, startedAt: localDateTime(day, 12 * 60), endedAt: localDateTime(day, 13 * 60), startEventId: closed.id },
    });
    const beforeBreakEnd = await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'WRONG_TIME', workSessionId: closed.id, eventType: 'CHECK_OUT', proposedTime: `${day}T12:30`, reason: 'Left early' });
    expect(beforeBreakEnd.status).toBe(409);
    const bad = await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'WRONG_TIME', workSessionId: closed.id, proposedTime: `${day}T17:00`, reason: 'No event type' });
    expect(bad.status).toBe(400);
  });

  it('rejection appends nothing; scope and permissions are enforced; employees cancel their own', async () => {
    const empId = people.users.emp.employeeId;
    const day = pastWorkday(2);
    const session = await sessionWithEvents(empId, day, 8 * 60, null, 'MISSING_CHECKOUT');
    const req = (await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T16:00`, reason: 'Forgot' })).body;
    const before = await eventsOf(empId);

    expect((await people.http.opsMgr.post(`/api/v1/approvals/correction/${req.id}/approve`).send({})).status).toBe(403);
    expect((await people.http.emp2.post(`/api/v1/approvals/correction/${req.id}/approve`).send({})).status).toBe(403);
    const rejected = await people.http.mgr.post(`/api/v1/approvals/correction/${req.id}/reject`).send({ comment: 'You left at 14:00' });
    expect(rejected.body.correction).toMatchObject({ status: 'REJECTED', decisionComment: 'You left at 14:00', appliedEventId: null });
    expect(await eventsOf(empId)).toEqual(before);
    expect((await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('MISSING_CHECKOUT');

    const second = (await people.http.emp.post('/api/v1/corrections/requests').send({ kind: 'MISSING_CHECK_OUT', workSessionId: session.id, proposedTime: `${day}T14:00`, reason: 'Left at two' })).body;
    expect((await people.http.emp2.post(`/api/v1/corrections/requests/${second.id}/cancel`)).status).toBe(404);
    expect((await people.http.emp.post(`/api/v1/corrections/requests/${second.id}/cancel`)).body.status).toBe('CANCELLED');
    expect(await auditActions(second.id)).toEqual(['CORRECTION_REQUEST_CREATE', 'CORRECTION_REQUEST_CANCEL']);
    expect((await people.http.emp.get('/api/v1/corrections/me/requests')).body.map((r: { status: string }) => r.status)).toEqual(['CANCELLED', 'REJECTED']);
  });
});

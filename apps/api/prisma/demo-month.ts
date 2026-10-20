/**
 * Demo data: one month of fictional attendance plus leave, overtime and correction requests,
 * so every screen (dashboard, live attendance, reports, Approval Center, balances) has something
 * to show. For the development database only - refuses to run unless DEMO_MODE=true.
 *
 *   npm run db:demo-month -w @workforce/api
 *
 * Attendance (sessions, breaks, events) is written directly, because the engine only records
 * "now"; requests and decisions go through the real services so balances, approval steps,
 * notifications and audit rows are exactly what the app would produce. Runs once (an audit row
 * marks completion; attendance events are append-only); an interrupted run can be re-run, since
 * days that already have a session are skipped.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth';
import { addDays, dateOnly, localDate, localDateTime, weekdayOf } from '../src/common/time';
import { AuditService } from '../src/modules/audit/audit.service';
import { PRINCIPAL_INCLUDE, toAuthUser } from '../src/modules/auth/session.service';
import { ApprovalsService } from '../src/modules/requests/approvals.service';
import { CorrectionsService } from '../src/modules/requests/corrections.service';
import { LeaveService } from '../src/modules/requests/leave.service';
import { OvertimeService } from '../src/modules/requests/overtime.service';

const MARK = 'demo-month';
const DAYS_BACK = 30;
const prisma = new PrismaClient();
const log = new Logger('demo-month');

// ───────────── Deterministic randomness ─────────────

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, min: number, max: number) => Math.round(min + r() * (max - min));

// ───────────── Personas ─────────────

interface Persona {
  /** Usual arrival and working span (minutes after midnight / minutes), with jitter. */
  arrive: number; arriveJitter: number; span: number; spanJitter: number;
  /** Chance of a late morning (+20–45 min) and of leaving early (−30–60 min). */
  late: number; early: number;
  shortBreak: number;
}

const PERSONAS: Record<string, Persona> = {
  admin: { arrive: 510, arriveJitter: 15, span: 510, spanJitter: 20, late: 0.05, early: 0.05, shortBreak: 0.3 },
  hr: { arrive: 495, arriveJitter: 10, span: 520, spanJitter: 15, late: 0.02, early: 0.02, shortBreak: 0.4 },
  manager: { arrive: 530, arriveJitter: 15, span: 560, spanJitter: 30, late: 0.05, early: 0.02, shortBreak: 0.2 },
  dev1: { arrive: 585, arriveJitter: 25, span: 525, spanJitter: 30, late: 0.2, early: 0.05, shortBreak: 0.5 },
  dev2: { arrive: 480, arriveJitter: 10, span: 515, spanJitter: 15, late: 0.03, early: 0.1, shortBreak: 0.3 },
  ops1: { arrive: 530, arriveJitter: 8, span: 510, spanJitter: 10, late: 0.12, early: 0.03, shortBreak: 0.3 },
  ops2: { arrive: 545, arriveJitter: 12, span: 490, spanJitter: 20, late: 0.25, early: 0.2, shortBreak: 0.6 },
  design1: { arrive: 600, arriveJitter: 20, span: 560, spanJitter: 40, late: 0.1, early: 0.05, shortBreak: 0.4 },
  design2: { arrive: 540, arriveJitter: 15, span: 515, spanJitter: 15, late: 0.08, early: 0.05, shortBreak: 0.3 },
};

// ───────────── Writers ─────────────

interface Ctx {
  employeeId: string;
  office: { id: string; latitude: number; longitude: number } | null;
  ip: string;
  breakTypes: Map<string, string>;
}

async function event(c: Ctx, type: 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_START' | 'BREAK_END', at: Date, extra: { workSessionId: string; breakSessionId?: string; breakTypeId?: string }) {
  return prisma.attendanceEvent.create({
    data: {
      employeeId: c.employeeId, type, occurredAt: at, source: 'WEB', ipAddress: c.ip,
      ...(type === 'CHECK_IN' || type === 'CHECK_OUT'
        ? c.office
          ? { locationVerified: true, latitude: c.office.latitude, longitude: c.office.longitude, accuracyMeters: 12, distanceMeters: 8, officeId: c.office.id }
          : { locationVerified: false }
        : { locationVerified: false }),
      idempotencyKey: randomUUID(), metadata: { demo: MARK }, ...extra,
    },
  });
}

/**
 * One working day: check-in, optional breaks, check-out (or none when the check-out is "forgotten").
 * Events go first and the session is written in its final state: only one OPEN session per
 * employee is allowed, and someone may be checked in right now.
 */
async function workDay(c: Ctx, date: string, start: number, end: number, breaks: { code: string; at: number; minutes: number }[], forgotCheckout = false) {
  const startedAt = localDateTime(date, start);
  // An interrupted earlier run may have left this exact check-in without its session; reuse it (events cannot be deleted).
  const orphan = await prisma.attendanceEvent.findFirst({
    where: { employeeId: c.employeeId, type: 'CHECK_IN', occurredAt: startedAt, metadata: { path: ['demo'], equals: MARK } },
  });
  const sessionId = orphan?.workSessionId ?? randomUUID();
  const checkIn = orphan ?? (await event(c, 'CHECK_IN', startedAt, { workSessionId: sessionId }));

  const planned: { id: string; typeId: string; start: { id: string; occurredAt: Date }; end: { id: string; occurredAt: Date } }[] = [];
  for (const b of breaks) {
    if (b.at <= start || b.at + b.minutes >= end) continue;
    const id = randomUUID();
    const typeId = c.breakTypes.get(b.code)!;
    const s = await event(c, 'BREAK_START', localDateTime(date, b.at), { workSessionId: sessionId, breakSessionId: id, breakTypeId: typeId });
    const e = await event(c, 'BREAK_END', localDateTime(date, b.at + b.minutes), { workSessionId: sessionId, breakSessionId: id, breakTypeId: typeId });
    planned.push({ id, typeId, start: s, end: e });
  }
  const out = forgotCheckout ? null : await event(c, 'CHECK_OUT', localDateTime(date, end), { workSessionId: sessionId });
  await prisma.workSession.create({
    data: {
      id: sessionId, employeeId: c.employeeId, workDate: dateOnly.toDb(date), startedAt: checkIn.occurredAt, startEventId: checkIn.id,
      status: out ? 'CLOSED' : 'MISSING_CHECKOUT', endedAt: out?.occurredAt ?? null, endEventId: out?.id ?? null,
    },
  });
  for (const b of planned) {
    await prisma.breakSession.create({
      data: {
        id: b.id, workSessionId: sessionId, employeeId: c.employeeId, breakTypeId: b.typeId, startedAt: b.start.occurredAt, endedAt: b.end.occurredAt,
        startEventId: b.start.id, endEventId: b.end.id,
      },
    });
  }
  return sessionId;
}

// ───────────── The month ─────────────

async function main() {
  if (process.env.DEMO_MODE !== 'true') throw new Error('Refusing to run: demo data is only for a development database with DEMO_MODE=true.');
  if (await prisma.auditLog.findFirst({ where: { action: 'DEMO_DATA_GENERATED', entityId: MARK } })) {
    log.warn('Demo month already generated (attendance events are append-only, so it is not generated twice).');
    return;
  }

  const today = localDate(new Date());
  const from = addDays(today, -DAYS_BACK);
  const workdays: string[] = [];
  for (let d = from; d < today; d = addDays(d, 1)) if (weekdayOf(d) <= 4) workdays.push(d);
  const wd = (i: number) => workdays[Math.min(Math.max(i, 0), workdays.length - 1)];
  const nextWorkday = (after: number) => {
    let d = addDays(today, after);
    while (weekdayOf(d) > 4) d = addDays(d, 1);
    return d;
  };

  const users = await prisma.user.findMany({ where: { username: { in: Object.keys(PERSONAS) } }, include: PRINCIPAL_INCLUDE });
  const byName = new Map(users.map((u) => [u.username, u]));
  const auth = (username: string): AuthUser => toAuthUser(byName.get(username)!, 'demo-script', '192.168.1.10');
  const emp = (username: string) => byName.get(username)!.employeeId!;
  const hq = await prisma.location.findFirst({ where: { name: 'Amman HQ', latitude: { not: null }, longitude: { not: null } } });
  const office = hq ? { id: hq.id, latitude: hq.latitude!, longitude: hq.longitude! } : null;
  const breakTypes = new Map((await prisma.breakType.findMany()).map((b) => [b.code, b.id]));
  const leaveType = async (code: string) => (await prisma.leaveType.findUniqueOrThrow({ where: { code } })).id;

  // Days that are not ordinary working days for someone.
  const leave = {
    dev2Annual: [wd(6), wd(7)], // two full days, approved by the manager
    ops1Sick: wd(11), // sensitive, approved by HR
    design2Half: wd(14), // morning off
    ops2Hourly: wd(17), // 09:00–11:00
  };
  const absent: Record<string, string[]> = { dev2: [wd(16)], ops2: [wd(3)] };
  const forgot: Record<string, string> = { dev2: wd(12), ops2: wd(18), design1: wd(9) };
  const overtimeDays: Record<string, string[]> = { manager: [wd(2), wd(8), wd(13), wd(19)], design1: [wd(5), wd(15)] };
  const skip: Record<string, string[]> = {
    dev2: [...leave.dev2Annual, ...absent.dev2],
    ops1: [leave.ops1Sick],
    ops2: absent.ops2,
  };

  const forgottenSessions: Record<string, string> = {};
  let wrongTime: { date: string; sessionId: string; start: number } | null = null;
  let sessions = 0;

  for (const [username, p] of Object.entries(PERSONAS)) {
    const user = byName.get(username);
    if (!user?.employeeId) continue;
    const c: Ctx = { employeeId: user.employeeId, office, ip: `192.168.1.${20 + users.indexOf(user)}`, breakTypes };
    const r = rng(`${MARK}:${username}`);
    const taken = new Set((await prisma.workSession.findMany({ where: { employeeId: c.employeeId, workDate: { gte: dateOnly.toDb(from) } }, select: { workDate: true } }))
      .map((s) => dateOnly.fromDb(s.workDate)));

    for (const date of workdays) {
      if (taken.has(date) || skip[username]?.includes(date)) continue;
      let start = p.arrive + between(r, -p.arriveJitter, p.arriveJitter);
      let span = p.span + between(r, -p.spanJitter, p.spanJitter);
      if (r() < p.late) start += between(r, 20, 45);
      if (r() < p.early) span -= between(r, 30, 60);
      if (overtimeDays[username]?.includes(date)) span += between(r, 110, 140);
      if (username === 'design2' && date === leave.design2Half) (start = 780), (span = 270);
      if (username === 'ops2' && date === leave.ops2Hourly) (start = 662), (span = 360);
      const end = start + span;
      const lunch = r() < 0.12 ? between(r, 66, 80) : between(r, 30, 55); // now and then over the 60-minute limit
      const breaks = [{ code: 'LUNCH', at: 750 + between(r, -20, 30), minutes: lunch }];
      if (r() < p.shortBreak) breaks.push({ code: 'SHORT', at: 660 + between(r, -30, 30), minutes: r() < 0.2 ? between(r, 17, 22) : between(r, 8, 14) });
      if (r() < 0.06) breaks.push({ code: 'PERSONAL', at: 900 + between(r, 0, 40), minutes: between(r, 15, 30) });
      if (username === 'ops2' && r() < 0.15) breaks.push({ code: 'OFFICIAL', at: 840, minutes: between(r, 60, 90) });

      const missing = forgot[username] === date;
      const id = await workDay(c, date, start, end, breaks, missing);
      if (missing) forgottenSessions[username] = id;
      if (username === 'dev1' && !wrongTime && start > 630 && date >= wd(10)) wrongTime = { date, sessionId: id, start };
      sessions++;
    }
  }
  log.log(`Attendance: ${sessions} work sessions over ${workdays.length} working days (${workdays[0]} → ${workdays[workdays.length - 1]}).`);

  // ───── Requests, through the real services ─────
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const leaveSvc = app.get(LeaveService);
    const overtimeSvc = app.get(OvertimeService);
    const corrections = app.get(CorrectionsService);
    const approvals = app.get(ApprovalsService);
    const audit = app.get(AuditService);
    const say = async <T>(label: string, f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        log.warn(`${label}: ${(e as Error).message}`);
        return null;
      }
    };

    for (const [username, sessionId] of Object.entries(forgottenSessions)) {
      await audit.record(prisma, {
        actorUserId: null, action: 'ATTENDANCE_MISSING_CHECKOUT', entityType: 'WorkSession', entityId: sessionId,
        after: { employeeId: emp(username), reason: 'left open past the configured limit', demo: MARK },
      });
    }

    // Leave
    const annual = await leaveType('ANNUAL');
    const l1 = await say('dev2 annual', () => leaveSvc.create(auth('dev2'), {
      leaveTypeId: annual, mode: 'FULL_DAY', startDate: leave.dev2Annual[0], endDate: leave.dev2Annual[1], reason: 'Family trip to Aqaba',
    }));
    if (l1) await say('approve dev2 annual', () => approvals.decide(auth('manager'), 'LEAVE', l1.id, 'APPROVED', 'Enjoy the trip'));

    const l2 = await say('ops1 sick', async () => leaveSvc.create(auth('ops1'), {
      leaveTypeId: await leaveType('SICK'), mode: 'FULL_DAY', startDate: leave.ops1Sick, endDate: leave.ops1Sick, reason: 'Flu, doctor note handed to HR',
    }));
    if (l2) await say('approve ops1 sick', () => approvals.decide(auth('hr'), 'LEAVE', l2.id, 'APPROVED', 'Get well soon'));

    const l3 = await say('design2 half day', async () => leaveSvc.create(auth('design2'), {
      leaveTypeId: annual, mode: 'HALF_DAY', startDate: leave.design2Half, half: 'FIRST', reason: 'Bank appointment',
    }));
    if (l3) await say('approve design2 half day', () => approvals.decide(auth('hr'), 'LEAVE', l3.id, 'APPROVED'));

    const l4 = await say('ops2 hourly', async () => leaveSvc.create(auth('ops2'), {
      leaveTypeId: await leaveType('HOURLY'), mode: 'HOURLY', startDate: leave.ops2Hourly, startTime: '09:00', endTime: '11:00', reason: 'Car inspection',
    }));
    if (l4) await say('approve ops2 hourly', () => approvals.decide(auth('hr'), 'LEAVE', l4.id, 'APPROVED'));

    // Waiting in the Approval Center: a future week off and an emergency day that the manager rejects.
    const nextSunday = (() => {
      let d = addDays(today, 14);
      while (weekdayOf(d) !== 0) d = addDays(d, 1);
      return d;
    })();
    await say('design1 annual (pending)', () => leaveSvc.create(auth('design1'), {
      leaveTypeId: annual, mode: 'FULL_DAY', startDate: nextSunday, endDate: addDays(nextSunday, 4), reason: 'Visiting family abroad',
    }));
    const l6 = await say('dev1 emergency', async () => leaveSvc.create(auth('dev1'), {
      leaveTypeId: await leaveType('EMERGENCY'), mode: 'FULL_DAY', startDate: nextWorkday(3), endDate: nextWorkday(3), reason: 'Home repair',
    }));
    if (l6) await say('reject dev1 emergency', () => approvals.decide(auth('manager'), 'LEAVE', l6.id, 'REJECTED', 'Release day: please pick another date'));

    // Overtime (retrospective, capped at the recorded extra time)
    const ot = async (username: string, workDate: string, minutes: number, reason: string, compensation: 'PAY' | 'TIME_OFF' = 'PAY') =>
      say(`${username} overtime ${workDate}`, () => overtimeSvc.create(auth(username), { workDate, minutes, reason, compensation }));
    const [m1, m2, m3] = [
      await ot('manager', overtimeDays.manager[0], 90, 'Production incident follow-up'),
      await ot('manager', overtimeDays.manager[1], 60, 'Quarterly planning'),
      await ot('manager', overtimeDays.manager[2], 90, 'Release night', 'TIME_OFF'),
    ];
    await ot('manager', overtimeDays.manager[3], 60, 'Vendor call across time zones');
    if (m1) await say('approve m1', () => approvals.decide(auth('hr'), 'OVERTIME', m1.id, 'APPROVED'));
    if (m3) await say('approve m3', () => approvals.decide(auth('hr'), 'OVERTIME', m3.id, 'APPROVED', 'Time off credited by HR'));
    if (m2) await say('reject m2', () => approvals.decide(auth('hr'), 'OVERTIME', m2.id, 'REJECTED', 'Planning fits normal hours'));
    const d1 = await ot('design1', overtimeDays.design1[0], 75, 'Campaign deadline');
    if (d1) await say('approve d1', () => approvals.decide(auth('hr'), 'OVERTIME', d1.id, 'APPROVED'));
    await ot('design1', overtimeDays.design1[1], 60, 'Client revisions');
    await say('dev1 pre-approval', () => overtimeSvc.create(auth('dev1'), { workDate: nextWorkday(2), minutes: 120, reason: 'Database migration window' }));

    // Corrections
    const fix = async (username: string, sessionId: string, date: string, minute: number, reason: string) =>
      say(`${username} correction`, () => corrections.create(auth(username), {
        kind: 'MISSING_CHECK_OUT', workSessionId: sessionId, proposedTime: localDateTime(date, minute).toISOString(), reason,
      }));
    const c1 = await fix('dev2', forgottenSessions.dev2, forgot.dev2, 1000, 'Left in a hurry, forgot to check out');
    if (c1) await say('approve dev2 correction', () => approvals.decide(auth('manager'), 'CORRECTION', c1.id, 'APPROVED'));
    if (forgottenSessions.ops2) await fix('ops2', forgottenSessions.ops2, forgot.ops2, 1020, 'Phone battery died before check-out');
    // design1's forgotten check-out is left without a request: it shows as a missing punch.
    const w = wrongTime;
    if (w) {
      await say('dev1 wrong time', () => corrections.create(auth('dev1'), {
        kind: 'WRONG_TIME', workSessionId: w.sessionId, eventType: 'CHECK_IN',
        proposedTime: localDateTime(w.date, w.start - 50).toISOString(), reason: 'Checked in late from my desk; I arrived for the stand-up',
      }));
    }

    const counts = await Promise.all([
      prisma.leaveRequest.groupBy({ by: ['status'], _count: true }),
      prisma.overtimeRequest.groupBy({ by: ['status'], _count: true }),
      prisma.attendanceCorrection.groupBy({ by: ['status'], _count: true }),
    ]);
    await audit.record(prisma, {
      actorUserId: null, action: 'DEMO_DATA_GENERATED', entityType: 'Demo', entityId: MARK,
      after: { from, to: workdays[workdays.length - 1], sessions },
    });
    log.log(`Requests now in the database - leave ${JSON.stringify(counts[0])}, overtime ${JSON.stringify(counts[1])}, corrections ${JSON.stringify(counts[2])}`);
  } finally {
    await app.close();
  }
}

main()
  .catch((e) => {
    log.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

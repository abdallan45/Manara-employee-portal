// Pure attendance math: one employee, one work date. No I/O; every other module delegates here.
import type { DayMetrics, DayStatus, SaturdayRotaDay, ScheduleType } from '@workforce/shared';
import { localDate, localDateTime, TIMEZONE } from '../../common/time';

const MINUTE = 60_000;

/** The schedule rules that apply to one employee on one date (output of ScheduleResolver). */
export interface ScheduleDayRule {
  scheduleId: string | null;
  scheduleName: string;
  type: ScheduleType;
  isWorkday: boolean;
  /** Minutes after local midnight. endMinute < startMinute means the shift ends the next day. */
  startMinute: number | null;
  endMinute: number | null;
  requiredMinutes: number;
  graceMinutes: number;
  coreStartMinute: number | null;
  coreEndMinute: number | null;
  /**
   * Break time included in the working day: breaks are deducted from net work only beyond this
   * allowance (a 9-hour day "including a 1-hour break" = requiredMinutes 540, includedBreakMinutes 60).
   */
  includedBreakMinutes?: number;
}

export type CalcSessionStatus = 'OPEN' | 'CLOSED' | 'MISSING_CHECKOUT';

export interface CalcSession {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  status: CalcSessionStatus;
}

export interface CalcBreak {
  sessionId: string;
  startedAt: Date;
  endedAt: Date | null;
  isPaid: boolean;
  maxMinutes: number | null;
  countsAsWork: boolean;
}

export interface DayCalcInput {
  /** Local work date YYYY-MM-DD. Sessions passed in must have this work date (local date of check-in). */
  workDate: string;
  schedule: ScheduleDayRule;
  isHoliday: boolean;
  sessions: CalcSession[];
  breaks: CalcBreak[];
  now: Date;
  /** Full-day approved leave on a working day (see attendance/leave-days.ts). */
  onLeave?: boolean;
  /** Approved half-day / hourly leave that reduces the required minutes. */
  leaveMinutes?: number;
  /**
   * Instants covered by that half-day / hourly leave. Leave covering the start (or end) of the shift
   * moves the time the employee is due (or may leave); leave inside the core window counts as covered.
   */
  leaveWindows?: { startAt: Date; endAt: Date }[];
  /** Approved remote work: only marks the day (DayMetrics.remote); requirement, lateness and absence are unchanged. */
  remote?: boolean;
  /**
   * Saturday rota day (ResolvedDay.saturdayRota). WORKING days arrive as ordinary workdays; on OFF days the
   * schedule rule is already a day off and time worked is recorded but never counts as extra.
   */
  saturdayRota?: SaturdayRotaDay | null;
  zone?: string;
}

type Interval = [number, number];

const floorMin = (ms: number) => Math.max(0, Math.floor(ms / MINUTE));

const hhmm = (minutes: number | null): string | null => {
  if (minutes === null) return null;
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Total length of the union of intervals clipped to [from, to). */
function coveredMs(intervals: Interval[], from: number, to: number): number {
  const clipped = intervals
    .map(([a, b]): Interval => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [a, b] of clipped) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    } else if (b > curEnd) {
      curEnd = b;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Subtracts every `cut` interval from every `base` interval. */
function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let result = base;
  for (const [ca, cb] of cuts) {
    const next: Interval[] = [];
    for (const [a, b] of result) {
      if (cb <= a || ca >= b) { next.push([a, b]); continue; }
      if (ca > a) next.push([a, ca]);
      if (cb < b) next.push([cb, b]);
    }
    result = next;
  }
  return result;
}

/** Moves `t` forward past every interval that covers it (chained intervals included). */
function pushPast(t: number, intervals: Interval[]): number {
  for (let moved = true; moved; ) {
    moved = false;
    for (const [a, b] of intervals) if (a <= t && t < b) { t = b; moved = true; }
  }
  return t;
}

/** Moves `t` back before every interval that covers the time just before it. */
function pullBefore(t: number, intervals: Interval[]): number {
  for (let moved = true; moved; ) {
    moved = false;
    for (const [a, b] of intervals) if (a < t && t <= b) { t = a; moved = true; }
  }
  return t;
}

export function computeDayMetrics(input: DayCalcInput): DayMetrics {
  const { workDate, schedule, isHoliday, now } = input;
  const zone = input.zone ?? TIMEZONE;
  const nowMs = now.getTime();

  const missingPunch = input.sessions.some((s) => s.status === 'MISSING_CHECKOUT');
  const counted = input.sessions.filter((s) => s.status !== 'MISSING_CHECKOUT');
  const openSession = counted.some((s) => s.status === 'OPEN');
  const closedSessions = counted.filter((s) => s.status === 'CLOSED' && s.endedAt);

  // Session intervals; open sessions run until now. MISSING_CHECKOUT sessions contribute nothing.
  const sessionEnd = new Map<string, number>();
  const sessionIntervals: Interval[] = [];
  for (const s of counted) {
    const start = s.startedAt.getTime();
    const end = Math.max(start, s.endedAt ? s.endedAt.getTime() : nowMs);
    sessionEnd.set(s.id, end);
    sessionIntervals.push([start, end]);
  }
  const presenceMs = sessionIntervals.reduce((sum, [a, b]) => sum + (b - a), 0);

  let breakMs = 0;
  let paidMs = 0;
  let excessMs = 0;
  let deductMs = 0;
  let openBreak = false;
  const nonWorkBreakIntervals: Interval[] = [];
  for (const b of input.breaks) {
    const sEnd = sessionEnd.get(b.sessionId);
    if (sEnd === undefined) continue; // break of a MISSING_CHECKOUT (or foreign) session
    if (b.endedAt === null) openBreak = true;
    const start = b.startedAt.getTime();
    const end = Math.max(start, Math.min(b.endedAt ? b.endedAt.getTime() : nowMs, sEnd));
    const dur = end - start;
    const excess = b.maxMinutes === null ? 0 : Math.max(0, dur - b.maxMinutes * MINUTE);
    breakMs += dur;
    excessMs += excess;
    if (b.isPaid) paidMs += dur - excess;
    // Excess is never paid: even a break that counts as work loses its excess from net work.
    if (b.countsAsWork) {
      deductMs += excess;
      if (excess > 0) nonWorkBreakIntervals.push([end - excess, end]);
    } else {
      deductMs += dur;
      nonWorkBreakIntervals.push([start, end]);
    }
  }

  const presenceMinutes = floorMin(presenceMs);
  const breakMinutes = floorMin(breakMs);
  const paidBreakMinutes = floorMin(paidMs);
  // Break time within the included allowance stays part of the working day.
  const allowanceMs = Math.max(0, schedule.includedBreakMinutes ?? 0) * MINUTE;
  const netWorkMinutes = floorMin(presenceMs - Math.max(0, deductMs - allowanceMs));

  const isScheduledDay = schedule.isWorkday && !isHoliday && !input.onLeave;
  const requiredMinutes = isScheduledDay ? Math.max(0, schedule.requiredMinutes - (input.leaveMinutes ?? 0)) : 0;

  const firstInMs = input.sessions.length ? Math.min(...input.sessions.map((s) => s.startedAt.getTime())) : null;
  const lastOutMs = closedSessions.length ? Math.max(...closedSessions.map((s) => s.endedAt!.getTime())) : null;
  const checkedOut = !openSession && closedSessions.length > 0;
  const dayPassed = workDate < localDate(now, zone);
  const complete = dayPassed || checkedOut;

  const missingMinutes = complete ? Math.max(0, requiredMinutes - netWorkMinutes) : 0;
  const saturdayRota = isHoliday ? null : input.saturdayRota ?? null;
  const extraMinutes = saturdayRota === 'OFF' ? 0 : Math.max(0, netWorkMinutes - requiredMinutes);

  let lateMinutes = 0;
  let earlyDepartureMinutes = 0;
  let missingCoreMinutes = 0;
  let dueAtMs: number | null = null; // when a no-show becomes ABSENT
  const graceMs = schedule.graceMinutes * MINUTE;
  const at = (minute: number) => localDateTime(workDate, minute, zone).getTime();
  const leaveIntervals: Interval[] = (isScheduledDay ? input.leaveWindows ?? [] : [])
    .map((w): Interval => [w.startAt.getTime(), w.endAt.getTime()])
    .filter(([a, b]) => b > a);

  if (isScheduledDay && schedule.type === 'FIXED' && schedule.startMinute !== null) {
    // Leave at the start of the shift moves the due time to its end; leave at the end moves the end to its start.
    const startMs = pushPast(at(schedule.startMinute), leaveIntervals);
    const endMs = schedule.endMinute === null ? null
      : pullBefore(at(schedule.endMinute < schedule.startMinute ? schedule.endMinute + 1440 : schedule.endMinute), leaveIntervals);
    if (endMs === null || startMs < endMs) {
      dueAtMs = startMs + graceMs;
      if (firstInMs !== null) lateMinutes = floorMin(firstInMs - dueAtMs);
      if (checkedOut && lastOutMs !== null && endMs !== null) earlyDepartureMinutes = floorMin(endMs - graceMs - lastOutMs);
    }
  } else if (isScheduledDay && schedule.type === 'FLEXIBLE' && schedule.coreStartMinute !== null && schedule.coreEndMinute !== null) {
    const coreStart = pushPast(at(schedule.coreStartMinute), leaveIntervals);
    const coreEnd = pullBefore(at(schedule.coreEndMinute < schedule.coreStartMinute ? schedule.coreEndMinute + 1440 : schedule.coreEndMinute), leaveIntervals);
    if (coreStart < coreEnd) {
      dueAtMs = coreStart + graceMs;
      if (firstInMs !== null) lateMinutes = floorMin(firstInMs - dueAtMs);
      const windowEnd = Math.min(coreEnd, nowMs);
      if (windowEnd > coreStart) {
        // Leave inside the core window counts as covered.
        const covered = [...subtract(sessionIntervals, nonWorkBreakIntervals), ...leaveIntervals];
        missingCoreMinutes = floorMin(windowEnd - coreStart - coveredMs(covered, coreStart, windowEnd));
      }
      if (checkedOut && lastOutMs !== null) earlyDepartureMinutes = floorMin(coreEnd - lastOutMs);
    }
  }

  let status: DayStatus;
  if (openBreak && openSession) status = 'ON_BREAK';
  else if (openSession) status = 'WORKING';
  else if (missingPunch) status = 'MISSING_PUNCH';
  else if (closedSessions.length > 0) status = 'CHECKED_OUT';
  else if (input.onLeave || (isScheduledDay && requiredMinutes === 0 && (input.leaveMinutes ?? 0) > 0)) status = 'ON_LEAVE';
  else if (isScheduledDay) status = dayPassed || (dueAtMs !== null && nowMs >= dueAtMs) ? 'ABSENT' : 'NOT_STARTED';
  else status = 'NOT_SCHEDULED';

  const scheduledWorkday = schedule.isWorkday && !isHoliday;
  return {
    workDate,
    status,
    scheduled: {
      type: schedule.type,
      isWorkday: scheduledWorkday,
      start: scheduledWorkday ? hhmm(schedule.startMinute) : null,
      end: scheduledWorkday ? hhmm(schedule.endMinute) : null,
      requiredMinutes,
      coreStart: hhmm(schedule.coreStartMinute),
      coreEnd: hhmm(schedule.coreEndMinute),
    },
    firstIn: firstInMs === null ? null : new Date(firstInMs).toISOString(),
    lastOut: lastOutMs === null ? null : new Date(lastOutMs).toISOString(),
    presenceMinutes,
    breakMinutes,
    paidBreakMinutes,
    unpaidBreakMinutes: Math.max(0, breakMinutes - paidBreakMinutes),
    excessBreakMinutes: floorMin(excessMs),
    netWorkMinutes,
    requiredMinutes,
    includedBreakMinutes: floorMin(allowanceMs),
    breakAllowanceLeftMinutes: floorMin(allowanceMs - deductMs),
    missingMinutes,
    extraMinutes,
    lateMinutes,
    earlyDepartureMinutes,
    missingCoreMinutes,
    missingPunch,
    isLate: lateMinutes > 0,
    remote: !!input.remote && isScheduledDay,
    saturdayRota,
  };
}

/** Sums net/required/extra over a set of days (week / month to date). */
export function sumPeriod(days: DayMetrics[]): { netWorkMinutes: number; requiredMinutes: number; extraMinutes: number } {
  return days.reduce(
    (acc, d) => ({
      netWorkMinutes: acc.netWorkMinutes + d.netWorkMinutes,
      requiredMinutes: acc.requiredMinutes + d.requiredMinutes,
      extraMinutes: acc.extraMinutes + d.extraMinutes,
    }),
    { netWorkMinutes: 0, requiredMinutes: 0, extraMinutes: 0 },
  );
}

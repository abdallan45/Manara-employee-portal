// Turns approved leave requests into calc.ts inputs (onLeave / leaveMinutes / leaveWindows / remote) for one date. Pure.
import { localDate, TIMEZONE } from '../../common/time';

export interface ApprovedLeave {
  mode: string; // FULL_DAY | HALF_DAY | HOURLY
  startAt: Date;
  endAt: Date;
  minutes: number;
  /** Request of a remote-work type: a working day, not leave. */
  remote?: boolean;
}

/** True when an approved remote-work request covers local date `date` (working day or not). */
export function remoteOn(leaves: ApprovedLeave[], date: string, zone = TIMEZONE): boolean {
  return leaves.some((l) => {
    if (!l.remote) return false;
    const { startDate, endDate } = leaveDates(l, zone);
    return date >= startDate && date <= endDate;
  });
}

/** Local dates [first, last] covered by a request (endAt is exclusive). */
export function leaveDates(l: { startAt: Date; endAt: Date }, zone = TIMEZONE): { startDate: string; endDate: string } {
  return { startDate: localDate(l.startAt, zone), endDate: localDate(new Date(l.endAt.getTime() - 1), zone) };
}

/**
 * Full-day leave marks a working day as on leave (non-working days are untouched so weekends stay
 * NOT_SCHEDULED). Half-day and hourly leave reduce that day's required minutes, and their instants
 * (a half-day request stores the half of the shift it covers) shift lateness / early departure.
 * Remote work (any mode) is not leave: the day keeps its full schedule and is only marked remote.
 */
export function leaveForDay(
  leaves: ApprovedLeave[], date: string, isWorkingDay: boolean, zone = TIMEZONE,
): { onLeave: boolean; leaveMinutes: number; leaveWindows: { startAt: Date; endAt: Date }[]; remote: boolean } {
  let onLeave = false;
  let remote = false;
  let leaveMinutes = 0;
  const leaveWindows: { startAt: Date; endAt: Date }[] = [];
  for (const l of leaves) {
    const { startDate, endDate } = leaveDates(l, zone);
    if (date < startDate || date > endDate) continue;
    if (l.remote) remote = remote || isWorkingDay;
    else if (l.mode === 'FULL_DAY') onLeave = onLeave || isWorkingDay;
    else if (isWorkingDay) {
      leaveMinutes += l.minutes;
      leaveWindows.push({ startAt: l.startAt, endAt: l.endAt });
    }
  }
  return { onLeave, leaveMinutes, leaveWindows, remote };
}

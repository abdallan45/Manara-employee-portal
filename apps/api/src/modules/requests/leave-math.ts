// Pure leave math: ledger summaries, accrual, carryover and the cost of a request. No I/O.
import type { HalfDay, LeaveAccrual, LeaveMode } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import { addDays, localDateTime, startOfLocalDay, TIMEZONE } from '../../common/time';

export type LedgerKind = 'ACCRUAL' | 'USAGE' | 'ADJUSTMENT' | 'CARRYOVER' | 'CANCELLATION';

export interface LedgerSummary {
  accrued: number;
  carriedOver: number;
  adjusted: number;
  /** Net usage: debits minus cancellation credits (positive number). */
  used: number;
  balance: number;
}

/** Sums leave_transactions rows of one employee / type / year by kind. */
export function summarizeLedger(rows: { minutes: number; kind: string }[]): LedgerSummary {
  const s = { accrued: 0, carriedOver: 0, adjusted: 0, used: 0, balance: 0 };
  for (const r of rows) {
    s.balance += r.minutes;
    if (r.kind === 'ACCRUAL') s.accrued += r.minutes;
    else if (r.kind === 'CARRYOVER') s.carriedOver += r.minutes;
    else if (r.kind === 'ADJUSTMENT') s.adjusted += r.minutes;
    else s.used -= r.minutes; // USAGE is negative, CANCELLATION gives it back
  }
  return s;
}

/** Types without an accrual and without an entitlement (unpaid, remote work…) have no balance to check. */
export const tracksBalance = (t: { accrual: string; annualEntitlementMinutes: number }) =>
  t.accrual !== 'NONE' || t.annualEntitlementMinutes > 0;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dayOfYear = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
};

/**
 * Yearly grant. In the hire year it is prorated by the days remaining from the hire date (inclusive),
 * rounded down to whole minutes; no grant for years before the hire year.
 */
export function yearlyAccrual(entitlementMinutes: number, year: number, hireDate: string | null): number {
  if (entitlementMinutes <= 0) return 0;
  if (!hireDate) return entitlementMinutes;
  const hireYear = Number(hireDate.slice(0, 4));
  if (year < hireYear) return 0;
  if (year > hireYear) return entitlementMinutes;
  const days = isLeap(year) ? 366 : 365;
  const remaining = days - dayOfYear(hireDate) + 1;
  return Math.floor((entitlementMinutes * remaining) / days);
}

/**
 * Monthly accrual rows due for `year` up to and including month `upToMonth` (1–12).
 * Month m earns floor(E·m/12) − floor(E·(m−1)/12) so twelve months add up to exactly E.
 * Months before the hire month earn nothing; the hire month earns in full.
 */
export function monthlyAccruals(entitlementMinutes: number, year: number, hireDate: string | null, upToMonth: number): { month: string; minutes: number }[] {
  if (entitlementMinutes <= 0 || upToMonth < 1) return [];
  const hireYear = hireDate ? Number(hireDate.slice(0, 4)) : null;
  if (hireYear !== null && year < hireYear) return [];
  const firstMonth = hireYear === year ? Number(hireDate!.slice(5, 7)) : 1;
  const out: { month: string; minutes: number }[] = [];
  for (let m = firstMonth; m <= Math.min(12, upToMonth); m++) {
    const minutes = Math.floor((entitlementMinutes * m) / 12) - Math.floor((entitlementMinutes * (m - 1)) / 12);
    if (minutes > 0) out.push({ month: `${year}-${String(m).padStart(2, '0')}`, minutes });
  }
  return out;
}

/** Months of `year` whose monthly accrual is due by `today` (all twelve for past years, none for future ones). */
export function monthsDue(year: number, today: string): number {
  const thisYear = Number(today.slice(0, 4));
  return year < thisYear ? 12 : year === thisYear ? Number(today.slice(5, 7)) : 0;
}

/** Everything the accrual schedule should have granted for `year` by `today` with this entitlement. */
export function accrualDue(mode: LeaveAccrual | 'NONE', entitlementMinutes: number, year: number, hireDate: string | null, today: string): number {
  if (mode === 'YEARLY') return yearlyAccrual(entitlementMinutes, year, hireDate);
  if (mode === 'MONTHLY') return monthlyAccruals(entitlementMinutes, year, hireDate, monthsDue(year, today)).reduce((s, m) => s + m.minutes, 0);
  return 0;
}

/** Unused balance carried into the next year, capped; a negative balance is never carried. */
export const carryoverMinutes = (previousBalance: number, capMinutes: number) => Math.max(0, Math.min(previousBalance, capMinutes));

/** Which accrual schedule a type follows (NONE with an entitlement behaves like a yearly grant). */
export const accrualMode = (t: { accrual: string; annualEntitlementMinutes: number }): LeaveAccrual | 'NONE' =>
  t.accrual === 'MONTHLY' ? 'MONTHLY' : tracksBalance(t) ? 'YEARLY' : 'NONE';

// ───────────────────────────── Request cost ─────────────────────────────

/** Schedule facts for one local date (from ScheduleResolver). */
export interface LeaveDayRule {
  isWorkday: boolean;
  isHoliday: boolean;
  requiredMinutes: number;
  startMinute: number | null;
  endMinute: number | null;
}

export interface LeaveSpanInput {
  mode: LeaveMode;
  startDate: string;
  endDate: string;
  half?: HalfDay;
  startTime?: string;
  endTime?: string;
}

export interface LeaveSpan {
  minutes: number;
  workdays: number;
  startAt: Date;
  endAt: Date;
}

const invalid = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);

export const parseHhmm = (value: string | undefined, field: string): number => {
  const m = value?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw invalid(field, `${field} must be HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Minutes a request takes from the balance and the instants it covers.
 * FULL_DAY: the required minutes of every working day in the range (weekends and holidays are free).
 * HALF_DAY: half of that day's required minutes; FIRST/SECOND split the scheduled shift (or the calendar day).
 * HOURLY: the given local times on one working day, at most that day's required minutes.
 */
export function computeLeaveSpan(input: LeaveSpanInput, day: (date: string) => LeaveDayRule, zone = TIMEZONE): LeaveSpan {
  const working = (r: LeaveDayRule) => r.isWorkday && !r.isHoliday && r.requiredMinutes > 0;

  if (input.mode === 'FULL_DAY') {
    let minutes = 0;
    let workdays = 0;
    for (let d = input.startDate; d <= input.endDate; d = addDays(d, 1, zone)) {
      const r = day(d);
      if (!working(r)) continue;
      minutes += r.requiredMinutes;
      workdays += 1;
    }
    if (workdays === 0) throw invalid('startDate', 'The selected dates contain no working days');
    return { minutes, workdays, startAt: startOfLocalDay(input.startDate, zone), endAt: startOfLocalDay(addDays(input.endDate, 1, zone), zone) };
  }

  const r = day(input.startDate);
  if (!working(r)) throw invalid('startDate', 'The selected date is not a working day');

  if (input.mode === 'HALF_DAY') {
    if (input.half !== 'FIRST' && input.half !== 'SECOND') throw invalid('half', 'half must be FIRST or SECOND');
    const firstHalf = Math.floor(r.requiredMinutes / 2);
    let from = 0;
    let to = 1440;
    if (r.startMinute !== null && r.endMinute !== null) {
      from = r.startMinute;
      to = r.endMinute <= r.startMinute ? r.endMinute + 1440 : r.endMinute;
    }
    const mid = from + Math.floor((to - from) / 2);
    const [a, b] = input.half === 'FIRST' ? [from, mid] : [mid, to];
    return {
      minutes: input.half === 'FIRST' ? firstHalf : r.requiredMinutes - firstHalf,
      workdays: 1,
      startAt: localDateTime(input.startDate, a, zone),
      endAt: localDateTime(input.startDate, b, zone),
    };
  }

  const from = parseHhmm(input.startTime, 'startTime');
  const to = parseHhmm(input.endTime, 'endTime');
  if (to <= from) throw invalid('endTime', 'endTime must be after startTime');
  if (to - from > r.requiredMinutes) throw invalid('endTime', 'Hourly leave cannot exceed the working hours of that day');
  return { minutes: to - from, workdays: 1, startAt: localDateTime(input.startDate, from, zone), endAt: localDateTime(input.startDate, to, zone) };
}

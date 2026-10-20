import { DateTime } from 'luxon';
import { AppError } from '../../common/app-error';
import { addDays, localDate, TIMEZONE } from '../../common/time';

export function assertDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !DateTime.fromISO(value, { zone: TIMEZONE }).isValid) {
    throw AppError.badRequest('VALIDATION_FAILED', `${field} must be a valid YYYY-MM-DD date`, { field, value });
  }
  return value;
}

/** Number of calendar days from `from` to `to` inclusive. */
export function daySpan(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: 'UTC' }).diff(DateTime.fromISO(from, { zone: 'UTC' }), 'days').days) + 1;
}

/** Validates an inclusive local-date range (defaults: month to date) with an optional maximum length. */
export function resolveRange(from: string | undefined, to: string | undefined, maxDays: number, now = new Date()): { from: string; to: string } {
  const today = localDate(now);
  const end = to ? assertDate(to, 'to') : today;
  const start = from ? assertDate(from, 'from') : `${end.slice(0, 8)}01`;
  if (start > end) throw AppError.badRequest('VALIDATION_FAILED', '`from` must not be after `to`', { from: start, to: end });
  if (daySpan(start, end) > maxDays) throw AppError.badRequest('VALIDATION_FAILED', `Range may not exceed ${maxDays} days`, { from: start, to: end, maxDays });
  return { from: start, to: end };
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

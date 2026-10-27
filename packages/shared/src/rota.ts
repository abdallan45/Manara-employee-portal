// Alternating Saturdays: the team is split into groups A and B, which work every other Saturday.

export type SaturdayGroup = 'A' | 'B';
/** Stored on an employee: a group, NONE (no rota), or null (the department's group). */
export type EmployeeSaturdayGroup = SaturdayGroup | 'NONE';
export const SATURDAY_GROUPS: readonly SaturdayGroup[] = ['A', 'B'];
export type SaturdayRotaDay = 'WORKING' | 'OFF';

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a YYYY-MM-DD calendar date, or null if it is not a real date. */
function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

/** A valid YYYY-MM-DD date that falls on a Saturday. */
export function isSaturdayDate(date: string): boolean {
  const n = dayNumber(date);
  return n !== null && new Date(n * DAY_MS).getUTCDay() === 6;
}

/** The group effective for an employee: their own (NONE = no rota), else the department's. */
export function effectiveSaturdayGroup(own: string | null | undefined, department: string | null | undefined): SaturdayGroup | null {
  if (own === 'NONE') return null;
  if (own === 'A' || own === 'B') return own;
  return department === 'A' || department === 'B' ? department : null;
}

/**
 * Rota day of a Saturday: start is group A's first working Saturday, then the groups alternate weekly.
 * Null when the date is not a Saturday, is before start, or there is no start or no group.
 */
export function saturdayRotaFor(date: string, start: string | null, group: SaturdayGroup | null): SaturdayRotaDay | null {
  if (!start || !group || !isSaturdayDate(date) || !isSaturdayDate(start) || date < start) return null;
  const weeks = Math.round((dayNumber(date)! - dayNumber(start)!) / 7);
  const working: SaturdayGroup = weeks % 2 === 0 ? 'A' : 'B';
  return working === group ? 'WORKING' : 'OFF';
}

const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The first `count` Saturdays on or after a date. */
export function saturdaysFrom(date: string, count: number): string[] {
  const n = dayNumber(date);
  if (n === null) return [];
  const first = n + ((6 - new Date(n * DAY_MS).getUTCDay() + 7) % 7);
  return Array.from({ length: count }, (_, i) => fromDayNumber(first + 7 * i));
}

/** The group's first working Saturday on or after a date (null without a rota or a group). */
export function nextWorkingSaturday(date: string, start: string | null, group: SaturdayGroup | null): string | null {
  if (!start || !group || !isSaturdayDate(start)) return null;
  const from = date < start ? start : date;
  return saturdaysFrom(from, 2).find((d) => saturdayRotaFor(d, start, group) === 'WORKING') ?? null;
}

/** The group working on a rota Saturday, or null outside the rota. */
export function saturdayWorkingGroup(date: string, start: string | null): SaturdayGroup | null {
  return saturdayRotaFor(date, start, 'A') === 'WORKING' ? 'A' : saturdayRotaFor(date, start, 'B') === 'WORKING' ? 'B' : null;
}

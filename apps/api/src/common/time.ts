import { DateTime } from 'luxon';

/** Company timezone. All local-date logic (work dates, schedules, holidays) uses this zone. */
export const TIMEZONE = process.env.TZ_COMPANY || 'Asia/Amman';

/** Local calendar date (YYYY-MM-DD) of an instant in the company timezone. */
export function localDate(instant: Date, zone = TIMEZONE): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/** UTC instant of local midnight at the start of a YYYY-MM-DD date. */
export function startOfLocalDay(date: string, zone = TIMEZONE): Date {
  return DateTime.fromISO(date, { zone }).startOf('day').toJSDate();
}

/** UTC instant for a local date plus minutes after midnight (minutes may exceed 1440 for overnight). */
export function localDateTime(date: string, minutesAfterMidnight: number, zone = TIMEZONE): Date {
  return DateTime.fromISO(date, { zone }).startOf('day').plus({ minutes: minutesAfterMidnight }).toJSDate();
}

/** Weekday 0 = Sunday … 6 = Saturday for a local date. */
export function weekdayOf(date: string, zone = TIMEZONE): number {
  return DateTime.fromISO(date, { zone }).weekday % 7;
}

export function addDays(date: string, days: number, zone = TIMEZONE): string {
  return DateTime.fromISO(date, { zone }).plus({ days }).toISODate()!;
}

/** Prisma returns @db.Date columns as UTC-midnight Dates; this converts to/from YYYY-MM-DD. */
export const dateOnly = {
  toDb: (date: string) => new Date(`${date}T00:00:00.000Z`),
  fromDb: (d: Date) => d.toISOString().slice(0, 10),
};

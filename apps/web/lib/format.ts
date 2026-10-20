import type { Locale } from '@/lib/i18n/dictionaries';

/** All wall-clock values are shown in company time, with Latin digits in both languages. */
export const TIME_ZONE = 'Asia/Amman';

const intlLocale = (locale: Locale) => (locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB');

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: Locale, opts: Intl.DateTimeFormatOptions, tz: string = TIME_ZONE): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocale(locale), { ...opts, timeZone: tz, numberingSystem: 'latn' });
    cache.set(key, f);
  }
  return f;
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatTime(value: string | number | Date | null | undefined, locale: Locale, withSeconds = false): string {
  if (value === null || value === undefined) return '—';
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf(locale, { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false }).format(d);
}

export function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf(locale, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** Calendar date "YYYY-MM-DD" (already an Amman local date) -> noon UTC so formatting never shifts the day. */
function workDateToUtc(date: string): Date {
  return new Date(`${date.slice(0, 10)}T12:00:00Z`);
}

export function formatWorkDate(date: string | null | undefined, locale: Locale, style: 'short' | 'long' = 'short'): string {
  if (!date) return '—';
  const d = workDateToUtc(date);
  if (Number.isNaN(d.getTime())) return date;
  return dtf(locale, style === 'long' ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' } : { year: 'numeric', month: 'short', day: '2-digit' }, 'UTC').format(d);
}

export function formatWeekday(date: string, locale: Locale, style: 'short' | 'long' = 'short'): string {
  const d = workDateToUtc(date);
  if (Number.isNaN(d.getTime())) return '';
  return dtf(locale, { weekday: style }, 'UTC').format(d);
}

export function formatDayMonth(date: string, locale: Locale): string {
  const d = workDateToUtc(date);
  if (Number.isNaN(d.getTime())) return date;
  return dtf(locale, { day: 'numeric', month: 'short' }, 'UTC').format(d);
}

export function formatClockDate(ms: number, locale: Locale): string {
  return dtf(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
}

/** Schedule boundaries may arrive as "HH:MM" or as ISO timestamps. */
export function formatScheduleTime(value: string | null, locale: Locale): string {
  if (!value) return '—';
  if (/^\d{1,2}:\d{2}/.test(value)) return value.slice(0, 5);
  return formatTime(value, locale);
}

/** Today's Amman calendar date as YYYY-MM-DD. */
export function todayInAmman(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days between two YYYY-MM-DD dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export interface DurationUnits {
  h: string;
  m: string;
}

/** 455 -> "7h 35m" (units come from the dictionary). Negative values keep their sign. */
export function formatMinutes(minutes: number | null | undefined, units: DurationUnits): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const total = Math.round(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${sign}${m}${units.m}`;
  if (m === 0) return `${sign}${h}${units.h}`;
  return `${sign}${h}${units.h} ${m}${units.m}`;
}

export interface DurationPart {
  /** The number, with a leading "-" on the first part of a negative duration. */
  value: string;
  unit: string;
}

/**
 * 455 -> [{ value: '7', unit: 'h' }, { value: '35', unit: 'm' }]: the same parts formatMinutes joins, for
 * components that render each number in its own <bdi> so Arabic reads hours before minutes. Empty for
 * null / undefined / NaN (render "—").
 */
export function formatDurationParts(minutes: number | null | undefined, units: DurationUnits): DurationPart[] {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return [];
  const sign = minutes < 0 ? '-' : '';
  const total = Math.round(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return [{ value: `${sign}${m}`, unit: units.m }];
  if (m === 0) return [{ value: `${sign}${h}`, unit: units.h }];
  return [
    { value: `${sign}${h}`, unit: units.h },
    { value: String(m), unit: units.m },
  ];
}

/**
 * Parses a number typed with Western, Arabic-Indic (U+0660–0669) or Extended Arabic-Indic (U+06F0–06F9)
 * digits. Accepts "." / "," / "٫" as the decimal separator (one at most) and a leading sign; trims spaces
 * and ignores the Arabic thousands separator "٬".
 * parseLocaleNumber('١٫٢٥') -> 1.25, parseLocaleNumber('2,5') -> 2.5, parseLocaleNumber('') -> null.
 */
export function parseLocaleNumber(input: string): number | null {
  if (typeof input !== 'string') return null;
  let s = '';
  for (const ch of input.trim()) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) s += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) s += String(code - 0x06f0);
    else if (ch === '٫' || ch === ',') s += '.';
    else if (ch === '٬') continue; // Arabic thousands separator
    else if (ch === '−') s += '-';
    else s += ch;
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Milliseconds -> "HH:MM:SS" for live timers. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatNumber(value: number, locale: Locale, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(intlLocale(locale), { numberingSystem: 'latn', ...opts } as Intl.NumberFormatOptions).format(value);
}

export function formatPercent(ratio: number, locale: Locale): string {
  return formatNumber(ratio, locale, { style: 'percent', maximumFractionDigits: 1 });
}

export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

/** Picks the Arabic variant of a stored name when the UI is Arabic and one exists. */
export const localized = (locale: Locale, name: string | null | undefined, nameAr: string | null | undefined): string =>
  (locale === 'ar' && nameAr) || name || '';

/** ISO instant -> "YYYY-MM-DDTHH:mm" wall time in Amman, for <input type="datetime-local"> (the API reads it as company time). */
export function toAmmanInput(value: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(toDate(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

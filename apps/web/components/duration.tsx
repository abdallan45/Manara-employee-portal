'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { formatClock, formatDurationParts, formatScheduleTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * Static minutes value: 455 -> "7h 35m" / "7 س 35 د". Zero renders muted.
 * Each number sits in its own <bdi> and the span follows the UI direction, so Arabic reads hours before
 * minutes even inside an LTR container. Exports and Excel keep using formatMinutes.
 */
export function Minutes({ value, className, dimZero = true }: { value: number | null | undefined; className?: string; dimZero?: boolean }) {
  const { units, locale, dir } = useI18n();
  const parts = formatDurationParts(value, units);
  const gap = locale === 'ar' ? ' ' : '';
  return (
    <span className={cn('tabular whitespace-nowrap', dimZero && (value ?? 0) === 0 && 'text-muted-foreground', className)} dir={dir}>
      {parts.length === 0
        ? '—'
        : parts.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <bdi>{p.value}</bdi>
              {gap}
              {p.unit}
            </Fragment>
          ))}
    </span>
  );
}

/**
 * "08:00 – 16:30": each time in <bdi>, joined by an en dash, in the UI's reading order (the start time
 * comes first for Arabic readers too). Accepts ISO timestamps or "HH:MM" schedule times; a missing end
 * renders `endFallback` (default "…", e.g. an open work period).
 */
export function TimeRange({ start, end, className, endFallback = '…' }: {
  start: string | null | undefined;
  end: string | null | undefined;
  className?: string;
  endFallback?: ReactNode;
}) {
  const { locale, dir } = useI18n();
  const s = formatScheduleTime(start ?? null, locale);
  return (
    <span className={cn('tabular whitespace-nowrap', className)} dir={dir}>
      <bdi>{s}</bdi>
      {' – '}
      {end ? <bdi>{formatScheduleTime(end, locale)}</bdi> : <bdi>{endFallback}</bdi>}
    </span>
  );
}

/** Returns a timestamp that updates every second (corrected by a server offset). */
export function useNow(offsetMs = 0, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    setNow(Date.now() + offsetMs);
    const id = window.setInterval(() => setNow(Date.now() + offsetMs), intervalMs);
    return () => window.clearInterval(id);
  }, [offsetMs, intervalMs]);
  return now;
}

/** Live HH:MM:SS since `since`, using server-corrected time. The clock is isolated in <bdi>. */
export function LiveTimer({ since, offsetMs, className }: { since: string; offsetMs: number; className?: string }) {
  const now = useNow(offsetMs);
  const ms = now - new Date(since).getTime();
  return (
    <span className={cn('num tabular', className)}>
      <bdi>{formatClock(ms)}</bdi>
    </span>
  );
}

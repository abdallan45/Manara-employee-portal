'use client';

import type { AttendanceAction, AttendanceEventDto } from '@workforce/shared';
import type { LucideIcon } from 'lucide-react';
import { Coffee, LogIn, LogOut, MapPin, ShieldAlert, ShieldCheck, TimerReset } from 'lucide-react';

import { formatDayMonth, formatTime, formatWeekday, localized } from '@/lib/format';
import { formatDistance, mapsUrl } from '@/lib/geolocation';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/** `mirror`: only direction-bearing icons (LogIn / LogOut arrows) flip in RTL; the cup and the timer never do. */
const EVENT_ICON: Record<AttendanceAction, { icon: LucideIcon; color: string; mirror: boolean }> = {
  CHECK_IN: { icon: LogIn, color: 'var(--status-working)', mirror: true },
  CHECK_OUT: { icon: LogOut, color: 'var(--status-out)', mirror: true },
  BREAK_START: { icon: Coffee, color: 'var(--status-break)', mirror: false },
  BREAK_END: { icon: TimerReset, color: 'var(--brand-soft)', mirror: false },
};

/** The Amman calendar date of an ISO timestamp, as YYYY-MM-DD. */
function ammanDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** Check-in and check-out carry the device location; breaks carry none. */
const LOCATED: ReadonlySet<AttendanceAction> = new Set(['CHECK_IN', 'CHECK_OUT']);

/**
 * Attendance events, newest first as given. `showSource` (default true, for HR) shows where each punch came
 * from and whether it was made at the office. Employee pages pass false: they only see a note on check-ins
 * and check-outs made away from the office. Both get a map link when the event has a position.
 */
export function EventList({ events, showDate = true, showSource = true, className }: {
  events: AttendanceEventDto[];
  showDate?: boolean;
  showSource?: boolean;
  className?: string;
}) {
  const { t, locale } = useI18n();
  return (
    <ol className={cn('divide-y divide-tint/[0.05]', className)}>
      {events.map((e) => {
        const { icon: Icon, color, mirror } = EVENT_ICON[e.type];
        const day = ammanDate(e.occurredAt);
        const located = LOCATED.has(e.type);
        const away = located && !e.locationVerified && e.source !== 'ADMIN_CORRECTION';
        const where =
          located && (e.distanceMeters !== null || (e.latitude !== null && e.longitude !== null)) ? (
            <>
              {e.distanceMeters !== null && e.officeName && (
                <span className="tabular">
                  <bdi>{fmt(t.events.distanceFrom, { distance: formatDistance(e.distanceMeters, locale), office: e.officeName })}</bdi>
                </span>
              )}
              {e.accuracyMeters !== null && <span className="tabular" dir="ltr">{fmt(t.events.accuracy, { accuracy: formatDistance(e.accuracyMeters, locale) })}</span>}
              {e.latitude !== null && e.longitude !== null && (
                <a
                  href={mapsUrl(e.latitude, e.longitude)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t.events.openMap}
                  className="text-link inline-flex items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                >
                  <MapPin className="size-3" aria-hidden />
                  {t.events.map}
                </a>
              )}
            </>
          ) : null;
        return (
          <li key={e.id} className="flex items-center gap-3 py-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-xl"
              style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
            >
              <Icon className={cn('size-4', mirror && 'rtl:-scale-x-100')} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {t.events[e.type]}
                {e.breakTypeName ? (
                  <span className="text-muted-foreground font-normal">
                    {' · '}
                    <bdi>{localized(locale, e.breakTypeName, e.breakTypeNameAr)}</bdi>
                  </span>
                ) : null}
              </p>
              {showSource ? (
                <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  <span title={e.ipAddress}>{t.events.source[e.source]}</span>
                  {located && (
                    <span className="inline-flex items-center gap-1">
                      {e.locationVerified ? (
                        <ShieldCheck className="size-3 text-[color:var(--status-working)]" aria-hidden />
                      ) : (
                        <ShieldAlert className="size-3 text-[color:var(--status-missing)]" aria-hidden />
                      )}
                      {e.locationVerified ? t.events.verified : t.events.unverified}
                    </span>
                  )}
                  {where}
                </p>
              ) : (
                (away || where) && (
                  <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    {away && (
                      <span className="inline-flex items-center gap-1">
                        <ShieldAlert className="size-3 text-[color:var(--status-missing)]" aria-hidden />
                        {t.employeeSelfService.attendance.outsideOffice}
                      </span>
                    )}
                    {where}
                  </p>
                )
              )}
            </div>
            <div className="text-end">
              <p className="num text-sm">
                <bdi>{formatTime(e.occurredAt, locale)}</bdi>
              </p>
              {showDate && (
                <p className="text-muted-foreground text-xs">
                  {formatWeekday(day, locale)} {formatDayMonth(day, locale)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({ value, max, className, tone = 'brand', label }: {
  value: number;
  max: number;
  className?: string;
  tone?: 'brand' | 'warn';
  label?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-tint/[0.06]', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(Math.min(value, max))}
      aria-label={label}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tone === 'brand' ? 'bg-brand-gradient' : 'bg-[color:var(--status-break)]')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

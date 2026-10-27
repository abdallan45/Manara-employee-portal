'use client';

import Link from 'next/link';
import type { AttendanceEventDto, CorrectableSessionDto, DayMetrics, Paginated } from '@workforce/shared';

import { EventList } from '@/components/attendance-bits';
import { DayOffBadge } from '@/components/day-metrics-table';
import { Minutes, TimeRange } from '@/components/duration';
import { ErrorState, LoadingRows } from '@/components/states';
import { DayStatusBadge, LateBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { addDays, formatTime, formatWorkDate, todayInAmman } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { usePortal } from '@/lib/portal';
import { useApi } from '@/lib/use-api';

/** The Amman calendar date of an ISO timestamp, as YYYY-MM-DD. */
function ammanDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

const correctionUrl = (params: Record<string, string>) => `/me/corrections?${new URLSearchParams({ new: '1', ...params }).toString()}`;

/** Work periods can be corrected for this many past days (the API lists /corrections/me/sessions that far back). */
const CORRECTABLE_DAYS = 31;

/**
 * One day of the employee's own attendance in a side sheet: its figures, its work periods with a direct
 * "fix" link for each (hidden when HR turned off Corrections), and its check-in events (hidden when the
 * event log is turned off). `sessions` are the correctable work periods of the last 31 days; for an older
 * day the sheet shows the day's first check-in and last check-out instead and says only HR can fix it.
 * `sessionsError` / `onRetrySessions` show an error with Retry when the work periods could not be loaded.
 */
export function DaySheet({ day, sessions, sessionsError, onRetrySessions, onOpenChange }: {
  day: DayMetrics | null;
  sessions: CorrectableSessionDto[] | undefined;
  sessionsError?: unknown;
  onRetrySessions?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale, dir } = useI18n();
  const s = t.employeeSelfService;
  const a = s.attendance;
  const c = t.myAttendance.cols;
  const { isVisible } = usePortal();
  const showEvents = isVisible('attendance.events');
  const showCorrections = isVisible('corrections');

  const today = todayInAmman();
  const periods = day ? (sessions ?? []).filter((x) => x.workDate === day.workDate || ammanDate(x.startedAt) === day.workDate) : [];
  const future = day !== null && day.workDate > today;
  const tooOld = day !== null && day.workDate < addDays(today, -CORRECTABLE_DAYS);

  return (
    <Sheet open={day !== null} onOpenChange={onOpenChange}>
      <SheetContent side={dir === 'rtl' ? 'left' : 'right'} className="overflow-y-auto">
        {day && (
          <>
            <SheetHeader>
              <SheetTitle>{formatWorkDate(day.workDate, locale, 'long')}</SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-2">
                  {!day.scheduled.isWorkday && day.status === 'NOT_SCHEDULED' ? (
                    <DayOffBadge rotaOff={day.saturdayRota === 'OFF'} />
                  ) : (
                    <DayStatusBadge status={day.status} remote={day.remote} rotaOff={day.saturdayRota === 'OFF'} />
                  )}
                  {day.isLate && <LateBadge minutes={day.lateMinutes} />}
                  {day.scheduled.isWorkday && day.scheduled.type === 'FIXED' && (
                    <span className="text-muted-foreground text-xs">
                      <TimeRange start={day.scheduled.start} end={day.scheduled.end} />
                    </span>
                  )}
                </div>
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-5 pb-6">
              <section aria-labelledby="day-figures" className="space-y-2">
                <h3 id="day-figures" className="text-sm font-semibold">{a.dayFigures}</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  {([
                    [s.hoursWorked, day.netWorkMinutes, 'font-semibold'],
                    [c.required, day.requiredMinutes, ''],
                    [t.home.breaks, day.breakMinutes, ''],
                    [c.missing, day.missingMinutes, day.missingMinutes > 0 ? 'text-[color:var(--status-missing)]' : ''],
                    [c.extra, day.extraMinutes, day.extraMinutes > 0 ? 'text-[color:var(--status-working)]' : ''],
                    [c.late, day.lateMinutes, ''],
                  ] as const).map(([label, value, cls]) => (
                    <div key={label} className="rounded-xl border border-tint/[0.06] bg-tint/[0.02] p-2.5">
                      <dt className="text-muted-foreground text-xs">{label}</dt>
                      <dd>
                        <Minutes value={value} className={cls || undefined} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section aria-labelledby="day-periods" className="space-y-2">
                <h3 id="day-periods" className="text-sm font-semibold">{a.workPeriods}</h3>
                {tooOld ? (
                  <>
                    {day.firstIn ? (
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <dt className="text-muted-foreground text-xs">{c.firstIn}</dt>
                          <dd><bdi className="tabular">{formatTime(day.firstIn, locale)}</bdi></dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground text-xs">{c.lastOut}</dt>
                          <dd>{day.lastOut ? <bdi className="tabular">{formatTime(day.lastOut, locale)}</bdi> : a.noCheckOut}</dd>
                        </div>
                      </dl>
                    ) : (
                      <p className="text-muted-foreground text-sm">{a.noWorkPeriods}</p>
                    )}
                    {showCorrections && <p className="text-muted-foreground text-xs">{a.correctionWindow}</p>}
                  </>
                ) : sessions === undefined && sessionsError ? (
                  <ErrorState compact error={sessionsError} onRetry={onRetrySessions} />
                ) : sessions === undefined ? (
                  <LoadingRows rows={1} className="p-0" />
                ) : periods.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{a.noWorkPeriods}</p>
                ) : (
                  <ul className="space-y-2">
                    {periods.map((p) => (
                      <li key={p.id} className="space-y-2 rounded-xl border border-tint/[0.06] bg-tint/[0.02] p-3">
                        <p className="text-sm font-medium">
                          <TimeRange start={p.startedAt} end={p.endedAt} endFallback={a.noCheckOut} />
                        </p>
                        {showCorrections &&
                          (p.pendingCorrection ? (
                            <p className="text-muted-foreground text-xs">{s.home.correctionPending}</p>
                          ) : p.status === 'MISSING_CHECKOUT' ? (
                            <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                              <Link href={correctionUrl({ session: p.id })}>{a.addCheckOut}</Link>
                            </Button>
                          ) : p.status === 'CLOSED' ? (
                            <div className="flex flex-wrap gap-2">
                              <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                                <Link href={correctionUrl({ session: p.id, event: 'CHECK_IN' })}>{a.fixCheckIn}</Link>
                              </Button>
                              <Button asChild size="sm" variant="outline" className="max-md:min-h-10">
                                <Link href={correctionUrl({ session: p.id, event: 'CHECK_OUT' })}>{a.fixCheckOut}</Link>
                              </Button>
                            </div>
                          ) : null)}
                      </li>
                    ))}
                  </ul>
                )}
                {showCorrections && day.scheduled.isWorkday && !future && !tooOld && (
                  <Button asChild size="sm" variant="ghost" className="max-md:min-h-10">
                    <Link href={correctionUrl({ date: day.workDate })}>{a.addMissingPeriod}</Link>
                  </Button>
                )}
              </section>

              {/* Keyed by day: each day loads its own events, so another day's punches never show under this title. */}
              {showEvents && <DayEvents key={day.workDate} workDate={day.workDate} />}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The check-ins and check-outs of one day (mounted per day by DaySheet). */
function DayEvents({ workDate }: { workDate: string }) {
  const { t } = useI18n();
  const events = useApi<Paginated<AttendanceEventDto>>('/attendance/me/events', { from: workDate, to: workDate, page: 1, pageSize: 50 });
  return (
    <section aria-labelledby="day-events" className="space-y-1">
      <h3 id="day-events" className="text-sm font-semibold">{t.employeeSelfService.attendance.events}</h3>
      {events.error && !events.data ? (
        <ErrorState compact error={events.error} onRetry={() => void events.refetch()} />
      ) : !events.data ? (
        <LoadingRows rows={2} className="p-0" />
      ) : events.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t.events.empty}</p>
      ) : (
        <EventList events={[...events.data.items].reverse()} showDate={false} showSource={false} />
      )}
    </section>
  );
}

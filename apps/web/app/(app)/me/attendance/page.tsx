'use client';

import { Suspense, useEffect, useState } from 'react';
import { CalendarCheck, Clock, Columns3, Hourglass, TrendingUp } from 'lucide-react';
import { PERMISSIONS, type AttendanceEventDto, type CorrectableSessionDto, type DayMetrics, type Paginated } from '@workforce/shared';

import { EventList } from '@/components/attendance-bits';
import { Pagination } from '@/components/data-table';
import { currentMonthRange, DateRangePicker } from '@/components/date-range';
import { DayMetricsTable, sumMetrics } from '@/components/day-metrics-table';
import { DaySheet } from '@/components/day-sheet';
import { KpiCard } from '@/components/kpi-card';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/context';
import { usePortal } from '@/lib/portal';
import { useApi } from '@/lib/use-api';
import { useUrlState } from '@/lib/use-url-state';

const EVENTS_PAGE_SIZE = 20;
/** Per-viewer convenience: whether the employee chose to see every column. */
const COLUMNS_KEY = 'wf_my_attendance_columns';

export default function MyAttendancePage() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  if (!user.employee || !can(PERMISSIONS.ATTENDANCE_SELF)) {
    return <EmptyState title={t.home.noEmployee} description={t.employeeSelfService.noEmployeeBody} />;
  }
  return (
    <Suspense fallback={<LoadingRows />}>
      <MyAttendance />
    </Suspense>
  );
}

function readColumns(): 'full' | 'essential' {
  try {
    return window.localStorage.getItem(COLUMNS_KEY) === 'full' ? 'full' : 'essential';
  } catch {
    return 'essential';
  }
}

function MyAttendance() {
  const { t } = useI18n();
  const s = t.employeeSelfService;
  const { isVisible } = usePortal();
  const showEvents = isVisible('attendance.events');
  const [range, setRange] = useUrlState({ ...currentMonthRange() });
  const [eventsPage, setEventsPage] = useState(1);
  const [columns, setColumns] = useState<'full' | 'essential'>('essential');
  const [openDay, setOpenDay] = useState<DayMetrics | null>(null);

  useEffect(() => {
    setColumns(readColumns());
  }, []);

  const toggleColumns = () => {
    const next = columns === 'full' ? 'essential' : 'full';
    setColumns(next);
    try {
      window.localStorage.setItem(COLUMNS_KEY, next);
    } catch {
      // storage unavailable: the choice still applies to this visit
    }
  };

  const days = useApi<DayMetrics[]>('/attendance/me/days', { from: range.from, to: range.to });
  const events = useApi<Paginated<AttendanceEventDto>>(showEvents ? '/attendance/me/events' : null, {
    from: range.from,
    to: range.to,
    page: eventsPage,
    pageSize: EVENTS_PAGE_SIZE,
  });
  const sessions = useApi<CorrectableSessionDto[]>(openDay ? '/corrections/me/sessions' : null);

  const list = days.data ?? [];
  const net = sumMetrics(list, (d) => d.netWorkMinutes);
  const required = sumMetrics(list, (d) => d.requiredMinutes);
  const extra = sumMetrics(list, (d) => d.extraMinutes);
  const lateDays = list.filter((d) => d.isLate).length;

  return (
    <div className="space-y-6">
      <PageHeader title={t.myAttendance.title} description={t.myAttendance.subtitle} />

      <DateRangePicker
        value={range}
        onChange={(r) => {
          setRange(r);
          setEventsPage(1);
        }}
      />

      {days.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label={s.hoursWorked} minutes={net} icon={Clock} accent="var(--brand-pink)" />
          <KpiCard label={t.myAttendance.cols.required} minutes={required} icon={Hourglass} accent="var(--brand-purple)" />
          <KpiCard label={t.myAttendance.cols.extra} minutes={extra} icon={TrendingUp} accent="var(--status-working)" />
          <KpiCard label={s.attendance.lateDays} value={String(lateDays)} icon={CalendarCheck} accent="var(--brand-red)" />
        </div>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-4">
          <CardTitle className="text-base">{t.myAttendance.daysTitle}</CardTitle>
          <Button type="button" variant="ghost" size="sm" className="hidden md:inline-flex" aria-pressed={columns === 'full'} onClick={toggleColumns}>
            <Columns3 aria-hidden />
            {columns === 'full' ? s.attendance.fewerColumns : s.attendance.moreColumns}
          </Button>
        </CardHeader>
        <DayMetricsTable
          days={days.data}
          columnSet={columns}
          loading={days.loading || days.refreshing}
          error={days.error}
          onRetry={() => void days.refetch()}
          onRowClick={setOpenDay}
        />
      </Card>

      {showEvents && (
        <Card className="gap-0 py-0">
          <CardHeader className="py-4">
            <CardTitle className="text-base">{t.myAttendance.eventsTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {events.error && !events.data ? (
              <ErrorState compact error={events.error} onRetry={() => void events.refetch()} />
            ) : events.loading && !events.data ? (
              <LoadingRows rows={4} className="px-0" />
            ) : events.data && events.data.items.length > 0 ? (
              <EventList events={events.data.items} showSource={false} />
            ) : (
              <EmptyState title={t.events.empty} />
            )}
          </CardContent>
          {events.data && (
            <Pagination page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} onPageChange={setEventsPage} />
          )}
        </Card>
      )}

      <DaySheet
        day={openDay}
        sessions={sessions.data}
        sessionsError={sessions.error}
        onRetrySessions={() => void sessions.refetch()}
        onOpenChange={(o) => !o && setOpenDay(null)}
      />
    </div>
  );
}

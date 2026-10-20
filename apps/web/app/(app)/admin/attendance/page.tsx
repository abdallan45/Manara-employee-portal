'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Pause, RotateCw, Search } from 'lucide-react';
import {
  PERMISSIONS,
  type DayStatus,
  type DepartmentDto,
  type LiveAttendanceRow,
  type Paginated,
  type ScheduleType,
} from '@workforce/shared';

import { DataTable, nextSort, Pagination, type Column, type SortOrder, type SortState } from '@/components/data-table';
import { Minutes } from '@/components/duration';
import { employeeHref } from '@/components/employee-link';
import { PageHeader } from '@/components/page-header';
import { ForbiddenState, LoadingRows } from '@/components/states';
import { DayStatusBadge, LateBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { formatTime, localized, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';

type LiveSort = 'name' | 'code' | 'department' | 'firstIn' | 'netWork' | 'late' | 'status';
const SORTS: LiveSort[] = ['name', 'code', 'department', 'firstIn', 'netWork', 'late', 'status'];
const PAGE_SIZE = 25;
const ALL = '__all';
const STATUSES: DayStatus[] = ['WORKING', 'ON_BREAK', 'CHECKED_OUT', 'NOT_STARTED', 'ABSENT', 'MISSING_PUNCH', 'NOT_SCHEDULED', 'ON_LEAVE', 'PENDING_REVIEW'];
const SCHEDULE_TYPES: ScheduleType[] = ['FIXED', 'FLEXIBLE'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function LiveAttendancePage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.ATTENDANCE_READ_ALL)) return <ForbiddenState />;
  // Filters live in the URL (dashboard tiles link here; Back from an employee restores them) - needs Suspense.
  return (
    <Suspense fallback={<LoadingRows />}>
      <LiveAttendance />
    </Suspense>
  );
}

function useCurrentUrl(): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}

function LiveAttendance() {
  const { t, locale } = useI18n();
  const w = t.adminWorkflows.live;
  const today = todayInAmman();
  const [url, setUrl] = useUrlState({
    date: today, status: '', departmentId: '', q: '', sort: 'name', order: 'asc', scheduleType: '', page: '1',
  });
  const date = DATE_RE.test(url.date) && url.date <= today ? url.date : today;
  const status = STATUSES.includes(url.status as DayStatus) ? url.status : '';
  const scheduleType = SCHEDULE_TYPES.includes(url.scheduleType as ScheduleType) ? url.scheduleType : '';
  const sort: SortState<LiveSort> = {
    key: SORTS.includes(url.sort as LiveSort) ? (url.sort as LiveSort) : 'name',
    order: url.order === 'desc' ? 'desc' : 'asc',
  };
  const page = Math.max(1, Number.parseInt(url.page, 10) || 1);
  const currentUrl = useCurrentUrl();

  // Typing stays local; the debounced value goes to the URL (and the API). A q that changes from outside
  // (a sidebar or notification link, Back) replaces the box instead of being overwritten by it: this page
  // stays mounted when only the query string changes.
  const [search, setSearch] = useState(url.q);
  const debouncedSearch = useDebounced(search.trim());
  const lastTyped = useRef(debouncedSearch);
  const syncedQ = useRef(url.q);
  useEffect(() => {
    // Only a new debounced value (typing) writes; a URL change alone never writes the old text back.
    if (debouncedSearch === lastTyped.current) return;
    lastTyped.current = debouncedSearch;
    if (debouncedSearch === url.q) return;
    syncedQ.current = debouncedSearch;
    setUrl({ q: debouncedSearch, page: '1' });
  }, [debouncedSearch, url.q, setUrl]);
  useEffect(() => {
    if (url.q === syncedQ.current) return;
    syncedQ.current = url.q;
    setSearch(url.q);
  }, [url.q]);

  const [paused, setPaused] = useState(false);
  const departments = useApi<DepartmentDto[]>('/departments');
  const live = useApi<Paginated<LiveAttendanceRow>>(
    '/dashboard/live',
    {
      date,
      search: url.q || undefined,
      departmentId: url.departmentId || undefined,
      status: status || undefined,
      scheduleType: scheduleType || undefined,
      sort: sort.key,
      order: sort.order,
      page,
      pageSize: PAGE_SIZE,
    },
    { refreshMs: paused ? undefined : 60_000, refetchOnFocus: !paused },
  );

  const filter = (patch: Partial<typeof url>) => setUrl({ ...patch, page: '1' });

  const nameOf = (r: LiveAttendanceRow) => localized(locale, r.fullName, r.fullNameAr);
  const c = t.live.cols;
  const columns: Column<LiveAttendanceRow, LiveSort>[] = [
    {
      id: 'name',
      header: c.employee,
      sortKey: 'name',
      cell: (r) => (
        <span className="grid min-w-0">
          <span className="max-w-[16rem] truncate font-medium">
            <bdi>{nameOf(r)}</bdi>
          </span>
          <span className="text-muted-foreground text-xs" dir="ltr">
            {r.employeeCode}
          </span>
        </span>
      ),
    },
    { id: 'department', header: c.department, sortKey: 'department', cell: (r) => <span className="text-muted-foreground"><bdi>{localized(locale, r.departmentName, r.departmentNameAr) || '—'}</bdi></span> },
    { id: 'status', header: c.state, sortKey: 'status', cell: (r) => <DayStatusBadge status={r.metrics.status} remote={r.metrics.remote} /> },
    { id: 'firstIn', header: c.firstIn, sortKey: 'firstIn', cell: (r) => <span className="tabular" dir="ltr">{formatTime(r.metrics.firstIn, locale)}</span> },
    { id: 'lastOut', header: c.lastOut, cell: (r) => <span className="tabular" dir="ltr">{formatTime(r.metrics.lastOut, locale)}</span> },
    { id: 'net', header: c.netWork, sortKey: 'netWork', cell: (r) => <Minutes value={r.metrics.netWorkMinutes} className="font-semibold" /> },
    { id: 'breaks', header: c.breaks, cell: (r) => <Minutes value={r.metrics.breakMinutes} /> },
    { id: 'late', header: c.late, sortKey: 'late', cell: (r) => (r.metrics.isLate ? <LateBadge minutes={r.metrics.lateMinutes} /> : <Minutes value={0} />) },
    { id: 'extra', header: c.extra, cell: (r) => <Minutes value={r.metrics.extraMinutes} /> },
    { id: 'schedule', header: c.schedule, cell: (r) => <span className="text-muted-foreground">{t.scheduleType[r.scheduleType]}</span> },
  ];

  const updated = live.lastUpdatedAt ? fmt(t.common.updatedAt, { time: formatTime(live.lastUpdatedAt, locale) }) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.live.title}
        description={t.live.subtitle}
        actions={
          <>
            {/* Not a live region: it changes with every background refresh. aria-pressed reports the pause state. */}
            <span className="text-muted-foreground text-xs">
              {updated && <span className="tabular">{updated}</span>}
              {updated && ' · '}
              {paused ? w.autoPaused : t.common.autoRefresh}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={paused}
              className={cn('max-md:min-h-10', paused && 'border-tint/40 bg-tint/[0.1]')}
              onClick={() => setPaused((p) => !p)}
            >
              <Pause aria-hidden />
              {w.pauseAuto}
            </Button>
            <Button variant="outline" size="icon" onClick={() => void live.refetch()} aria-label={t.common.refresh} disabled={live.refreshing}>
              <RotateCw className={live.refreshing ? 'animate-spin' : undefined} aria-hidden />
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="live-search" className="text-xs">
            {t.common.search}
          </Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
            <Input id="live-search" type="search" className="ps-9" placeholder={t.live.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="live-date" className="text-xs">
            {t.common.date}
          </Label>
          <Input id="live-date" type="date" value={date} max={today} onChange={(e) => e.target.value && filter({ date: e.target.value })} />
        </div>
        {departments.data && departments.data.length > 0 && (
          <div className="grid gap-1.5">
            <Label className="text-xs" id="live-dept-label">
              {t.live.department}
            </Label>
            <Select value={url.departmentId || ALL} onValueChange={(v) => filter({ departmentId: v === ALL ? '' : v })}>
              <SelectTrigger className="w-full" aria-labelledby="live-dept-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t.live.allDepartments}</SelectItem>
                {departments.data.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {localized(locale, d.name, d.nameAr)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label className="text-xs" id="live-status-label">
            {t.live.status}
          </Label>
          <Select value={status || ALL} onValueChange={(v) => filter({ status: v === ALL ? '' : v })}>
            <SelectTrigger className="w-full" aria-labelledby="live-status-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t.live.allStatuses}</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t.dayStatus[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs" id="live-schedule-label">
            {t.live.scheduleType}
          </Label>
          <Select value={scheduleType || ALL} onValueChange={(v) => filter({ scheduleType: v === ALL ? '' : v })}>
            <SelectTrigger className="w-full" aria-labelledby="live-schedule-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t.live.allSchedules}</SelectItem>
              {SCHEDULE_TYPES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t.scheduleType[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <DataTable
          rows={live.data?.items}
          columns={columns}
          rowKey={(r) => r.employeeId}
          loading={live.loading || live.refreshing}
          error={live.error}
          onRetry={() => void live.refetch()}
          emptyTitle={t.live.empty}
          sort={sort}
          onSortChange={(key) => {
            const next = nextSort(sort, key);
            filter({ sort: next.key, order: next.order as SortOrder });
          }}
          rowHref={(r) => employeeHref(r.employeeId, 'attendance', currentUrl)}
          rowLabel={(r) => fmt(t.live.openDetails, { name: nameOf(r) })}
          stale={live.stale && live.lastUpdatedAt ? { since: live.lastUpdatedAt, onRetry: () => void live.refetch() } : undefined}
          resultCount={live.data?.total}
          mobileCard={(r) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <bdi>{nameOf(r)}</bdi>
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    <span dir="ltr">{r.employeeCode}</span>
                    {r.departmentName ? <> · <bdi>{localized(locale, r.departmentName, r.departmentNameAr)}</bdi></> : null}
                  </p>
                </div>
                <DayStatusBadge status={r.metrics.status} remote={r.metrics.remote} />
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span>
                  {c.firstIn}: <span className="text-foreground tabular" dir="ltr">{formatTime(r.metrics.firstIn, locale)}</span>
                </span>
                <span>
                  {c.netWork}: <Minutes value={r.metrics.netWorkMinutes} className="text-foreground" />
                </span>
                {r.metrics.isLate && <LateBadge minutes={r.metrics.lateMinutes} />}
              </div>
            </div>
          )}
        />
        {live.data && (
          <Pagination page={live.data.page} pageSize={live.data.pageSize} total={live.data.total} onPageChange={(p) => setUrl({ page: String(p) })} className="border-t border-tint/[0.05]" />
        )}
      </Card>
    </div>
  );
}

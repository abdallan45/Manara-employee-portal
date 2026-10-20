'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Printer, Search } from 'lucide-react';
import { PERMISSIONS, type AttendanceReportDto, type AttendanceReportRow, type DepartmentDto } from '@workforce/shared';

import { DataTable, nextSort, type Column, type SortState } from '@/components/data-table';
import { DateRangePicker, type DateRange } from '@/components/date-range';
import { ExportReportButton } from '@/components/excel-export-button';
import { Minutes } from '@/components/duration';
import { employeeHref } from '@/components/employee-link';
import { PageHeader } from '@/components/page-header';
import { ReportKpis } from '@/components/report-bits';
import { ErrorState, ForbiddenState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatNumber, formatPercent, localized, startOfMonth, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';

const ALL = '__all';
const MAX_DAYS = 93;
type SortKey = 'name' | 'rate' | 'absent' | 'late' | 'missing' | 'overtime';
const SORT_KEYS: SortKey[] = ['name', 'rate', 'absent', 'late', 'missing', 'overtime'];

const SORT_VALUE: Record<Exclude<SortKey, 'name'>, (r: AttendanceReportRow) => number> = {
  rate: (r) => r.totals.attendanceRate ?? -1,
  absent: (r) => r.totals.absentDays,
  late: (r) => r.totals.lateMinutes,
  missing: (r) => r.totals.missingMinutes,
  overtime: (r) => r.totals.overtimeApprovedMinutes,
};

export default function ReportsPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM)) return <ForbiddenState />;
  // Period, department, search and sort live in the URL (Back from an employee restores them) - needs Suspense.
  return (
    <Suspense fallback={<LoadingRows />}>
      <Reports />
    </Suspense>
  );
}

function useCurrentUrl(): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}

function Reports() {
  const { t, locale } = useI18n();
  const { can } = useAuth();
  const r = t.reports;
  const today = todayInAmman();
  const [url, setUrl] = useUrlState({ from: startOfMonth(today), to: today, departmentId: '', q: '', sort: 'name', order: 'asc' });
  const { from, to, departmentId } = url;
  const range = useMemo<DateRange>(() => ({ from, to }), [from, to]);
  const sort: SortState<SortKey> = {
    key: SORT_KEYS.includes(url.sort as SortKey) ? (url.sort as SortKey) : 'name',
    order: url.order === 'desc' ? 'desc' : 'asc',
  };
  const currentUrl = useCurrentUrl();

  // The list filters as you type; the URL follows after a short pause. A q that changes from outside
  // (a link to this page, Back) replaces the box instead of being overwritten by it: this page stays
  // mounted when only the query string changes.
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
    setUrl({ q: debouncedSearch });
  }, [debouncedSearch, url.q, setUrl]);
  useEffect(() => {
    if (url.q === syncedQ.current) return;
    syncedQ.current = url.q;
    setSearch(url.q);
  }, [url.q]);

  const departments = useApi<DepartmentDto[]>('/departments');
  const report = useApi<AttendanceReportDto>('/reports/attendance', { from, to, departmentId: departmentId || undefined });
  const nameOf = (row: AttendanceReportRow) => localized(locale, row.employee.fullName, row.employee.fullNameAr);

  const rows = useMemo(() => {
    const nameOf = (row: AttendanceReportRow) => localized(locale, row.employee.fullName, row.employee.fullNameAr);
    const q = search.trim().toLowerCase();
    const list = (report.data?.rows ?? []).filter(
      (row) => !q || row.employee.fullName.toLowerCase().includes(q) || (row.employee.fullNameAr ?? '').includes(q) || row.employee.employeeCode.toLowerCase().includes(q),
    );
    const dirn = sort.order === 'asc' ? 1 : -1;
    return [...list].sort((a, b) =>
      sort.key === 'name' ? nameOf(a).localeCompare(nameOf(b), locale) * dirn : (SORT_VALUE[sort.key](a) - SORT_VALUE[sort.key](b)) * dirn || nameOf(a).localeCompare(nameOf(b), locale),
    );
  }, [report.data, search, sort.key, sort.order, locale]);

  const c = r.cols;
  const columns: Column<AttendanceReportRow, SortKey>[] = [
    {
      id: 'employee',
      header: c.employee,
      sortKey: 'name',
      cell: (row) => (
        <span className="grid min-w-0">
          <span className="max-w-[14rem] truncate font-medium">
            <bdi>{nameOf(row)}</bdi>
          </span>
          <span className="text-muted-foreground text-xs" dir="ltr">
            {row.employee.employeeCode}
          </span>
        </span>
      ),
    },
    { id: 'department', header: c.department, cell: (row) => <span className="text-muted-foreground"><bdi>{localized(locale, row.employee.departmentName, row.employee.departmentNameAr) || '—'}</bdi></span> },
    { id: 'rate', header: c.rate, sortKey: 'rate', cell: (row) => <RateCell rate={row.totals.attendanceRate} /> },
    {
      id: 'present',
      header: c.present,
      cell: (row) => (
        <span className="tabular" dir="ltr">
          {formatNumber(row.totals.presentDays, locale)}/{formatNumber(row.totals.scheduledDays, locale)}
        </span>
      ),
    },
    {
      id: 'absent',
      header: c.absent,
      sortKey: 'absent',
      cell: (row) => <span className={cn('tabular', row.totals.absentDays > 0 ? 'font-semibold text-[color:var(--status-absent)]' : 'text-muted-foreground')}>{formatNumber(row.totals.absentDays, locale)}</span>,
    },
    { id: 'leave', header: c.leave, cell: (row) => <span className={cn('tabular', row.totals.leaveDays === 0 && 'text-muted-foreground')}>{formatNumber(row.totals.leaveDays, locale)}</span> },
    {
      id: 'late',
      header: c.late,
      sortKey: 'late',
      cell: (row) => (
        <div className="grid">
          <span className={cn('tabular', row.totals.lateDays === 0 && 'text-muted-foreground')}>{formatNumber(row.totals.lateDays, locale)}</span>
          {row.totals.lateMinutes > 0 && <Minutes value={row.totals.lateMinutes} className="text-muted-foreground text-xs" />}
        </div>
      ),
    },
    {
      id: 'worked',
      header: c.worked,
      cell: (row) => (
        <div className="grid">
          <Minutes value={row.totals.netWorkMinutes} className="font-semibold" />
          <Minutes value={row.totals.requiredMinutes} className="text-muted-foreground text-xs" />
        </div>
      ),
    },
    {
      id: 'missing',
      header: c.missing,
      sortKey: 'missing',
      cell: (row) => <Minutes value={row.totals.missingMinutes} className={row.totals.missingMinutes > 0 ? 'text-[color:var(--status-missing)]' : undefined} />,
    },
    {
      id: 'overtime',
      header: c.overtime,
      sortKey: 'overtime',
      cell: (row) => (
        <Minutes value={row.totals.overtimeApprovedMinutes} className={row.totals.overtimeApprovedMinutes > 0 ? 'text-[color:var(--status-working)]' : undefined} />
      ),
    },
    { id: 'excessBreaks', header: c.excessBreaks, cell: (row) => <Minutes value={row.totals.excessBreakMinutes} /> },
    {
      id: 'missingPunch',
      header: c.missingPunch,
      cell: (row) => <span className={cn('tabular', row.totals.missingPunchDays > 0 ? 'text-[color:var(--status-missing)]' : 'text-muted-foreground')}>{formatNumber(row.totals.missingPunchDays, locale)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={r.title}
        description={[r.subtitle, r.note].join('\n')}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="outline" onClick={() => window.print()} disabled={!report.data}>
              <Printer aria-hidden />
              {r.print}
            </Button>
            {can(PERMISSIONS.REPORTS_EXPORT) && <ExportReportButton allowCsv initialRange={range} query={{ departmentId: departmentId || undefined }} />}
          </div>
        }
      />

      <Card className="py-4 print:hidden">
        <CardContent className="flex flex-wrap items-start gap-4">
          <DateRangePicker value={range} onChange={(next) => setUrl({ from: next.from, to: next.to })} maxDays={MAX_DAYS} tooLongMessage={r.rangeTooLong} />
          <div className="grid gap-1.5">
            <Label id="rep-dept-label" className="text-xs">
              {t.live.department}
            </Label>
            <Select value={departmentId || ALL} onValueChange={(v) => setUrl({ departmentId: v === ALL ? '' : v })}>
              <SelectTrigger className="w-48" aria-labelledby="rep-dept-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t.live.allDepartments}</SelectItem>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {localized(locale, d.name, d.nameAr)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rep-search" className="text-xs">
              {t.common.search}
            </Label>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
              <Input id="rep-search" type="search" className="w-56 ps-9" placeholder={t.live.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {report.error && !report.data ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !report.data ? (
        <LoadingRows rows={3} />
      ) : (
        <ReportKpis totals={report.data.totals} />
      )}

      <Card className="gap-0 py-0">
        <DataTable
          rows={report.data ? rows : undefined}
          columns={columns}
          rowKey={(row) => row.employee.id}
          loading={report.loading || report.refreshing}
          error={report.error}
          onRetry={() => void report.refetch()}
          emptyTitle={search ? t.common.noResults : r.empty}
          sort={sort}
          onSortChange={(key) => {
            const next = nextSort(sort, key);
            setUrl({ sort: next.key, order: next.order });
          }}
          rowHref={(row) => employeeHref(row.employee.id, 'attendance', currentUrl)}
          rowLabel={(row) => `${t.employeeProfile.openFull}: ${nameOf(row)}`}
          resultCount={report.data ? rows.length : undefined}
          stale={report.stale && report.lastUpdatedAt ? { since: report.lastUpdatedAt, onRetry: () => void report.refetch() } : undefined}
          mobileCard={(row) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">
                  <bdi>{nameOf(row)}</bdi>
                </p>
                <RateCell rate={row.totals.attendanceRate} />
              </div>
              <p className="text-muted-foreground text-xs">
                {c.present} {formatNumber(row.totals.presentDays, locale)}/{formatNumber(row.totals.scheduledDays, locale)} · {c.absent}{' '}
                {formatNumber(row.totals.absentDays, locale)} · {c.late} {formatNumber(row.totals.lateDays, locale)} · {c.leave}{' '}
                {formatNumber(row.totals.leaveDays, locale)}
              </p>
            </div>
          )}
        />
      </Card>

      {report.data && (
        <p className="text-muted-foreground text-xs">{fmt(r.generated, { time: formatDateTime(report.data.generatedAt, locale) })}</p>
      )}
    </div>
  );
}

function RateCell({ rate }: { rate: number | null }) {
  const { locale } = useI18n();
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  const color = rate >= 0.95 ? 'var(--status-working)' : rate >= 0.85 ? 'var(--status-break)' : 'var(--status-absent)';
  return (
    <div className="flex min-w-24 items-center gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-tint/[0.06]" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.round(rate * 100)}%`, background: color }} />
      </div>
      <span className="tabular text-xs font-semibold" style={{ color }}>
        {formatPercent(rate, locale)}
      </span>
    </div>
  );
}

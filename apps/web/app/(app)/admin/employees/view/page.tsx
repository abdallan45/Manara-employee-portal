'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, Download, FilePen, KeyRound, Loader2, MoreHorizontal, Pencil, Power, PowerOff, Scale } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  type AttendanceEventDto, type AttendanceReportDto, type DayMetrics, type EmployeeDto, type EmployeeScheduleDto, type LeaveBalanceDto, type Paginated,
} from '@workforce/shared';

import { EventList } from '@/components/attendance-bits';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DateRangePicker, type DateRange } from '@/components/date-range';
import { DayMetricsTable } from '@/components/day-metrics-table';
import { EmployeeLink, type EmployeeTab } from '@/components/employee-link';
import { DirectCorrections, EmployeeLeavePanel } from '@/components/employee-panels';
import { ExportReportButton } from '@/components/excel-export-button';
import { PageHeader, type Breadcrumb } from '@/components/page-header';
import { ReportKpis } from '@/components/report-bits';
import { useLeaveAmount } from '@/components/request-bits';
import { EmptyState, ErrorState, ForbiddenState, LoadingRows } from '@/components/states';
import { ActiveBadge, DayStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDays, formatWorkDate, localized, startOfMonth, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { CHANGE_PASSWORD_PATH } from '@/lib/nav';
import { useApi } from '@/lib/use-api';
import { useUrlState, useUrlTab } from '@/lib/use-url-state';
import { safeRedirect, isUnder } from '@/lib/safe-redirect';
import { cn } from '@/lib/utils';
import { EmployeeDialog } from '../employee-dialog';
import { OverviewTab } from './overview-tab';
import { OvertimeTab } from './overtime-tab';
import { ProfileTab } from './profile-tab';
import { ScheduleTab } from './schedule-tab';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** GET /corrections/employees/:id/sessions covers work dates from today − 31 days (corrections.service). */
const CORRECTABLE_DAYS = 31;
const ALL_TABS: readonly EmployeeTab[] = ['overview', 'attendance', 'leave', 'overtime', 'schedule', 'profile'];
/** Tab values of the older page, still found in bookmarks and notifications. */
const LEGACY_TABS: Record<string, EmployeeTab> = { days: 'attendance', events: 'attendance', correct: 'attendance', details: 'profile' };

/**
 * Everything about one employee: /admin/employees/view?id=<uuid>&tab=overview|attendance|leave|overtime|schedule|profile
 * [&from=<relative /admin/... URL>][&welcome=1][&edit=1] (static export, so no dynamic segment).
 */
export default function EmployeeProfilePage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.EMPLOYEES_READ)) return <ForbiddenState />;
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <Profile />
    </Suspense>
  );
}

function Profile() {
  const params = useSearchParams();
  const { t } = useI18n();
  const id = params.get('id');
  if (!id) return <EmptyState title={t.employeeProfile.missingId} />;
  return <ProfileFor key={id} id={id} />;
}

/** The `from` param when it is a same-origin /admin/... URL (anything else is ignored). */
function safeFrom(from: string | null): string | null {
  const path = safeRedirect(from);
  return path && isUnder(path, '/admin') ? path : null;
}

/** First crumb: the page the user came from, named by its path. */
function originCrumb(from: string | null, c: { employees: string; live: string; reports: string; approvals: string; overtime: string; settings: string; schedules: string; dashboard: string }): Breadcrumb {
  if (!from) return { label: c.employees, href: '/admin/employees' };
  const path = (from.split('?')[0] ?? from).replace(/\/+$/, '') || '/';
  const label = path.startsWith('/admin/attendance') ? c.live
    : path.startsWith('/admin/reports') ? c.reports
      : path.startsWith('/admin/approvals') ? c.approvals
        : path.startsWith('/admin/overtime') ? c.overtime
          : path.startsWith('/admin/settings') ? c.settings
            : path.startsWith('/admin/schedules') ? c.schedules
              : path === '/admin' ? c.dashboard
                : c.employees;
  return { label, href: from };
}

/** Attendance period: the one of the page the user came from (e.g. Reports), else this month so far. */
function initialRange(from: string | null): DateRange {
  const today = todayInAmman();
  if (from?.includes('?')) {
    const q = new URLSearchParams(from.slice(from.indexOf('?') + 1));
    const f = q.get('from');
    const to = q.get('to');
    if (f && to && DATE_RE.test(f) && DATE_RE.test(to) && f <= to) return { from: f, to };
    const date = q.get('date');
    if (date && DATE_RE.test(date)) return { from: startOfMonth(date), to: date };
  }
  return { from: startOfMonth(today), to: today };
}

function ProfileFor({ id }: { id: string }) {
  const { t, locale, errorMessage } = useI18n();
  const { user, can } = useAuth();
  const params = useSearchParams();
  const p = t.employeeHub.page;
  const amount = useLeaveAmount();
  const enc = encodeURIComponent(id);
  const from = safeFrom(params.get('from'));
  // &adjust=<leaveTypeId> (or 1 for a type picker) opens "Adjust balance" on the Leave tab, then is cleared.
  const [flags, setFlags] = useUrlState({ edit: '', welcome: '', adjust: '' });
  const legacy = LEGACY_TABS[params.get('tab') ?? ''];

  const canManage = can(PERMISSIONS.EMPLOYEES_MANAGE);
  const canReport = can(PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM);
  const canAttendance = can(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM);
  const canLeave = can(PERMISSIONS.LEAVE_APPROVE);
  const canAdjust = canLeave && can(PERMISSIONS.ATTENDANCE_READ_ALL);
  const canOvertime = can(PERMISSIONS.OVERTIME_APPROVE);
  const canSchedules = can(PERMISSIONS.SCHEDULES_MANAGE);
  const isSelf = user.employee?.id === id;
  const canCorrect = can(PERMISSIONS.ATTENDANCE_CORRECT) && can(PERMISSIONS.ATTENDANCE_READ_ALL) && !isSelf;
  const canExport = canReport && can(PERMISSIONS.REPORTS_EXPORT);

  // Profile is read-only for EMPLOYEES_READ (contact and employment details); access details need manage.
  const allowed = ALL_TABS.filter((tab) =>
    tab === 'overview' ? true
      : tab === 'attendance' ? canAttendance
        : tab === 'leave' ? canLeave
          : tab === 'overtime' ? canOvertime
            : tab === 'schedule' ? canSchedules
              : true,
  );
  const [urlTab, setTab] = useUrlTab(allowed, 'overview');
  const tab = legacy && allowed.includes(legacy) ? legacy : urlTab;
  // Rewrite an old ?tab=days|events|correct|details link to the new value once.
  useEffect(() => {
    if (legacy) setTab(allowed.includes(legacy) ? legacy : 'overview');
  }, [legacy]); // eslint-disable-line react-hooks/exhaustive-deps
  // An &adjust= link without tab=leave still lands on the Leave tab, where the dialog opens.
  const adjustParam = canAdjust ? flags.adjust : '';
  useEffect(() => {
    if (adjustParam && tab !== 'leave') setTab('leave');
  }, [adjustParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const [range, setRange] = useState<DateRange>(() => initialRange(from));
  // Header actions that open a dialog inside a tab (the tab mounts first, then takes the request).
  const [openAdjust, setOpenAdjust] = useState(false);
  const [openAssign, setOpenAssign] = useState(false);
  const [focusCorrections, setFocusCorrections] = useState(0);
  /** The More menu must not hand focus back to its trigger when 'Correct attendance' moves it to the corrections. */
  const keepMenuFocusRef = useRef(false);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [focusPassword, setFocusPassword] = useState(false);
  const [exporting, setExporting] = useState(false);
  const today = todayInAmman();
  const thisYear = Number(today.slice(0, 4));

  const employee = useApi<EmployeeDto>(`/employees/${enc}`);
  const managerId = employee.data?.managerId ?? null;
  const manager = useApi<EmployeeDto>(managerId ? `/employees/${encodeURIComponent(managerId)}` : null);
  const todayDays = useApi<DayMetrics[]>(canAttendance ? `/attendance/employees/${enc}/days` : null, { from: today, to: today });
  const balances = useApi<LeaveBalanceDto[]>(canLeave ? `/leave/employees/${enc}/balances` : null, { year: thisYear });
  const schedule = useApi<EmployeeScheduleDto>(canAttendance || canSchedules ? `/schedules/employees/${enc}/current` : null);

  // Scroll to the corrections section after "Correct attendance" switched to the Attendance tab. One-shot:
  // the request is cleared once handled, so later visits to the tab stay at the top with focus on the tabs.
  useEffect(() => {
    if (!focusCorrections || tab !== 'attendance') return;
    const el = document.getElementById('employee-corrections');
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    }
    setFocusCorrections(0);
  }, [focusCorrections, tab]);

  if (employee.error && !employee.data) return <ErrorState error={employee.error} onRetry={() => void employee.refetch()} />;
  if (!employee.data) return <LoadingRows rows={6} />;
  const e = employee.data;
  const name = localized(locale, e.fullName, e.fullNameAr);
  const department = localized(locale, e.departmentName, e.departmentNameAr);
  const ref = { id, name, subtitle: e.employeeCode };
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');
  const todayStatus = todayDays.data?.[0];
  const chips = (balances.data ?? []).slice(0, 3);
  const crumbs: Breadcrumb[] = [originCrumb(from, p.crumbs), { label: name }];

  const goTab = (next: EmployeeTab) => setTab(next);
  const toggleActive = async () => {
    try {
      await apiPost<EmployeeDto>(`/employees/${enc}/${e.isActive ? 'deactivate' : 'activate'}`);
      toast.success(fmt(e.isActive ? p.deactivatedToast : p.activatedToast, { name }));
      void employee.refetch();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };
  const exportExcel = async () => {
    setExporting(true);
    try {
      // detail/export=true make the API require `reports.export` (see components/excel-export-button.tsx).
      const report = await apiGet<AttendanceReportDto>('/reports/attendance', { ...range, employeeId: id, detail: 'true', export: 'true' });
      const { exportReportExcel } = await import('@/components/report-excel');
      await exportReportExcel(report, t, locale, { single: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const moreItems = [
    canCorrect && (
      <DropdownMenuItem
        key="correct"
        onSelect={() => {
          keepMenuFocusRef.current = true;
          goTab('attendance');
          setFocusCorrections((n) => n + 1);
        }}
      >
        <FilePen aria-hidden />
        {p.correctAttendance}
      </DropdownMenuItem>
    ),
    // Your own record: the change-password page (an admin cannot set their own password here).
    (isSelf || e.user?.id === user.id) && e.user && (
      <DropdownMenuItem key="password" asChild>
        <Link href={CHANGE_PASSWORD_PATH}>
          <KeyRound aria-hidden />
          {t.accountSecurity.changePasswordMenu}
        </Link>
      </DropdownMenuItem>
    ),
    canManage && e.user && !(isSelf || e.user.id === user.id) && (
      <DropdownMenuItem
        key="password"
        onSelect={() => {
          setFocusPassword(true);
          setFlags({ edit: '1' });
        }}
      >
        <KeyRound aria-hidden />
        {p.resetPassword}
      </DropdownMenuItem>
    ),
    canExport && (
      <DropdownMenuItem key="export" disabled={exporting} onSelect={() => void exportExcel()}>
        {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
        {p.exportExcel}
      </DropdownMenuItem>
    ),
  ].filter(Boolean);

  const actions = (
    <>
      {canManage && (
        <Button
          variant="outline"
          onClick={() => {
            setFocusPassword(false);
            setFlags({ edit: '1' });
          }}
        >
          <Pencil aria-hidden />
          {p.editProfile}
        </Button>
      )}
      {canAdjust && (
        <Button
          variant="outline"
          onClick={() => {
            goTab('leave');
            setOpenAdjust(true);
          }}
        >
          <Scale aria-hidden />
          {p.adjustLeave}
        </Button>
      )}
      {canSchedules && (
        <Button
          variant="outline"
          onClick={() => {
            goTab('schedule');
            setOpenAssign(true);
          }}
        >
          <CalendarClock aria-hidden />
          {p.assignSchedule}
        </Button>
      )}
      {(moreItems.length > 0 || canManage) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label={p.more}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-56"
            onCloseAutoFocus={(ev) => {
              // After its exit animation the menu would refocus its trigger, undoing the move to the corrections.
              if (keepMenuFocusRef.current) {
                keepMenuFocusRef.current = false;
                ev.preventDefault();
              }
            }}
          >
            {moreItems}
            {canManage && moreItems.length > 0 && <DropdownMenuSeparator />}
            {canManage && (
              <DropdownMenuItem variant={e.isActive ? 'destructive' : 'default'} onSelect={() => setConfirmToggle(true)}>
                {e.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                {e.isActive ? p.deactivate : p.activate}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <PageHeader
          title={name}
          subtitle={[e.jobTitle, department].filter(Boolean).join(' · ') || undefined}
          breadcrumbs={crumbs}
          documentTitle={fmt(p.documentTitle, { name, section: p.crumbs.employees })}
          actions={actions}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="bg-brand-gradient flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white" aria-hidden>
            {initials}
          </span>
          <span dir="ltr" className="text-muted-foreground tabular">
            {e.employeeCode}
          </span>
          {managerId && manager.data && (
            <span className="text-muted-foreground">
              {p.manager}:{' '}
              <EmployeeLink id={manager.data.id} name={manager.data.fullName} nameAr={manager.data.fullNameAr} from={from ?? undefined} />
            </span>
          )}
          <ActiveBadge active={e.isActive} />
          {todayStatus && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">{p.todayStatus}:</span>
              <DayStatusBadge status={todayStatus.status} remote={todayStatus.remote} rotaOff={todayStatus.saturdayRota === 'OFF'} pulse={todayStatus.status === 'WORKING'} />
            </span>
          )}
          {chips.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={p.remainingLeave}>
              {chips.map((b) => (
                <li key={b.leaveType.id}>
                  <button
                    type="button"
                    onClick={() => goTab('leave')}
                    className="inline-flex min-h-6 items-center gap-1 rounded-full border border-tint/10 bg-tint/[0.04] px-2.5 py-0.5 text-xs hover:bg-tint/[0.08]"
                  >
                    <span>{localized(locale, b.leaveType.name, b.leaveType.nameAr)}</span>
                    <span className="tabular font-semibold" dir="auto">
                      {amount(b.available, b.leaveType.unit)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!e.isActive && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--status-missing)]/40 bg-[color:var(--status-missing)]/10 px-4 py-3 text-sm">
            <span>{p.inactiveBanner}</span>
            {canManage && (
              <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => setConfirmToggle(true)}>
                <Power aria-hidden />
                {p.reactivate}
              </Button>
            )}
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => goTab(v as EmployeeTab)} className="gap-4">
        <TabsList>
          {allowed.map((value) => (
            <TabsTrigger key={value} value={value}>
              {value === 'profile' && !canManage ? p.profileReadOnly : p.tabs[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab
            employee={e}
            name={name}
            from={from}
            schedule={schedule}
            balances={canLeave ? balances : null}
            welcome={flags.welcome === '1' && canManage}
            onDismissWelcome={() => setFlags({ welcome: '' })}
            goTab={goTab}
            onAdjust={() => {
              goTab('leave');
              setOpenAdjust(true);
            }}
            onAssign={() => {
              goTab('schedule');
              setOpenAssign(true);
            }}
            onAttendanceChanged={() => void todayDays.refetch()}
          />
        </TabsContent>

        {canAttendance && (
          <TabsContent value="attendance">
            <AttendanceTab
              employee={ref}
              range={range}
              onRangeChange={setRange}
              canReport={canReport}
              canExport={canExport}
              canCorrect={canCorrect}
              onChanged={() => void todayDays.refetch()}
            />
          </TabsContent>
        )}

        {canLeave && (
          <TabsContent value="leave">
            <EmployeeLeavePanel
              employee={ref}
              openAdjust={adjustParam || openAdjust}
              onAdjustOpened={() => {
                setOpenAdjust(false);
                if (flags.adjust) setFlags({ adjust: '' });
              }}
              onChanged={() => void balances.refetch()}
            />
          </TabsContent>
        )}

        {canOvertime && (
          <TabsContent value="overtime">
            <OvertimeTab employeeId={id} />
          </TabsContent>
        )}

        {canSchedules && (
          <TabsContent value="schedule">
            <ScheduleTab employee={e} name={name} schedule={schedule} openAssign={openAssign} onAssignOpened={() => setOpenAssign(false)} />
          </TabsContent>
        )}

        <TabsContent value="profile">
          <ProfileTab
            employee={e}
            manager={manager.data ?? null}
            from={from}
            onEdit={
              canManage
                ? () => {
                    setFocusPassword(false);
                    setFlags({ edit: '1' });
                  }
                : undefined
            }
          />
        </TabsContent>
      </Tabs>

      {canManage && (
        <EmployeeDialog
          open={flags.edit === '1'}
          employeeId={id}
          focusField={focusPassword ? 'password' : undefined}
          onOpenChange={(o) => !o && setFlags({ edit: '' })}
          onSaved={() => {
            setFlags({ edit: '' });
            void employee.refetch();
            void manager.refetch();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmToggle}
        onOpenChange={setConfirmToggle}
        destructive={e.isActive}
        title={fmt(e.isActive ? p.deactivateTitle : p.activateTitle, { name })}
        description={e.isActive ? p.deactivateBody : p.activateBody}
        confirmLabel={e.isActive ? p.deactivateConfirm : p.activateConfirm}
        cancelLabel={e.isActive ? p.keepActive : p.keepInactive}
        onConfirm={toggleActive}
      />
    </div>
  );
}

/**
 * Attendance tab: the period and its figures, then Days | Events (a two-option toggle, not nested
 * tabs). Days that need fixing get a Fix button that opens the direct correction for that day.
 */
function AttendanceTab({ employee, range, onRangeChange, canReport, canExport, canCorrect, onChanged }: {
  employee: { id: string; name: string; subtitle?: string };
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  canReport: boolean;
  canExport: boolean;
  canCorrect: boolean;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const a = t.employeeHub.attendance;
  const enc = encodeURIComponent(employee.id);
  const [view, setView] = useState<'days' | 'events'>('days');
  const [fixDay, setFixDay] = useState<{ workDate: string; seq: number } | null>(null);

  const report = useApi<AttendanceReportDto>(canReport ? '/reports/attendance' : null, { ...range, employeeId: employee.id });
  // Without report access the daily figures come from the attendance endpoint (max 62 days).
  const plainDays = useApi<DayMetrics[]>(!canReport ? `/attendance/employees/${enc}/days` : null, { ...range });
  const events = useApi<Paginated<AttendanceEventDto>>(view === 'events' ? `/attendance/employees/${enc}/events` : null, { ...range, page: 1, pageSize: 200 });

  const row = report.data?.rows[0];
  const days = canReport ? row?.days : plainDays.data;
  const daysState = canReport ? report : plainDays;
  const sortedDays = days ? [...days].sort((x, y) => y.workDate.localeCompare(x.workDate)) : undefined;
  const refresh = () => {
    void report.refetch();
    void plainDays.refetch();
    void events.refetch();
    onChanged();
  };
  // Work periods can be corrected for the last 31 days only (the sessions the correction form can pick
  // from); an older late or missing-punch day would wrongly open "Add a missing work period". An absent
  // day has no work period, so adding one is right at any age.
  const windowStart = addDays(todayInAmman(), -CORRECTABLE_DAYS);
  const needsFix = (d: DayMetrics) =>
    d.status === 'ABSENT' || (d.workDate >= windowStart && (d.status === 'MISSING_PUNCH' || d.isLate));

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="flex flex-wrap items-end justify-between gap-3">
          <DateRangePicker value={range} onChange={onRangeChange} maxDays={canReport ? 93 : 62} tooLongMessage={canReport ? t.reports.rangeTooLong : undefined} />
          {canExport && <ExportReportButton single variant="outline" initialRange={range} query={{ employeeId: employee.id }} />}
        </CardContent>
      </Card>

      {canReport &&
        (report.error && !report.data ? (
          <ErrorState error={report.error} onRetry={() => void report.refetch()} />
        ) : row ? (
          <ReportKpis totals={row.totals} />
        ) : (
          <LoadingRows rows={2} />
        ))}

      <div role="group" aria-label={a.view} className="inline-flex rounded-full border border-tint/[0.06] bg-tint/[0.04] p-1">
        {(['days', 'events'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={cn(
              'min-h-8 rounded-full px-4 text-sm font-medium transition-colors max-md:min-h-10',
              view === v ? 'bg-tint/[0.14] text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {a[v]}
          </button>
        ))}
      </div>

      {view === 'days' ? (
        <Card className="gap-0 py-0">
          <DayMetricsTable
            days={sortedDays}
            loading={daysState.loading || daysState.refreshing}
            error={daysState.error}
            onRetry={() => void daysState.refetch()}
            rowAction={
              canCorrect
                ? (d) =>
                    needsFix(d) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="max-md:min-h-10"
                        aria-label={fmt(a.fixLabel, { date: formatWorkDate(d.workDate, locale, 'long') })}
                        onClick={() => setFixDay((prev) => ({ workDate: d.workDate, seq: (prev?.seq ?? 0) + 1 }))}
                      >
                        <FilePen aria-hidden />
                        {a.fix}
                      </Button>
                    ) : null
                : undefined
            }
          />
        </Card>
      ) : (
        <Card>
          <CardContent>
            {events.error && !events.data ? (
              <ErrorState compact error={events.error} onRetry={() => void events.refetch()} />
            ) : !events.data ? (
              <LoadingRows rows={4} className="px-0" />
            ) : events.data.items.length === 0 ? (
              <EmptyState title={t.events.empty} />
            ) : (
              <EventList events={events.data.items} />
            )}
          </CardContent>
        </Card>
      )}

      {canCorrect && (
        <Card>
          <CardContent className="space-y-3">
            <h2 id="employee-corrections" tabIndex={-1} className="font-semibold">
              {a.correctionsTitle}
            </h2>
            <DirectCorrections employee={employee} fixDay={fixDay} onApplied={refresh} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

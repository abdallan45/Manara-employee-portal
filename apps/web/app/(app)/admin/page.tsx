'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlarmClockOff,
  CircleAlert,
  CircleCheck,
  Coffee,
  FileBarChart,
  FilePen,
  Gauge,
  Loader2,
  Plane,
  RotateCw,
  Settings,
  Timer,
  TimerReset,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import { PERMISSIONS, type ApprovalSummaryDto, type DashboardSummary } from '@workforce/shared';

import { SERIES, SimpleBarChart, TrendLineChart } from '@/components/charts';
import { Minutes } from '@/components/duration';
import { HelpTip } from '@/components/help-tip';
import { AttentionTile, KpiCard } from '@/components/kpi-card';
import { OvertimeCallout, useUnapprovedOvertime } from '@/components/overtime-callout';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { formatDayMonth, formatNumber, formatPercent, localized, minutesToHours, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { APPROVAL_PERMISSIONS, NAV_ITEMS, allowedSettingsTabs, homeFor } from '@/lib/nav';
import { useApi } from '@/lib/use-api';

const KPI_TILES = 6;
const POLL = { refreshMs: 60_000, refetchOnFocus: true };
/** The candidates are computed over 30 days for every employee in scope, so they refresh less often. */
const OVERTIME_POLL = { refreshMs: 5 * 60_000, refetchOnFocus: true };

export default function AdminDashboardPage() {
  const { can, user } = useAuth();
  const { t } = useI18n();
  if (!can(PERMISSIONS.DASHBOARD_READ)) {
    const home = homeFor(user);
    return <ForbiddenState homeHref={home} homeLabel={NAV_ITEMS.find((i) => i.href === home)?.label(t)} />;
  }
  return <Dashboard />;
}

function Dashboard() {
  const { t, locale } = useI18n();
  const nf = t.navFindability;
  const { can, user } = useAuth();
  const today = todayInAmman();
  const [date, setDate] = useState(today);
  const summary = useApi<DashboardSummary>('/dashboard/summary', { date }, POLL);
  const approver = can(...APPROVAL_PERMISSIONS);
  const approvals = useApi<ApprovalSummaryDto>(approver ? '/approvals/summary' : null, undefined, POLL);
  const overtime = useUnapprovedOvertime(can(PERMISSIONS.OVERTIME_APPROVE), OVERTIME_POLL);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const data = summary.data;
  const n = (v: number) => formatNumber(v, locale);
  const hoursFmt = (v: number) => `${formatNumber(v, locale, { maximumFractionDigits: 1 })}${t.common.h}`;

  const canLive = can(PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.ATTENDANCE_READ_ALL);
  /** Live attendance for the selected day, pre-filtered (URL contract of /admin/attendance). */
  const live = (params: Record<string, string> = {}) => (canLive ? `/admin/attendance?${new URLSearchParams({ date, ...params }).toString()}` : undefined);

  const trend = (data?.trend ?? []).map((d) => ({
    label: formatDayMonth(d.date, locale),
    present: d.present,
    scheduled: d.scheduled,
    late: d.late,
    hours: minutesToHours(d.workMinutes),
  }));
  const departments = (data?.departments ?? []).map((d) => ({
    // The API names the no-department row 'Unassigned' (nameAr null); show the localized label instead.
    label: d.departmentId === null ? t.admin.unassigned : localized(locale, d.name, d.nameAr),
    present: d.present,
    scheduled: d.scheduled,
  }));

  // ── Needs attention ──
  const pending = approvals.data?.pending;
  const isToday = date === today;
  const attention = [
    pending?.leave
      ? { key: 'leave', label: nf.pendingLeave, value: n(pending.leave), icon: Plane, accent: 'var(--status-leave)', href: '/admin/approvals?kind=LEAVE' }
      : null,
    pending?.overtime
      ? { key: 'overtime', label: nf.pendingOvertime, value: n(pending.overtime), icon: TimerReset, accent: 'var(--brand-blue)', href: '/admin/approvals?kind=OVERTIME' }
      : null,
    pending?.correction
      ? { key: 'correction', label: nf.pendingCorrections, value: n(pending.correction), icon: FilePen, accent: 'var(--brand-purple)', href: '/admin/approvals?kind=CORRECTION' }
      : null,
    data?.kpis.missingCheckouts
      ? { key: 'missing', label: t.admin.kpi.missingCheckouts, value: n(data.kpis.missingCheckouts), icon: AlarmClockOff, accent: 'var(--status-missing)', href: live({ status: 'MISSING_PUNCH' }) }
      : null,
    data?.kpis.onLeave
      ? { key: 'onLeave', label: isToday ? nf.onLeaveToday : t.admin.kpi.onLeave, value: n(data.kpis.onLeave), icon: Plane, accent: 'var(--status-leave)', href: live({ status: 'ON_LEAVE' }) }
      : null,
  ].filter((x) => x !== null);
  const attentionSettled =
    (data !== undefined || summary.error !== undefined) && (!approver || approvals.data !== undefined || approvals.error !== undefined) && overtime.settled;
  // A source that never loaded counts nothing, so it must not read as "nothing waiting".
  const approvalsFailed = approver && approvals.data === undefined && approvals.error !== undefined;
  const attentionFailed = approvalsFailed || overtime.failed;
  // "All clear" only when every source answered; a failed summary is reported by its error card below.
  const allClear = attentionSettled && data !== undefined && !attentionFailed && attention.length === 0 && overtime.days === 0;
  const hasAttention = attention.length > 0 || overtime.days > 0;
  const retryingAttention = (approvalsFailed && approvals.loading) || (overtime.failed && overtime.busy);
  const retryAttention = () => {
    if (approvalsFailed) void approvals.refetch();
    if (overtime.failed) void overtime.refetch();
  };

  // Refresh reloads every figure on the page, not only the KPIs.
  const refreshAll = () => {
    setRefreshingAll(true);
    void Promise.all([summary.refetch(), approvals.refetch(), overtime.refetch()]).finally(() => setRefreshingAll(false));
  };
  const refreshing = refreshingAll || summary.refreshing;

  // ── Quick actions ──
  const quickActions = [
    can(PERMISSIONS.EMPLOYEES_MANAGE) && { href: '/admin/employees?new=1', label: nf.actions.addEmployee, icon: UserPlus },
    can(PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM) && { href: '/admin/reports', label: nf.openReports, icon: FileBarChart },
    allowedSettingsTabs(user).length > 0 && { href: '/admin/settings', label: t.nav.settings, icon: Settings },
  ].filter((x) => x !== false);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.admin.title}
        description={can(PERMISSIONS.ATTENDANCE_READ_ALL) ? t.admin.subtitle : nf.subtitleTeam}
        actions={
          <>
            <div className="flex items-center gap-2">
              <Label htmlFor="dash-date" className="sr-only">
                {t.common.date}
              </Label>
              <Input id="dash-date" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="w-[10.5rem]" />
            </div>
            <Button variant="outline" size="icon" onClick={refreshAll} aria-label={t.common.refresh} disabled={refreshing}>
              <RotateCw className={refreshing ? 'animate-spin' : undefined} aria-hidden />
            </Button>
          </>
        }
      />

      {(!attentionSettled || allClear || hasAttention || attentionFailed) && (
        <section aria-labelledby="dash-attention" className="space-y-3">
          <h2 id="dash-attention" className="text-sm font-semibold">
            {nf.needsAttention}
          </h2>
          {!attentionSettled ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 2 }, (_, i) => (
                <Skeleton key={i} className="h-[76px] rounded-2xl" />
              ))}
            </div>
          ) : allClear ? (
            <p className="text-muted-foreground flex items-center gap-2 rounded-2xl border border-tint/[0.06] bg-tint/[0.02] px-4 py-3 text-sm" role="status">
              <CircleCheck className="size-4 shrink-0 text-[color:var(--status-working)]" aria-hidden />
              {nf.allClear}
            </p>
          ) : (
            <>
              {hasAttention && (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {attention.map((tile) => (
                    <li key={tile.key}>
                      <AttentionTile label={tile.label} value={tile.value} icon={tile.icon} accent={tile.accent} href={tile.href} action={nf.review} />
                    </li>
                  ))}
                  {overtime.days > 0 && (
                    <li>
                      <OvertimeCallout variant="tile" summary={overtime} />
                    </li>
                  )}
                </ul>
              )}
              {attentionFailed && (
                <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" role="status">
                  <CircleAlert className="size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />
                  <span>{nf.attentionFailed}</span>
                  <Button variant="link" size="sm" className="h-auto p-0 text-sm" onClick={retryAttention} disabled={retryingAttention}>
                    {retryingAttention && <Loader2 className="animate-spin" aria-hidden />}
                    {t.uiFoundation.retry}
                  </Button>
                </p>
              )}
            </>
          )}
        </section>
      )}

      {summary.error && !data ? (
        <Card>
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      ) : !data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: KPI_TILES }, (_, i) => (
              <Skeleton key={i} className="h-[116px] rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label={nf.kpiRow}>
            <KpiCard label={t.admin.kpi.currentlyWorking} value={n(data.kpis.currentlyWorking)} icon={UserCheck} accent="var(--status-working)" href={live({ status: 'WORKING' })} />
            <KpiCard label={t.admin.kpi.onBreak} value={n(data.kpis.onBreak)} icon={Coffee} accent="var(--status-break)" href={live({ status: 'ON_BREAK' })} />
            <KpiCard label={t.admin.kpi.absent} value={n(data.kpis.absent)} icon={UserX} accent="var(--status-absent)" href={live({ status: 'ABSENT' })} />
            <KpiCard label={t.admin.kpi.late} value={n(data.kpis.late)} icon={Timer} accent="var(--brand-red)" href={live({ sort: 'late', order: 'desc' })} />
            <KpiCard label={t.admin.kpi.onLeave} value={n(data.kpis.onLeave)} icon={Plane} accent="var(--status-leave)" href={live({ status: 'ON_LEAVE' })} />
            <KpiCard label={t.admin.kpi.attendanceRate} value={formatPercent(data.kpis.attendanceRate, locale)} icon={Gauge} accent="var(--brand-pink)" href={live()} />
          </section>

          {quickActions.length > 0 && (
            <nav aria-label={nf.quickActions} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground me-1 text-sm font-semibold">{nf.quickActions}</span>
              {quickActions.map((a) => (
                <Button key={a.href} asChild variant="outline" size="sm" className="h-10 px-4">
                  <Link href={a.href}>
                    <a.icon aria-hidden />
                    {a.label}
                  </Link>
                </Button>
              ))}
            </nav>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-1 text-base">
                  {t.admin.trendTitle}
                  <HelpTip text={t.admin.trendSubtitle} />
                </CardTitle>
                <p id="dash-trend-desc" className="sr-only">
                  {t.admin.trendSubtitle}
                </p>
                <CardAction>
                  <span className="text-muted-foreground rounded-full border border-tint/10 px-3 py-1 text-xs font-medium whitespace-nowrap">
                    {fmt(nf.employeesCount, { n: n(data.kpis.totalEmployees) })}
                  </span>
                </CardAction>
              </CardHeader>
              <CardContent>
                {trend.length === 0 ? (
                  <EmptyState title={t.admin.noChartData} />
                ) : (
                  <TrendLineChart
                    data={trend}
                    xKey="label"
                    label={t.admin.trendTitle}
                    series={[
                      { key: 'present', label: t.admin.present, color: SERIES.primary },
                      { key: 'scheduled', label: t.admin.scheduled, color: SERIES.secondary },
                      { key: 'late', label: t.admin.late, color: SERIES.tertiary },
                    ]}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1 text-base">
                  {t.admin.hoursTitle}
                  <HelpTip text={nf.hoursSubtitle} />
                </CardTitle>
                <p id="dash-hours-desc" className="sr-only">
                  {nf.hoursSubtitle}
                </p>
                <CardAction>
                  <dl className="flex flex-col items-end gap-0.5 text-xs">
                    <div className="flex items-center gap-1.5">
                      <dt className="text-muted-foreground">{nf.hoursWorked}</dt>
                      <dd className="font-semibold">
                        <Minutes value={data.kpis.totalWorkMinutes} dimZero={false} />
                      </dd>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <dt className="text-muted-foreground">{nf.extraTime}</dt>
                      <dd className="font-semibold">
                        <Minutes value={data.kpis.extraMinutes} />
                      </dd>
                    </div>
                  </dl>
                </CardAction>
              </CardHeader>
              <CardContent>
                {trend.length === 0 ? (
                  <EmptyState title={t.admin.noChartData} />
                ) : (
                  <SimpleBarChart
                    data={trend}
                    xKey="label"
                    label={t.admin.hoursTitle}
                    format={hoursFmt}
                    series={[{ key: 'hours', label: t.admin.hours, color: SERIES.primary }]}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1 text-base">
                  {t.admin.deptTitle}
                  <HelpTip text={t.admin.deptSubtitle} />
                </CardTitle>
                <p id="dash-dept-desc" className="sr-only">
                  {t.admin.deptSubtitle}
                </p>
              </CardHeader>
              <CardContent>
                {departments.length === 0 ? (
                  <EmptyState title={t.admin.noChartData} />
                ) : (
                  <SimpleBarChart
                    data={departments}
                    xKey="label"
                    layout="vertical"
                    height={Math.max(220, departments.length * 44 + 60)}
                    label={t.admin.deptTitle}
                    series={[
                      { key: 'present', label: t.admin.present, color: SERIES.primary },
                      { key: 'scheduled', label: t.admin.scheduled, color: SERIES.secondary },
                    ]}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

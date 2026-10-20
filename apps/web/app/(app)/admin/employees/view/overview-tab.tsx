'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlarmClockOff, AlarmClock, CalendarCheck, CalendarX, CheckCircle2, ChevronRight, Clock, Hourglass, X } from 'lucide-react';
import {
  PERMISSIONS,
  type ApprovalItemDto, type AttendanceReportDto, type CorrectableSessionDto, type DayMetrics, type EmployeeDto, type EmployeeScheduleDto,
  type LeaveBalanceDto, type Paginated,
} from '@workforce/shared';

import { employeeHref, type EmployeeTab } from '@/components/employee-link';
import { DirectCorrectionDialog } from '@/components/employee-panels';
import { HelpTip } from '@/components/help-tip';
import { KpiCard } from '@/components/kpi-card';
import { ReportKpis } from '@/components/report-bits';
import { useLeaveAmount } from '@/components/request-bits';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CorrectionDraft } from '@/components/correction-form';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatMinutes, formatNumber, formatTime, formatWorkDate, localized, startOfMonth, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi, type ApiState } from '@/lib/use-api';

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{title}</h2>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

const linkClass = 'text-link inline-flex min-h-6 items-center gap-1 text-sm underline-offset-4 hover:underline';

/**
 * Overview tab (default): this month's headline figures, leave remaining, requests waiting for a
 * decision, the schedule in force and open work periods to fix. With ?welcome=1 (right after the
 * employee was created) a setup checklist comes first.
 */
export function OverviewTab({ employee, name, from, schedule, balances, welcome, onDismissWelcome, goTab, onAdjust, onAssign, onAttendanceChanged }: {
  employee: EmployeeDto;
  name: string;
  from: string | null;
  schedule: ApiState<EmployeeScheduleDto>;
  /** null when the viewer cannot see leave balances. */
  balances: ApiState<LeaveBalanceDto[]> | null;
  welcome: boolean;
  onDismissWelcome: () => void;
  goTab: (tab: EmployeeTab) => void;
  onAdjust: () => void;
  onAssign: () => void;
  onAttendanceChanged: () => void;
}) {
  const { t, locale, units } = useI18n();
  const { user, can } = useAuth();
  const o = t.employeeHub.overview;
  const amount = useLeaveAmount();
  const id = employee.id;
  const enc = encodeURIComponent(id);
  const back = from ?? undefined;
  const today = todayInAmman();
  const month = { from: startOfMonth(today), to: today };

  const canReport = can(PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM);
  const canAttendance = can(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM);
  const canApprove = can(PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.OVERTIME_APPROVE, PERMISSIONS.CORRECTIONS_APPROVE);
  const canCorrect = can(PERMISSIONS.ATTENDANCE_CORRECT) && can(PERMISSIONS.ATTENDANCE_READ_ALL) && user.employee?.id !== id;
  const canAdjust = can(PERMISSIONS.LEAVE_APPROVE) && can(PERMISSIONS.ATTENDANCE_READ_ALL);
  const canSchedules = can(PERMISSIONS.SCHEDULES_MANAGE);

  const report = useApi<AttendanceReportDto>(canReport ? '/reports/attendance' : null, { ...month, employeeId: id });
  const days = useApi<DayMetrics[]>(!canReport && canAttendance ? `/attendance/employees/${enc}/days` : null, month);
  const pending = useApi<Paginated<ApprovalItemDto>>(canApprove ? '/approvals' : null, { tab: 'PENDING', employeeId: id, page: 1, pageSize: 20 });
  const sessions = useApi<CorrectableSessionDto[]>(canCorrect ? `/corrections/employees/${enc}/sessions` : null);
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);

  const attendanceHref = employeeHref(id, 'attendance', back);
  const scheduleLabel = schedule.data ? `${schedule.data.scheduleName} (${t.employeeHub.scheduleSource[schedule.data.source]})` : null;
  const open = (sessions.data ?? []).filter((s) => s.status === 'MISSING_CHECKOUT');

  // ── This month ──
  let kpis: ReactNode = null;
  if (canReport) {
    const row = report.data?.rows[0];
    kpis = report.error && !report.data ? (
      <ErrorState compact error={report.error} onRetry={() => void report.refetch()} />
    ) : row ? (
      <ReportKpis totals={row.totals} variant="headline" href={attendanceHref} />
    ) : (
      <LoadingRows rows={1} className="px-0" />
    );
  } else if (canAttendance) {
    const list = days.data;
    const cards = list
      ? [
          { label: o.kpis.present, icon: CalendarCheck, accent: 'var(--status-working)', value: formatNumber(list.filter((d) => d.presenceMinutes > 0).length, locale) },
          { label: o.kpis.late, icon: AlarmClock, accent: 'var(--status-missing)', value: formatNumber(list.filter((d) => d.isLate).length, locale) },
          { label: o.kpis.absent, icon: CalendarX, accent: 'var(--status-absent)', value: formatNumber(list.filter((d) => d.status === 'ABSENT').length, locale) },
          { label: o.kpis.worked, icon: Clock, value: formatMinutes(list.reduce((s, d) => s + d.netWorkMinutes, 0), units) },
        ]
      : null;
    kpis = days.error && !days.data ? (
      <ErrorState compact error={days.error} onRetry={() => void days.refetch()} />
    ) : cards ? (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.label} href={attendanceHref} className="block rounded-2xl [&>div]:h-full">
            <KpiCard {...c} />
          </Link>
        ))}
      </div>
    ) : (
      <LoadingRows rows={1} className="px-0" />
    );
  }

  const pendingText = (i: ApprovalItemDto): string => {
    if (i.leave) {
      const r = i.leave;
      const type = r.leaveType ? localized(locale, r.leaveType.name, r.leaveType.nameAr) : t.leave.confidential;
      const dates = r.startDate === r.endDate ? formatWorkDate(r.startDate, locale) : `${formatWorkDate(r.startDate, locale)} – ${formatWorkDate(r.endDate, locale)}`;
      return `${type} · ${dates}`;
    }
    if (i.overtime) return `${t.requests.kind.OVERTIME} · ${formatWorkDate(i.overtime.workDate, locale)} · ${formatMinutes(i.overtime.minutes, units)}`;
    if (i.correction) {
      const c = i.correction;
      return `${t.corrections.kinds[c.kind]} · ${c.session ? formatWorkDate(c.session.workDate, locale) : formatDateTime(c.proposedTime, locale)}`;
    }
    return t.requests.kind[i.kind];
  };

  return (
    <div className="space-y-6">
      {welcome && (
        <Card className="border-[color:var(--brand-soft)]/30">
          <CardContent className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold">{fmt(o.welcome.title, { name })}</h2>
              <Button variant="ghost" size="sm" className="max-md:min-h-10" onClick={onDismissWelcome}>
                <X aria-hidden />
                {o.welcome.dismiss}
              </Button>
            </div>
            <ol className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
              <ChecklistItem
                title={o.welcome.schedule}
                hint={scheduleLabel ? fmt(o.welcome.scheduleHint, { label: scheduleLabel }) : t.common.loading}
                action={canSchedules && <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={onAssign}>{o.welcome.change}</Button>}
              />
              {canAdjust && (
                <ChecklistItem
                  title={o.welcome.entitlements}
                  help={o.welcome.entitlementsHint}
                  action={<Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => goTab('leave')}>{o.welcome.personalise}</Button>}
                />
              )}
              {canAdjust && (
                <ChecklistItem
                  title={o.welcome.opening}
                  help={o.welcome.openingHint}
                  action={<Button size="sm" variant="outline" className="max-md:min-h-10" onClick={onAdjust}>{o.welcome.adjust}</Button>}
                />
              )}
              <ChecklistItem
                title={o.welcome.signIn}
                hint={
                  employee.user ? (
                    <>
                      {o.welcome.signInHint.split('{username}')[0]}
                      <span dir="ltr" className="text-foreground font-medium">{employee.user.username}</span>
                      {o.welcome.signInHint.split('{username}')[1] ?? ''}
                    </>
                  ) : (
                    o.welcome.noAccount
                  )
                }
              />
            </ol>
          </CardContent>
        </Card>
      )}

      {kpis && (
        <section className="space-y-3" aria-labelledby="ov-month">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="ov-month" className="font-semibold">{o.monthTitle}</h2>
            <Link href={attendanceHref} className={linkClass}>
              {o.openAttendance}
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
            </Link>
          </div>
          {kpis}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {balances && (
          <Section
            title={o.leaveTitle}
            action={
              <Link href={employeeHref(id, 'leave', back)} className={linkClass}>
                {o.leaveAll}
                <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
              </Link>
            }
          >
            {balances.error && !balances.data ? (
              <ErrorState compact error={balances.error} onRetry={() => void balances.refetch()} />
            ) : !balances.data ? (
              <LoadingRows rows={2} className="px-0" />
            ) : balances.data.length === 0 ? (
              <EmptyState title={t.leave.noBalances} />
            ) : (
              <ul className="divide-y divide-tint/[0.05]">
                {balances.data.map((b) => (
                  <li key={b.leaveType.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                    <span>{localized(locale, b.leaveType.name, b.leaveType.nameAr)}</span>
                    <span className="tabular font-semibold" dir="auto">{amount(b.available, b.leaveType.unit)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {canApprove && (
          <Section title={o.pendingTitle}>
            {pending.error && !pending.data ? (
              <ErrorState compact error={pending.error} onRetry={() => void pending.refetch()} />
            ) : !pending.data ? (
              <LoadingRows rows={2} className="px-0" />
            ) : pending.data.items.length === 0 ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-[color:var(--status-working)]" aria-hidden />
                {o.pendingEmpty}
              </p>
            ) : (
              <ul className="divide-y divide-tint/[0.05]">
                {pending.data.items.map((i) => (
                  <li key={`${i.kind}-${i.id}`}>
                    <Link
                      href={`/admin/approvals?kind=${i.kind}&id=${encodeURIComponent(i.id)}`}
                      className="flex min-h-10 items-center justify-between gap-3 rounded-lg py-2 text-sm hover:bg-tint/[0.03]"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{pendingText(i)}</span>
                        {/* submittedAt is a UTC instant: take its Amman calendar date, not the UTC one. */}
                        <span className="text-muted-foreground text-xs">{fmt(o.submitted, { date: formatWorkDate(todayInAmman(Date.parse(i.submittedAt)), locale) })}</span>
                      </span>
                      <ChevronRight className="text-muted-foreground size-4 shrink-0 rtl:-scale-x-100" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {(canAttendance || canSchedules) && (
          <Section
            title={o.scheduleTitle}
            action={
              canSchedules && (
                <Link href={employeeHref(id, 'schedule', back)} className={linkClass}>
                  {o.change}
                  <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
                </Link>
              )
            }
          >
            {schedule.error && !schedule.data ? (
              <ErrorState compact error={schedule.error} onRetry={() => void schedule.refetch()} />
            ) : !schedule.data ? (
              <LoadingRows rows={1} className="px-0" />
            ) : (
              <div className="space-y-1 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <Hourglass className="text-muted-foreground size-4" aria-hidden />
                  <bdi>{schedule.data.scheduleName}</bdi>
                </p>
                <p className="text-muted-foreground">
                  {t.employeeHub.scheduleSource[schedule.data.source]}
                  {schedule.data.validTo && ` · ${fmt(o.until, { date: formatWorkDate(schedule.data.validTo, locale) })}`}
                </p>
              </div>
            )}
          </Section>
        )}

        {canCorrect && (
          <Section title={o.alertsTitle}>
            {sessions.error && !sessions.data ? (
              <ErrorState compact error={sessions.error} onRetry={() => void sessions.refetch()} />
            ) : !sessions.data ? (
              <LoadingRows rows={1} className="px-0" />
            ) : open.length === 0 ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-[color:var(--status-working)]" aria-hidden />
                {o.noAlerts}
              </p>
            ) : (
              <ul className="divide-y divide-tint/[0.05]">
                {open.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                    <span className="flex min-w-0 items-start gap-2">
                      <AlarmClockOff className="mt-0.5 size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />
                      <span>
                        <span className="block font-medium">{fmt(o.openPeriod, { date: formatWorkDate(s.workDate, locale, 'long') })}</span>
                        <span className="text-muted-foreground text-xs">
                          {o.openPeriodSince.split('{time}')[0]}
                          <bdi className="tabular">{formatTime(s.startedAt, locale)}</bdi>
                          {o.openPeriodSince.split('{time}')[1] ?? ''}
                        </span>
                      </span>
                    </span>
                    <Button
                      size="sm"
                      className="max-md:min-h-10"
                      aria-label={`${o.fix}: ${formatWorkDate(s.workDate, locale, 'long')}`}
                      onClick={() => setDraft({ kind: 'MISSING_CHECK_OUT', sessionId: s.id })}
                    >
                      {o.fix}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      {canCorrect && (
        <DirectCorrectionDialog
          employee={{ id, name }}
          sessions={sessions.data ?? []}
          draft={draft}
          onClose={() => setDraft(null)}
          onApplied={() => {
            void sessions.refetch();
            void report.refetch();
            void days.refetch();
            onAttendanceChanged();
          }}
        />
      )}
    </div>
  );
}

/** `hint` is a visible status line (data); `help` is an explanation shown behind a "?" after the title. */
function ChecklistItem({ title, hint, help, action }: { title: string; hint?: ReactNode; help?: string; action?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-sm font-medium">
          {title}
          {help && <HelpTip text={help} />}
        </p>
        {help && <p className="sr-only">{help}</p>}
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      {action}
    </li>
  );
}

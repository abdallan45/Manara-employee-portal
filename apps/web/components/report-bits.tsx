'use client';

import Link from 'next/link';
import { AlarmClock, AlarmClockOff, CalendarCheck, CalendarX, Clock, Coffee, Hourglass, LogOut, Percent, Plane, TimerOff } from 'lucide-react';
import type { AttendanceReportDto, AttendanceReportTotals } from '@workforce/shared';

import { KpiCard } from '@/components/kpi-card';
import { formatMinutes, formatNumber, formatPercent, localized } from '@/lib/format';
import { fmt, type Dictionary } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

/**
 * Headline figures of a report (whole company, a department, or one employee). `variant="headline"`
 * shows only Days present, Late days, Absences and Hours worked; `href` makes every card a link.
 */
export function ReportKpis({ totals, variant = 'full', href }: { totals: AttendanceReportTotals; variant?: 'full' | 'headline'; href?: string }) {
  const { t, locale, units } = useI18n();
  const k = t.reports.kpis;
  const h = t.reports.hints;
  const d = (m: number) => formatMinutes(m, units);
  const n = (v: number) => formatNumber(v, locale);
  const cards = [
    {
      label: k.attendanceRate, icon: Percent, accent: 'var(--status-working)',
      value: totals.attendanceRate === null ? '—' : formatPercent(totals.attendanceRate, locale),
      hint: totals.attendanceRate === null ? h.noneExpected : undefined,
    },
    { label: k.present, icon: CalendarCheck, accent: 'var(--status-working)', value: n(totals.presentDays),
      hint: fmt(h.presentOf, { n: n(totals.scheduledDays) })
        + (totals.remoteDays > 0 ? ` · ${fmt(h.remoteDays, { n: n(totals.remoteDays) })}` : '')
        + (totals.restDaysWorked > 0 ? ` · ${fmt(h.restDays, { n: n(totals.restDaysWorked) })}` : ''),
    },
    { label: k.absent, icon: CalendarX, accent: 'var(--status-absent)', value: n(totals.absentDays) },
    { label: k.leave, icon: Plane, accent: 'var(--status-leave)', value: n(totals.leaveDays) },
    { label: k.late, icon: AlarmClock, accent: 'var(--status-missing)', value: n(totals.lateDays), hint: fmt(h.lateTotal, { duration: d(totals.lateMinutes) }) },
    { label: k.earlyDeparture, icon: LogOut, accent: 'var(--status-missing)', value: d(totals.earlyDepartureMinutes) },
    { label: k.worked, icon: Clock, value: d(totals.netWorkMinutes), hint: fmt(h.workedOf, { duration: d(totals.requiredMinutes) }) },
    { label: k.missing, icon: TimerOff, accent: 'var(--status-missing)', value: d(totals.missingMinutes) },
    {
      label: k.overtime, icon: Hourglass, accent: 'var(--brand-soft)', value: d(totals.overtimeApprovedMinutes),
      hint: fmt(h.compensated, { duration: d(totals.overtimeCompensatedMinutes) }),
    },
    { label: k.excessBreaks, icon: Coffee, accent: 'var(--status-break)', value: d(totals.excessBreakMinutes) },
    { label: k.missingPunch, icon: AlarmClockOff, accent: 'var(--status-missing)', value: n(totals.missingPunchDays) },
  ];
  const o = t.employeeHub.overview.kpis;
  const shown = variant === 'headline'
    ? [
        { ...cards[1], label: o.present },
        { ...cards[4], label: o.late },
        { ...cards[2], label: o.absent },
        { ...cards[6], label: o.worked },
      ]
    : cards;
  return (
    <div className={variant === 'headline' ? 'grid grid-cols-2 gap-3 lg:grid-cols-4' : 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'}>
      {shown.map((c) =>
        href ? (
          <Link key={c.label} href={href} className="block rounded-2xl transition-colors [&>div]:h-full hover:[&>div]:border-tint/15">
            <KpiCard {...c} />
          </Link>
        ) : (
          <KpiCard key={c.label} {...c} />
        ),
      )}
    </div>
  );
}

/**
 * One CSV field. Text a spreadsheet would read as a formula (starting, after optional whitespace, with
 * = + - @ tab or CR) gets a leading ' so Excel/LibreOffice show it as text (CSV formula injection).
 * Numbers are written as they are: a negative number is data, not a formula.
 */
export const csvCell = (v: string | number | null) => {
  let s = v === null ? '' : String(v);
  if (typeof v === 'string' && /^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of a report in the viewer's language (UTF-8 with BOM so Excel shows Arabic correctly); amounts in minutes. */
export function reportCsv(report: AttendanceReportDto, t: Dictionary, locale: 'en' | 'ar'): string {
  const c = t.reports.cols;
  const x = t.reports.csv;
  const header = [
    x.code, c.employee, c.department, x.scheduledDays, c.present, x.remoteDays, x.restDays, c.absent, c.leave, x.lateDays, x.lateMinutes, x.earlyMinutes,
    x.workedMinutes, x.requiredMinutes, x.missingMinutes, x.breakMinutes, x.excessBreakMinutes, c.missingPunch,
    x.overtimeApproved, x.overtimeCompensated, x.rate,
  ];
  const lines = report.rows.map(({ employee: e, totals: s }) => [
    e.employeeCode, localized(locale, e.fullName, e.fullNameAr), localized(locale, e.departmentName, e.departmentNameAr),
    s.scheduledDays, s.presentDays, s.remoteDays, s.restDaysWorked, s.absentDays, s.leaveDays, s.lateDays, s.lateMinutes, s.earlyDepartureMinutes,
    s.netWorkMinutes, s.requiredMinutes, s.missingMinutes, s.breakMinutes, s.excessBreakMinutes, s.missingPunchDays,
    s.overtimeApprovedMinutes, s.overtimeCompensatedMinutes,
    s.attendanceRate === null ? null : Math.round(s.attendanceRate * 1000) / 10,
  ]);
  return '﻿' + [header, ...lines].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  downloadBlob(filename, new Blob([text], { type }));
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

'use client';

// Excel export of an attendance report: a summary sheet plus detail tabs (daily, lateness, absences,
// leave, overtime, corrections) and, for a multi-employee report, one tab per employee.
// exceljs is loaded on demand so it never weighs on normal page loads.
import type { AttendanceReportDto, AttendanceReportRow, AttendanceReportTotals, DayMetrics } from '@workforce/shared';
import type { Workbook, Worksheet } from 'exceljs';

import { downloadBlob } from '@/components/report-bits';
import { localized } from '@/lib/format';
import type { Dictionary, Locale } from '@/lib/i18n/dictionaries';

const MAX_EMPLOYEE_TABS = 60;
const TZ = 'Asia/Amman';
const DURATION = '[h]:mm';
const BRAND = 'FFCE1289';

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** Minutes as an Excel duration (fraction of a day) so totals add up in Excel. */
const dur = (minutes: number | null | undefined) => (minutes === null || minutes === undefined ? null : minutes / 1440);
const day = (date: string) => new Date(`${date}T00:00:00Z`);
const time = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '');
const stamp = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)).replace(',', '') : '');
/** Excel sheet names: max 31 chars, none of : \ / ? * [ ] and unique within the workbook. */
function sheetName(wb: Workbook, wanted: string): string {
  const base = wanted.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  for (let i = 2; wb.getWorksheet(name); i++) name = `${base.slice(0, 28)} ${i}`;
  return name;
}

interface Col {
  header: string;
  width?: number;
  /** 'dur' = minutes shown as h:mm, 'date' = YYYY-MM-DD, 'pct' = 0–1 ratio. */
  kind?: 'dur' | 'date' | 'pct' | 'num' | 'text';
}

function table(ws: Worksheet, cols: Col[], rows: (string | number | Date | null)[][], startRow: number, totals?: (string | number | null)[]) {
  const header = ws.getRow(startRow);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    ws.getColumn(i + 1).width = Math.max(ws.getColumn(i + 1).width ?? 0, c.width ?? 14);
  });
  header.height = 30;
  const fmt = (c: Col | undefined) => (c?.kind === 'dur' ? DURATION : c?.kind === 'date' ? 'yyyy-mm-dd' : c?.kind === 'pct' ? '0.0%' : undefined);
  rows.forEach((values, r) => {
    const row = ws.getRow(startRow + 1 + r);
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      const f = fmt(cols[i]);
      if (f) cell.numFmt = f;
    });
  });
  if (totals) {
    const row = ws.getRow(startRow + 1 + rows.length);
    totals.forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v;
      cell.font = { bold: true };
      cell.border = { top: { style: 'thin' } };
      const f = fmt(cols[i]);
      if (f) cell.numFmt = f;
    });
  }
  ws.views = [{ state: 'frozen', ySplit: startRow, rightToLeft: ws.views?.[0]?.rightToLeft ?? false }];
  if (rows.length) ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow + rows.length, column: cols.length } };
}

function newSheet(wb: Workbook, name: string, rtl: boolean): Worksheet {
  return wb.addWorksheet(sheetName(wb, name), { views: [{ rightToLeft: rtl }] });
}

export async function exportReportExcel(report: AttendanceReportDto, t: Dictionary, locale: Locale, opts: { single?: boolean } = {}) {
  const mod = await import('exceljs');
  // exceljs is CommonJS: depending on the bundler interop the classes sit on the namespace or on `default`.
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const wb: Workbook = new ExcelJS.Workbook();
  wb.creator = 'Employee Portal';
  wb.created = new Date(report.generatedAt);
  const rtl = locale === 'ar';
  const x = t.reports.xlsx;
  const s = t.reports.sheets;
  const k = t.reports.kpis;
  const c = t.reports.cols;
  const name = (r: AttendanceReportRow) => localized(locale, r.employee.fullName, r.employee.fullNameAr);
  const dept = (r: AttendanceReportRow) => localized(locale, r.employee.departmentName, r.employee.departmentNameAr);
  const byId = new Map(report.rows.map((r) => [r.employee.id, r]));
  const who = (id: string) => byId.get(id);
  const weekday = (date: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(day(date));
  const status = (st: string) => (t.requests.status as Record<string, string>)[st] ?? st;
  const yes = (b: boolean) => (b ? t.common.yes : '');

  // ── Summary ──
  const summary = newSheet(wb, s.summary, rtl);
  const single = opts.single && report.rows.length === 1 ? report.rows[0] : null;
  summary.getCell('A1').value = single ? `${x.employeeTitle} - ${name(single)}` : x.title;
  summary.getCell('A1').font = { bold: true, size: 14 };
  summary.getCell('A2').value = `${x.period}: ${report.from} → ${report.to}`;
  summary.getCell('A3').value = `${x.generated}: ${stamp(report.generatedAt)} · ${x.durationsNote}`;
  summary.getCell('A4').value = t.reports.note;
  summary.getCell('A4').font = { italic: true, color: { argb: 'FF666666' } };

  const totalsCols: Col[] = [
    { header: x.code, width: 11 }, { header: x.employee, width: 26 }, { header: x.department, width: 18 },
    { header: t.reports.csv.scheduledDays, kind: 'num' }, { header: c.present, kind: 'num' }, { header: t.reports.csv.restDays, kind: 'num' },
    { header: c.absent, kind: 'num' }, { header: c.leave, kind: 'num' }, { header: x.remote, kind: 'num' }, { header: t.reports.csv.lateDays, kind: 'num' },
    { header: x.late, kind: 'dur' }, { header: x.earlyDeparture, kind: 'dur' }, { header: x.net, kind: 'dur' }, { header: x.required, kind: 'dur' },
    { header: x.missing, kind: 'dur' }, { header: x.excessBreaks, kind: 'dur' }, { header: x.missingPunch, kind: 'num' },
    { header: k.overtime, kind: 'dur' }, { header: x.compensated, kind: 'dur' },
    { header: k.attendanceRate, kind: 'pct' },
  ];
  const totalsValues = (tt: AttendanceReportTotals) => [
    tt.scheduledDays, tt.presentDays, tt.restDaysWorked, tt.absentDays, tt.leaveDays, tt.remoteDays ?? 0, tt.lateDays,
    dur(tt.lateMinutes), dur(tt.earlyDepartureMinutes), dur(tt.netWorkMinutes), dur(tt.requiredMinutes), dur(tt.missingMinutes),
    dur(tt.excessBreakMinutes), tt.missingPunchDays, dur(tt.overtimeApprovedMinutes), dur(tt.overtimeCompensatedMinutes),
    tt.attendanceRate,
  ];
  table(
    summary, totalsCols,
    report.rows.map((r) => [r.employee.employeeCode, name(r), dept(r), ...totalsValues(r.totals)]),
    6,
    single ? undefined : [x.total, '', '', ...totalsValues(report.totals)],
  );

  // ── Daily ──
  const dailyCols = (withEmployee: boolean): Col[] => [
    ...(withEmployee ? [{ header: x.code, width: 11 }, { header: x.employee, width: 24 }, { header: x.department, width: 16 }] : []),
    { header: x.date, kind: 'date', width: 12 }, { header: x.weekday, width: 12 }, { header: x.status, width: 16 }, { header: x.scheduled, width: 13 },
    { header: x.firstIn, width: 9 }, { header: x.lastOut, width: 9 }, { header: x.presence, kind: 'dur' }, { header: x.paidBreaks, kind: 'dur' },
    { header: x.unpaidBreaks, kind: 'dur' }, { header: x.excessBreaks, kind: 'dur' }, { header: x.net, kind: 'dur' }, { header: x.required, kind: 'dur' },
    { header: x.missing, kind: 'dur' }, { header: x.late, kind: 'dur' }, { header: x.earlyDeparture, kind: 'dur' }, { header: k.overtime, kind: 'dur' },
    { header: x.remote, width: 9 },
  ];
  // Only approved overtime counts (calculated extra time is not overtime until a manager approves it).
  const approvedOt = new Map<string, number>();
  for (const o of report.details?.overtime ?? []) {
    if (o.status === 'APPROVED') approvedOt.set(`${o.employeeId}|${o.workDate}`, (o.approvedMinutes ?? o.minutes) + (approvedOt.get(`${o.employeeId}|${o.workDate}`) ?? 0));
  }
  const otOf = (employeeId: string, d: DayMetrics) => approvedOt.get(`${employeeId}|${d.workDate}`) ?? 0;
  const scheduledText = (d: DayMetrics) =>
    !d.scheduled.isWorkday ? t.myAttendance.off : d.scheduled.type === 'FLEXIBLE' ? t.scheduleType.FLEXIBLE : `${d.scheduled.start ?? ''}–${d.scheduled.end ?? ''}`;
  const dayValues = (employeeId: string, d: DayMetrics) => [
    day(d.workDate), weekday(d.workDate), t.dayStatus[d.status] ?? d.status, scheduledText(d), time(d.firstIn), time(d.lastOut),
    dur(d.presenceMinutes), dur(d.paidBreakMinutes), dur(d.unpaidBreakMinutes), dur(d.excessBreakMinutes), dur(d.netWorkMinutes),
    dur(d.requiredMinutes), dur(d.missingMinutes), dur(d.lateMinutes), dur(d.earlyDepartureMinutes), dur(otOf(employeeId, d)), yes(Boolean(d.remote)),
  ];
  const sumDays = (employeeId: string, days: DayMetrics[], label: string = x.total) => {
    const sum = (f: (d: DayMetrics) => number) => dur(days.reduce((a, d) => a + f(d), 0));
    return [label, '', '', '', '', '', sum((d) => d.presenceMinutes), sum((d) => d.paidBreakMinutes), sum((d) => d.unpaidBreakMinutes),
      sum((d) => d.excessBreakMinutes), sum((d) => d.netWorkMinutes), sum((d) => d.requiredMinutes), sum((d) => d.missingMinutes),
      sum((d) => d.lateMinutes), sum((d) => d.earlyDepartureMinutes), sum((d) => otOf(employeeId, d)), ''];
  };
  const allDays = report.rows.flatMap((r) => (r.days ?? []).map((d) => ({ r, d })));
  if (allDays.length) {
    const daily = newSheet(wb, s.daily, rtl);
    if (single) table(daily, dailyCols(false), (single.days ?? []).map((d) => dayValues(single.employee.id, d)), 1, sumDays(single.employee.id, single.days ?? []));
    else {
      // Day by day for each employee, each followed by that employee's total row.
      const rows: (string | number | Date | null)[][] = [];
      const totalRows: number[] = [];
      for (const r of report.rows) {
        const days = r.days ?? [];
        for (const d of days) rows.push([r.employee.employeeCode, name(r), dept(r), ...dayValues(r.employee.id, d)]);
        rows.push([r.employee.employeeCode, name(r), dept(r), ...sumDays(r.employee.id, days, `${x.total} - ${name(r)}`)]);
        totalRows.push(rows.length);
      }
      table(daily, dailyCols(true), rows, 1);
      for (const n of totalRows) {
        const row = daily.getRow(1 + n);
        row.font = { bold: true };
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E8F0' } };
        });
      }
    }

    // ── Lateness / absences ──
    const late = newSheet(wb, s.late, rtl);
    const lateRows = allDays.filter(({ d }) => d.isLate);
    table(
      late,
      [{ header: x.code, width: 11 }, { header: x.employee, width: 24 }, { header: x.date, kind: 'date', width: 12 }, { header: x.weekday, width: 12 },
        { header: x.scheduled, width: 13 }, { header: x.firstIn, width: 9 }, { header: x.late, kind: 'dur' }],
      lateRows.map(({ r, d }) => [r.employee.employeeCode, name(r), day(d.workDate), weekday(d.workDate), scheduledText(d), time(d.firstIn), dur(d.lateMinutes)]),
      1,
      lateRows.length ? [x.total, '', '', '', '', '', dur(lateRows.reduce((a, { d }) => a + d.lateMinutes, 0))] : undefined,
    );
    const absences = newSheet(wb, s.absences, rtl);
    const absentRows = allDays.filter(({ d }) => d.status === 'ABSENT' || d.status === 'MISSING_PUNCH' || d.status === 'ON_LEAVE');
    table(
      absences,
      [{ header: x.code, width: 11 }, { header: x.employee, width: 24 }, { header: x.date, kind: 'date', width: 12 }, { header: x.weekday, width: 12 },
        { header: x.status, width: 18 }, { header: x.firstIn, width: 9 }, { header: x.missing, kind: 'dur' }],
      absentRows.map(({ r, d }) => [r.employee.employeeCode, name(r), day(d.workDate), weekday(d.workDate), t.dayStatus[d.status] ?? d.status, time(d.firstIn), dur(d.missingMinutes)]),
      1,
    );
  }

  // ── Requests ──
  const details = report.details;
  if (details) {
    const empCols: Col[] = single ? [] : [{ header: x.code, width: 11 }, { header: x.employee, width: 24 }];
    const empVals = (id: string) => {
      const r = who(id);
      return single ? [] : [r?.employee.employeeCode ?? '', r ? name(r) : ''];
    };
    const leave = newSheet(wb, s.leave, rtl);
    table(
      leave,
      [...empCols, { header: x.leaveType, width: 20 }, { header: x.mode, width: 12 }, { header: x.from, kind: 'date', width: 12 }, { header: x.to, kind: 'date', width: 12 },
        { header: x.amount, kind: 'dur' }, { header: x.status, width: 12 }, { header: x.reason, width: 30 }, { header: x.attachments, kind: 'num', width: 11 },
        { header: x.submitted, width: 17 }, { header: x.decided, width: 17 }],
      details.leave.map((l) => [
        ...empVals(l.employeeId),
        l.leaveType ? localized(locale, l.leaveType.name, l.leaveType.nameAr) : x.confidential,
        (t.leave.modes as Record<string, string>)[l.mode] ?? l.mode, day(l.startDate), day(l.endDate), dur(l.minutes), status(l.status),
        l.reason ?? '', l.attachments, stamp(l.createdAt), stamp(l.decidedAt),
      ]),
      1,
    );
    const overtime = newSheet(wb, s.overtime, rtl);
    table(
      overtime,
      [...empCols, { header: x.workDate, kind: 'date', width: 12 }, { header: x.requested, kind: 'dur' }, { header: x.approved, kind: 'dur' },
        { header: x.multiplier, width: 10 }, { header: x.compensated, kind: 'dur' }, { header: x.compensation, width: 12 }, { header: x.preApproval, width: 11 },
        { header: x.status, width: 12 }, { header: x.reason, width: 30 }, { header: x.submitted, width: 17 }, { header: x.decided, width: 17 }],
      details.overtime.filter((o) => o.status === 'APPROVED').map((o) => [
        ...empVals(o.employeeId), day(o.workDate), dur(o.minutes), dur(o.approvedMinutes), o.multiplier ?? '', dur(o.compensatedMinutes),
        (t.overtime.compensationTypes as Record<string, string>)[o.compensation] ?? o.compensation, yes(o.isPreApproval), status(o.status), o.reason,
        stamp(o.createdAt), stamp(o.decidedAt),
      ]),
      1,
    );
    const corrections = newSheet(wb, s.corrections, rtl);
    table(
      corrections,
      [...empCols, { header: x.kind, width: 20 }, { header: x.event, width: 12 }, { header: x.proposedTime, width: 17 }, { header: x.proposedEnd, width: 17 },
        { header: x.status, width: 12 }, { header: x.reason, width: 30 }, { header: x.comment, width: 24 }, { header: x.submitted, width: 17 }, { header: x.decided, width: 17 }],
      details.corrections.map((cr) => [
        ...empVals(cr.employeeId), (t.corrections.kinds as Record<string, string>)[cr.kind] ?? cr.kind,
        (t.corrections.eventTypes as Record<string, string>)[cr.eventType] ?? cr.eventType, stamp(cr.proposedTime), stamp(cr.proposedEndTime),
        status(cr.status), cr.reason, cr.decisionComment ?? '', stamp(cr.createdAt), stamp(cr.decidedAt),
      ]),
      1,
    );
  }

  // ── One tab per employee (multi-employee detailed report) ──
  if (!single && allDays.length && report.rows.length <= MAX_EMPLOYEE_TABS) {
    for (const r of report.rows) {
      const ws = newSheet(wb, `${r.employee.employeeCode} ${name(r)}`, rtl);
      ws.getCell('A1').value = `${name(r)} · ${r.employee.employeeCode}${dept(r) ? ` · ${dept(r)}` : ''}`;
      ws.getCell('A1').font = { bold: true, size: 13 };
      ws.getCell('A2').value = `${x.period}: ${report.from} → ${report.to}`;
      table(ws, dailyCols(false), (r.days ?? []).map((d) => dayValues(r.employee.id, d)), 4, sumDays(r.employee.id, r.days ?? []));
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const base = single ? `attendance_${single.employee.employeeCode}` : 'attendance-report';
  downloadBlob(`${base}_${report.from}_${report.to}.xlsx`, new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

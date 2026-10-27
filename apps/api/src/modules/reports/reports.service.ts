import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS, type AttendanceReportDetails, type AttendanceReportDto, type AttendanceReportRow, type AttendanceReportTotals, type DayMetrics,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { employeeScopeWhere, inScope, readScope } from '../../common/scope';
import { addDays, dateOnly, localDate, startOfLocalDay } from '../../common/time';
import { AttendanceMetricsService } from '../attendance/attendance-metrics.service';
import { resolveRange } from '../attendance/date-range';
import { leaveDates } from '../attendance/leave-days';
import { compensatedMinutes } from '../requests/overtime-math';

/** Longest range one report may cover (about a quarter). */
export const MAX_REPORT_DAYS = 93;

const emptyTotals = (): AttendanceReportTotals => ({
  scheduledDays: 0, presentDays: 0, restDaysWorked: 0, absentDays: 0, leaveDays: 0, remoteDays: 0, lateDays: 0, lateMinutes: 0, earlyDepartureMinutes: 0,
  missingPunchDays: 0, requiredMinutes: 0, netWorkMinutes: 0, missingMinutes: 0, extraMinutes: 0, breakMinutes: 0,
  excessBreakMinutes: 0, overtimeApprovedMinutes: 0, overtimePendingMinutes: 0, overtimeCompensatedMinutes: 0, attendanceRate: null,
});

const rate = (t: AttendanceReportTotals) => {
  const expected = t.scheduledDays - t.leaveDays;
  return expected > 0 ? Math.round((t.presentDays / expected) * 1000) / 1000 : null;
};

/**
 * Adds one day's calc.ts figures. Days after today, and today before the employee is due
 * (NOT_STARTED), are ignored: nothing is known about them yet.
 */
export function addDay(t: AttendanceReportTotals, d: DayMetrics, today: string): void {
  if (d.workDate > today || d.status === 'NOT_STARTED') return;
  if (d.scheduled.isWorkday) t.scheduledDays++;
  if (d.firstIn !== null) {
    if (d.scheduled.isWorkday) t.presentDays++;
    else t.restDaysWorked++;
    if (d.remote) t.remoteDays++;
  }
  if (d.status === 'ABSENT') t.absentDays++;
  if (d.status === 'ON_LEAVE') t.leaveDays++;
  if (d.isLate) t.lateDays++;
  if (d.missingPunch) t.missingPunchDays++;
  t.lateMinutes += d.lateMinutes;
  t.earlyDepartureMinutes += d.earlyDepartureMinutes;
  t.requiredMinutes += d.requiredMinutes;
  t.netWorkMinutes += d.netWorkMinutes;
  t.missingMinutes += d.missingMinutes;
  t.extraMinutes += d.extraMinutes;
  t.breakMinutes += d.breakMinutes;
  t.excessBreakMinutes += d.excessBreakMinutes;
}

const NUMERIC_KEYS = Object.keys(emptyTotals()).filter((k) => k !== 'attendanceRate') as (keyof Omit<AttendanceReportTotals, 'attendanceRate'>)[];

export interface ReportQuery {
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  /** Daily figures for every row plus the leave / overtime / correction records of the period. */
  detail?: boolean;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly metrics: AttendanceMetricsService) {}

  /**
   * Per-employee attendance totals for a range: HR/admins (reports.read.all) see everyone,
   * department managers (reports.read.team) their departments. With `employeeId` the row also
   * carries the daily figures; `detail` adds them for every row, plus the request records.
   */
  async attendance(user: AuthUser, q: ReportQuery): Promise<AttendanceReportDto> {
    const now = new Date();
    const today = localDate(now);
    const { from, to } = resolveRange(q.from, q.to, MAX_REPORT_DAYS, now);
    const scope = readScope(user, PERMISSIONS.REPORTS_READ_ALL, PERMISSIONS.REPORTS_READ_TEAM);
    // A department filter is allowed for a managed department, or to narrow supervised employees by department.
    if (q.departmentId && scope !== null && !scope.departmentIds.includes(q.departmentId) && !scope.employeeIds.length) {
      throw AppError.forbidden('FORBIDDEN', 'This department is outside your scope');
    }

    const employees = await this.prisma.employee.findMany({
      // One employee is loaded first and checked against the scope below (404, like a missing employee).
      where: q.employeeId
        ? { deletedAt: null, id: q.employeeId }
        : { deletedAt: null, isActive: true, ...(q.departmentId ? { departmentId: q.departmentId } : {}), AND: [employeeScopeWhere(scope)] },
      select: {
        id: true, employeeCode: true, fullName: true, fullNameAr: true, departmentId: true, locationId: true,
        department: { select: { name: true, nameAr: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    if (q.employeeId) {
      const e = employees[0];
      if (!e) throw AppError.notFound('Employee not found');
      if (!inScope(scope, e)) throw AppError.notFound('Employee not found');
    }

    const ids = employees.map((e) => e.id);
    const [{ days }, overtime] = await Promise.all([
      this.metrics.computeRange(employees, from, to, now),
      ids.length
        ? this.prisma.overtimeRequest.findMany({
            where: { employeeId: { in: ids }, workDate: { gte: dateOnly.toDb(from), lte: dateOnly.toDb(to) }, status: { in: ['APPROVED', 'PENDING'] } },
            select: { employeeId: true, status: true, minutes: true, approvedMinutes: true, multiplier: true },
          })
        : Promise.resolve([]),
    ]);

    const rows: AttendanceReportRow[] = employees.map((e) => {
      const totals = emptyTotals();
      const list = days.get(e.id) ?? [];
      for (const d of list) addDay(totals, d, today);
      for (const o of overtime) {
        if (o.employeeId !== e.id) continue;
        if (o.status === 'PENDING') totals.overtimePendingMinutes += o.minutes;
        else {
          const minutes = o.approvedMinutes ?? o.minutes;
          totals.overtimeApprovedMinutes += minutes;
          totals.overtimeCompensatedMinutes += o.multiplier ? compensatedMinutes(minutes, o.multiplier.toString()) : minutes;
        }
      }
      totals.attendanceRate = rate(totals);
      return {
        employee: {
          id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, fullNameAr: e.fullNameAr,
          departmentId: e.departmentId, departmentName: e.department?.name ?? null, departmentNameAr: e.department?.nameAr ?? null,
        },
        totals,
        ...(q.employeeId || q.detail ? { days: list } : {}),
      };
    });

    const totals = emptyTotals();
    for (const r of rows) for (const k of NUMERIC_KEYS) totals[k] += r.totals[k];
    totals.attendanceRate = rate(totals);
    const details = q.detail ? await this.details(ids, from, to, scope === null) : undefined;
    return { from, to, generatedAt: now.toISOString(), rows, totals, ...(details ? { details } : {}) };
  }

  /** All leave, overtime and correction requests of the period (any status), oldest first. */
  private async details(ids: string[], from: string, to: string, companyWide: boolean): Promise<AttendanceReportDetails> {
    if (!ids.length) return { leave: [], overtime: [], corrections: [] };
    const start = startOfLocalDay(from);
    const end = startOfLocalDay(addDays(to, 1));
    const [leave, overtime, corrections] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where: { employeeId: { in: ids }, startAt: { lt: end }, endAt: { gt: start } },
        include: { leaveType: { select: { code: true, name: true, nameAr: true, isSensitive: true } }, _count: { select: { documents: true } } },
        orderBy: { startAt: 'asc' },
      }),
      this.prisma.overtimeRequest.findMany({
        where: { employeeId: { in: ids }, workDate: { gte: dateOnly.toDb(from), lte: dateOnly.toDb(to) } },
        orderBy: { workDate: 'asc' },
      }),
      this.prisma.attendanceCorrection.findMany({
        where: { employeeId: { in: ids }, proposedTime: { gte: start, lt: end } },
        orderBy: { proposedTime: 'asc' },
      }),
    ]);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      leave: leave.map((l) => {
        // Team-scope viewers (department managers) see sensitive leave only as "confidential".
        const confidential = l.leaveType.isSensitive && !companyWide;
        const { startDate, endDate } = leaveDates(l);
        return {
          id: l.id, employeeId: l.employeeId, confidential,
          leaveType: confidential ? null : { code: l.leaveType.code, name: l.leaveType.name, nameAr: l.leaveType.nameAr },
          mode: l.mode, startDate, endDate, minutes: l.minutes, status: l.status, reason: confidential ? null : l.reason,
          // How many documents a request carries can hint at the type, so masked rows show none.
          attachments: confidential ? 0 : l._count.documents, createdAt: l.createdAt.toISOString(), decidedAt: iso(l.decidedAt),
        };
      }),
      overtime: overtime.map((o) => {
        const multiplier = o.multiplier ? o.multiplier.toFixed(2) : null;
        const base = o.status === 'APPROVED' ? (o.approvedMinutes ?? o.minutes) : null;
        return {
          id: o.id, employeeId: o.employeeId, workDate: dateOnly.fromDb(o.workDate), minutes: o.minutes, approvedMinutes: o.approvedMinutes,
          multiplier, compensatedMinutes: base !== null && multiplier ? compensatedMinutes(base, multiplier) : base,
          compensation: o.compensation, isPreApproval: o.isPreApproval, status: o.status, reason: o.reason,
          createdAt: o.createdAt.toISOString(), decidedAt: iso(o.decidedAt),
        };
      }),
      corrections: corrections.map((c) => ({
        id: c.id, employeeId: c.employeeId, kind: c.kind, eventType: c.eventType, proposedTime: c.proposedTime.toISOString(),
        proposedEndTime: iso(c.proposedEndTime), status: c.status, reason: c.reason, decisionComment: c.decisionComment,
        createdAt: c.createdAt.toISOString(), decidedAt: iso(c.decidedAt),
      })),
    };
  }
}

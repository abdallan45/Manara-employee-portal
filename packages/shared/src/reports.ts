// Attendance report: per-employee totals over a date range (Asia/Amman local dates, minutes).
import type { DayMetrics } from './api';

export interface AttendanceReportTotals {
  /** Scheduled working days up to today (holidays and rest days excluded). */
  scheduledDays: number;
  /** Scheduled days with a check-in. */
  presentDays: number;
  /** Rest days and holidays with a check-in (not part of the attendance rate). */
  restDaysWorked: number;
  /** Scheduled days without a check-in and without approved full-day leave. */
  absentDays: number;
  /** Days of approved full-day leave (remote work is not leave). */
  leaveDays: number;
  /** Scheduled days covered by approved remote work with a check-in (also counted in presentDays). */
  remoteDays: number;
  lateDays: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  /** Days with a check-in but no check-out (missing punch). */
  missingPunchDays: number;
  requiredMinutes: number;
  netWorkMinutes: number;
  missingMinutes: number;
  /** Time worked beyond the requirement, as calculated (not necessarily approved overtime). */
  extraMinutes: number;
  breakMinutes: number;
  excessBreakMinutes: number;
  overtimeApprovedMinutes: number;
  overtimePendingMinutes: number;
  /** Approved overtime × the multiplier stored on each request (paid-equivalent or time-off minutes). */
  overtimeCompensatedMinutes: number;
  /** presentDays ÷ (scheduledDays − leaveDays), 0–1; null when nothing was expected. */
  attendanceRate: number | null;
}

export interface AttendanceReportRow {
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    fullNameAr: string | null;
    departmentId: string | null;
    departmentName: string | null;
    departmentNameAr: string | null;
  };
  totals: AttendanceReportTotals;
  /** Daily figures; included for a one-employee report and for detailed reports. */
  days?: DayMetrics[];
}

/** One leave request overlapping the period. Sensitive types are masked for team-scope viewers. */
export interface ReportLeaveRecord {
  id: string;
  employeeId: string;
  leaveType: { code: string; name: string; nameAr: string | null } | null;
  confidential: boolean;
  mode: string;
  startDate: string;
  endDate: string;
  minutes: number;
  status: string;
  reason: string | null;
  attachments: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface ReportOvertimeRecord {
  id: string;
  employeeId: string;
  workDate: string;
  minutes: number;
  approvedMinutes: number | null;
  multiplier: string | null;
  compensatedMinutes: number | null;
  compensation: string;
  isPreApproval: boolean;
  status: string;
  reason: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface ReportCorrectionRecord {
  id: string;
  employeeId: string;
  kind: string;
  eventType: string;
  proposedTime: string;
  proposedEndTime: string | null;
  status: string;
  reason: string;
  decisionComment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Request records in the period (all statuses), for detailed reports and spreadsheet exports. */
export interface AttendanceReportDetails {
  leave: ReportLeaveRecord[];
  overtime: ReportOvertimeRecord[];
  corrections: ReportCorrectionRecord[];
}

export interface AttendanceReportDto {
  from: string;
  to: string;
  generatedAt: string;
  rows: AttendanceReportRow[];
  /** Sum over all rows (attendanceRate recomputed from the summed days). */
  totals: AttendanceReportTotals;
  /** Present with detail=true. */
  details?: AttendanceReportDetails;
}

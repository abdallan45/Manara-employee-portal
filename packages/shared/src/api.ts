import type { OfficeGeofenceDto } from './attendance';
// API contract shared by the web app and (later) the Flutter app. Times are ISO-8601 UTC strings.
import type { PortalVisibility } from './portal';
import type { SaturdayRotaDay } from './rota';

export const API_PREFIX = '/api/v1';

export type AttendanceAction = 'CHECK_IN' | 'CHECK_OUT' | 'BREAK_START' | 'BREAK_END';
export type AttendanceState = 'OFF' | 'WORKING' | 'ON_BREAK';
export type EventSource = 'WEB' | 'MOBILE' | 'ADMIN_CORRECTION' | 'SYSTEM';
export type ScheduleType = 'FIXED' | 'FLEXIBLE';

/** Daily status shown in dashboards and timesheets. */
export type DayStatus =
  | 'WORKING' | 'ON_BREAK' | 'CHECKED_OUT' | 'ABSENT' | 'NOT_SCHEDULED'
  | 'ON_LEAVE' | 'MISSING_PUNCH' | 'PENDING_REVIEW'
  /** Scheduled workday whose start (+ grace) has not been reached yet and no check-in so far. */
  | 'NOT_STARTED';

/** Error envelope returned by every failing endpoint. */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
  statusCode: number;
  path: string;
  timestamp: string;
}

export const ERROR_CODES = [
  'VALIDATION_FAILED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED',
  'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'CSRF_FAILED',
  'NOT_AN_EMPLOYEE',
  // Device location (GPS) check on check-in / check-out
  'LOCATION_REQUIRED', 'LOCATION_INACCURATE', 'LOCATION_OUTSIDE_OFFICE', 'LOCATION_NOT_CONFIGURED',
  'ATTENDANCE_INVALID_TRANSITION', 'IDEMPOTENCY_KEY_REUSED', 'BREAK_TYPE_INACTIVE',
  'EMPLOYEE_CODE_TAKEN', 'USERNAME_TAKEN', 'INTERNAL_ERROR',
  // Requests and approvals
  'LEAVE_OVERLAP', 'LEAVE_BALANCE_INSUFFICIENT', 'LEAVE_TYPE_INACTIVE', 'LEAVE_ALREADY_STARTED',
  'REQUEST_NOT_PENDING', 'SELF_APPROVAL_FORBIDDEN', 'APPROVAL_NOT_ALLOWED', 'DUPLICATE_REQUEST',
  'OVERTIME_RETRO_NOT_ALLOWED', 'OVERTIME_EXCEEDS_RECORDED', 'OVERTIME_BELOW_MINIMUM', 'CORRECTION_INVALID',
  // Overtime asked for a Saturday that is part of the contract (the employee's rota Saturday off)
  'OVERTIME_CONTRACT_DAY',
  // Leave documents
  'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_TYPE_NOT_ALLOWED', 'ATTACHMENT_LIMIT_REACHED', 'ATTACHMENT_NOT_ALLOWED',
  // Passwords and sessions
  'PASSWORD_CHANGE_REQUIRED', 'INVALID_CURRENT_PASSWORD', 'PASSWORD_REUSED', 'UNSUPPORTED_MEDIA_TYPE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SessionUser {
  id: string;
  username: string;
  locale: 'en' | 'ar';
  roles: string[];
  permissions: string[];
  employee: { id: string; employeeCode: string; fullName: string; fullNameAr: string | null; departmentName: string | null; departmentNameAr: string | null } | null;
  /** company-wide employee-portal visibility; absent = all visible */
  portal?: PortalVisibility;
  /**
   * True when the account must set a new password before doing anything else (first login with a
   * temporary password, or after an admin reset). While true, every API call except GET /auth/me,
   * POST /auth/me/password and POST /auth/logout answers 403 PASSWORD_CHANGE_REQUIRED.
   */
  mustChangePassword: boolean;
}

/** POST /auth/me/password: change your own password (204 on success). */
export interface ChangePasswordInput {
  currentPassword: string;
  /** 10-128 characters, must differ from the current one. */
  newPassword: string;
}

export interface LoginResponse {
  user: SessionUser;
  /** Web clients get an HTTP-only cookie plus this CSRF token; mobile clients get a bearer token. */
  csrfToken?: string;
  accessToken?: string;
  expiresAt: string;
}

export interface BreakTypeDto {
  id: string; code: string; name: string; nameAr: string | null;
  maxMinutes: number | null; isPaid: boolean; requiresApproval: boolean;
  countsAsWork: boolean; notifyAfterMinutes: number | null; isActive: boolean;
}

/** Computed figures for one employee on one work date (Asia/Amman local date). */
export interface DayMetrics {
  workDate: string;
  status: DayStatus;
  scheduled: { type: ScheduleType; isWorkday: boolean; start: string | null; end: string | null; requiredMinutes: number; coreStart: string | null; coreEnd: string | null };
  firstIn: string | null;
  lastOut: string | null;
  presenceMinutes: number;
  breakMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  excessBreakMinutes: number;
  /** Presence minus break time beyond the included break allowance. */
  netWorkMinutes: number;
  /** Time to spend at work on this day, break included (0 on days off, holidays, full-day leave). */
  requiredMinutes: number;
  /** Break time inside the working day: breaks up to this many minutes still count as work. */
  includedBreakMinutes: number;
  /** Part of that allowance not yet used by deductible break time, as of the computation. */
  breakAllowanceLeftMinutes: number;
  missingMinutes: number;
  extraMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  missingCoreMinutes: number;
  missingPunch: boolean;
  isLate: boolean;
  /** Working day covered by approved remote work (a leave type with isRemoteWork): the schedule applies as usual. */
  remote: boolean;
  /**
   * Saturday rota: WORKING = the employee's group works (a normal workday), OFF = their Saturday off (nothing
   * required, never absent, time worked is recorded but never extra). null = not a rota Saturday for them.
   */
  saturdayRota: SaturdayRotaDay | null;
}

export interface AttendanceStatusDto {
  state: AttendanceState;
  serverTime: string;
  timezone: string;
  /**
   * Device-location rule for check-in and check-out. offices: active office geofences, so the client can show
   * how far away the employee is before they press. remote: today is covered by approved remote work, so
   * actions from outside the office are accepted.
   */
  location: { enforcement: 'ENFORCE' | 'FLAG'; maxAccuracyMeters: number; remote: boolean; offices: OfficeGeofenceDto[] };
  openSession: { id: string; startedAt: string } | null;
  openBreak: { id: string; startedAt: string; breakType: BreakTypeDto } | null;
  today: DayMetrics;
  /** Public holiday on today's local date (company-wide or for the employee's location), else null. */
  todayHoliday: { name: string; nameAr: string | null } | null;
  /**
   * Approved leave covering any part of today (remote work is not leave and is never reported here), else null.
   * The employee always sees their own type, sensitive or not. mode is FULL_DAY | HALF_DAY | HOURLY; startAt/endAt
   * (ISO, endAt exclusive) are the request's instants. When several cover today: a full day wins, then the one
   * running now, then the next one still to come today, then the earliest.
   */
  todayLeave: { leaveTypeName: string; leaveTypeNameAr: string | null; mode: string; startAt: string; endAt: string } | null;
  week: { netWorkMinutes: number; requiredMinutes: number; extraMinutes: number };
  month: { netWorkMinutes: number; requiredMinutes: number; extraMinutes: number };
  breakTypes: BreakTypeDto[];
}

export interface AttendanceEventDto {
  id: string;
  type: AttendanceAction;
  occurredAt: string;
  source: EventSource;
  /** The device location was inside an office geofence (always false for events without a location). */
  locationVerified: boolean;
  ipAddress: string;
  /** Device location sent with the action (check-in / check-out), else null. */
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  /** Distance to the nearest office at the time, metres. */
  distanceMeters: number | null;
  officeName: string | null;
  breakTypeName?: string | null;
  breakTypeNameAr?: string | null;
}

export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

export interface LiveAttendanceRow {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  fullNameAr: string | null;
  departmentId: string | null;
  departmentName: string | null;
  departmentNameAr: string | null;
  scheduleType: ScheduleType;
  state: AttendanceState;
  metrics: DayMetrics;
}

export interface DashboardSummary {
  date: string;
  kpis: {
    totalEmployees: number;
    currentlyWorking: number;
    onBreak: number;
    checkedOut: number;
    absent: number;
    /** Approved full-day leave on a scheduled day. */
    onLeave: number;
    late: number;
    missingCheckouts: number;
    totalWorkMinutes: number;
    extraMinutes: number;
    attendanceRate: number; // 0..1, present / scheduled
  };
  trend: { date: string; present: number; scheduled: number; late: number; workMinutes: number }[];
  /** departmentId null = employees without a department (name 'Unassigned', nameAr null). */
  departments: { departmentId: string | null; name: string; nameAr: string | null; present: number; scheduled: number; workMinutes: number }[];
}

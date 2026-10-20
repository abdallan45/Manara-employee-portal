// Permission catalog. The backend enforces these; the frontend only uses them to hide UI.
export const PERMISSIONS = {
  // Self-service
  ATTENDANCE_SELF: 'attendance.self',
  // Attendance visibility: team = departments the user manages, all = whole company
  ATTENDANCE_READ_TEAM: 'attendance.read.team',
  ATTENDANCE_READ_ALL: 'attendance.read.all',
  ATTENDANCE_CORRECT: 'attendance.correct',
  DASHBOARD_READ: 'dashboard.read',
  // People
  EMPLOYEES_READ: 'employees.read',
  EMPLOYEES_MANAGE: 'employees.manage',
  DEPARTMENTS_MANAGE: 'departments.manage',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  // Configuration
  SCHEDULES_MANAGE: 'schedules.manage',
  BREAK_TYPES_MANAGE: 'break_types.manage',
  /** Office locations (GPS geofences) used by the check-in / check-out location rule. */
  OFFICES_MANAGE: 'offices.manage',
  SETTINGS_MANAGE: 'settings.manage',
  // Oversight
  AUDIT_READ: 'audit.read',
  /** Manage Nouria's lines, recordings, rules and on/off switch. */
  MASCOT_MANAGE: 'mascot.manage',
  REPORTS_READ_TEAM: 'reports.read.team',
  REPORTS_READ_ALL: 'reports.read.all',
  REPORTS_EXPORT: 'reports.export',
  TIMESHEETS_CLOSE: 'timesheets.close',
  // Requests (later phases build on these)
  LEAVE_SELF: 'leave.self',
  LEAVE_APPROVE: 'leave.approve',
  OVERTIME_SELF: 'overtime.self',
  OVERTIME_APPROVE: 'overtime.approve',
  CORRECTIONS_APPROVE: 'corrections.approve',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  DEPARTMENT_MANAGER: 'DEPARTMENT_MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const;
export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

const P = PERMISSIONS;
const SELF: Permission[] = [P.ATTENDANCE_SELF, P.LEAVE_SELF, P.OVERTIME_SELF];

/** Default permission sets for the built-in roles (seeded; editable later through Roles & Permissions). */
export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  HR_ADMIN: [
    ...SELF,
    P.ATTENDANCE_READ_ALL, P.ATTENDANCE_CORRECT, P.DASHBOARD_READ,
    P.EMPLOYEES_READ, P.EMPLOYEES_MANAGE, P.DEPARTMENTS_MANAGE,
    P.SCHEDULES_MANAGE, P.BREAK_TYPES_MANAGE,
    P.REPORTS_READ_ALL, P.REPORTS_EXPORT, P.TIMESHEETS_CLOSE,
    P.LEAVE_APPROVE, P.OVERTIME_APPROVE, P.CORRECTIONS_APPROVE, P.AUDIT_READ, P.MASCOT_MANAGE,
  ],
  DEPARTMENT_MANAGER: [
    ...SELF,
    P.ATTENDANCE_READ_TEAM, P.DASHBOARD_READ, P.EMPLOYEES_READ, P.REPORTS_READ_TEAM,
    P.LEAVE_APPROVE, P.OVERTIME_APPROVE, P.CORRECTIONS_APPROVE,
  ],
  EMPLOYEE: SELF,
};

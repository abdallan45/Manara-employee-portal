// DTOs for administration endpoints. Times are ISO-8601 UTC strings; dates are YYYY-MM-DD (Asia/Amman).
import type { PortalVisibility } from './portal';
import type { EmployeeSaturdayGroup, SaturdayGroup } from './rota';

export interface DepartmentDto {
  id: string; code: string; name: string; nameAr: string | null;
  parentId: string | null; employeeCount: number;
  /** Saturday rota group of the department's employees; null = no rota. */
  saturdayGroup: SaturdayGroup | null;
}
/** POST /departments (departments.manage); PATCH takes any subset. */
export interface CreateDepartmentInput {
  code: string; name: string; nameAr?: string | null; parentId?: string | null; saturdayGroup?: SaturdayGroup | null;
}
export type UpdateDepartmentInput = Partial<CreateDepartmentInput>;

export interface RoleDto {
  id: string; key: string; name: string; nameAr: string | null; description: string | null; isSystem: boolean; permissions: string[];
  /** Active users holding the role. */
  userCount: number;
}

/** POST /roles (roles.manage). The key is fixed once created (approval chains refer to it). */
export interface CreateRoleInput {
  key: string; name: string; nameAr?: string | null; description?: string | null; permissions: string[];
}
/** PATCH /roles/:id. SUPER_ADMIN keeps every permission; system roles keep their key. */
export type UpdateRoleInput = Partial<Omit<CreateRoleInput, 'key'>>;

/** A user who approves for, and sees, an employee (project manager / supervisor). */
export interface SupervisorRef { userId: string; username: string; name: string | null; nameAr: string | null }

export interface EmployeeDto {
  id: string;
  employeeCode: string;
  fullName: string;
  fullNameAr: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  departmentNameAr: string | null;
  managerId: string | null;
  hireDate: string | null;
  /** Personal daily requirement in minutes (break included); null = the company default. */
  dailyRequiredMinutes: number | null;
  /** Personal break allowance inside that requirement; null = the company default. */
  includedBreakMinutes: number | null;
  /** Own Saturday rota group: A | B, NONE = no rota, null = the department's group. */
  saturdayGroup: EmployeeSaturdayGroup | null;
  /** Group that applies after the department default is resolved; null = Saturdays follow the schedule. */
  effectiveSaturdayGroup: SaturdayGroup | null;
  /** Users who approve this employee's requests and see their data (in addition to department managers). */
  supervisors: SupervisorRef[];
  isActive: boolean;
  createdAt: string;
  user: { id: string; username: string; isActive: boolean; roles: { key: string; departmentId: string | null }[]; lastLoginAt: string | null } | null;
}

export interface CreateEmployeeInput {
  employeeCode: string;
  fullName: string;
  fullNameAr?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  departmentId?: string | null;
  managerId?: string | null;
  hireDate?: string; // YYYY-MM-DD
  dailyRequiredMinutes?: number | null;
  includedBreakMinutes?: number | null;
  saturdayGroup?: EmployeeSaturdayGroup | null;
  /** User ids of the employee's supervisors (project managers); replaces the list on update. */
  supervisorUserIds?: string[];
  username: string;
  password: string;
  /** Role keys; defaults to ['EMPLOYEE']. */
  roleKeys?: string[];
  /** Departments this user manages (scopes DEPARTMENT_MANAGER). */
  managedDepartmentIds?: string[];
}
export type UpdateEmployeeInput = Partial<Omit<CreateEmployeeInput, 'password'>> & { password?: string };


export interface ScheduleDayDto { weekday: number; isWorkday: boolean; startMinute: number | null; endMinute: number | null; requiredMinutes: number }
export interface ScheduleDto {
  id: string; name: string; type: 'FIXED' | 'FLEXIBLE'; weeklyRequiredMinutes: number; graceMinutes: number;
  coreStartMinute: number | null; coreEndMinute: number | null; isDefault: boolean; days: ScheduleDayDto[];
  /**
   * Legacy, no longer used by the calculations: the daily requirement and break allowance come from the
   * employee (dailyRequiredMinutes / includedBreakMinutes) or the company work-hours rule for the day. Schedules
   * decide which days are workdays and the start/end times (lateness, early departure).
   */
  includedBreakMinutes: number;
}

export interface AuditLogDto {
  id: string; seq: string; actor: { id: string; username: string } | null;
  action: string; entityType: string; entityId: string | null;
  before: unknown; after: unknown; ipAddress: string | null; createdAt: string;
}
export interface AuditVerifyResult { valid: boolean; checked: number; brokenAtSeq: string | null }

export interface NotificationDto {
  id: string; type: string; title: string; body: string; data: Record<string, unknown>; readAt: string | null; createdAt: string;
}

export interface SettingDto { key: string; value: unknown; updatedAt: string }

/** Known system setting keys and their defaults. */
export const SETTING_DEFAULTS = {
  'company.name': 'Manara Entertainment',
  'company.timezone': 'Asia/Amman',
  /** ENFORCE: reject check-in / check-out away from the office. FLAG: accept but mark for review. */
  'attendance.locationEnforcement': 'ENFORCE' as 'ENFORCE' | 'FLAG',
  /** A device location less precise than this (metres) is refused as too vague. */
  'attendance.maxLocationAccuracyMeters': 150,
  /** An open session older than this is treated as a missing check-out. */
  'attendance.maxOpenSessionHours': 18,
  /** Approval chains for overtime and corrections (leave types have their own): 'MANAGER' or role keys, in order. */
  'approvals.overtimeSteps': ['MANAGER'] as string[],
  'approvals.correctionSteps': ['MANAGER'] as string[],
  'auth.maxFailedLogins': 5,
  'auth.lockoutMinutes': 15,
  'auth.sessionHours': 12,
  /** A session unused for this many minutes ends (0 = no idle limit). */
  'auth.idleMinutes': 60,
  /** Which "My work" pages and sections employees see (see portal.ts). Empty = everything visible. */
  'portal.visibility': {} as PortalVisibility,
  /** Nouria the mascot on/off for everyone (each employee can still mute or minimise her). */
  'mascot.enabled': true as boolean,
  /** Language Nouria speaks for everyone: auto (each viewer's interface language), ar or en. */
  'mascot.language': 'auto' as 'auto' | 'ar' | 'en',
  /** Saturday (YYYY-MM-DD) on which group A works first; the groups then alternate weekly. null = no rota. */
  'attendance.saturdayRotaStart': null as string | null,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Allowed integer ranges (inclusive) of the numeric settings; the API validates with the same values. */
export const SETTING_RANGES = {
  'attendance.maxOpenSessionHours': { min: 1, max: 48 },
  'attendance.maxLocationAccuracyMeters': { min: 10, max: 2000 },
  'auth.maxFailedLogins': { min: 3, max: 50 },
  'auth.lockoutMinutes': { min: 1, max: 1440 },
  'auth.sessionHours': { min: 1, max: 720 },
  'auth.idleMinutes': { min: 0, max: 1440 },
} as const satisfies Partial<Record<SettingKey, { min: number; max: number }>>;
export type RangedSettingKey = keyof typeof SETTING_RANGES;

/** Limits of a work-hours rule and of the per-employee overrides (minutes). */
export const WORK_HOURS_RANGES = {
  dailyRequiredMinutes: { min: 30, max: 1440 },
  includedBreakMinutes: { min: 0, max: 240 },
} as const;

/**
 * Company default daily requirement (break included) and break allowance from effectiveFrom on.
 * A day uses the rule with the latest effectiveFrom on or before it; employee overrides still win.
 * The break is counted as work whether taken or not; only longer breaks are deducted.
 */
export interface WorkHoursRuleDto {
  id: string;
  effectiveFrom: string; // YYYY-MM-DD
  dailyRequiredMinutes: number;
  includedBreakMinutes: number;
  createdAt: string;
}
/** Company hours in force today (GET /settings/work-hours/current). */
export type CurrentWorkHoursDto = Pick<WorkHoursRuleDto, 'effectiveFrom' | 'dailyRequiredMinutes' | 'includedBreakMinutes'>;
/** Creates a rule, or replaces the one with the same effectiveFrom. */
export interface CreateWorkHoursRuleInput {
  effectiveFrom: string; // YYYY-MM-DD
  dailyRequiredMinutes: number;
  includedBreakMinutes: number;
}

/** One-click demo login entry (GET /auth/demo/accounts, only when DEMO_MODE=true). */
export interface DemoAccountDto { username: string; displayName: string; displayNameAr: string | null; roles: string[] }

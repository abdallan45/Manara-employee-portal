import { PERMISSIONS } from '@workforce/shared';
import type { AuthUser } from './auth';
import { AppError } from './app-error';

/**
 * Department visibility for read operations.
 * Returns null when the user may see every department, otherwise the department ids they manage.
 * `allPermission` grants company-wide scope; `teamPermission` grants scope over managed departments.
 */
export function departmentScope(user: AuthUser, allPermission: string, teamPermission: string): string[] | null {
  if (user.permissions.has(allPermission)) return null;
  if (user.permissions.has(teamPermission)) return user.managedDepartmentIds;
  throw AppError.forbidden();
}

/** Attendance visibility: HR/admins see all, department managers see their departments. */
export const attendanceScope = (user: AuthUser) =>
  departmentScope(user, PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM);

/** True when a department id falls inside a scope returned by departmentScope. */
export const inScope = (scope: string[] | null, departmentId: string | null) =>
  scope === null || (departmentId !== null && scope.includes(departmentId));

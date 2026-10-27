import type { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@workforce/shared';
import type { AuthUser } from './auth';
import { AppError } from './app-error';

/**
 * Who a team viewer may see: every employee of the departments they manage (DEPARTMENT_MANAGER) plus the
 * employees assigned to them as supervisor (project managers). null below always means company-wide.
 */
export interface Scope {
  departmentIds: string[];
  employeeIds: string[];
}

export const teamScope = (user: AuthUser): Scope => ({ departmentIds: user.managedDepartmentIds, employeeIds: user.supervisedEmployeeIds });

/**
 * Visibility for read operations: null when the user may see everyone, otherwise their team scope.
 * `allPermission` grants company-wide scope; `teamPermission` grants the team scope.
 */
export function readScope(user: AuthUser, allPermission: string, teamPermission: string): Scope | null {
  if (user.permissions.has(allPermission)) return null;
  if (user.permissions.has(teamPermission)) return teamScope(user);
  throw AppError.forbidden();
}

/** Attendance visibility: HR/admins see all, managers their departments and supervised employees. */
export const attendanceScope = (user: AuthUser) =>
  readScope(user, PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM);

/** True when the employee falls inside the scope. */
export const inScope = (scope: Scope | null, employee: { id: string; departmentId: string | null }) =>
  scope === null
  || scope.employeeIds.includes(employee.id)
  || (employee.departmentId !== null && scope.departmentIds.includes(employee.departmentId));

/** Prisma filter on Employee for a scope ({} = everyone). */
export function employeeScopeWhere(scope: Scope | null): Prisma.EmployeeWhereInput {
  if (scope === null) return {};
  return { OR: [{ departmentId: { in: scope.departmentIds } }, { id: { in: scope.employeeIds } }] };
}

/** Prisma filter for rows that belong to an employee (an `employee` relation) inside a scope. */
export function employeeRelationScopeWhere(scope: Scope | null): { employee?: Prisma.EmployeeWhereInput } {
  return scope === null ? {} : { employee: employeeScopeWhere(scope) };
}

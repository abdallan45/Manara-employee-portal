// Pure approval routing: who may decide which request at which level. No I/O.
import { PERMISSIONS } from '@workforce/shared';
import type { AuthUser } from '../../common/auth';

/**
 * An approver for one request type. `companyWide` approvers (HR / admins: the approve permission plus
 * company-wide attendance access) act on every department; team approvers only on the departments
 * they manage.
 */
export interface Approver {
  userId: string;
  employeeId: string | null;
  companyWide: boolean;
  departmentIds: string[];
}

export function approverFor(user: AuthUser, permission: string): Approver | null {
  if (!user.permissions.has(permission)) return null;
  return {
    userId: user.userId,
    employeeId: user.employeeId,
    companyWide: user.permissions.has(PERMISSIONS.ATTENDANCE_READ_ALL),
    departmentIds: user.managedDepartmentIds,
  };
}

export const coversDepartment = (a: Approver, departmentId: string | null) =>
  a.companyWide || (departmentId !== null && a.departmentIds.includes(departmentId));

export interface RoutedRequest {
  employeeId: string;
  departmentId: string | null;
}

/** Single-level requests (overtime, corrections): any approver covering the department, never the requester. */
export const canDecideSingle = (a: Approver, r: RoutedRequest) => a.employeeId !== r.employeeId && coversDepartment(a, r.departmentId);

export interface RoutedLeave extends RoutedRequest {
  currentLevel: number;
  isSensitive: boolean;
  /** Users who already approved an earlier level of this request. */
  priorApproverIds: string[];
}

/**
 * Leave routing. Level 1 is the department manager step; levels 2…N are HR steps.
 * - HR (company-wide) may act at any level, including on behalf of the manager.
 * - A department manager acts only at level 1, only for departments they manage, never on sensitive types.
 * - Nobody approves their own request or two levels of the same request.
 */
export function canDecideLeave(a: Approver, r: RoutedLeave): boolean {
  if (a.employeeId !== null && a.employeeId === r.employeeId) return false;
  if (r.priorApproverIds.includes(a.userId)) return false;
  if (a.companyWide) return true;
  return r.currentLevel === 1 && !r.isSensitive && r.departmentId !== null && a.departmentIds.includes(r.departmentId);
}

/**
 * First level of a new leave request. The manager step is skipped for sensitive types or when the
 * department has no other manager; with two or more levels the request then starts at the first HR level.
 */
export const initialLeaveLevel = (approvalLevels: number, hasManagerStep: boolean) =>
  hasManagerStep || approvalLevels <= 1 ? 1 : 2;

/** Outcome of an approval at `level`: final, or the next level that still has to approve. */
export function afterLeaveApproval(level: number, approvalLevels: number): { final: true } | { final: false; nextLevel: number } {
  return level >= Math.max(1, approvalLevels) ? { final: true } : { final: false, nextLevel: level + 1 };
}

/** Who should be told a request is waiting at `level`: the department's managers, or HR. */
export const levelAudience = (level: number, isSensitive: boolean): 'TEAM' | 'COMPANY' => (level === 1 && !isSensitive ? 'TEAM' : 'COMPANY');

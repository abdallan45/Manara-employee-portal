// Pure approval routing: who may decide which step of a request's chain. No I/O.
import { FALLBACK_STEP, MANAGER_STEP, PERMISSIONS, SYSTEM_ROLES, type ApprovalStep } from '@workforce/shared';
import type { AuthUser } from '../../common/auth';

/**
 * An approver for one request kind (the user holds its approve permission).
 * - `companyWide`: company-wide attendance access (HR, general manager); decides the fallback step and
 *   sees every request.
 * - `departmentIds` / `employeeIds`: the team the user manages (department manager grants) or supervises
 *   (project manager); this is who they decide the MANAGER step for.
 * - `roles`: role keys, for the role steps of a chain.
 * - `superAdmin`: may decide any step (override).
 */
export interface Approver {
  userId: string;
  employeeId: string | null;
  companyWide: boolean;
  departmentIds: string[];
  employeeIds: string[];
  roles: string[];
  superAdmin: boolean;
}

export function approverFor(user: AuthUser, permission: string): Approver | null {
  if (!user.permissions.has(permission)) return null;
  return {
    userId: user.userId,
    employeeId: user.employeeId,
    companyWide: user.permissions.has(PERMISSIONS.ATTENDANCE_READ_ALL),
    departmentIds: user.managedDepartmentIds,
    employeeIds: user.supervisedEmployeeIds,
    roles: user.roles,
    superAdmin: user.roles.includes(SYSTEM_ROLES.SUPER_ADMIN),
  };
}

export interface RoutedEmployee {
  employeeId: string;
  departmentId: string | null;
}

/** The approver manages the employee's department or supervises the employee. */
export const managesEmployee = (a: Approver, r: RoutedEmployee) =>
  a.employeeIds.includes(r.employeeId) || (r.departmentId !== null && a.departmentIds.includes(r.departmentId));

/** The approver may see the employee's requests at all (company-wide or their team). */
export const coversEmployee = (a: Approver, r: RoutedEmployee) => a.companyWide || managesEmployee(a, r);

export interface RoutedRequest extends RoutedEmployee {
  /** The step waiting for a decision (null when the request is no longer pending). */
  step: ApprovalStep | null;
  /** Users who already approved an earlier step of this request. */
  priorApproverIds: string[];
}

/**
 * Whether `a` may decide the request's current step.
 * - Never their own request, never two steps of one request.
 * - MANAGER: the employee's supervisors (their direct manager included) and the managers of their department.
 * - FALLBACK_STEP: company-wide approvers.
 * - A role key: holders of that role.
 * - SUPER_ADMIN may decide any step.
 */
export function canDecideStep(a: Approver, r: RoutedRequest): boolean {
  if (r.step === null) return false;
  if (a.employeeId !== null && a.employeeId === r.employeeId) return false;
  if (r.priorApproverIds.includes(a.userId)) return false;
  if (a.superAdmin) return true;
  if (r.step === MANAGER_STEP) return managesEmployee(a, r);
  if (r.step === FALLBACK_STEP) return a.companyWide;
  return a.roles.includes(r.step);
}

/** The step at a 1-based level, or null past the end. */
export const stepAt = (steps: ApprovalStep[], level: number): ApprovalStep | null => steps[level - 1] ?? null;

/**
 * Levels nobody decided although the request moved past them (no one could decide them): every level
 * below the one it reached without a decision row. A pending or cancelled request reached its current
 * level, a rejected one the level of the rejection, an approved one the end of the chain.
 */
export function skippedLevels(
  status: string, currentLevel: number, totalLevels: number, decisions: { level: number; decision: string }[],
): number[] {
  const decided = new Set(decisions.map((d) => d.level));
  const rejectedAt = decisions.find((d) => d.decision === 'REJECTED')?.level;
  const reached = status === 'APPROVED' ? totalLevels + 1 : status === 'REJECTED' ? rejectedAt ?? currentLevel : currentLevel;
  const out: number[] = [];
  for (let level = 1; level < reached && level <= totalLevels; level++) if (!decided.has(level)) out.push(level);
  return out;
}

/** Reads a stored chain (JSON); anything malformed counts as the single manager step. */
export function parseSteps(value: unknown): ApprovalStep[] {
  return Array.isArray(value) && value.length && value.every((s) => typeof s === 'string') ? (value as string[]) : [MANAGER_STEP];
}

// Helpers shared by the leave, overtime, correction and approval services.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FALLBACK_STEP, MANAGER_STEP, MAX_APPROVAL_STEPS, PERMISSIONS, RESERVED_STEP_KEYS, SYSTEM_ROLES, type ApprovalStep, type LeaveApprovalStepDto, type RequestEmployeeRef,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { DateTime } from 'luxon';
import { TIMEZONE } from '../../common/time';
import { canDecideStep, coversEmployee, type Approver, type RoutedRequest } from './approval-routing';

export const EMPLOYEE_REF_SELECT = {
  id: true, employeeCode: true, fullName: true, fullNameAr: true, departmentId: true, locationId: true, hireDate: true,
  department: { select: { name: true, nameAr: true } },
} satisfies Prisma.EmployeeSelect;

export type EmployeeRefRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_REF_SELECT }>;

export const toEmployeeRef = (e: EmployeeRefRow): RequestEmployeeRef => ({
  id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, fullNameAr: e.fullNameAr,
  departmentId: e.departmentId, departmentName: e.department?.name ?? null, departmentNameAr: e.department?.nameAr ?? null,
});

export function requireEmployee(user: AuthUser): string {
  if (!user.employeeId) throw AppError.forbidden('NOT_AN_EMPLOYEE', 'Your account is not linked to an employee record');
  return user.employeeId;
}

/** Serialises every request / attendance mutation of one employee (same lock the attendance engine takes). */
export async function lockEmployee(tx: Prisma.TransactionClient, employeeId: string): Promise<Date> {
  const rows = await tx.$queryRaw<{ id: string; now: Date }[]>`
    SELECT id, clock_timestamp() AS now FROM employees WHERE id = ${employeeId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (!rows.length) throw AppError.notFound('Employee not found');
  return new Date(rows[0].now);
}

export const TX_OPTIONS = { maxWait: 15_000, timeout: 20_000 };

export const invalidField = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);

/** ISO instant with an offset, or a local wall time "YYYY-MM-DDTHH:mm[:ss]" read in the company timezone. */
export function parseInstant(value: string, field: string): Date {
  const dt = DateTime.fromISO(value, { zone: TIMEZONE });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !dt.isValid) throw invalidField(field, `${field} must be an ISO date-time`);
  return dt.toJSDate();
}

export const notPending = (status: string) =>
  AppError.conflict('REQUEST_NOT_PENDING', `This request is already ${status.toLowerCase()}`, { status });

/** Throws when `approver` may not decide requests of this employee at all (own request, outside their scope). */
export function assertMayDecide(approver: Approver | null, r: RoutedRequest): asserts approver is Approver {
  if (!approver) throw AppError.forbidden();
  if (approver.employeeId !== null && approver.employeeId === r.employeeId) {
    throw AppError.forbidden('SELF_APPROVAL_FORBIDDEN', 'You cannot decide your own request');
  }
  const holdsStep = r.step !== null && approver.roles.includes(r.step);
  if (!approver.superAdmin && !holdsStep && !coversEmployee(approver, r)) {
    throw AppError.forbidden('FORBIDDEN', 'This employee is outside your scope');
  }
}

/** Throws unless `approver` may decide the waiting step (checked after the request is known to be pending). */
export function assertStepAllowed(approver: Approver, r: RoutedRequest, currentLevel: number): void {
  if (!canDecideStep(approver, r)) {
    throw AppError.forbidden('APPROVAL_NOT_ALLOWED', 'This request is waiting for a different approver', { currentLevel, step: r.step });
  }
}

/**
 * Validates a configured approval chain (leave type, overtime / correction settings): 1 to
 * MAX_APPROVAL_STEPS steps, each MANAGER or the key of an existing role. The same role may appear twice
 * (two different people of that role).
 */
export async function assertValidChain(db: Db, value: unknown, field: string): Promise<ApprovalStep[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_APPROVAL_STEPS || !value.every((s) => typeof s === 'string' && s.length > 0)) {
    throw invalidField(field, `${field} must list 1 to ${MAX_APPROVAL_STEPS} steps`);
  }
  const steps = value as string[];
  const roleKeys = [...new Set(steps.filter((s) => s !== MANAGER_STEP))];
  const reserved = roleKeys.filter((s) => RESERVED_STEP_KEYS.includes(s));
  const known = roleKeys.length ? await db.role.findMany({ where: { key: { in: roleKeys } }, select: { key: true } }) : [];
  const unknown = roleKeys.filter((s) => reserved.includes(s) || !known.some((r) => r.key === s));
  if (unknown.length) throw invalidField(field, `Unknown role(s) in ${field}: ${unknown.join(', ')}`);
  return steps;
}

/** Approved decisions so far (the people who may not decide another step). */
export const priorApprovers = (approvals: { approverUserId: string; decision: string }[]) =>
  approvals.filter((a) => a.decision === 'APPROVED').map((a) => a.approverUserId);

/** Builds approval-step DTOs per request (oldest first), resolving approver names in one query. */
export async function approvalStepsByRequest(
  db: Db,
  rows: { requestId: string; approverUserId: string; level: number; step: string; decision: string; comment: string | null; createdAt: Date }[],
): Promise<Map<string, LeaveApprovalStepDto[]>> {
  const out = new Map<string, LeaveApprovalStepDto[]>();
  if (!rows.length) return out;
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.approverUserId))] } },
    select: { id: true, username: true, employee: { select: { fullName: true, fullNameAr: true } } },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const r of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const u = byId.get(r.approverUserId);
    const list = out.get(r.requestId) ?? [];
    list.push({
      level: r.level,
      step: r.step,
      decision: r.decision as LeaveApprovalStepDto['decision'],
      comment: r.comment,
      approver: { id: r.approverUserId, username: u?.username ?? '—', name: u?.employee?.fullName ?? null, nameAr: u?.employee?.fullNameAr ?? null },
      createdAt: r.createdAt.toISOString(),
    });
    out.set(r.requestId, list);
  }
  return out;
}

export interface ChainEmployee {
  id: string;
  departmentId: string | null;
}

export interface ChainOptions {
  /** Sensitive leave: managers never see it, so the MANAGER step always counts as having nobody. */
  skipManager?: boolean;
}

/** Where a request waits: its chain level and the users who can decide it (to notify). */
export interface ChainPosition {
  level: number;
  step: ApprovalStep;
  recipients: string[];
}

/** Finds who decides each step of an approval chain, and so where a request waits. */
@Injectable()
export class ApproverDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active users who can decide `step` for this employee with `permission` (SUPER_ADMIN's override does
   * not count): never the employee themselves, never `excludeUserIds` (who approved an earlier step).
   */
  async forStep(permission: string, step: ApprovalStep, employee: ChainEmployee, excludeUserIds: string[], opts: ChainOptions = {}, db: Db = this.prisma): Promise<string[]> {
    if (step === FALLBACK_STEP) return (await this.companyWide(permission, employee.id, db)).filter((id) => !excludeUserIds.includes(id));
    if (step === MANAGER_STEP && opts.skipManager) return [];
    const who: Prisma.UserWhereInput = step === MANAGER_STEP
      ? {
          OR: [
            { supervising: { some: { employeeId: employee.id } } },
            // The employee's direct manager supervises them automatically.
            { employee: { isActive: true, deletedAt: null, reports: { some: { id: employee.id } } } },
            ...(employee.departmentId ? [{ roles: { some: { departmentId: employee.departmentId, role: { key: SYSTEM_ROLES.DEPARTMENT_MANAGER } } } }] : []),
          ],
        }
      : { roles: { some: { role: { key: step } } } };
    const users = await db.user.findMany({
      where: {
        isActive: true, deletedAt: null,
        ...(excludeUserIds.length ? { id: { notIn: excludeUserIds } } : {}),
        AND: [
          who,
          { roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } } },
          { OR: [{ employeeId: null }, { employeeId: { not: employee.id } }] },
        ],
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** The first level from `fromLevel` on whose step somebody can decide; null when none is left. */
  async nextPosition(
    permission: string, steps: ApprovalStep[], fromLevel: number, employee: ChainEmployee, excludeUserIds: string[], opts: ChainOptions = {}, db: Db = this.prisma,
  ): Promise<ChainPosition | null> {
    for (let level = fromLevel; level <= steps.length; level++) {
      const recipients = await this.forStep(permission, steps[level - 1], employee, excludeUserIds, opts, db);
      if (recipients.length) return { level, step: steps[level - 1], recipients };
    }
    return null;
  }

  /**
   * The chain a new request follows and where it starts. Steps nobody can decide are skipped; when that
   * leaves nothing, the fallback step (company-wide approvers) is appended so the request never gets stuck.
   */
  async start(permission: string, configured: ApprovalStep[], employee: ChainEmployee, opts: ChainOptions = {}, db: Db = this.prisma): Promise<ChainPosition & { steps: ApprovalStep[] }> {
    const first = await this.nextPosition(permission, configured, 1, employee, [], opts, db);
    if (first) return { ...first, steps: configured };
    const steps = [...configured, FALLBACK_STEP];
    return { steps, level: steps.length, step: FALLBACK_STEP, recipients: await this.companyWide(permission, employee.id, db) };
  }

  /** Active users with `permission` and company-wide attendance access (HR / admins). */
  async companyWide(permission: string, excludeEmployeeId: string | null, db: Db = this.prisma): Promise<string[]> {
    const has = (key: string) => ({ roles: { some: { role: { permissions: { some: { permission: { key } } } } } } });
    const users = await db.user.findMany({
      where: {
        isActive: true, deletedAt: null,
        AND: [has(permission), has(PERMISSIONS.ATTENDANCE_READ_ALL)],
        ...(excludeEmployeeId ? { OR: [{ employeeId: null }, { employeeId: { not: excludeEmployeeId } }] } : {}),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}

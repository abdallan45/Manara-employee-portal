// Helpers shared by the leave, overtime, correction and approval services.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSIONS, type LeaveApprovalStepDto, type RequestEmployeeRef } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService, type Db } from '../../common/prisma.service';
import { DateTime } from 'luxon';
import { TIMEZONE } from '../../common/time';
import type { Approver } from './approval-routing';

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

/** Throws the right error when `approver` may not decide a request of this employee. */
export function assertMayDecide(approver: Approver | null, employeeId: string, departmentId: string | null, allowed: boolean): void {
  if (!approver) throw AppError.forbidden();
  if (approver.employeeId !== null && approver.employeeId === employeeId) {
    throw AppError.forbidden('SELF_APPROVAL_FORBIDDEN', 'You cannot decide your own request');
  }
  if (!approver.companyWide && (departmentId === null || !approver.departmentIds.includes(departmentId))) {
    throw AppError.forbidden('FORBIDDEN', 'This employee is outside your scope');
  }
  if (!allowed) throw AppError.forbidden('APPROVAL_NOT_ALLOWED', 'This request is waiting for a different approver');
}

/** Builds approval-step DTOs per request (oldest first), resolving approver names in one query. */
export async function approvalStepsByRequest(
  db: Db,
  rows: { requestId: string; approverUserId: string; level: number; decision: string; comment: string | null; createdAt: Date }[],
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
      decision: r.decision as LeaveApprovalStepDto['decision'],
      comment: r.comment,
      approver: { id: r.approverUserId, username: u?.username ?? '—', name: u?.employee?.fullName ?? null, nameAr: u?.employee?.fullNameAr ?? null },
      createdAt: r.createdAt.toISOString(),
    });
    out.set(r.requestId, list);
  }
  return out;
}

/** Finds the users who should hear about a request waiting for approval. */
@Injectable()
export class ApproverDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /** Active users holding `permission` through a grant scoped to this department (department managers). */
  async team(permission: string, departmentId: string | null, excludeEmployeeId: string | null, db: Db = this.prisma): Promise<string[]> {
    if (!departmentId) return [];
    const users = await db.user.findMany({
      where: {
        isActive: true, deletedAt: null,
        roles: { some: { departmentId, role: { permissions: { some: { permission: { key: permission } } } } } },
        ...(excludeEmployeeId ? { OR: [{ employeeId: null }, { employeeId: { not: excludeEmployeeId } }] } : {}),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
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

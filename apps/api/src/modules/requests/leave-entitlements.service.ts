import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type LeaveEntitlementRowDto, type SetLeaveEntitlementInput } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { dateOnly, localDate } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { approverFor } from './approval-routing';
import { tracksBalance } from './leave-math';
import { assertNotOwnBalance, LeaveService } from './leave.service';
import { invalidField, lockEmployee, TX_OPTIONS } from './request-common';

/**
 * Personal yearly leave entitlements (seniority, contract terms): HR gives one employee or a group a
 * different yearly amount for a leave type than the type's default, from a given year on. The
 * hiring-year proration, monthly accrual and carryover rules stay the same. Changing an entitlement
 * for a year that is already open posts the difference to the ledger right away.
 */
@Injectable()
export class LeaveEntitlementsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly leave: LeaveService) {}

  private assertHr(user: AuthUser) {
    if (!approverFor(user, PERMISSIONS.LEAVE_APPROVE)?.companyWide) throw AppError.forbidden('FORBIDDEN', 'Only HR can manage leave entitlements');
  }

  async list(user: AuthUser, q: { year: number; departmentId?: string; employeeId?: string }): Promise<LeaveEntitlementRowDto[]> {
    this.assertHr(user);
    const [types, employees] = await Promise.all([
      this.prisma.leaveType.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
      this.prisma.employee.findMany({
        where: { deletedAt: null, ...(q.employeeId ? { id: q.employeeId } : { isActive: true }), ...(q.departmentId ? { departmentId: q.departmentId } : {}) },
        select: { id: true, employeeCode: true, fullName: true, fullNameAr: true, departmentId: true, hireDate: true, department: { select: { name: true, nameAr: true } } },
        orderBy: { fullName: 'asc' },
      }),
    ]);
    const balanceTypes = types.filter((t) => tracksBalance(t));
    const custom = await this.prisma.leaveEntitlement.findMany({
      where: { employeeId: { in: employees.map((e) => e.id) }, fromYear: { lte: q.year } },
      orderBy: { fromYear: 'desc' },
    });
    return employees.map((e) => ({
      employee: {
        id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, fullNameAr: e.fullNameAr, departmentId: e.departmentId,
        departmentName: e.department?.name ?? null, departmentNameAr: e.department?.nameAr ?? null,
        hireDate: e.hireDate ? dateOnly.fromDb(e.hireDate) : null,
      },
      entitlements: balanceTypes.map((t) => {
        // Rows are newest first, so the first match is the one in force for the year.
        const own = custom.find((c) => c.employeeId === e.id && c.leaveTypeId === t.id);
        return {
          leaveTypeId: t.id, defaultMinutes: t.annualEntitlementMinutes, effectiveMinutes: own?.annualEntitlementMinutes ?? t.annualEntitlementMinutes,
          custom: own ? { id: own.id, fromYear: own.fromYear, minutes: own.annualEntitlementMinutes, note: own.note } : null,
        };
      }),
    }));
  }

  async set(user: AuthUser, input: SetLeaveEntitlementInput): Promise<{ updated: number; ledgerCorrections: number }> {
    this.assertHr(user);
    const type = await this.prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    if (!type) throw AppError.notFound('Leave type not found');
    if (!tracksBalance(type)) throw invalidField('leaveTypeId', 'This leave type does not keep a balance');
    const ids = [...new Set(input.employeeIds)];
    assertNotOwnBalance(user, ids, 'entitlement');
    const employees = await this.prisma.employee.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    if (employees.length !== ids.length) throw invalidField('employeeIds', 'Some employees do not exist');
    const today = localDate(new Date());
    let ledgerCorrections = 0;
    // One transaction per employee keeps locks short; each is complete on its own.
    for (const employeeId of ids) {
      ledgerCorrections += await this.prisma.$transaction(async (tx) => {
        await lockEmployee(tx, employeeId);
        const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, hireDate: true } });
        const key = { employeeId_leaveTypeId_fromYear: { employeeId, leaveTypeId: type.id, fromYear: input.fromYear } };
        const before = await tx.leaveEntitlement.findUnique({ where: key });
        const row = await tx.leaveEntitlement.upsert({
          where: key,
          create: {
            employeeId, leaveTypeId: type.id, fromYear: input.fromYear, annualEntitlementMinutes: input.annualEntitlementMinutes,
            note: input.note?.trim() || null, createdById: user.userId,
          },
          update: { annualEntitlementMinutes: input.annualEntitlementMinutes, note: input.note?.trim() || null },
        });
        const posted = await this.leave.reconcileEntitlement(tx, employee, type, input.fromYear, user.userId, today);
        await this.audit.record(tx, {
          actorUserId: user.userId, action: 'LEAVE_ENTITLEMENT_SET', entityType: 'LeaveEntitlement', entityId: row.id, ipAddress: user.ip,
          before: before ? { minutes: before.annualEntitlementMinutes, note: before.note } : null,
          after: { employeeId, leaveType: type.code, fromYear: row.fromYear, minutes: row.annualEntitlementMinutes, note: row.note, ledgerCorrections: posted },
        });
        return posted;
      }, TX_OPTIONS);
    }
    return { updated: ids.length, ledgerCorrections };
  }

  /** Back to the type's default (or an earlier personal entitlement) from that year on. */
  async remove(user: AuthUser, id: string): Promise<void> {
    this.assertHr(user);
    const row = await this.prisma.leaveEntitlement.findUnique({ where: { id }, include: { leaveType: true } });
    if (!row) throw AppError.notFound('Entitlement not found');
    assertNotOwnBalance(user, [row.employeeId], 'entitlement');
    await this.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, row.employeeId);
      const employee = await tx.employee.findUniqueOrThrow({ where: { id: row.employeeId }, select: { id: true, hireDate: true } });
      await tx.leaveEntitlement.delete({ where: { id } });
      const posted = await this.leave.reconcileEntitlement(tx, employee, row.leaveType, row.fromYear, user.userId, localDate(new Date()));
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_ENTITLEMENT_DELETE', entityType: 'LeaveEntitlement', entityId: id, ipAddress: user.ip,
        before: { employeeId: row.employeeId, leaveType: row.leaveType.code, fromYear: row.fromYear, minutes: row.annualEntitlementMinutes, note: row.note },
        after: { ledgerCorrections: posted },
      });
    }, TX_OPTIONS);
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma, type LeaveType } from '@prisma/client';
import type { CreateLeaveTypeInput, LeaveTypeDto, UpdateLeaveTypeInput } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { leaveTypeToDto } from './leave.service';
import { invalidField } from './request-common';

function mapConflict(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT', 'A leave type with this code already exists');
  throw e;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

/**
 * A type without accrual keeps no balance, so an entitlement or carryover on it would be silently ignored.
 * Remote work is not leave and never uses a balance, so it must be such a type.
 */
function assertConsistent(t: Pick<LeaveType, 'accrual' | 'annualEntitlementMinutes' | 'carryoverMaxMinutes' | 'isRemoteWork'>) {
  if (t.isRemoteWork && t.accrual !== 'NONE') throw invalidField('accrual', 'A remote-work type keeps no balance: accrual must be NONE');
  if (t.accrual !== 'NONE') return;
  if (t.annualEntitlementMinutes > 0) throw invalidField('annualEntitlementMinutes', 'A leave type without accrual cannot have an entitlement');
  if (t.carryoverMaxMinutes > 0) throw invalidField('carryoverMaxMinutes', 'A leave type without accrual cannot carry a balance over');
}

/**
 * Leave type configuration (settings.manage). Types are never deleted - requests and ledger rows
 * refer to them - so "delete" is deactivation. Entitlement changes apply to years opened afterwards
 * and to monthly accruals still to be posted; ledger rows already written are not rewritten.
 */
@Injectable()
export class LeaveTypesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(includeInactive: boolean): Promise<LeaveTypeDto[]> {
    const rows = await this.prisma.leaveType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map(leaveTypeToDto);
  }

  async create(user: AuthUser, body: CreateLeaveTypeInput): Promise<LeaveTypeDto> {
    const data = {
      code: body.code, name: body.name.trim(), nameAr: blankToNull(body.nameAr) ?? null, isPaid: body.isPaid ?? true,
      unit: body.unit, accrual: body.accrual,
      annualEntitlementMinutes: body.annualEntitlementMinutes ?? 0, carryoverMaxMinutes: body.carryoverMaxMinutes ?? 0,
      requiresAttachment: body.requiresAttachment ?? false, approvalLevels: body.approvalLevels ?? 1,
      isSensitive: body.isSensitive ?? false, isRemoteWork: body.isRemoteWork ?? false, isActive: body.isActive ?? true,
    };
    if (!data.name) throw invalidField('name', 'name must not be empty');
    assertConsistent(data);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.leaveType.create({ data });
      const dto = leaveTypeToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'LEAVE_TYPE_CREATE', entityType: 'LeaveType', entityId: row.id, after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  async update(user: AuthUser, id: string, body: UpdateLeaveTypeInput): Promise<LeaveTypeDto> {
    const data: Prisma.LeaveTypeUpdateInput = {
      name: body.name?.trim(), nameAr: blankToNull(body.nameAr), isPaid: body.isPaid, unit: body.unit, accrual: body.accrual,
      annualEntitlementMinutes: body.annualEntitlementMinutes, carryoverMaxMinutes: body.carryoverMaxMinutes,
      requiresAttachment: body.requiresAttachment, approvalLevels: body.approvalLevels, isSensitive: body.isSensitive, isRemoteWork: body.isRemoteWork, isActive: body.isActive,
    };
    if (data.name === '') throw invalidField('name', 'name must not be empty');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.leaveType.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Leave type not found');
      assertConsistent({
        accrual: body.accrual ?? before.accrual,
        annualEntitlementMinutes: body.annualEntitlementMinutes ?? before.annualEntitlementMinutes,
        carryoverMaxMinutes: body.carryoverMaxMinutes ?? before.carryoverMaxMinutes,
        isRemoteWork: body.isRemoteWork ?? before.isRemoteWork,
      });
      const row = await tx.leaveType.update({ where: { id }, data });
      const dto = leaveTypeToDto(row);
      const action = before.isActive && !row.isActive ? 'LEAVE_TYPE_DEACTIVATE' : !before.isActive && row.isActive ? 'LEAVE_TYPE_REACTIVATE' : 'LEAVE_TYPE_UPDATE';
      await this.audit.record(tx, { actorUserId: user.userId, action, entityType: 'LeaveType', entityId: id, before: leaveTypeToDto(before), after: dto, ipAddress: user.ip });
      return dto;
    });
  }
}

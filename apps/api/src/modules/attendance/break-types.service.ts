import { Injectable } from '@nestjs/common';
import { Prisma, type BreakType } from '@prisma/client';
import type { BreakTypeDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { CreateBreakTypeDto, UpdateBreakTypeDto } from './attendance.dto';

export const breakTypeToDto = (b: BreakType): BreakTypeDto => ({
  id: b.id, code: b.code, name: b.name, nameAr: b.nameAr, maxMinutes: b.maxMinutes, isPaid: b.isPaid,
  requiresApproval: b.requiresApproval, countsAsWork: b.countsAsWork, notifyAfterMinutes: b.notifyAfterMinutes, isActive: b.isActive,
});

function mapConflict(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT', 'A break type with this code already exists');
  throw e;
}

@Injectable()
export class BreakTypesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(includeInactive = false): Promise<BreakTypeDto[]> {
    const rows = await this.prisma.breakType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(breakTypeToDto);
  }

  async create(user: AuthUser, body: CreateBreakTypeDto): Promise<BreakTypeDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.breakType.create({
        data: {
          code: body.code, name: body.name.trim(), nameAr: body.nameAr?.trim() ?? null, maxMinutes: body.maxMinutes ?? null,
          isPaid: body.isPaid ?? false, requiresApproval: body.requiresApproval ?? false, countsAsWork: body.countsAsWork ?? false,
          notifyAfterMinutes: body.notifyAfterMinutes ?? null, isActive: body.isActive ?? true, sortOrder: body.sortOrder ?? 0,
        },
      });
      const dto = breakTypeToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'BREAK_TYPE_CREATE', entityType: 'BreakType', entityId: row.id, after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  async update(user: AuthUser, id: string, body: UpdateBreakTypeDto): Promise<BreakTypeDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.breakType.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Break type not found');
      const row = await tx.breakType.update({
        where: { id },
        data: {
          name: body.name?.trim(), nameAr: body.nameAr, maxMinutes: body.maxMinutes, isPaid: body.isPaid,
          requiresApproval: body.requiresApproval, countsAsWork: body.countsAsWork,
          notifyAfterMinutes: body.notifyAfterMinutes, isActive: body.isActive, sortOrder: body.sortOrder,
        },
      });
      const dto = breakTypeToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'BREAK_TYPE_UPDATE', entityType: 'BreakType', entityId: id, before: breakTypeToDto(before), after: dto, ipAddress: user.ip });
      return dto;
    });
  }
}

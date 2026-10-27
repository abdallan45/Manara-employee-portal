import { Injectable } from '@nestjs/common';
import type { WorkHoursRule } from '@prisma/client';
import { WORK_HOURS_RANGES, type CreateWorkHoursRuleInput, type CurrentWorkHoursDto, type WorkHoursRuleDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { Db, PrismaService } from '../../common/prisma.service';
import { dateOnly, localDate } from '../../common/time';
import { assertDate } from '../attendance/date-range';
import { AuditService } from '../audit/audit.service';

/** Company hours when no rule covers a day (only before the base rule exists). */
export const FALLBACK_WORK_HOURS = { dailyRequiredMinutes: 540, includedBreakMinutes: 60 } as const;

export const workHoursRuleToDto = (r: WorkHoursRule): WorkHoursRuleDto => ({
  id: r.id,
  effectiveFrom: dateOnly.fromDb(r.effectiveFrom),
  dailyRequiredMinutes: r.dailyRequiredMinutes,
  includedBreakMinutes: r.includedBreakMinutes,
  createdAt: r.createdAt.toISOString(),
});

/** The rule in force on a date: the latest effectiveFrom on or before it. `rules` must be sorted ascending. */
export function ruleOn<T extends { effectiveFrom: string }>(rules: readonly T[], date: string): T | null {
  let found: T | null = null;
  for (const r of rules) {
    if (r.effectiveFrom > date) break;
    found = r;
  }
  return found;
}

const invalid = (field: string, message: string) => AppError.badRequest('VALIDATION_FAILED', message, [{ field, messages: [message] }]);

/** Effective-dated company work hours (table work_hours_rules). */
@Injectable()
export class WorkHoursService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** All rules, oldest first. */
  async list(db: Db = this.prisma): Promise<WorkHoursRuleDto[]> {
    const rows = await db.workHoursRule.findMany({ orderBy: { effectiveFrom: 'asc' } });
    return rows.map(workHoursRuleToDto);
  }

  /** The rule in force today (company time zone), or the fallback hours when there is none. */
  async current(): Promise<CurrentWorkHoursDto> {
    const today = localDate(new Date());
    const rule = await this.prisma.workHoursRule.findFirst({ where: { effectiveFrom: { lte: dateOnly.toDb(today) } }, orderBy: { effectiveFrom: 'desc' } });
    if (!rule) return { effectiveFrom: today, ...FALLBACK_WORK_HOURS };
    return { effectiveFrom: dateOnly.fromDb(rule.effectiveFrom), dailyRequiredMinutes: rule.dailyRequiredMinutes, includedBreakMinutes: rule.includedBreakMinutes };
  }

  /** Creates a rule, or replaces the one with the same effectiveFrom. */
  async set(input: CreateWorkHoursRuleInput, user: AuthUser): Promise<WorkHoursRuleDto> {
    const effectiveFrom = assertDate(input.effectiveFrom, 'effectiveFrom');
    for (const field of ['dailyRequiredMinutes', 'includedBreakMinutes'] as const) {
      const v = input[field];
      const { min, max } = WORK_HOURS_RANGES[field];
      if (!Number.isInteger(v) || v < min || v > max) throw invalid(field, `${field} must be a whole number between ${min} and ${max}`);
    }
    if (input.includedBreakMinutes > input.dailyRequiredMinutes) {
      throw invalid('includedBreakMinutes', 'includedBreakMinutes must not exceed dailyRequiredMinutes');
    }
    const data = { dailyRequiredMinutes: input.dailyRequiredMinutes, includedBreakMinutes: input.includedBreakMinutes, createdById: user.userId };
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.workHoursRule.findUnique({ where: { effectiveFrom: dateOnly.toDb(effectiveFrom) } });
      const row = await tx.workHoursRule.upsert({
        where: { effectiveFrom: dateOnly.toDb(effectiveFrom) },
        create: { effectiveFrom: dateOnly.toDb(effectiveFrom), ...data },
        update: data,
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: before ? 'WORK_HOURS_RULE_UPDATE' : 'WORK_HOURS_RULE_CREATE', entityType: 'WorkHoursRule', entityId: row.id,
        before: before ? workHoursRuleToDto(before) : undefined, after: workHoursRuleToDto(row), ipAddress: user.ip,
      });
      return workHoursRuleToDto(row);
    });
  }

  /** The earliest rule cannot go: every day must stay covered. */
  async remove(id: string, user: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rule = await tx.workHoursRule.findUnique({ where: { id } });
      if (!rule) throw AppError.notFound('Work hours rule not found');
      const earliest = await tx.workHoursRule.findFirst({ orderBy: { effectiveFrom: 'asc' }, select: { id: true } });
      if (earliest?.id === rule.id) throw AppError.conflict('CONFLICT', 'The earliest work hours rule cannot be deleted');
      await tx.workHoursRule.delete({ where: { id } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'WORK_HOURS_RULE_DELETE', entityType: 'WorkHoursRule', entityId: id,
        before: workHoursRuleToDto(rule), ipAddress: user.ip,
      });
    });
  }
}

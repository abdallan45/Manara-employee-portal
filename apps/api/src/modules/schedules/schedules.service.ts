import { Injectable } from '@nestjs/common';
import { Prisma, type Holiday, type ScheduleAssignment } from '@prisma/client';
import { PERMISSIONS, type EmployeeScheduleDto, type HolidayDto, type ScheduleAssignmentDto, type ScheduleDto } from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { attendanceScope, inScope } from '../../common/scope';
import { addDays, dateOnly, localDate } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { assertDate, daySpan } from '../attendance/date-range';
import { ScheduleResolver, type ScheduleWithDays } from './schedule-resolver';
import type {
  CreateAssignmentDto, CreateHolidayDto, CreateHolidayRangeDto, CreateScheduleDto, ScheduleDayInput, UpdateHolidayDto, UpdateScheduleDto,
} from './schedules.dto';

export const scheduleToDto = (s: ScheduleWithDays): ScheduleDto => ({
  id: s.id, name: s.name, type: s.type, weeklyRequiredMinutes: s.weeklyRequiredMinutes, graceMinutes: s.graceMinutes,
  coreStartMinute: s.coreStartMinute, coreEndMinute: s.coreEndMinute, isDefault: s.isDefault, includedBreakMinutes: s.includedBreakMinutes,
  days: [...s.days].sort((a, b) => a.weekday - b.weekday).map((d) => ({
    weekday: d.weekday, isWorkday: d.isWorkday, startMinute: d.startMinute, endMinute: d.endMinute, requiredMinutes: d.requiredMinutes,
  })),
});

const assignmentToDto = (a: ScheduleAssignment): ScheduleAssignmentDto => ({
  id: a.id, scheduleId: a.scheduleId, employeeId: a.employeeId, departmentId: a.departmentId,
  validFrom: dateOnly.fromDb(a.validFrom), validTo: a.validTo ? dateOnly.fromDb(a.validTo) : null, createdAt: a.createdAt.toISOString(),
});

const holidayToDto = (h: Holiday): HolidayDto => ({
  id: h.id, date: dateOnly.fromDb(h.date), name: h.name, nameAr: h.nameAr, isPaid: h.isPaid, locationId: h.locationId,
});

/**
 * Departments whose schedules a user may read: null = all (schedule managers, company-wide attendance),
 * the managed departments for team viewers, none for callers who may only see themselves.
 */
function viewScope(user: AuthUser): string[] | null {
  if (user.permissions.has(PERMISSIONS.SCHEDULES_MANAGE)) return null;
  if (!user.permissions.has(PERMISSIONS.ATTENDANCE_READ_ALL) && !user.permissions.has(PERMISSIONS.ATTENDANCE_READ_TEAM)) return [];
  return attendanceScope(user);
}

const invalid = (message: string, details?: unknown) => AppError.badRequest('VALIDATION_FAILED', message, details);

interface ScheduleShape {
  type: 'FIXED' | 'FLEXIBLE';
  coreStartMinute: number | null;
  coreEndMinute: number | null;
  days: ScheduleDayInput[];
}

/** Normalises days to exactly 7 rows (missing weekdays = day off) and validates them against the type. */
function normaliseDays(shape: ScheduleShape) {
  const seen = new Set<number>();
  for (const d of shape.days) {
    if (seen.has(d.weekday)) throw invalid('Duplicate weekday in days', { weekday: d.weekday });
    seen.add(d.weekday);
  }
  if ((shape.coreStartMinute === null) !== (shape.coreEndMinute === null)) {
    throw invalid('coreStartMinute and coreEndMinute must be given together');
  }
  if (shape.type === 'FIXED' && shape.coreStartMinute !== null) throw invalid('Core hours apply to FLEXIBLE schedules only');
  if (shape.coreStartMinute !== null && shape.coreEndMinute! <= shape.coreStartMinute) throw invalid('Core hours must end after they start');
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const d = shape.days.find((x) => x.weekday === weekday);
    if (!d || !d.isWorkday) return { weekday, isWorkday: false, startMinute: null, endMinute: null, requiredMinutes: 0 };
    const start = d.startMinute ?? null;
    const end = d.endMinute ?? null;
    if (shape.type === 'FIXED' && (start === null || end === null || start === end)) {
      throw invalid('FIXED workdays need distinct startMinute and endMinute', { weekday });
    }
    if ((start === null) !== (end === null)) throw invalid('startMinute and endMinute must be given together', { weekday });
    return { weekday, isWorkday: true, startMinute: start, endMinute: end, requiredMinutes: d.requiredMinutes };
  });
}

function mapConflict(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT', 'An item with these unique values already exists', e.meta);
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw invalid('Referenced record does not exist', e.meta);
  throw e;
}

@Injectable()
export class SchedulesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly resolver: ScheduleResolver) {}

  async list(): Promise<ScheduleDto[]> {
    const rows = await this.prisma.workSchedule.findMany({ include: { days: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return rows.map(scheduleToDto);
  }

  async create(user: AuthUser, body: CreateScheduleDto): Promise<ScheduleDto> {
    const shape = { type: body.type, coreStartMinute: body.coreStartMinute ?? null, coreEndMinute: body.coreEndMinute ?? null, days: body.days };
    const days = normaliseDays(shape);
    return this.prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.workSchedule.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      const row = await tx.workSchedule.create({
        data: {
          name: body.name.trim(), type: body.type, graceMinutes: body.graceMinutes ?? 10, includedBreakMinutes: body.includedBreakMinutes ?? 0,
          coreStartMinute: shape.coreStartMinute, coreEndMinute: shape.coreEndMinute, isDefault: body.isDefault ?? false,
          weeklyRequiredMinutes: body.weeklyRequiredMinutes ?? days.reduce((s, d) => s + d.requiredMinutes, 0),
          days: { create: days },
        },
        include: { days: true },
      });
      const dto = scheduleToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'SCHEDULE_CREATE', entityType: 'WorkSchedule', entityId: row.id, after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  async update(user: AuthUser, id: string, body: UpdateScheduleDto): Promise<ScheduleDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.workSchedule.findUnique({ where: { id }, include: { days: true } });
      if (!before) throw AppError.notFound('Schedule not found');
      const shape: ScheduleShape = {
        type: body.type ?? before.type,
        coreStartMinute: body.coreStartMinute !== undefined ? body.coreStartMinute : before.coreStartMinute,
        coreEndMinute: body.coreEndMinute !== undefined ? body.coreEndMinute : before.coreEndMinute,
        days: body.days ?? before.days.map((d) => ({ ...d })),
      };
      const days = normaliseDays(shape);
      if (body.isDefault) await tx.workSchedule.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
      if (body.days) {
        await tx.scheduleDay.deleteMany({ where: { scheduleId: id } });
        await tx.scheduleDay.createMany({ data: days.map((d) => ({ ...d, scheduleId: id })) });
      }
      const row = await tx.workSchedule.update({
        where: { id },
        data: {
          name: body.name?.trim(), type: shape.type, graceMinutes: body.graceMinutes, isDefault: body.isDefault, includedBreakMinutes: body.includedBreakMinutes,
          coreStartMinute: shape.coreStartMinute, coreEndMinute: shape.coreEndMinute,
          weeklyRequiredMinutes: body.weeklyRequiredMinutes ?? (body.days ? days.reduce((s, d) => s + d.requiredMinutes, 0) : undefined),
        },
        include: { days: true },
      });
      const dto = scheduleToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'SCHEDULE_UPDATE', entityType: 'WorkSchedule', entityId: id, before: scheduleToDto(before), after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  /**
   * Assignments of a schedule. Schedule managers and company-wide viewers get all of them; department
   * managers only those of the departments they manage and of employees in those departments.
   */
  async listAssignments(user: AuthUser, scheduleId: string): Promise<ScheduleAssignmentDto[]> {
    const scope = viewScope(user);
    const where: Prisma.ScheduleAssignmentWhereInput = scope === null
      ? { scheduleId }
      : { scheduleId, OR: [{ departmentId: { in: scope } }, { employee: { departmentId: { in: scope } } }] };
    const rows = await this.prisma.scheduleAssignment.findMany({ where, orderBy: { validFrom: 'desc' } });
    return rows.map(assignmentToDto);
  }

  async assign(user: AuthUser, scheduleId: string, body: CreateAssignmentDto): Promise<ScheduleAssignmentDto> {
    if (!!body.employeeId === !!body.departmentId) throw invalid('Give exactly one of employeeId or departmentId');
    const validFrom = assertDate(body.validFrom, 'validFrom');
    const validTo = body.validTo ? assertDate(body.validTo, 'validTo') : null;
    if (validTo && validTo < validFrom) throw invalid('validTo must not be before validFrom');
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.workSchedule.findUnique({ where: { id: scheduleId }, select: { id: true } }))) throw AppError.notFound('Schedule not found');
      const row = await tx.scheduleAssignment.create({
        data: {
          scheduleId, employeeId: body.employeeId ?? null, departmentId: body.departmentId ?? null,
          validFrom: dateOnly.toDb(validFrom), validTo: validTo ? dateOnly.toDb(validTo) : null,
        },
      });
      const dto = assignmentToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'SCHEDULE_ASSIGN', entityType: 'ScheduleAssignment', entityId: row.id, after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  /** Every assignment with the schedule, employee and department names (newest first). */
  async listAllAssignments(): Promise<ScheduleAssignmentDto[]> {
    const rows = await this.prisma.scheduleAssignment.findMany({
      include: {
        schedule: { select: { name: true } },
        employee: { select: { employeeCode: true, fullName: true, fullNameAr: true } },
        department: { select: { name: true, nameAr: true } },
      },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((a) => ({ ...assignmentToDto(a), scheduleName: a.schedule.name, employee: a.employee, department: a.department }));
  }

  /** Ends (or re-opens) an assignment. History stays as it was: the schedule applied up to validTo. */
  async updateAssignment(user: AuthUser, id: string, validTo: string | null): Promise<ScheduleAssignmentDto> {
    const to = validTo ? assertDate(validTo, 'validTo') : null;
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.scheduleAssignment.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Assignment not found');
      if (to && to < dateOnly.fromDb(before.validFrom)) throw invalid('validTo must not be before validFrom', [{ field: 'validTo', messages: ['validTo must not be before validFrom'] }]);
      const row = await tx.scheduleAssignment.update({ where: { id }, data: { validTo: to ? dateOnly.toDb(to) : null } });
      const dto = assignmentToDto(row);
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'SCHEDULE_ASSIGNMENT_UPDATE', entityType: 'ScheduleAssignment', entityId: id,
        before: assignmentToDto(before), after: dto, ipAddress: user.ip,
      });
      return dto;
    });
  }

  /** Deletes an assignment that has not started yet; one already in effect is ended with validTo instead. */
  async deleteAssignment(user: AuthUser, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.scheduleAssignment.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Assignment not found');
      if (dateOnly.fromDb(before.validFrom) <= localDate(new Date())) {
        throw AppError.conflict('CONFLICT', 'This assignment is already in effect; set an end date instead so past days keep their schedule');
      }
      await tx.scheduleAssignment.delete({ where: { id } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'SCHEDULE_ASSIGNMENT_DELETE', entityType: 'ScheduleAssignment', entityId: id,
        before: assignmentToDto(before), ipAddress: user.ip,
      });
    });
  }

  /** The schedule in force for an employee on a date (default today), for anyone who may read their attendance. */
  async current(user: AuthUser, employeeId: string, date?: string): Promise<EmployeeScheduleDto> {
    const day = date ? assertDate(date, 'date') : localDate(new Date());
    const employee = await this.prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { id: true, departmentId: true, locationId: true } });
    if (!employee) throw AppError.notFound('Employee not found');
    // Out of scope (including callers who may only see themselves) answers like a missing employee.
    if (employee.id !== user.employeeId && !inScope(viewScope(user), employee.departmentId)) throw AppError.notFound('Employee not found');
    const context = await this.resolver.load([employee], day, day);
    const { schedule, source } = context.schedule(employee, day);
    let validTo: string | null = null;
    if (source === 'EMPLOYEE' || source === 'DEPARTMENT') {
      const a = await this.prisma.scheduleAssignment.findFirst({
        where: {
          scheduleId: schedule.id, ...(source === 'EMPLOYEE' ? { employeeId } : { departmentId: employee.departmentId }),
          validFrom: { lte: dateOnly.toDb(day) }, OR: [{ validTo: null }, { validTo: { gte: dateOnly.toDb(day) } }],
        },
        orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
      });
      validTo = a?.validTo ? dateOnly.fromDb(a.validTo) : null;
    }
    return { date: day, scheduleId: source === 'BUILT_IN' ? null : schedule.id, scheduleName: schedule.name, source, validTo };
  }

  async listHolidays(year?: number): Promise<HolidayDto[]> {
    const where = year ? { date: { gte: dateOnly.toDb(`${year}-01-01`), lte: dateOnly.toDb(`${year}-12-31`) } } : {};
    return (await this.prisma.holiday.findMany({ where, orderBy: { date: 'asc' } })).map(holidayToDto);
  }

  async createHoliday(user: AuthUser, body: CreateHolidayDto): Promise<HolidayDto> {
    const date = assertDate(body.date, 'date');
    const locationId = body.locationId ?? null;
    return this.prisma.$transaction(async (tx) => {
      // The (date, location_id) unique index does not catch duplicates when location_id is NULL.
      if (await tx.holiday.findFirst({ where: { date: dateOnly.toDb(date), locationId } })) {
        throw AppError.conflict('CONFLICT', 'A holiday already exists on this date', { date, locationId });
      }
      const row = await tx.holiday.create({
        data: { date: dateOnly.toDb(date), name: body.name.trim(), nameAr: body.nameAr?.trim() ?? null, isPaid: body.isPaid ?? true, locationId },
      });
      const dto = holidayToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'HOLIDAY_CREATE', entityType: 'Holiday', entityId: row.id, after: dto, ipAddress: user.ip });
      return dto;
    }).catch(mapConflict);
  }

  /** A holiday spanning several days (e.g. Eid): one row per date, all or nothing. */
  async createHolidayRange(user: AuthUser, body: CreateHolidayRangeDto): Promise<HolidayDto[]> {
    const from = assertDate(body.from, 'from');
    const to = assertDate(body.to, 'to');
    if (to < from) throw invalid('`to` must not be before `from`', [{ field: 'to', messages: ['to must not be before from'] }]);
    if (daySpan(from, to) > 31) throw invalid('A holiday may span at most 31 days', [{ field: 'to', messages: ['at most 31 days'] }]);
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    return this.prisma.$transaction(async (tx) => {
      const taken = await tx.holiday.findMany({ where: { date: { in: dates.map(dateOnly.toDb) }, locationId: null }, select: { date: true } });
      if (taken.length) throw AppError.conflict('CONFLICT', 'Some of these dates already have a holiday', { dates: taken.map((h) => dateOnly.fromDb(h.date)) });
      const out: HolidayDto[] = [];
      for (const date of dates) {
        const row = await tx.holiday.create({
          data: { date: dateOnly.toDb(date), name: body.name.trim(), nameAr: body.nameAr?.trim() || null, isPaid: body.isPaid ?? true, locationId: null },
        });
        const dto = holidayToDto(row);
        await this.audit.record(tx, { actorUserId: user.userId, action: 'HOLIDAY_CREATE', entityType: 'Holiday', entityId: row.id, after: dto, ipAddress: user.ip });
        out.push(dto);
      }
      return out;
    });
  }

  async updateHoliday(user: AuthUser, id: string, body: UpdateHolidayDto): Promise<HolidayDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.holiday.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Holiday not found');
      const row = await tx.holiday.update({
        where: { id },
        data: { name: body.name?.trim(), nameAr: body.nameAr === undefined ? undefined : body.nameAr?.trim() || null, isPaid: body.isPaid },
      });
      const dto = holidayToDto(row);
      await this.audit.record(tx, { actorUserId: user.userId, action: 'HOLIDAY_UPDATE', entityType: 'Holiday', entityId: id, before: holidayToDto(before), after: dto, ipAddress: user.ip });
      return dto;
    });
  }

  async deleteHoliday(user: AuthUser, id: string): Promise<{ ok: true }> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.holiday.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Holiday not found');
      await tx.holiday.delete({ where: { id } });
      await this.audit.record(tx, { actorUserId: user.userId, action: 'HOLIDAY_DELETE', entityType: 'Holiday', entityId: id, before: holidayToDto(before), ipAddress: user.ip });
    });
    return { ok: true };
  }
}

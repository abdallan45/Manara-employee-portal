import { Injectable } from '@nestjs/common';
import type { Holiday, ScheduleAssignment, ScheduleDay, WorkSchedule } from '@prisma/client';
import { dateOnly, weekdayOf } from '../../common/time';
import type { Db } from '../../common/prisma.service';
import { PrismaService } from '../../common/prisma.service';
import type { ScheduleDayRule } from '../attendance/calc';

export type ScheduleWithDays = WorkSchedule & { days: ScheduleDay[] };
export interface EmployeeRef { id: string; departmentId: string | null; locationId?: string | null }
export interface ResolvedDay {
  rule: ScheduleDayRule;
  source: 'EMPLOYEE' | 'DEPARTMENT' | 'DEFAULT' | 'BUILT_IN';
  isHoliday: boolean;
  holidayName: string | null;
}

/** Used only when no schedule is assigned and none is marked default: Sun–Thu 08:00–16:00. */
export const BUILT_IN_SCHEDULE: ScheduleWithDays = {
  id: 'built-in',
  name: 'Built-in default (Sun–Thu 08:00–16:00)',
  type: 'FIXED',
  weeklyRequiredMinutes: 5 * 480,
  graceMinutes: 10,
  includedBreakMinutes: 0,
  coreStartMinute: null,
  coreEndMinute: null,
  isDefault: false,
  createdAt: new Date(0),
  days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const work = weekday <= 4;
    return {
      id: `built-in-${weekday}`, scheduleId: 'built-in', weekday, isWorkday: work,
      startMinute: work ? 480 : null, endMinute: work ? 960 : null, requiredMinutes: work ? 480 : 0,
    };
  }),
};

export function ruleFor(schedule: ScheduleWithDays, date: string): ScheduleDayRule {
  const day = schedule.days.find((d) => d.weekday === weekdayOf(date));
  const isWorkday = day?.isWorkday ?? false;
  return {
    scheduleId: schedule.id === BUILT_IN_SCHEDULE.id ? null : schedule.id,
    scheduleName: schedule.name,
    type: schedule.type,
    isWorkday,
    startMinute: isWorkday ? day?.startMinute ?? null : null,
    endMinute: isWorkday ? day?.endMinute ?? null : null,
    requiredMinutes: isWorkday ? day?.requiredMinutes ?? 0 : 0,
    graceMinutes: schedule.graceMinutes,
    includedBreakMinutes: schedule.includedBreakMinutes,
    coreStartMinute: schedule.coreStartMinute,
    coreEndMinute: schedule.coreEndMinute,
  };
}

type LoadedAssignment = ScheduleAssignment & { schedule: ScheduleWithDays; from: string; to: string | null };

/** In-memory resolver for a set of employees over a date range (built from a fixed number of queries). */
export class ScheduleContext {
  private readonly byEmployee = new Map<string, LoadedAssignment[]>();
  private readonly byDepartment = new Map<string, LoadedAssignment[]>();
  private readonly holidays = new Map<string, Holiday[]>();

  constructor(assignments: (ScheduleAssignment & { schedule: ScheduleWithDays })[], private readonly defaultSchedule: ScheduleWithDays | null, holidays: Holiday[]) {
    for (const a of assignments) {
      const loaded: LoadedAssignment = { ...a, from: dateOnly.fromDb(a.validFrom), to: a.validTo ? dateOnly.fromDb(a.validTo) : null };
      const key = a.employeeId ?? a.departmentId;
      const map = a.employeeId ? this.byEmployee : this.byDepartment;
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), loaded]);
    }
    // Latest validFrom wins when assignments overlap; ties go to the most recently created.
    for (const list of [...this.byEmployee.values(), ...this.byDepartment.values()]) {
      list.sort((x, y) => (x.from === y.from ? y.createdAt.getTime() - x.createdAt.getTime() : x.from < y.from ? 1 : -1));
    }
    for (const h of holidays) {
      const d = dateOnly.fromDb(h.date);
      this.holidays.set(d, [...(this.holidays.get(d) ?? []), h]);
    }
  }

  private static pick(list: LoadedAssignment[] | undefined, date: string) {
    return list?.find((a) => a.from <= date && (a.to === null || a.to >= date))?.schedule ?? null;
  }

  schedule(emp: EmployeeRef, date: string): { schedule: ScheduleWithDays; source: ResolvedDay['source'] } {
    const own = ScheduleContext.pick(this.byEmployee.get(emp.id), date);
    if (own) return { schedule: own, source: 'EMPLOYEE' };
    const dept = emp.departmentId ? ScheduleContext.pick(this.byDepartment.get(emp.departmentId), date) : null;
    if (dept) return { schedule: dept, source: 'DEPARTMENT' };
    if (this.defaultSchedule) return { schedule: this.defaultSchedule, source: 'DEFAULT' };
    return { schedule: BUILT_IN_SCHEDULE, source: 'BUILT_IN' };
  }

  holiday(emp: EmployeeRef, date: string): Holiday | null {
    return this.holidays.get(date)?.find((h) => h.locationId === null || h.locationId === (emp.locationId ?? null)) ?? null;
  }

  day(emp: EmployeeRef, date: string): ResolvedDay {
    const { schedule, source } = this.schedule(emp, date);
    const holiday = this.holiday(emp, date);
    return { rule: ruleFor(schedule, date), source, isHoliday: holiday !== null, holidayName: holiday?.name ?? null };
  }
}

@Injectable()
export class ScheduleResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads everything needed to resolve schedules/holidays for these employees between from and to (inclusive). */
  async load(employees: EmployeeRef[], from: string, to: string, db: Db = this.prisma): Promise<ScheduleContext> {
    const employeeIds = employees.map((e) => e.id);
    const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((d): d is string => d !== null))];
    const [assignments, defaultSchedule, holidays] = await Promise.all([
      employees.length
        ? db.scheduleAssignment.findMany({
            where: {
              OR: [{ employeeId: { in: employeeIds } }, ...(departmentIds.length ? [{ departmentId: { in: departmentIds } }] : [])],
              validFrom: { lte: dateOnly.toDb(to) },
              AND: [{ OR: [{ validTo: null }, { validTo: { gte: dateOnly.toDb(from) } }] }],
            },
            include: { schedule: { include: { days: true } } },
          })
        : Promise.resolve([]),
      db.workSchedule.findFirst({ where: { isDefault: true }, include: { days: true }, orderBy: { createdAt: 'asc' } }),
      db.holiday.findMany({ where: { date: { gte: dateOnly.toDb(from), lte: dateOnly.toDb(to) } } }),
    ]);
    return new ScheduleContext(assignments, defaultSchedule, holidays);
  }

  /** Employee assignment > department assignment > default schedule > built-in fallback, plus holiday flag. */
  async resolve(employeeId: string, departmentId: string | null, date: string, locationId: string | null = null): Promise<ResolvedDay> {
    const emp = { id: employeeId, departmentId, locationId };
    return (await this.load([emp], date, date)).day(emp, date);
  }
}

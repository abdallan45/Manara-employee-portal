import { Injectable } from '@nestjs/common';
import type { Holiday, ScheduleAssignment, ScheduleDay, WorkSchedule } from '@prisma/client';
import { dateOnly, weekdayOf } from '../../common/time';
import type { Db } from '../../common/prisma.service';
import { PrismaService } from '../../common/prisma.service';
import type { ScheduleDayRule } from '../attendance/calc';
import { SettingsService } from '../settings/settings.service';

export type ScheduleWithDays = WorkSchedule & { days: ScheduleDay[] };
export interface EmployeeRef { id: string; departmentId: string | null; locationId?: string | null }
export interface ResolvedDay {
  rule: ScheduleDayRule;
  source: 'EMPLOYEE' | 'DEPARTMENT' | 'DEFAULT' | 'BUILT_IN';
  isHoliday: boolean;
  holidayName: string | null;
}

/** Daily requirement on a workday, break included, and the break allowance inside it. */
export interface DailyHours { requiredMinutes: number; includedBreakMinutes: number }
/** Per-employee overrides; null = company default. */
export interface EmployeeHours { dailyRequiredMinutes: number | null; includedBreakMinutes: number | null }

/** Used only when no schedule is assigned and none is marked default: Sun–Thu 08:00–17:00. */
export const BUILT_IN_SCHEDULE: ScheduleWithDays = {
  id: 'built-in',
  name: 'Built-in default (Sun–Thu 08:00–17:00)',
  type: 'FIXED',
  weeklyRequiredMinutes: 5 * 540,
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
      startMinute: work ? 480 : null, endMinute: work ? 1020 : null, requiredMinutes: work ? 540 : 0,
    };
  }),
};

export const DEFAULT_DAILY_HOURS: DailyHours = { requiredMinutes: 540, includedBreakMinutes: 60 };

/** Employee override, else the company default; the allowance never exceeds the requirement. */
export function effectiveHours(defaults: DailyHours, own?: EmployeeHours | null): DailyHours {
  const requiredMinutes = own?.dailyRequiredMinutes ?? defaults.requiredMinutes;
  const allowance = own?.includedBreakMinutes ?? defaults.includedBreakMinutes;
  return { requiredMinutes, includedBreakMinutes: Math.max(0, Math.min(allowance, requiredMinutes)) };
}

/**
 * The schedule decides workdays, start/end and core hours; the hours come from the employee or the
 * company settings (the schedule's per-day requiredMinutes and includedBreakMinutes are not used).
 */
export function ruleFor(schedule: ScheduleWithDays, date: string, hours: DailyHours = DEFAULT_DAILY_HOURS): ScheduleDayRule {
  const day = schedule.days.find((d) => d.weekday === weekdayOf(date));
  const isWorkday = day?.isWorkday ?? false;
  return {
    scheduleId: schedule.id === BUILT_IN_SCHEDULE.id ? null : schedule.id,
    scheduleName: schedule.name,
    type: schedule.type,
    isWorkday,
    startMinute: isWorkday ? day?.startMinute ?? null : null,
    endMinute: isWorkday ? day?.endMinute ?? null : null,
    requiredMinutes: isWorkday ? hours.requiredMinutes : 0,
    graceMinutes: schedule.graceMinutes,
    includedBreakMinutes: hours.includedBreakMinutes,
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

  private readonly employeeHours = new Map<string, EmployeeHours>();

  constructor(
    assignments: (ScheduleAssignment & { schedule: ScheduleWithDays })[],
    private readonly defaultSchedule: ScheduleWithDays | null,
    holidays: Holiday[],
    private readonly defaultHours: DailyHours = DEFAULT_DAILY_HOURS,
    employees: ({ id: string } & EmployeeHours)[] = [],
  ) {
    for (const e of employees) this.employeeHours.set(e.id, { dailyRequiredMinutes: e.dailyRequiredMinutes, includedBreakMinutes: e.includedBreakMinutes });
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

  /** Effective daily requirement and break allowance of this employee. */
  hours(emp: EmployeeRef): DailyHours {
    return effectiveHours(this.defaultHours, this.employeeHours.get(emp.id));
  }

  holiday(emp: EmployeeRef, date: string): Holiday | null {
    return this.holidays.get(date)?.find((h) => h.locationId === null || h.locationId === (emp.locationId ?? null)) ?? null;
  }

  day(emp: EmployeeRef, date: string): ResolvedDay {
    const { schedule, source } = this.schedule(emp, date);
    const holiday = this.holiday(emp, date);
    return { rule: ruleFor(schedule, date, this.hours(emp)), source, isHoliday: holiday !== null, holidayName: holiday?.name ?? null };
  }
}

@Injectable()
export class ScheduleResolver {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  /** Loads everything needed to resolve schedules/holidays for these employees between from and to (inclusive). */
  async load(employees: EmployeeRef[], from: string, to: string, db: Db = this.prisma): Promise<ScheduleContext> {
    const employeeIds = employees.map((e) => e.id);
    const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((d): d is string => d !== null))];
    const [assignments, defaultSchedule, holidays, own, requiredMinutes, includedBreakMinutes] = await Promise.all([
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
      employees.length
        ? db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, dailyRequiredMinutes: true, includedBreakMinutes: true } })
        : Promise.resolve([]),
      this.settings.get('attendance.dailyRequiredMinutes'),
      this.settings.get('attendance.includedBreakMinutes'),
    ]);
    return new ScheduleContext(assignments, defaultSchedule, holidays, { requiredMinutes, includedBreakMinutes }, own);
  }

  /**
   * Employee assignment > department assignment > default schedule > built-in fallback, plus holiday flag.
   * Daily hours: employee override > settings default.
   */
  async resolve(employeeId: string, departmentId: string | null, date: string, locationId: string | null = null): Promise<ResolvedDay> {
    const emp = { id: employeeId, departmentId, locationId };
    return (await this.load([emp], date, date)).day(emp, date);
  }
}

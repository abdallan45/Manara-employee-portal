import { Injectable } from '@nestjs/common';
import type { Holiday, ScheduleAssignment, ScheduleDay, WorkSchedule } from '@prisma/client';
import { effectiveSaturdayGroup, isSaturdayDate, saturdayRotaFor, type SaturdayGroup, type SaturdayRotaDay } from '@workforce/shared';
import { dateOnly, weekdayOf } from '../../common/time';
import type { Db } from '../../common/prisma.service';
import { PrismaService } from '../../common/prisma.service';
import type { ScheduleDayRule } from '../attendance/calc';
import { FALLBACK_WORK_HOURS, ruleOn } from '../settings/work-hours.service';

export type ScheduleWithDays = WorkSchedule & { days: ScheduleDay[] };
export interface EmployeeRef { id: string; departmentId: string | null; locationId?: string | null }
export interface ResolvedDay {
  rule: ScheduleDayRule;
  source: 'EMPLOYEE' | 'DEPARTMENT' | 'DEFAULT' | 'BUILT_IN';
  isHoliday: boolean;
  holidayName: string | null;
  /** Saturday rota day of the employee; null when not a rota Saturday or a holiday (the holiday wins). */
  saturdayRota: SaturdayRotaDay | null;
}

/** Daily requirement on a workday, break included, and the break allowance inside it. */
export interface DailyHours { requiredMinutes: number; includedBreakMinutes: number }
/** Company default from effectiveFrom (YYYY-MM-DD) on. */
export interface CompanyHoursRule extends DailyHours { effectiveFrom: string }
/** Per-employee overrides; null = company default. */
export interface EmployeeHours { dailyRequiredMinutes: number | null; includedBreakMinutes: number | null }
/** Per-employee data loaded with the context; saturdayGroup is the effective rota group. */
export type EmployeeDayData = { id: string; saturdayGroup?: SaturdayGroup | null } & EmployeeHours;

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

export const DEFAULT_DAILY_HOURS: DailyHours = { requiredMinutes: FALLBACK_WORK_HOURS.dailyRequiredMinutes, includedBreakMinutes: FALLBACK_WORK_HOURS.includedBreakMinutes };

/** Employee override, else the company default; the allowance never exceeds the requirement. */
export function effectiveHours(defaults: DailyHours, own?: EmployeeHours | null): DailyHours {
  const requiredMinutes = own?.dailyRequiredMinutes ?? defaults.requiredMinutes;
  const allowance = own?.includedBreakMinutes ?? defaults.includedBreakMinutes;
  return { requiredMinutes, includedBreakMinutes: Math.max(0, Math.min(allowance, requiredMinutes)) };
}

/**
 * The schedule decides workdays, start/end and core hours; the hours come from the employee or the
 * company work-hours rule for the day (the schedule's per-day requiredMinutes and includedBreakMinutes are not used).
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

/**
 * Rule of a Saturday adjusted for the rota. WORKING: a workday with the times of the schedule's Sunday
 * (or its first workday of the week). OFF: a day off whatever the schedule says.
 */
export function rotaSaturdayRule(schedule: ScheduleWithDays, date: string, hours: DailyHours, rota: SaturdayRotaDay): ScheduleDayRule {
  const base = ruleFor(schedule, date, hours);
  if (rota === 'OFF') return { ...base, isWorkday: false, startMinute: null, endMinute: null, requiredMinutes: 0 };
  const template = [...schedule.days].sort((x, y) => x.weekday - y.weekday).find((d) => d.isWorkday);
  return {
    ...base,
    isWorkday: true,
    startMinute: template?.startMinute ?? null,
    endMinute: template?.endMinute ?? null,
    requiredMinutes: hours.requiredMinutes,
  };
}

const SATURDAY_ROTA_START_KEY = 'attendance.saturdayRotaStart';

type LoadedAssignment = ScheduleAssignment & { schedule: ScheduleWithDays; from: string; to: string | null };

/** In-memory resolver for a set of employees over a date range (built from a fixed number of queries). */
export class ScheduleContext {
  private readonly byEmployee = new Map<string, LoadedAssignment[]>();
  private readonly byDepartment = new Map<string, LoadedAssignment[]>();
  private readonly holidays = new Map<string, Holiday[]>();

  private readonly employeeHours = new Map<string, EmployeeHours>();
  private readonly saturdayGroups = new Map<string, SaturdayGroup | null>();
  private readonly companyHours: CompanyHoursRule[];

  constructor(
    assignments: (ScheduleAssignment & { schedule: ScheduleWithDays })[],
    private readonly defaultSchedule: ScheduleWithDays | null,
    holidays: Holiday[],
    companyHours: readonly CompanyHoursRule[] = [],
    employees: EmployeeDayData[] = [],
    private readonly saturdayRotaStart: string | null = null,
  ) {
    this.companyHours = [...companyHours].sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : x.effectiveFrom > y.effectiveFrom ? 1 : 0));
    for (const e of employees) {
      this.employeeHours.set(e.id, { dailyRequiredMinutes: e.dailyRequiredMinutes, includedBreakMinutes: e.includedBreakMinutes });
      this.saturdayGroups.set(e.id, e.saturdayGroup ?? null);
    }
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

  /** Company default on a date: the latest rule on or before it. */
  companyHoursOn(date: string): DailyHours {
    const rule = ruleOn(this.companyHours, date);
    return rule ? { requiredMinutes: rule.requiredMinutes, includedBreakMinutes: rule.includedBreakMinutes } : DEFAULT_DAILY_HOURS;
  }

  /** Effective daily requirement and break allowance of this employee on a date. */
  hours(emp: EmployeeRef, date: string): DailyHours {
    return effectiveHours(this.companyHoursOn(date), this.employeeHours.get(emp.id));
  }

  holiday(emp: EmployeeRef, date: string): Holiday | null {
    return this.holidays.get(date)?.find((h) => h.locationId === null || h.locationId === (emp.locationId ?? null)) ?? null;
  }

  /** Rota start (group A's first working Saturday), null when the rota is off. */
  get rotaStart(): string | null {
    return this.saturdayRotaStart;
  }

  /** Effective Saturday rota group of a loaded employee. */
  saturdayGroup(emp: EmployeeRef): SaturdayGroup | null {
    return this.saturdayGroups.get(emp.id) ?? null;
  }

  /** WORKING / OFF on a rota Saturday of this employee, else null (holidays not considered). */
  saturdayRota(emp: EmployeeRef, date: string): SaturdayRotaDay | null {
    return saturdayRotaFor(date, this.saturdayRotaStart, this.saturdayGroups.get(emp.id) ?? null);
  }

  day(emp: EmployeeRef, date: string): ResolvedDay {
    const { schedule, source } = this.schedule(emp, date);
    const holiday = this.holiday(emp, date);
    const hours = this.hours(emp, date);
    const rota = this.saturdayRota(emp, date);
    return {
      rule: rota ? rotaSaturdayRule(schedule, date, hours, rota) : ruleFor(schedule, date, hours),
      source,
      isHoliday: holiday !== null,
      holidayName: holiday?.name ?? null,
      saturdayRota: holiday ? null : rota,
    };
  }
}

@Injectable()
export class ScheduleResolver {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads everything needed to resolve schedules/holidays for these employees between from and to (inclusive). */
  async load(employees: EmployeeRef[], from: string, to: string, db: Db = this.prisma): Promise<ScheduleContext> {
    const employeeIds = employees.map((e) => e.id);
    const departmentIds = [...new Set(employees.map((e) => e.departmentId).filter((d): d is string => d !== null))];
    const [assignments, defaultSchedule, holidays, own, rules, rotaStart] = await Promise.all([
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
        ? db.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, dailyRequiredMinutes: true, includedBreakMinutes: true, saturdayGroup: true, department: { select: { saturdayGroup: true } } },
          })
        : Promise.resolve([]),
      // A handful of rows; all are loaded so a rule from before the range still applies.
      db.workHoursRule.findMany({ orderBy: { effectiveFrom: 'asc' } }),
      db.systemSetting.findUnique({ where: { key: SATURDAY_ROTA_START_KEY }, select: { value: true } }),
    ]);
    const companyHours = rules.map((r) => ({
      effectiveFrom: dateOnly.fromDb(r.effectiveFrom), requiredMinutes: r.dailyRequiredMinutes, includedBreakMinutes: r.includedBreakMinutes,
    }));
    const people = own.map(({ department, ...e }) => ({ ...e, saturdayGroup: effectiveSaturdayGroup(e.saturdayGroup, department?.saturdayGroup) }));
    const start = typeof rotaStart?.value === 'string' && isSaturdayDate(rotaStart.value) ? rotaStart.value : null;
    return new ScheduleContext(assignments, defaultSchedule, holidays, companyHours, people, start);
  }

  /**
   * Employee assignment > department assignment > default schedule > built-in fallback, plus holiday flag.
   * Daily hours: employee override > company work-hours rule for the date.
   */
  async resolve(employeeId: string, departmentId: string | null, date: string, locationId: string | null = null): Promise<ResolvedDay> {
    const emp = { id: employeeId, departmentId, locationId };
    return (await this.load([emp], date, date)).day(emp, date);
  }
}

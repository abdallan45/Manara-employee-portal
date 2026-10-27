import { Injectable } from '@nestjs/common';
import type { AttendanceState, DashboardSummary, DayMetrics, LiveAttendanceRow, Paginated } from '@workforce/shared';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { attendanceScope, employeeScopeWhere } from '../../common/scope';
import { addDays, localDate } from '../../common/time';
import { AttendanceMetricsService } from '../attendance/attendance-metrics.service';
import { assertDate, eachDate } from '../attendance/date-range';
import { foldArabic } from '../employees/employees.service';

export const LIVE_SORT_KEYS = ['name', 'code', 'department', 'firstIn', 'netWork', 'late', 'status'] as const;
export type LiveSortKey = (typeof LIVE_SORT_KEYS)[number];

export interface LiveQuery {
  date?: string;
  search?: string;
  departmentId?: string;
  status?: string;
  scheduleType?: string;
  sort?: LiveSortKey;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

const TREND_DAYS = 14;

const stateFromMetrics = (m: DayMetrics): AttendanceState => (m.status === 'WORKING' ? 'WORKING' : m.status === 'ON_BREAK' ? 'ON_BREAK' : 'OFF');
const isScheduled = (m: DayMetrics) => m.requiredMinutes > 0;
const isPresent = (m: DayMetrics) => m.firstIn !== null;

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService, private readonly metrics: AttendanceMetricsService) {}

  private async employeesInScope(user: AuthUser) {
    const scope = attendanceScope(user);
    return this.prisma.employee.findMany({
      where: { isActive: true, deletedAt: null, ...employeeScopeWhere(scope) },
      select: {
        id: true, employeeCode: true, fullName: true, fullNameAr: true, departmentId: true, locationId: true,
        department: { select: { name: true, nameAr: true } },
      },
      orderBy: { fullName: 'asc' },
    });
  }

  /** The live state right now (open session / open break), independent of work date. */
  private async currentStates(employeeIds: string[]): Promise<Map<string, AttendanceState>> {
    const [sessions, breaks] = await Promise.all([
      this.prisma.workSession.findMany({ where: { employeeId: { in: employeeIds }, status: 'OPEN' }, select: { id: true, employeeId: true } }),
      this.prisma.breakSession.findMany({ where: { employeeId: { in: employeeIds }, endedAt: null }, select: { employeeId: true, workSessionId: true } }),
    ]);
    const openSession = new Map(sessions.map((s) => [s.employeeId, s.id]));
    const states = new Map<string, AttendanceState>();
    for (const id of employeeIds) states.set(id, openSession.has(id) ? 'WORKING' : 'OFF');
    for (const b of breaks) if (openSession.get(b.employeeId) === b.workSessionId) states.set(b.employeeId, 'ON_BREAK');
    return states;
  }

  async summary(user: AuthUser, date?: string): Promise<DashboardSummary> {
    const now = new Date();
    const day = date ? assertDate(date, 'date') : localDate(now);
    const from = addDays(day, -(TREND_DAYS - 1));
    const employees = await this.employeesInScope(user);
    const { days } = await this.metrics.computeRange(employees, from, day, now);
    const isToday = day === localDate(now);
    const states = isToday ? await this.currentStates(employees.map((e) => e.id)) : null;

    const onDay = employees.map((e) => {
      const list = days.get(e.id)!;
      const m = list[list.length - 1];
      return { e, m, state: states?.get(e.id) ?? stateFromMetrics(m) };
    });
    const scheduled = onDay.filter((x) => isScheduled(x.m));
    const sum = (f: (m: DayMetrics) => number) => onDay.reduce((s, x) => s + f(x.m), 0);

    const departments = new Map<string, DashboardSummary['departments'][number]>();
    for (const { e, m } of onDay) {
      const key = e.departmentId ?? '';
      const row = departments.get(key) ?? {
        departmentId: e.departmentId, name: e.department?.name ?? 'Unassigned', nameAr: e.department?.nameAr ?? null,
        present: 0, scheduled: 0, workMinutes: 0,
      };
      if (isPresent(m)) row.present += 1;
      if (isScheduled(m)) row.scheduled += 1;
      row.workMinutes += m.netWorkMinutes;
      departments.set(key, row);
    }

    const trend = eachDate(from, day).map((d, i) => {
      const point = { date: d, present: 0, scheduled: 0, late: 0, workMinutes: 0 };
      for (const e of employees) {
        const m = days.get(e.id)![i];
        if (isPresent(m)) point.present += 1;
        if (isScheduled(m)) point.scheduled += 1;
        if (m.isLate) point.late += 1;
        point.workMinutes += m.netWorkMinutes;
      }
      return point;
    });

    return {
      date: day,
      kpis: {
        totalEmployees: employees.length,
        currentlyWorking: onDay.filter((x) => x.state === 'WORKING').length,
        onBreak: onDay.filter((x) => x.state === 'ON_BREAK').length,
        checkedOut: onDay.filter((x) => x.m.status === 'CHECKED_OUT').length,
        absent: onDay.filter((x) => x.m.status === 'ABSENT').length,
        onLeave: onDay.filter((x) => x.m.status === 'ON_LEAVE').length,
        late: onDay.filter((x) => x.m.isLate).length,
        missingCheckouts: onDay.filter((x) => x.m.missingPunch).length,
        totalWorkMinutes: sum((m) => m.netWorkMinutes),
        extraMinutes: sum((m) => m.extraMinutes),
        attendanceRate: scheduled.length ? scheduled.filter((x) => isPresent(x.m)).length / scheduled.length : 0,
      },
      trend,
      departments: [...departments.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async live(user: AuthUser, q: LiveQuery): Promise<Paginated<LiveAttendanceRow>> {
    const now = new Date();
    const day = q.date ? assertDate(q.date, 'date') : localDate(now);
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 25));
    const employees = await this.employeesInScope(user);
    const { days, context } = await this.metrics.computeRange(employees, day, day, now);
    const states = day === localDate(now) ? await this.currentStates(employees.map((e) => e.id)) : null;

    let rows: LiveAttendanceRow[] = employees.map((e) => {
      const metrics = days.get(e.id)![0];
      return {
        employeeId: e.id, employeeCode: e.employeeCode, fullName: e.fullName, fullNameAr: e.fullNameAr,
        departmentId: e.departmentId, departmentName: e.department?.name ?? null, departmentNameAr: e.department?.nameAr ?? null,
        scheduleType: context.schedule(e, day).schedule.type,
        state: states?.get(e.id) ?? stateFromMetrics(metrics),
        metrics,
      };
    });

    // Same folding as the employee search: "احمد" finds "أحمد", "فاطمه" finds "فاطمة".
    const search = q.search ? foldArabic(q.search) : '';
    if (search) {
      rows = rows.filter((r) => [r.fullName, r.fullNameAr ?? '', r.employeeCode].some((v) => foldArabic(v).includes(search)));
    }
    if (q.departmentId) rows = rows.filter((r) => r.departmentId === q.departmentId);
    if (q.status) rows = rows.filter((r) => r.metrics.status === q.status);
    if (q.scheduleType) rows = rows.filter((r) => r.scheduleType === q.scheduleType);

    const dir = q.order === 'desc' ? -1 : 1;
    const key = q.sort ?? 'name';
    const value = (r: LiveAttendanceRow): string | number | null => {
      switch (key) {
        case 'code': return r.employeeCode;
        case 'department': return r.departmentName ?? '';
        case 'firstIn': return r.metrics.firstIn;
        case 'netWork': return r.metrics.netWorkMinutes;
        case 'late': return r.metrics.lateMinutes;
        case 'status': return r.metrics.status;
        default: return r.fullName;
      }
    };
    rows.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === vb) return a.fullName.localeCompare(b.fullName);
      if (va === null) return 1; // nulls last in both directions
      if (vb === null) return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir;
    });

    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  }
}

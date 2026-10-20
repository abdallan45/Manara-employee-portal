import { Injectable } from '@nestjs/common';
import type { DayMetrics } from '@workforce/shared';
import { PrismaService, type Db } from '../../common/prisma.service';
import { addDays, dateOnly, startOfLocalDay } from '../../common/time';
import { ScheduleContext, ScheduleResolver, type EmployeeRef } from '../schedules/schedule-resolver';
import { computeDayMetrics, type CalcBreak, type CalcSession } from './calc';
import { eachDate } from './date-range';
import { leaveForDay, type ApprovedLeave } from './leave-days';

export interface RangeMetrics {
  /** employeeId -> one DayMetrics per date in [from, to], in date order. */
  days: Map<string, DayMetrics[]>;
  context: ScheduleContext;
}

/**
 * Loads sessions, breaks, schedules, holidays and approved leave for many employees over a date range
 * in a fixed number of queries, then delegates every figure to the pure calc module.
 */
@Injectable()
export class AttendanceMetricsService {
  constructor(private readonly prisma: PrismaService, private readonly resolver: ScheduleResolver) {}

  async computeRange(employees: EmployeeRef[], from: string, to: string, now = new Date(), db: Db = this.prisma): Promise<RangeMetrics> {
    const ids = employees.map((e) => e.id);
    const [context, sessions, leaves] = await Promise.all([
      this.resolver.load(employees, from, to, db),
      ids.length
        ? db.workSession.findMany({
            where: { employeeId: { in: ids }, workDate: { gte: dateOnly.toDb(from), lte: dateOnly.toDb(to) } },
            include: { breaks: { include: { breakType: true } } },
            orderBy: { startedAt: 'asc' },
          })
        : Promise.resolve([]),
      ids.length
        ? db.leaveRequest.findMany({
            where: {
              employeeId: { in: ids }, status: 'APPROVED',
              startAt: { lt: startOfLocalDay(addDays(to, 1)) }, endAt: { gt: startOfLocalDay(from) },
            },
            select: { employeeId: true, mode: true, startAt: true, endAt: true, minutes: true, leaveType: { select: { isRemoteWork: true } } },
          })
        : Promise.resolve([]),
    ]);

    const leaveByEmployee = new Map<string, ApprovedLeave[]>();
    for (const { leaveType, ...l } of leaves) {
      leaveByEmployee.set(l.employeeId, [...(leaveByEmployee.get(l.employeeId) ?? []), { ...l, remote: leaveType.isRemoteWork }]);
    }

    const grouped = new Map<string, { sessions: CalcSession[]; breaks: CalcBreak[] }>();
    for (const s of sessions) {
      const key = `${s.employeeId}|${dateOnly.fromDb(s.workDate)}`;
      const bucket = grouped.get(key) ?? { sessions: [], breaks: [] };
      bucket.sessions.push({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, status: s.status });
      for (const b of s.breaks) {
        bucket.breaks.push({
          sessionId: s.id, startedAt: b.startedAt, endedAt: b.endedAt,
          isPaid: b.breakType.isPaid, maxMinutes: b.breakType.maxMinutes, countsAsWork: b.breakType.countsAsWork,
        });
      }
      grouped.set(key, bucket);
    }

    const dates = eachDate(from, to);
    const days = new Map<string, DayMetrics[]>();
    for (const emp of employees) {
      days.set(emp.id, dates.map((workDate) => {
        const resolved = context.day(emp, workDate);
        const bucket = grouped.get(`${emp.id}|${workDate}`);
        const leave = leaveForDay(leaveByEmployee.get(emp.id) ?? [], workDate, resolved.rule.isWorkday && !resolved.isHoliday);
        return computeDayMetrics({
          workDate, schedule: resolved.rule, isHoliday: resolved.isHoliday,
          sessions: bucket?.sessions ?? [], breaks: bucket?.breaks ?? [], now,
          onLeave: leave.onLeave, leaveMinutes: leave.leaveMinutes, leaveWindows: leave.leaveWindows, remote: leave.remote,
        });
      }));
    }
    return { days, context };
  }
}

import type { Holiday } from '@prisma/client';
import { effectiveSaturdayGroup, isSaturdayDate, nextWorkingSaturday, saturdaysFrom, saturdayRotaFor, saturdayWorkingGroup } from '@workforce/shared';
import { dateOnly, localDateTime } from '../../common/time';
import { computeDayMetrics, type CalcSession } from '../attendance/calc';
import { ScheduleContext, type ScheduleWithDays } from './schedule-resolver';

const START = '2026-10-31'; // group A's first working Saturday

describe('saturdayRotaFor', () => {
  it('alternates A and B weekly from the start date', () => {
    expect(saturdayRotaFor('2026-10-31', START, 'A')).toBe('WORKING');
    expect(saturdayRotaFor('2026-10-31', START, 'B')).toBe('OFF');
    expect(saturdayRotaFor('2026-11-07', START, 'A')).toBe('OFF');
    expect(saturdayRotaFor('2026-11-07', START, 'B')).toBe('WORKING');
    expect(saturdayRotaFor('2026-11-14', START, 'A')).toBe('WORKING');
    expect(saturdayRotaFor('2027-01-02', START, 'B')).toBe('WORKING'); // 9 weeks later, across the year end
  });

  it('is null off Saturdays, before the start, without a group or without a start', () => {
    expect(saturdayRotaFor('2026-11-01', START, 'A')).toBeNull();
    expect(saturdayRotaFor('2026-10-24', START, 'A')).toBeNull();
    expect(saturdayRotaFor('2026-10-31', START, null)).toBeNull();
    expect(saturdayRotaFor('2026-10-31', null, 'A')).toBeNull();
    expect(saturdayRotaFor('2026-10-31', '2026-10-30', 'A')).toBeNull(); // start is not a Saturday
  });

  it('validates Saturdays and lists the next ones', () => {
    expect(isSaturdayDate('2026-10-31')).toBe(true);
    expect(isSaturdayDate('2026-10-30')).toBe(false);
    expect(isSaturdayDate('2026-02-30')).toBe(false);
    expect(isSaturdayDate('31/10/2026')).toBe(false);
    expect(saturdaysFrom('2026-10-28', 3)).toEqual(['2026-10-31', '2026-11-07', '2026-11-14']);
    expect(saturdaysFrom('2026-10-31', 1)).toEqual(['2026-10-31']);
    expect(saturdayWorkingGroup('2026-11-07', START)).toBe('B');
    expect(saturdayWorkingGroup('2026-10-24', START)).toBeNull();
    expect(nextWorkingSaturday('2026-10-01', START, 'B')).toBe('2026-11-07');
    expect(nextWorkingSaturday('2026-11-01', START, 'A')).toBe('2026-11-14');
    expect(nextWorkingSaturday('2026-11-01', null, 'A')).toBeNull();
  });

  it('resolves the effective group: own group, NONE opts out, else the department', () => {
    expect(effectiveSaturdayGroup('B', 'A')).toBe('B');
    expect(effectiveSaturdayGroup('NONE', 'A')).toBeNull();
    expect(effectiveSaturdayGroup(null, 'A')).toBe('A');
    expect(effectiveSaturdayGroup(null, null)).toBeNull();
  });
});

const schedule = (days: { weekday: number; start?: number; end?: number }[], type: 'FIXED' | 'FLEXIBLE' = 'FIXED'): ScheduleWithDays => ({
  id: 'sched', name: 'Office', type, weeklyRequiredMinutes: 0, graceMinutes: 10, includedBreakMinutes: 0,
  coreStartMinute: type === 'FLEXIBLE' ? 600 : null, coreEndMinute: type === 'FLEXIBLE' ? 840 : null, isDefault: true, createdAt: new Date(0),
  days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const d = days.find((x) => x.weekday === weekday);
    return {
      id: `d${weekday}`, scheduleId: 'sched', weekday, isWorkday: !!d,
      startMinute: d?.start ?? null, endMinute: d?.end ?? null, requiredMinutes: d ? 540 : 0,
    };
  }),
});
// Sunday 07:30-16:30, Monday to Thursday 08:00-17:00.
const office = schedule([{ weekday: 0, start: 450, end: 990 }, ...[1, 2, 3, 4].map((weekday) => ({ weekday, start: 480, end: 1020 }))]);
const rules = [{ effectiveFrom: '2000-01-01', requiredMinutes: 540, includedBreakMinutes: 60 }];
const holiday = (date: string): Holiday => ({ id: 'h', date: dateOnly.toDb(date), name: 'Holiday', nameAr: null, isPaid: true, locationId: null } as Holiday);

const a = { id: 'a', departmentId: null };
const b = { id: 'b', departmentId: null };
const none = { id: 'n', departmentId: null };
const people = [
  { id: 'a', dailyRequiredMinutes: null, includedBreakMinutes: null, saturdayGroup: effectiveSaturdayGroup(null, 'A') },
  { id: 'b', dailyRequiredMinutes: null, includedBreakMinutes: null, saturdayGroup: effectiveSaturdayGroup('B', 'A') },
  { id: 'n', dailyRequiredMinutes: null, includedBreakMinutes: null, saturdayGroup: effectiveSaturdayGroup('NONE', 'A') },
];
const context = (sched = office, holidays: Holiday[] = [], start: string | null = START) => new ScheduleContext([], sched, holidays, rules, people, start);

let n = 0;
const session = (date: string, from: number, to: number): CalcSession => ({
  id: `s${++n}`, startedAt: localDateTime(date, from), endedAt: localDateTime(date, to), status: 'CLOSED',
});
const metrics = (ctx: ScheduleContext, emp: { id: string; departmentId: null }, date: string, sessions: CalcSession[] = []) => {
  const r = ctx.day(emp, date);
  return computeDayMetrics({
    workDate: date, schedule: r.rule, isHoliday: r.isHoliday, sessions, breaks: [], now: localDateTime('2026-12-01', 600), saturdayRota: r.saturdayRota,
  });
};

describe('Saturday rota in the schedule context and calc', () => {
  it('working Saturday: a normal workday with the Sunday times, lateness measured from them', () => {
    const ctx = context();
    const r = ctx.day(a, '2026-10-31');
    expect(r.saturdayRota).toBe('WORKING');
    expect(r.rule).toMatchObject({ isWorkday: true, startMinute: 450, endMinute: 990, requiredMinutes: 540, includedBreakMinutes: 60 });
    const m = metrics(ctx, a, '2026-10-31', [session('2026-10-31', 470, 990)]);
    expect(m).toMatchObject({ status: 'CHECKED_OUT', requiredMinutes: 540, lateMinutes: 10, missingMinutes: 20, saturdayRota: 'WORKING' });
    expect(metrics(ctx, a, '2026-10-31')).toMatchObject({ status: 'ABSENT', missingMinutes: 540 });
  });

  it('working Saturday without a Sunday workday uses the first workday of the week', () => {
    const ctx = context(schedule([{ weekday: 1, start: 540, end: 1080 }, { weekday: 2, start: 480, end: 1020 }]));
    expect(ctx.day(a, '2026-10-31').rule).toMatchObject({ isWorkday: true, startMinute: 540, endMinute: 1080 });
  });

  it('flexible schedule: a working Saturday uses the core hours', () => {
    const ctx = context(schedule([0, 1, 2, 3, 4].map((weekday) => ({ weekday })), 'FLEXIBLE'));
    const m = metrics(ctx, a, '2026-10-31', [session('2026-10-31', 615, 1155)]);
    expect(m).toMatchObject({ requiredMinutes: 540, lateMinutes: 5, scheduled: expect.objectContaining({ isWorkday: true, coreStart: '10:00', coreEnd: '14:00' }) });
  });

  it('Saturday off: nothing required, never absent, worked time recorded but never extra', () => {
    const ctx = context();
    expect(ctx.day(b, '2026-10-31').saturdayRota).toBe('OFF');
    expect(metrics(ctx, b, '2026-10-31')).toMatchObject({ status: 'NOT_SCHEDULED', requiredMinutes: 0, missingMinutes: 0, saturdayRota: 'OFF' });
    const worked = metrics(ctx, b, '2026-10-31', [session('2026-10-31', 480, 1020)]);
    expect(worked).toMatchObject({
      status: 'CHECKED_OUT', netWorkMinutes: 540, requiredMinutes: 0, extraMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0, missingMinutes: 0,
      saturdayRota: 'OFF', scheduled: expect.objectContaining({ isWorkday: false }),
    });
    // The next week the groups swap.
    expect(metrics(ctx, b, '2026-11-07')).toMatchObject({ status: 'ABSENT', requiredMinutes: 540, saturdayRota: 'WORKING' });
    expect(metrics(ctx, a, '2026-11-07')).toMatchObject({ status: 'NOT_SCHEDULED', saturdayRota: 'OFF' });
  });

  it('a public holiday on a rota Saturday wins', () => {
    const ctx = context(office, [holiday('2026-10-31')]);
    for (const emp of [a, b]) {
      const r = ctx.day(emp, '2026-10-31');
      expect(r).toMatchObject({ isHoliday: true, saturdayRota: null });
      const m = metrics(ctx, emp, '2026-10-31', [session('2026-10-31', 480, 600)]);
      expect(m).toMatchObject({ requiredMinutes: 0, extraMinutes: 120, saturdayRota: null, scheduled: expect.objectContaining({ isWorkday: false }) });
    }
  });

  it('before the start date, with the rota off, or for NONE, Saturday follows the schedule', () => {
    for (const [ctx, emp, date] of [[context(), a, '2026-10-24'], [context(office, [], null), a, '2026-10-31'], [context(), none, '2026-10-31']] as const) {
      const r = ctx.day(emp, date);
      expect(r.saturdayRota).toBeNull();
      expect(r.rule.isWorkday).toBe(false);
      const m = metrics(ctx, emp, date, [session(date, 480, 600)]);
      expect(m).toMatchObject({ status: 'CHECKED_OUT', requiredMinutes: 0, extraMinutes: 120, saturdayRota: null });
    }
  });
});

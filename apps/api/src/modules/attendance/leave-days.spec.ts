import { computeDayMetrics, type ScheduleDayRule } from './calc';
import { leaveDates, leaveForDay, remoteOn } from './leave-days';

// Amman is UTC+3 all year (no DST since 2022).
const fullDay = { mode: 'FULL_DAY', startAt: new Date('2026-11-01T21:00:00Z'), endAt: new Date('2026-11-04T21:00:00Z'), minutes: 3 * 480 }; // Nov 2–4
const hourly = { mode: 'HOURLY', startAt: new Date('2026-11-09T06:00:00Z'), endAt: new Date('2026-11-09T08:00:00Z'), minutes: 120 }; // Nov 9 09:00–11:00

const rule: ScheduleDayRule = {
  scheduleId: null, scheduleName: 'Fixed', type: 'FIXED', isWorkday: true, startMinute: 480, endMinute: 960,
  requiredMinutes: 480, graceMinutes: 10, coreStartMinute: null, coreEndMinute: null,
};

describe('leave → calc inputs', () => {
  it('maps a request to its local dates (end is exclusive)', () => {
    expect(leaveDates(fullDay)).toEqual({ startDate: '2026-11-02', endDate: '2026-11-04' });
    expect(leaveDates(hourly)).toEqual({ startDate: '2026-11-09', endDate: '2026-11-09' });
  });

  it('full-day leave marks working days only', () => {
    expect(leaveForDay([fullDay], '2026-11-01', true)).toEqual({ onLeave: false, leaveMinutes: 0, leaveWindows: [], remote: false });
    expect(leaveForDay([fullDay], '2026-11-02', true)).toEqual({ onLeave: true, leaveMinutes: 0, leaveWindows: [], remote: false });
    expect(leaveForDay([fullDay], '2026-11-04', true)).toEqual({ onLeave: true, leaveMinutes: 0, leaveWindows: [], remote: false });
    expect(leaveForDay([fullDay], '2026-11-03', false)).toEqual({ onLeave: false, leaveMinutes: 0, leaveWindows: [], remote: false });
    expect(leaveForDay([fullDay], '2026-11-05', true)).toEqual({ onLeave: false, leaveMinutes: 0, leaveWindows: [], remote: false });
  });

  it('partial leave reduces required minutes', () => {
    expect(leaveForDay([fullDay, hourly], '2026-11-09', true)).toEqual({ onLeave: false, leaveMinutes: 120, leaveWindows: [{ startAt: hourly.startAt, endAt: hourly.endAt }], remote: false });
  });

  it('feeds calc.ts: a full leave day is ON_LEAVE with nothing required, partial leave lowers the requirement', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const off = leaveForDay([fullDay], '2026-11-02', true);
    const day = computeDayMetrics({ workDate: '2026-11-02', schedule: rule, isHoliday: false, sessions: [], breaks: [], now, ...off });
    expect(day.status).toBe('ON_LEAVE');
    expect(day.requiredMinutes).toBe(0);
    expect(day.missingMinutes).toBe(0);

    const part = leaveForDay([hourly], '2026-11-09', true);
    const worked = computeDayMetrics({
      workDate: '2026-11-09', schedule: rule, isHoliday: false, now, ...part,
      sessions: [{ id: 's', startedAt: new Date('2026-11-09T08:00:00Z'), endedAt: new Date('2026-11-09T14:00:00Z'), status: 'CLOSED' }],
      breaks: [],
    });
    expect(worked.requiredMinutes).toBe(360);
    expect(worked.netWorkMinutes).toBe(360);
    expect(worked.missingMinutes).toBe(0);
  });

  it('hourly leave at the shift start: checking in right after it is not late', () => {
    // EMP-0202-style case: fixed 09:00–17:00, leave 09:00–11:00, check-in 11:02.
    const nine = { ...rule, startMinute: 540, endMinute: 1020 };
    const part = leaveForDay([hourly], '2026-11-09', true);
    const m = computeDayMetrics({
      workDate: '2026-11-09', schedule: nine, isHoliday: false, now: new Date('2026-11-20T12:00:00Z'), ...part,
      sessions: [{ id: 's', startedAt: new Date('2026-11-09T08:02:00Z'), endedAt: new Date('2026-11-09T14:00:00Z'), status: 'CLOSED' }],
      breaks: [],
    });
    expect(m.lateMinutes).toBe(0);
    expect(m.isLate).toBe(false);
  });

  it('half-day leave windows reach calc: morning half moves the due time, afternoon half the end', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const first = { mode: 'HALF_DAY', startAt: new Date('2026-11-10T05:00:00Z'), endAt: new Date('2026-11-10T09:00:00Z'), minutes: 240 }; // 08:00–12:00
    const second = { mode: 'HALF_DAY', startAt: new Date('2026-11-11T09:00:00Z'), endAt: new Date('2026-11-11T13:00:00Z'), minutes: 240 }; // 12:00–16:00
    const morning = computeDayMetrics({
      workDate: '2026-11-10', schedule: rule, isHoliday: false, now, ...leaveForDay([first], '2026-11-10', true),
      sessions: [{ id: 'a', startedAt: new Date('2026-11-10T09:08:00Z'), endedAt: new Date('2026-11-10T13:00:00Z'), status: 'CLOSED' }],
      breaks: [],
    });
    expect(morning.lateMinutes).toBe(0);
    const afternoon = computeDayMetrics({
      workDate: '2026-11-11', schedule: rule, isHoliday: false, now, ...leaveForDay([second], '2026-11-11', true),
      sessions: [{ id: 'b', startedAt: new Date('2026-11-11T05:00:00Z'), endedAt: new Date('2026-11-11T08:30:00Z'), status: 'CLOSED' }],
      breaks: [],
    });
    expect(afternoon.earlyDepartureMinutes).toBe(20); // 12:00 − 10 grace − 11:30
  });

  it('remote work is a working day, not leave: full schedule, lateness and absence still apply', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    const remote = { ...fullDay, remote: true }; // Nov 2–4
    const half = { ...hourly, mode: 'HALF_DAY', remote: true };
    expect(leaveForDay([remote], '2026-11-02', true)).toEqual({ onLeave: false, leaveMinutes: 0, leaveWindows: [], remote: true });
    expect(leaveForDay([half], '2026-11-09', true)).toEqual({ onLeave: false, leaveMinutes: 0, leaveWindows: [], remote: true });
    expect(leaveForDay([remote], '2026-11-03', false).remote).toBe(false);
    expect(remoteOn([remote], '2026-11-03')).toBe(true);
    expect(remoteOn([remote, fullDay], '2026-11-05')).toBe(false);
    expect(remoteOn([fullDay], '2026-11-02')).toBe(false);

    const absent = computeDayMetrics({ workDate: '2026-11-02', schedule: rule, isHoliday: false, sessions: [], breaks: [], now, ...leaveForDay([remote], '2026-11-02', true) });
    expect(absent.status).toBe('ABSENT');
    expect(absent.remote).toBe(true);
    expect(absent.requiredMinutes).toBe(480);
    expect(absent.missingMinutes).toBe(480);

    const late = computeDayMetrics({
      workDate: '2026-11-03', schedule: rule, isHoliday: false, now, ...leaveForDay([remote], '2026-11-03', true),
      sessions: [{ id: 'r', startedAt: new Date('2026-11-03T05:30:00Z'), endedAt: new Date('2026-11-03T13:30:00Z'), status: 'CLOSED' }],
      breaks: [],
    });
    expect(late.status).toBe('CHECKED_OUT');
    expect(late.remote).toBe(true);
    expect(late.lateMinutes).toBe(20); // 08:30 − (08:00 + 10 grace)
    expect(late.netWorkMinutes).toBe(480);
    expect(late.missingMinutes).toBe(0);

    // Leave on the same day wins: the day is leave, not remote.
    const both = computeDayMetrics({ workDate: '2026-11-02', schedule: rule, isHoliday: false, sessions: [], breaks: [], now, ...leaveForDay([remote, fullDay], '2026-11-02', true) });
    expect(both.status).toBe('ON_LEAVE');
    expect(both.remote).toBe(false);
  });
});

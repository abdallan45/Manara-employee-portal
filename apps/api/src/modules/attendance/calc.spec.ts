import { computeDayMetrics, sumPeriod, type CalcBreak, type CalcSession, type DayCalcInput, type ScheduleDayRule } from './calc';
import { localDateTime } from '../../common/time';

const D = '2026-10-15'; // a Thursday
const at = (hm: string, date = D) => {
  const [h, m] = hm.split(':').map(Number);
  return localDateTime(date, h * 60 + m);
};

const fixed = (over: Partial<ScheduleDayRule> = {}): ScheduleDayRule => ({
  scheduleId: 's1', scheduleName: 'Office', type: 'FIXED', isWorkday: true,
  startMinute: 8 * 60, endMinute: 16 * 60, requiredMinutes: 480, graceMinutes: 10,
  coreStartMinute: null, coreEndMinute: null, ...over,
});
const flexible = (over: Partial<ScheduleDayRule> = {}): ScheduleDayRule => ({
  scheduleId: 's2', scheduleName: 'Flex', type: 'FLEXIBLE', isWorkday: true,
  startMinute: null, endMinute: null, requiredMinutes: 480, graceMinutes: 0,
  coreStartMinute: null, coreEndMinute: null, ...over,
});

let n = 0;
const session = (from: string, to: string | null, status?: CalcSession['status'], date = D, toDate = date): CalcSession => ({
  id: `ws${++n}`, startedAt: at(from, date), endedAt: to ? at(to, toDate) : null,
  status: status ?? (to ? 'CLOSED' : 'OPEN'),
});
const brk = (s: CalcSession, from: string, to: string | null, rule: Partial<CalcBreak> = {}): CalcBreak => ({
  sessionId: s.id, startedAt: at(from), endedAt: to ? at(to) : null,
  isPaid: false, maxMinutes: null, countsAsWork: false, ...rule,
});
const run = (over: Partial<DayCalcInput>) =>
  computeDayMetrics({ workDate: D, schedule: fixed(), isHoliday: false, sessions: [], breaks: [], now: at('23:00'), ...over });

describe('computeDayMetrics - fixed schedule', () => {
  it('is on time within the grace period', () => {
    const m = run({ sessions: [session('08:09', '16:30')] });
    expect(m.isLate).toBe(false);
    expect(m.lateMinutes).toBe(0);
    expect(m.status).toBe('CHECKED_OUT');
    expect(m.presenceMinutes).toBe(501);
    expect(m.netWorkMinutes).toBe(501);
    expect(m.extraMinutes).toBe(21);
    expect(m.missingMinutes).toBe(0);
  });

  it('is late beyond the grace period (measured from start + grace)', () => {
    const m = run({ sessions: [session('08:25', '16:30')] });
    expect(m.isLate).toBe(true);
    expect(m.lateMinutes).toBe(15);
  });

  it('without grace any minute after start is late', () => {
    const m = run({ schedule: fixed({ graceMinutes: 0 }), sessions: [session('08:01', '16:00')] });
    expect(m.lateMinutes).toBe(1);
    expect(m.isLate).toBe(true);
    expect(m.missingMinutes).toBe(1);
  });

  it('flags early departure against end − grace, only once checked out', () => {
    const out = run({ sessions: [session('08:00', '15:20')] });
    expect(out.earlyDepartureMinutes).toBe(30);
    expect(out.missingMinutes).toBe(40);
    const stillIn = run({ sessions: [session('08:00', null)], now: at('15:20') });
    expect(stillIn.earlyDepartureMinutes).toBe(0);
    expect(stillIn.missingMinutes).toBe(0); // day not complete yet
    expect(stillIn.status).toBe('WORKING');
  });

  it('counts an overnight shift entirely on the check-in date', () => {
    const night = fixed({ startMinute: 22 * 60, endMinute: 6 * 60 });
    const s = session('22:00', '06:00', 'CLOSED', D, '2026-10-16');
    const m = run({ schedule: night, sessions: [s], now: at('12:00', '2026-10-16') });
    expect(m.presenceMinutes).toBe(480);
    expect(m.netWorkMinutes).toBe(480);
    expect(m.lateMinutes).toBe(0);
    expect(m.earlyDepartureMinutes).toBe(0);
    expect(m.missingMinutes).toBe(0);
    expect(m.scheduled.start).toBe('22:00');
    expect(m.scheduled.end).toBe('06:00');
    const early = run({ schedule: night, sessions: [session('22:00', '05:00', 'CLOSED', D, '2026-10-16')], now: at('12:00', '2026-10-16') });
    expect(early.earlyDepartureMinutes).toBe(50);
  });

  it('sums multiple sessions in one day', () => {
    const m = run({ sessions: [session('08:00', '12:00'), session('13:00', '17:00')] });
    expect(m.presenceMinutes).toBe(480);
    expect(m.firstIn).toBe(at('08:00').toISOString());
    expect(m.lastOut).toBe(at('17:00').toISOString());
    expect(m.earlyDepartureMinutes).toBe(0);
  });

  it('counts an open session until now', () => {
    const s = session('08:00', null);
    const m = run({ sessions: [s], now: at('10:30') });
    expect(m.presenceMinutes).toBe(150);
    expect(m.status).toBe('WORKING');
    const onBreak = run({ sessions: [s], breaks: [brk(s, '10:00', null)], now: at('10:30') });
    expect(onBreak.status).toBe('ON_BREAK');
    expect(onBreak.breakMinutes).toBe(30);
    expect(onBreak.netWorkMinutes).toBe(120);
  });
});

describe('computeDayMetrics - breaks', () => {
  it('splits paid / unpaid / excess and honours countsAsWork', () => {
    const s = session('08:00', '17:00');
    const m = run({
      sessions: [s],
      breaks: [
        brk(s, '10:00', '10:20', { isPaid: true, maxMinutes: 15 }), // paid 15, excess 5
        brk(s, '12:00', '13:00', { isPaid: false, maxMinutes: 60 }), // unpaid 60
        brk(s, '15:00', '15:40', { isPaid: true, countsAsWork: true, maxMinutes: 30 }), // work, excess 10
      ],
    });
    expect(m.presenceMinutes).toBe(540);
    expect(m.breakMinutes).toBe(120);
    expect(m.paidBreakMinutes).toBe(45);
    expect(m.unpaidBreakMinutes).toBe(75);
    expect(m.excessBreakMinutes).toBe(15);
    // net = 540 − 20 − 60 − 10 (excess of the counts-as-work break)
    expect(m.netWorkMinutes).toBe(450);
    expect(m.missingMinutes).toBe(30);
  });
});

describe('computeDayMetrics - break included in the working day', () => {
  // 09:00–18:00, nine hours including a one-hour break.
  const nine = fixed({ startMinute: 9 * 60, endMinute: 18 * 60, requiredMinutes: 540, includedBreakMinutes: 60 });

  it('a one-hour lunch is part of the nine hours: nothing missing, nothing extra', () => {
    const s = session('09:00', '18:00');
    const m = run({ schedule: nine, sessions: [s], breaks: [brk(s, '13:00', '14:00')] });
    expect(m.netWorkMinutes).toBe(540);
    expect(m.missingMinutes).toBe(0);
    expect(m.extraMinutes).toBe(0);
    expect(m.unpaidBreakMinutes).toBe(60); // still reported as break time
  });

  it('works the same when the break was not recorded', () => {
    const m = run({ schedule: nine, sessions: [session('09:00', '18:00')] });
    expect(m).toMatchObject({ netWorkMinutes: 540, missingMinutes: 0, extraMinutes: 0 });
  });

  it('only break time beyond the included hour is deducted', () => {
    const s = session('09:00', '18:00');
    const m = run({ schedule: nine, sessions: [s], breaks: [brk(s, '12:30', '14:00'), brk(s, '16:00', '16:15')] });
    expect(m.netWorkMinutes).toBe(540 - 45);
    expect(m.missingMinutes).toBe(45);
  });

  it('arriving an hour late and staying an hour later is not overtime, but it is late', () => {
    const s = session('10:00', '19:00');
    const m = run({ schedule: nine, sessions: [s], breaks: [brk(s, '13:00', '14:00')] });
    expect(m).toMatchObject({ netWorkMinutes: 540, extraMinutes: 0, missingMinutes: 0, isLate: true, lateMinutes: 50 });
  });

  it('without an included break (0) the previous rule applies: every break is deducted', () => {
    const s = session('09:00', '18:00');
    const m = run({ schedule: fixed({ startMinute: 9 * 60, endMinute: 18 * 60, requiredMinutes: 540 }), sessions: [s], breaks: [brk(s, '13:00', '14:00')] });
    expect(m).toMatchObject({ netWorkMinutes: 480, missingMinutes: 60 });
  });
});

describe('computeDayMetrics - flexible schedule', () => {
  it('without core hours is never late or early', () => {
    const m = run({ schedule: flexible(), sessions: [session('11:00', '14:00')] });
    expect(m.isLate).toBe(false);
    expect(m.lateMinutes).toBe(0);
    expect(m.earlyDepartureMinutes).toBe(0);
    expect(m.missingCoreMinutes).toBe(0);
    expect(m.missingMinutes).toBe(300);
  });

  it('without core hours is not ABSENT until the day has passed', () => {
    expect(run({ schedule: flexible(), now: at('15:00') }).status).toBe('NOT_STARTED');
    expect(run({ schedule: flexible(), now: at('09:00', '2026-10-16') }).status).toBe('ABSENT');
  });

  it('with core hours: late after core start + grace, missing core minutes, early departure', () => {
    const core = flexible({ coreStartMinute: 10 * 60, coreEndMinute: 14 * 60, graceMinutes: 5 });
    const s = session('10:20', '13:30');
    const m = run({ schedule: core, sessions: [s], breaks: [brk(s, '12:00', '12:30')] });
    expect(m.isLate).toBe(true);
    expect(m.lateMinutes).toBe(15);
    // core 10:00–14:00 = 240; covered 10:20–12:00 (100) + 12:30–13:30 (60) -> missing 80
    expect(m.missingCoreMinutes).toBe(80);
    expect(m.earlyDepartureMinutes).toBe(30);
  });

  it('a counts-as-work break covers core time', () => {
    const core = flexible({ coreStartMinute: 10 * 60, coreEndMinute: 14 * 60 });
    const s = session('09:00', '17:00');
    const m = run({ schedule: core, sessions: [s], breaks: [brk(s, '11:00', '11:30', { countsAsWork: true })] });
    expect(m.missingCoreMinutes).toBe(0);
    expect(m.isLate).toBe(false);
  });

  it('only counts the elapsed part of the core window', () => {
    const core = flexible({ coreStartMinute: 10 * 60, coreEndMinute: 14 * 60 });
    expect(run({ schedule: core, now: at('11:00') }).missingCoreMinutes).toBe(60);
  });
});

describe('computeDayMetrics - punches, holidays, absence', () => {
  it('MISSING_CHECKOUT contributes no presence and sets missingPunch', () => {
    const stale = session('08:00', null, 'MISSING_CHECKOUT');
    const m = run({ sessions: [stale], breaks: [brk(stale, '10:00', '10:00')], now: at('09:00', '2026-10-16') });
    expect(m.presenceMinutes).toBe(0);
    expect(m.netWorkMinutes).toBe(0);
    expect(m.breakMinutes).toBe(0);
    expect(m.missingPunch).toBe(true);
    expect(m.status).toBe('MISSING_PUNCH');
    expect(m.firstIn).toBe(at('08:00').toISOString());
    expect(m.missingMinutes).toBe(480);
  });

  it('holiday: required 0 and all work is extra', () => {
    const m = run({ isHoliday: true, sessions: [session('09:00', '12:00')] });
    expect(m.requiredMinutes).toBe(0);
    expect(m.extraMinutes).toBe(180);
    expect(m.isLate).toBe(false);
    expect(m.scheduled.isWorkday).toBe(false);
    expect(run({ isHoliday: true }).status).toBe('NOT_SCHEDULED');
  });

  it('non-workday: required 0, extra hours, NOT_SCHEDULED without work', () => {
    const off = fixed({ isWorkday: false, startMinute: null, endMinute: null, requiredMinutes: 0 });
    expect(run({ schedule: off }).status).toBe('NOT_SCHEDULED');
    const m = run({ schedule: off, sessions: [session('10:00', '12:00')] });
    expect(m.requiredMinutes).toBe(0);
    expect(m.extraMinutes).toBe(120);
    expect(m.missingMinutes).toBe(0);
  });

  it('ABSENT only after start + grace or once the day has passed', () => {
    expect(run({ now: at('08:05') }).status).toBe('NOT_STARTED');
    expect(run({ now: at('08:10') }).status).toBe('ABSENT');
    const past = run({ now: at('07:00', '2026-10-16') });
    expect(past.status).toBe('ABSENT');
    expect(past.missingMinutes).toBe(480);
    expect(run({ now: at('07:00') }).missingMinutes).toBe(0);
  });

  it('leave hooks: onLeave and partial leave minutes', () => {
    const leave = run({ onLeave: true });
    expect(leave.status).toBe('ON_LEAVE');
    expect(leave.requiredMinutes).toBe(0);
    expect(run({ leaveMinutes: 120, sessions: [session('08:00', '14:00')] }).missingMinutes).toBe(0);
  });

  it('sumPeriod aggregates days', () => {
    const a = run({ sessions: [session('08:00', '17:00')] });
    const b = run({ sessions: [session('08:00', '15:00')] });
    expect(sumPeriod([a, b])).toEqual({ netWorkMinutes: 960, requiredMinutes: 960, extraMinutes: 60 });
  });
});

describe('computeDayMetrics - partial-day leave windows', () => {
  const leave = (from: string, to: string) => ({ startAt: at(from), endAt: at(to) });

  it('hourly leave at the shift start moves the due time to its end', () => {
    const m = run({ sessions: [session('10:02', '16:00')], leaveMinutes: 120, leaveWindows: [leave('08:00', '10:00')] });
    expect(m.lateMinutes).toBe(0);
    expect(m.isLate).toBe(false);
    expect(m.requiredMinutes).toBe(360);
    const late = run({ sessions: [session('10:30', '16:00')], leaveMinutes: 120, leaveWindows: [leave('08:00', '10:00')] });
    expect(late.lateMinutes).toBe(20); // from 10:00 + 10 grace
  });

  it('hourly leave in the middle of the day leaves lateness unchanged', () => {
    const m = run({ sessions: [session('08:25', '16:00')], leaveMinutes: 60, leaveWindows: [leave('12:00', '13:00')] });
    expect(m.lateMinutes).toBe(15);
    expect(m.earlyDepartureMinutes).toBe(0);
  });

  it('a morning half day makes the employee due at the start of the second half', () => {
    const m = run({ sessions: [session('12:05', '16:00')], leaveMinutes: 240, leaveWindows: [leave('08:00', '12:00')] });
    expect(m.lateMinutes).toBe(0);
    expect(run({ sessions: [session('12:30', '16:00')], leaveMinutes: 240, leaveWindows: [leave('08:00', '12:00')] }).lateMinutes).toBe(20);
    // not ABSENT at 09:00 while on the morning half
    expect(run({ now: at('09:00'), leaveMinutes: 240, leaveWindows: [leave('08:00', '12:00')] }).status).toBe('NOT_STARTED');
  });

  it('an afternoon half day measures early departure from the end of the first half', () => {
    const ok = run({ sessions: [session('08:00', '12:00')], leaveMinutes: 240, leaveWindows: [leave('12:00', '16:00')] });
    expect(ok.earlyDepartureMinutes).toBe(0);
    expect(ok.missingMinutes).toBe(0);
    const early = run({ sessions: [session('08:00', '11:00')], leaveMinutes: 240, leaveWindows: [leave('12:00', '16:00')] });
    expect(early.earlyDepartureMinutes).toBe(50); // 12:00 − 10 grace − 11:00
  });

  it('flexible core window: leave covering its start or middle is not late or missing', () => {
    const sched = flexible({ coreStartMinute: 10 * 60, coreEndMinute: 15 * 60 });
    const m = run({
      schedule: sched, sessions: [session('11:00', '13:00'), session('14:00', '18:00')],
      leaveMinutes: 120, leaveWindows: [leave('10:00', '11:00'), leave('13:00', '14:00')],
    });
    expect(m.lateMinutes).toBe(0);
    expect(m.missingCoreMinutes).toBe(0);
  });

  it('leave covering the whole shift shows the day as on leave, not late', () => {
    const m = run({ now: at('20:00'), leaveMinutes: 480, leaveWindows: [leave('08:00', '12:00'), leave('12:00', '16:00')] });
    expect(m.status).toBe('ON_LEAVE');
    expect(m.lateMinutes).toBe(0);
  });
});

import {
  accrualMode, carryoverMinutes, computeLeaveSpan, monthlyAccruals, summarizeLedger, tracksBalance, yearlyAccrual, type LeaveDayRule,
} from './leave-math';

const DAY = 480;

describe('summarizeLedger', () => {
  it('splits a year of ledger rows by kind', () => {
    const s = summarizeLedger([
      { kind: 'ACCRUAL', minutes: 14 * DAY },
      { kind: 'CARRYOVER', minutes: 2 * DAY },
      { kind: 'ADJUSTMENT', minutes: -DAY },
      { kind: 'USAGE', minutes: -3 * DAY },
      { kind: 'USAGE', minutes: -DAY },
      { kind: 'CANCELLATION', minutes: DAY },
    ]);
    expect(s).toEqual({ accrued: 14 * DAY, carriedOver: 2 * DAY, adjusted: -DAY, used: 3 * DAY, balance: 12 * DAY });
  });

  it('is all zeros for an empty ledger', () => {
    expect(summarizeLedger([])).toEqual({ accrued: 0, carriedOver: 0, adjusted: 0, used: 0, balance: 0 });
  });
});

describe('tracksBalance / accrualMode', () => {
  it('tracks types with an accrual or an entitlement', () => {
    expect(tracksBalance({ accrual: 'YEARLY', annualEntitlementMinutes: 0 })).toBe(true);
    expect(tracksBalance({ accrual: 'NONE', annualEntitlementMinutes: 480 })).toBe(true);
    expect(tracksBalance({ accrual: 'NONE', annualEntitlementMinutes: 0 })).toBe(false);
  });
  it('treats NONE with an entitlement as a yearly grant', () => {
    expect(accrualMode({ accrual: 'NONE', annualEntitlementMinutes: 480 })).toBe('YEARLY');
    expect(accrualMode({ accrual: 'MONTHLY', annualEntitlementMinutes: 480 })).toBe('MONTHLY');
    expect(accrualMode({ accrual: 'NONE', annualEntitlementMinutes: 0 })).toBe('NONE');
  });
});

describe('yearlyAccrual', () => {
  const E = 14 * DAY; // 6720

  it('grants the full entitlement without a hire date or after the hire year', () => {
    expect(yearlyAccrual(E, 2026, null)).toBe(E);
    expect(yearlyAccrual(E, 2026, '2024-07-01')).toBe(E);
  });

  it('prorates the hire year by the remaining days (inclusive), rounding down', () => {
    expect(yearlyAccrual(E, 2026, '2026-01-01')).toBe(E);
    // 2026-07-02 is day 183 of 365 -> 183 days remain.
    expect(yearlyAccrual(E, 2026, '2026-07-02')).toBe(Math.floor((E * 183) / 365));
    expect(yearlyAccrual(E, 2026, '2026-12-31')).toBe(Math.floor(E / 365));
  });

  it('uses 366 days in leap years', () => {
    // 2028-03-01 is day 61 of 366 -> 306 remain.
    expect(yearlyAccrual(E, 2028, '2028-03-01')).toBe(Math.floor((E * 306) / 366));
  });

  it('grants nothing before the hire year or for zero entitlement', () => {
    expect(yearlyAccrual(E, 2025, '2026-03-01')).toBe(0);
    expect(yearlyAccrual(0, 2026, null)).toBe(0);
  });
});

describe('monthlyAccruals', () => {
  it('spreads the entitlement so twelve months add up exactly', () => {
    const rows = monthlyAccruals(1000, 2026, null, 12);
    expect(rows).toHaveLength(12);
    expect(rows.reduce((s, r) => s + r.minutes, 0)).toBe(1000);
    expect(rows[0]).toEqual({ month: '2026-01', minutes: 83 });
    expect(rows.map((r) => r.month)).toContain('2026-12');
  });

  it('stops at the current month', () => {
    const rows = monthlyAccruals(12 * DAY, 2026, null, 10);
    expect(rows.map((r) => r.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(rows.every((r) => r.minutes === DAY)).toBe(true);
  });

  it('starts at the hire month in the hire year and is empty before it', () => {
    expect(monthlyAccruals(12 * DAY, 2026, '2026-09-15', 12).map((r) => r.month)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
    expect(monthlyAccruals(12 * DAY, 2025, '2026-09-15', 12)).toEqual([]);
    expect(monthlyAccruals(12 * DAY, 2027, '2026-09-15', 1)).toEqual([{ month: '2027-01', minutes: DAY }]);
    expect(monthlyAccruals(12 * DAY, 2026, null, 0)).toEqual([]);
  });
});

describe('carryoverMinutes', () => {
  it('carries the unused balance up to the cap and never a deficit', () => {
    expect(carryoverMinutes(3 * DAY, 7 * DAY)).toBe(3 * DAY);
    expect(carryoverMinutes(10 * DAY, 7 * DAY)).toBe(7 * DAY);
    expect(carryoverMinutes(-DAY, 7 * DAY)).toBe(0);
    expect(carryoverMinutes(5 * DAY, 0)).toBe(0);
  });
});

describe('computeLeaveSpan', () => {
  // Sun–Thu 08:00–16:00 (480 min), Fri/Sat off; 2026-11-01 is a Sunday.
  const fixed = (date: string): LeaveDayRule => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const work = weekday <= 4;
    return { isWorkday: work, isHoliday: date === '2026-11-03', requiredMinutes: work ? DAY : 0, startMinute: work ? 480 : null, endMinute: work ? 960 : null };
  };

  it('full days count the required minutes of working days only (weekends and holidays are free)', () => {
    // Sun 1 … Sat 7: Tue 3 is a holiday, Fri/Sat off -> Sun, Mon, Wed, Thu.
    const span = computeLeaveSpan({ mode: 'FULL_DAY', startDate: '2026-11-01', endDate: '2026-11-07' }, fixed);
    expect(span.workdays).toBe(4);
    expect(span.minutes).toBe(4 * DAY);
    expect(span.startAt.toISOString()).toBe('2026-10-31T21:00:00.000Z'); // Amman midnight (UTC+3 all year)
    expect(span.endAt.toISOString()).toBe('2026-11-07T21:00:00.000Z');
  });

  it('rejects a full-day range without working days', () => {
    expect(() => computeLeaveSpan({ mode: 'FULL_DAY', startDate: '2026-11-06', endDate: '2026-11-07' }, fixed)).toThrow(/no working days/);
  });

  it('half days split the scheduled shift', () => {
    const first = computeLeaveSpan({ mode: 'HALF_DAY', startDate: '2026-11-02', endDate: '2026-11-02', half: 'FIRST' }, fixed);
    const second = computeLeaveSpan({ mode: 'HALF_DAY', startDate: '2026-11-02', endDate: '2026-11-02', half: 'SECOND' }, fixed);
    expect(first.minutes + second.minutes).toBe(DAY);
    expect(first.startAt.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // 08:00 local
    expect(first.endAt.toISOString()).toBe('2026-11-02T09:00:00.000Z'); // 12:00 local
    expect(second.startAt).toEqual(first.endAt);
    expect(second.endAt.toISOString()).toBe('2026-11-02T13:00:00.000Z'); // 16:00 local
  });

  it('half days on a flexible day (no fixed start) split the calendar day', () => {
    const flexible = (): LeaveDayRule => ({ isWorkday: true, isHoliday: false, requiredMinutes: 451, startMinute: null, endMinute: null });
    const first = computeLeaveSpan({ mode: 'HALF_DAY', startDate: '2026-11-02', endDate: '2026-11-02', half: 'FIRST' }, flexible);
    const second = computeLeaveSpan({ mode: 'HALF_DAY', startDate: '2026-11-02', endDate: '2026-11-02', half: 'SECOND' }, flexible);
    expect([first.minutes, second.minutes]).toEqual([225, 226]);
    expect(first.endAt.toISOString()).toBe('2026-11-02T09:00:00.000Z'); // local noon
  });

  it('hourly leave uses the local times and is capped by the working day', () => {
    const span = computeLeaveSpan({ mode: 'HOURLY', startDate: '2026-11-02', endDate: '2026-11-02', startTime: '09:30', endTime: '11:00' }, fixed);
    expect(span.minutes).toBe(90);
    expect(span.startAt.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(() => computeLeaveSpan({ mode: 'HOURLY', startDate: '2026-11-02', endDate: '2026-11-02', startTime: '11:00', endTime: '10:00' }, fixed)).toThrow(/after startTime/);
    expect(() => computeLeaveSpan({ mode: 'HOURLY', startDate: '2026-11-02', endDate: '2026-11-02', startTime: '07:00', endTime: '16:30' }, fixed)).toThrow(/cannot exceed/);
    expect(() => computeLeaveSpan({ mode: 'HOURLY', startDate: '2026-11-06', endDate: '2026-11-06', startTime: '09:00', endTime: '10:00' }, fixed)).toThrow(/not a working day/);
  });
});

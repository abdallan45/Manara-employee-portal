import { approvedOvertimeMinutes, compensatedMinutes, multiplierFor, normalizeMultiplier, overtimeKind, retroAllowed } from './overtime-math';

const policy = { regularMultiplier: '1.25', weekendMultiplier: '1.5', holidayMultiplier: '2.00' };

describe('overtime math', () => {
  it('classifies the day: holiday beats weekend beats regular', () => {
    expect(overtimeKind(true, false)).toBe('REGULAR');
    expect(overtimeKind(false, false)).toBe('WEEKEND');
    expect(overtimeKind(true, true)).toBe('HOLIDAY');
    expect(overtimeKind(false, true)).toBe('HOLIDAY');
  });

  it('takes the multiplier from the configured policy', () => {
    expect(multiplierFor(policy, 'REGULAR')).toBe('1.25');
    expect(multiplierFor(policy, 'WEEKEND')).toBe('1.50');
    expect(multiplierFor(policy, 'HOLIDAY')).toBe('2.00');
    // A different policy gives different results: nothing is hard-coded.
    expect(multiplierFor({ regularMultiplier: '1.1', weekendMultiplier: '1.3', holidayMultiplier: '3' }, 'REGULAR')).toBe('1.10');
  });

  it('normalizes and validates multipliers', () => {
    expect(normalizeMultiplier('1')).toBe('1.00');
    expect(normalizeMultiplier(' 1.5 ')).toBe('1.50');
    expect(() => normalizeMultiplier('1.255')).toThrow();
    expect(() => normalizeMultiplier('-1')).toThrow();
    expect(() => normalizeMultiplier('abc')).toThrow();
  });

  it('estimates compensation in exact integer arithmetic, rounding half up', () => {
    expect(compensatedMinutes(60, '1.25')).toBe(75);
    expect(compensatedMinutes(90, '1.50')).toBe(135);
    expect(compensatedMinutes(45, '1.25')).toBe(56); // 56.25
    expect(compensatedMinutes(2, '1.25')).toBe(3); // 2.5 → 3
    expect(compensatedMinutes(7, '1.10')).toBe(8); // 7.7
    expect(compensatedMinutes(0, '2.00')).toBe(0);
    // Floating point would give 1.15 * 100 = 114.99999…; integers do not.
    expect(compensatedMinutes(100, '1.15')).toBe(115);
  });

  it('caps approved minutes at what calc.ts recorded once the day has ended', () => {
    expect(approvedOvertimeMinutes(120, 90)).toBe(90);
    expect(approvedOvertimeMinutes(60, 90)).toBe(60);
    expect(approvedOvertimeMinutes(60, 0)).toBe(0);
    expect(approvedOvertimeMinutes(60, null)).toBe(60); // pre-approval for a day not yet worked
  });

  it('allows retrospective requests unless pre-approval is required and retro approval is off', () => {
    expect(retroAllowed({ requiresPreApproval: true, allowRetroApproval: true })).toBe(true);
    expect(retroAllowed({ requiresPreApproval: false, allowRetroApproval: false })).toBe(true);
    expect(retroAllowed({ requiresPreApproval: true, allowRetroApproval: false })).toBe(false);
  });
});

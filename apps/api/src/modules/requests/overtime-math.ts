// Pure overtime math. Multipliers always come from the configured OvertimePolicy - nothing statutory lives here.
import type { OvertimeKind } from '@workforce/shared';

export interface PolicyMultipliers {
  regularMultiplier: { toString(): string };
  weekendMultiplier: { toString(): string };
  holidayMultiplier: { toString(): string };
}

/** Holiday beats weekend: a holiday on a rest day is still holiday overtime. */
export function overtimeKind(isWorkday: boolean, isHoliday: boolean): OvertimeKind {
  if (isHoliday) return 'HOLIDAY';
  return isWorkday ? 'REGULAR' : 'WEEKEND';
}

export function multiplierFor(policy: PolicyMultipliers, kind: OvertimeKind): string {
  const m = kind === 'HOLIDAY' ? policy.holidayMultiplier : kind === 'WEEKEND' ? policy.weekendMultiplier : policy.regularMultiplier;
  return normalizeMultiplier(m.toString());
}

/** "1.5" -> "1.50"; throws on anything that is not a non-negative decimal with up to 2 places. */
export function normalizeMultiplier(value: string): string {
  const m = value.trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid multiplier: ${value}`);
  return `${Number(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`;
}

/** minutes × multiplier in exact integer arithmetic (hundredths), rounded half up to whole minutes. */
export function compensatedMinutes(minutes: number, multiplier: string): number {
  const [whole, frac] = normalizeMultiplier(multiplier).split('.');
  const hundredths = Number(whole) * 100 + Number(frac);
  return Math.floor((minutes * hundredths + 50) / 100);
}

/**
 * Minutes accepted when an overtime request is approved. For a day that has ended, calc.ts's extra
 * minutes are the ceiling; a day still in the future (pre-approval) is approved as requested.
 */
export function approvedOvertimeMinutes(requested: number, recordedExtra: number | null): number {
  return recordedExtra === null ? requested : Math.min(requested, recordedExtra);
}

/** Retrospective requests are allowed unless the policy demands pre-approval and forbids retro approval. */
export const retroAllowed = (p: { requiresPreApproval: boolean; allowRetroApproval: boolean }) => !p.requiresPreApproval || p.allowRetroApproval;

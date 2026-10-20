'use client';

import type { AttendanceState, DayStatus } from '@workforce/shared';
import { Clock, House } from 'lucide-react';

import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

type Tone = 'working' | 'break' | 'out' | 'absent' | 'missing' | 'none' | 'leave';

const TONE_CLASS: Record<Tone, string> = {
  working: 'text-[color:var(--status-working)] bg-[color:var(--status-working)]/10 border-[color:var(--status-working)]/25',
  break: 'text-[color:var(--status-break)] bg-[color:var(--status-break)]/10 border-[color:var(--status-break)]/25',
  out: 'text-[color:var(--status-out)] bg-[color:var(--status-out)]/10 border-[color:var(--status-out)]/25',
  absent: 'text-[color:var(--status-absent)] bg-[color:var(--status-absent)]/10 border-[color:var(--status-absent)]/25',
  missing: 'text-[color:var(--status-missing)] bg-[color:var(--status-missing)]/10 border-[color:var(--status-missing)]/25',
  none: 'text-[color:var(--status-none)] bg-tint/[0.04] border-tint/10',
  leave: 'text-[color:var(--status-leave)] bg-[color:var(--status-leave)]/10 border-[color:var(--status-leave)]/25',
};

const DAY_TONE: Record<DayStatus, Tone> = {
  WORKING: 'working',
  ON_BREAK: 'break',
  CHECKED_OUT: 'out',
  ABSENT: 'absent',
  NOT_SCHEDULED: 'none',
  ON_LEAVE: 'leave',
  MISSING_PUNCH: 'missing',
  PENDING_REVIEW: 'missing',
  NOT_STARTED: 'none',
};

const STATE_TONE: Record<AttendanceState, Tone> = { OFF: 'none', WORKING: 'working', ON_BREAK: 'break' };

/** The dot only pulses when a caller passes `pulse` explicitly, and never under prefers-reduced-motion. */
function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative flex size-2" aria-hidden>
      {pulse && <span className="absolute inline-flex size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />}
      <span className={cn('relative inline-flex size-2 rounded-full bg-current', tone === 'none' && 'opacity-60')} />
    </span>
  );
}

const base = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap';

/** Day status; `remote` (DayMetrics.remote) adds the Remote badge next to it. */
export function DayStatusBadge({ status, remote, pulse, className }: { status: DayStatus; remote?: boolean; pulse?: boolean; className?: string }) {
  const { t } = useI18n();
  const tone = DAY_TONE[status];
  const badge = (
    <span className={cn(base, TONE_CLASS[tone], !remote && className)}>
      <Dot tone={tone} pulse={pulse} />
      {t.dayStatus[status]}
    </span>
  );
  if (!remote) return badge;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {badge}
      <RemoteBadge />
    </span>
  );
}

/** Working day covered by approved remote work. */
export function RemoteBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn(base, 'border-[color:var(--brand-soft)]/30 bg-[color:var(--brand-soft)]/10 text-[color:var(--brand-soft)]', className)}>
      <House aria-hidden className="size-3" />
      {t.dayStatus.REMOTE}
    </span>
  );
}

export function StateBadge({ state, pulse, className }: { state: AttendanceState; pulse?: boolean; className?: string }) {
  const { t } = useI18n();
  const tone = STATE_TONE[state];
  return (
    <span className={cn(base, TONE_CLASS[tone], className)}>
      <Dot tone={tone} pulse={pulse} />
      {t.state[state]}
    </span>
  );
}

/** "Late 12 min" / "متأخر 12 د" (plain "Late" when the minutes are unknown or zero). */
export function LateBadge({ minutes, className }: { minutes?: number; className?: string }) {
  const { t } = useI18n();
  const known = minutes !== undefined && minutes > 0;
  const [before = '', after = ''] = t.uiFoundation.lateMinutes.split('{n}');
  return (
    <span className={cn(base, 'border-[color:var(--brand-red)]/30 bg-[color:var(--brand-red)]/10 text-[color:var(--status-late)]', className)}>
      <Clock aria-hidden className="size-3" />
      {known ? (
        <span>
          {before}
          <bdi className="tabular">{Math.round(minutes ?? 0)}</bdi>
          {after}
        </span>
      ) : (
        t.dayStatus.LATE
      )}
    </span>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useI18n();
  const tone: Tone = active ? 'working' : 'none';
  return (
    <span className={cn(base, TONE_CLASS[tone])}>
      <Dot tone={tone} />
      {active ? t.common.active : t.common.inactive}
    </span>
  );
}

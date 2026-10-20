'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';

import { Minutes } from '@/components/duration';
import { formatMinutes } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * One figure with a label. With `href` the whole card is a link to the filtered list behind the number
 * ("Absent: 3, show list"). Durations go in `minutes` and render through <Minutes> (correct order in
 * Arabic); plain numbers and percentages go in `value`.
 */
export function KpiCard({ label, value, minutes, hint, icon: Icon, accent, href, className }: {
  label: string;
  /** Pre-formatted figure, e.g. "12" or "87.5%". Ignored when `minutes` is set. */
  value?: string;
  /** A duration in minutes, rendered as "7h 35m" / "7 س 35 د". */
  minutes?: number;
  hint?: string;
  icon?: LucideIcon;
  /** CSS colour for the icon chip, e.g. "var(--status-working)". */
  accent?: string;
  /** Makes the card a link to the list behind the number. */
  href?: string;
  className?: string;
}) {
  const { t, units } = useI18n();
  const text = minutes !== undefined ? formatMinutes(minutes, units) : (value ?? '—');
  const chip = accent ?? 'var(--brand-soft)';

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground line-clamp-2 text-xs font-medium">{label}</span>
        {Icon && (
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-xl"
            style={{ color: chip, background: `color-mix(in srgb, ${chip} 12%, transparent)` }}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <div className="num truncate text-2xl font-bold">
        {minutes !== undefined ? <Minutes value={minutes} dimZero={false} /> : <bdi>{text}</bdi>}
      </div>
      {hint && <span className="text-muted-foreground line-clamp-2 text-xs">{hint}</span>}
    </>
  );

  const base = 'bg-card/80 flex min-w-0 flex-col gap-3 rounded-2xl border border-tint/[0.06] p-4 backdrop-blur';

  if (href) {
    return (
      <Link
        href={href}
        aria-label={fmt(t.navFindability.kpiShowList, { label, value: text })}
        className={cn(base, 'transition-colors hover:border-tint/20 hover:bg-tint/[0.05]', className)}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}

/**
 * "Needs attention" tile on the dashboard: a count of open work that links to the list where it is
 * handled, e.g. "3 · Leave requests waiting · Review".
 */
export function AttentionTile({ label, value, icon: Icon, accent, href, action, className }: {
  label: string;
  /** The figure; use <Minutes> for durations. */
  value: ReactNode;
  icon: LucideIcon;
  accent: string;
  /** Where the work is handled; without it the tile is informational only. */
  href?: string;
  /** Visible call to action, e.g. "Review". */
  action: string;
  className?: string;
}) {
  const classes = cn('group bg-card/80 flex min-w-0 items-center gap-3 rounded-2xl border p-4 backdrop-blur transition-colors', href && 'hover:bg-tint/[0.05]', className);
  const style = { borderColor: `color-mix(in srgb, ${accent} 28%, transparent)` };
  const body = (
    <>
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-xl"
        style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="num text-xl leading-tight font-bold">{value}</span>
        <span className="text-muted-foreground line-clamp-2 text-xs font-medium">{label}</span>
      </span>
      {href && (
        <span className="text-link flex shrink-0 items-center gap-1 text-xs font-semibold group-hover:underline">
          {action}
          <ChevronRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={classes} style={style}>
      {body}
    </Link>
  ) : (
    <div className={classes} style={style}>
      {body}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { Hourglass } from 'lucide-react';
import type { OvertimeCandidateDto } from '@workforce/shared';

import { Minutes } from '@/components/duration';
import { AttentionTile } from '@/components/kpi-card';
import { Button } from '@/components/ui/button';
import { addDays, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi, type UseApiOptions } from '@/lib/use-api';

export interface UnapprovedOvertime {
  /** True once the candidates loaded or failed. */
  settled: boolean;
  /** True once the candidates loaded (always true when disabled), so `days` is a real count. */
  loaded: boolean;
  /** The candidates could not be loaded and nothing is shown: `days` is 0 only because it is unknown. */
  failed: boolean;
  /** A load the user is waiting for is running (first load or refetch). */
  busy: boolean;
  /** Days with extra time that nobody approved or requested yet. */
  days: number;
  minutes: number;
  /** The Overtime approval list filtered to exactly these days. */
  href: string;
  /** Reload the candidates (no-op when disabled). */
  refetch: () => Promise<void>;
}

/** /admin/overtime filtered to the same window and state the callout counts (the overtime page reads these). */
export function unapprovedOvertimeHref(today = todayInAmman()): string {
  const qs = new URLSearchParams({ from: addDays(today, -30), to: addDays(today, -1), state: 'open' });
  return `/admin/overtime?${qs.toString()}`;
}

/**
 * Extra time in the last 30 days (up to yesterday) that the viewer could approve and nobody requested yet.
 * `options` adds background refreshes (poll / refetch on focus), as for the other dashboard tiles.
 */
export function useUnapprovedOvertime(enabled = true, options?: UseApiOptions): UnapprovedOvertime {
  const today = todayInAmman();
  const list = useApi<OvertimeCandidateDto[]>(enabled ? '/overtime/candidates' : null, { from: addDays(today, -30), to: addDays(today, -1) }, options);
  const open = (list.data ?? []).filter((c) => c.canApprove && !c.request);
  return {
    settled: !enabled || list.data !== undefined || list.error !== undefined,
    loaded: !enabled || list.data !== undefined,
    failed: enabled && list.data === undefined && list.error !== undefined,
    busy: enabled && (list.loading || list.refreshing),
    days: open.length,
    minutes: open.reduce((s, c) => s + c.extraMinutes, 0),
    href: unapprovedOvertimeHref(today),
    refetch: list.refetch,
  };
}

/**
 * Dashboard notice for unapproved extra time. `banner` (default) is the full-width callout; `tile` is a
 * "Needs attention" tile. Pass `summary` when the page already loaded it; renders nothing at zero.
 */
export function OvertimeCallout({ variant = 'banner', summary }: { variant?: 'banner' | 'tile'; summary?: UnapprovedOvertime }) {
  const { t } = useI18n();
  const o = t.overtimeAdmin;
  const own = useUnapprovedOvertime(summary === undefined);
  const data = summary ?? own;
  if (!data.days) return null;

  if (variant === 'tile') {
    return (
      <AttentionTile
        label={`${o.dashboardCard} · ${fmt(o.dashboardHint, { n: data.days })}`}
        value={<Minutes value={data.minutes} dimZero={false} />}
        icon={Hourglass}
        accent="var(--brand-soft)"
        href={data.href}
        action={o.dashboardAction}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[color:var(--brand-soft)]/20 bg-tint/[0.03] p-4">
      <span className="flex size-10 items-center justify-center rounded-xl bg-[color:var(--brand-soft)]/10 text-[color:var(--brand-soft)]">
        <Hourglass className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {o.dashboardCard}: <Minutes value={data.minutes} dimZero={false} />
        </p>
        <p className="text-muted-foreground text-sm">{fmt(o.dashboardHint, { n: data.days })}</p>
      </div>
      <Button asChild>
        <Link href={data.href}>{o.dashboardAction}</Link>
      </Button>
    </div>
  );
}

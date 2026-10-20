'use client';

import type { ReactNode } from 'react';
import { Moon } from 'lucide-react';
import type { DayMetrics } from '@workforce/shared';

import { DataTable, type Column } from '@/components/data-table';
import { Minutes, TimeRange } from '@/components/duration';
import { DayStatusBadge, LateBadge } from '@/components/status-badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { formatTime, formatWeekday, formatWorkDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

function sum(days: DayMetrics[], pick: (d: DayMetrics) => number): number {
  return days.reduce((acc, d) => acc + pick(d), 0);
}

/** Muted "Day off" / "يوم عطلة" badge for days that are not scheduled workdays. */
export function DayOffBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1 rounded-full border border-tint/10 bg-tint/[0.04] px-2 py-0.5 text-xs font-medium whitespace-nowrap', className)}>
      <Moon className="size-3" aria-hidden />
      {t.employeeSelfService.dayOff}
    </span>
  );
}

/** Single clock time, isolated so it never reorders inside RTL text. */
function Clock({ value }: { value: string | null }) {
  const { locale } = useI18n();
  return <bdi className="tabular">{formatTime(value, locale)}</bdi>;
}

/** Columns of `columnSet="essential"`: what employees need to read their own day. */
const ESSENTIAL = new Set(['date', 'firstIn', 'lastOut', 'net', 'late', 'status']);

/**
 * Daily breakdown with a totals row; renders as cards on small screens.
 *
 * - `columnSet`: 'full' (default) shows every figure; 'essential' shows Date, In, Out, Hours worked, Late, Status.
 * - `compact`: the older drawer subset (kept for compatibility).
 * - `onRowClick`: opens something for the day (the date cell becomes a button; the mobile card is the tap target).
 *   No aria-label is set on them: the visible date (and on phones the whole card, with In, Out, Hours worked
 *   and the status) is their accessible name, so screen-reader users hear the figures without opening the day.
 * - `rowAction`: a trailing cell per row (e.g. "Fix"); on phones it sits next to the card, outside its tap target.
 */
export function DayMetricsTable({ days, loading, error, onRetry, compact = false, columnSet = 'full', rowAction, onRowClick, emptyTitle, emptyDescription }: {
  days: DayMetrics[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Fewer columns (used inside the employee drawer). */
  compact?: boolean;
  columnSet?: 'full' | 'essential';
  rowAction?: (day: DayMetrics) => ReactNode;
  onRowClick?: (day: DayMetrics) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t, locale } = useI18n();
  const c = t.myAttendance.cols;
  const s = t.employeeSelfService;
  const essential = columnSet === 'essential';

  const scheduled = (d: DayMetrics): ReactNode => {
    if (!d.scheduled.isWorkday) return t.myAttendance.off;
    if (d.scheduled.type === 'FLEXIBLE') return t.scheduleType.FLEXIBLE;
    return <TimeRange start={d.scheduled.start} end={d.scheduled.end} />;
  };

  const status = (d: DayMetrics) => {
    const off = !d.scheduled.isWorkday;
    // A plain day off says so once; a day off with work on it shows both.
    if (off && d.status === 'NOT_SCHEDULED') return <DayOffBadge />;
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <DayStatusBadge status={d.status} remote={d.remote} />
        {off && <DayOffBadge />}
      </span>
    );
  };

  const all: (Column<DayMetrics> & { compact?: boolean })[] = [
    {
      id: 'date',
      header: c.date,
      compact: true,
      cell: (d) =>
        essential ? (
          <span className="whitespace-nowrap">
            <span className="text-muted-foreground">{formatWeekday(d.workDate, locale)}</span>{' '}
            <span className="tabular">{formatWorkDate(d.workDate, locale)}</span>
          </span>
        ) : (
          <span className="tabular whitespace-nowrap">{formatWorkDate(d.workDate, locale)}</span>
        ),
    },
    { id: 'day', header: c.day, compact: true, cell: (d) => <span className="text-muted-foreground">{formatWeekday(d.workDate, locale)}</span> },
    { id: 'scheduled', header: c.scheduled, cell: (d) => <span className="text-muted-foreground">{scheduled(d)}</span> },
    { id: 'firstIn', header: c.firstIn, compact: true, cell: (d) => <Clock value={d.firstIn} /> },
    { id: 'lastOut', header: c.lastOut, compact: true, cell: (d) => <Clock value={d.lastOut} /> },
    { id: 'presence', header: c.presence, cell: (d) => <Minutes value={d.presenceMinutes} /> },
    { id: 'paid', header: c.paidBreaks, cell: (d) => <Minutes value={d.paidBreakMinutes} /> },
    { id: 'unpaid', header: c.unpaidBreaks, cell: (d) => <Minutes value={d.unpaidBreakMinutes} /> },
    { id: 'net', header: s.hoursWorked, compact: true, cell: (d) => <Minutes value={d.netWorkMinutes} className="font-semibold" /> },
    { id: 'required', header: c.required, cell: (d) => <Minutes value={d.requiredMinutes} /> },
    { id: 'missing', header: c.missing, cell: (d) => <Minutes value={d.missingMinutes} className={d.missingMinutes > 0 ? 'text-[color:var(--status-missing)]' : undefined} /> },
    { id: 'late', header: c.late, compact: true, cell: (d) => (d.isLate ? <LateBadge minutes={d.lateMinutes} /> : <Minutes value={0} />) },
    { id: 'extra', header: c.extra, cell: (d) => <Minutes value={d.extraMinutes} className={d.extraMinutes > 0 ? 'text-[color:var(--status-working)]' : undefined} /> },
    { id: 'status', header: c.status, compact: true, cell: status },
  ];
  const base = essential ? all.filter((col) => ESSENTIAL.has(col.id)) : compact ? all.filter((col) => col.compact) : all;
  const columns: Column<DayMetrics>[] = rowAction
    ? [...base, { id: 'actions', header: t.common.actions, srOnlyHeader: true, className: 'w-px text-end whitespace-nowrap', cell: (d) => rowAction(d) }]
    : base;

  const totals: Record<string, number> | null =
    days && days.length > 0
      ? {
          presence: sum(days, (d) => d.presenceMinutes),
          paid: sum(days, (d) => d.paidBreakMinutes),
          unpaid: sum(days, (d) => d.unpaidBreakMinutes),
          net: sum(days, (d) => d.netWorkMinutes),
          required: sum(days, (d) => d.requiredMinutes),
          missing: sum(days, (d) => d.missingMinutes),
          late: sum(days, (d) => d.lateMinutes),
          extra: sum(days, (d) => d.extraMinutes),
        }
      : null;

  const footer = totals ? (
    <TableRow className="hover:bg-transparent">
      {columns.map((col, i) => (
        <TableCell key={col.id}>{i === 0 ? t.myAttendance.totals : col.id in totals ? <Minutes value={totals[col.id]} dimZero={false} /> : null}</TableCell>
      ))}
    </TableRow>
  ) : undefined;

  return (
    <DataTable
      rows={days}
      columns={columns}
      rowKey={(d) => d.workDate}
      loading={loading}
      error={error}
      onRetry={onRetry}
      emptyTitle={emptyTitle ?? t.myAttendance.empty}
      emptyDescription={emptyDescription}
      footer={footer}
      onRowClick={onRowClick}
      rowClassName={(d) => (!d.scheduled.isWorkday ? 'bg-tint/[0.015] text-muted-foreground' : undefined)}
      mobileActions={rowAction}
      mobileCard={(d) => (
        <div className={cn('space-y-2', !d.scheduled.isWorkday && 'text-muted-foreground')}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-foreground truncate text-sm font-medium">
                {formatWeekday(d.workDate, locale, 'long')} · <span className="tabular">{formatWorkDate(d.workDate, locale)}</span>
              </p>
              <p className="text-muted-foreground text-xs">{scheduled(d)}</p>
            </div>
            {status(d)}
          </div>
          <dl className="grid grid-cols-4 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">{c.firstIn}</dt>
              <dd>
                <Clock value={d.firstIn} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{c.lastOut}</dt>
              <dd>
                <Clock value={d.lastOut} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{s.hoursWorked}</dt>
              <dd className="font-semibold">
                <Minutes value={d.netWorkMinutes} />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{d.extraMinutes > 0 ? c.extra : c.missing}</dt>
              <dd>
                <Minutes value={d.extraMinutes > 0 ? d.extraMinutes : d.missingMinutes} />
              </dd>
            </div>
          </dl>
          {d.isLate && <LateBadge minutes={d.lateMinutes} />}
        </div>
      )}
    />
  );
}

export { sum as sumMetrics };

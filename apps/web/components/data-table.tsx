'use client';

import { useCallback, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type Ref } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';

import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatTime, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

export type SortOrder = 'asc' | 'desc';
export interface SortState<S extends string> {
  key: S;
  order: SortOrder;
}

export interface Column<T, S extends string = string> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortKey?: S;
  className?: string;
  /** Plain header text is used for aria; set to hide the header visually (e.g. action columns). */
  srOnlyHeader?: boolean;
}

export interface DataTableSelection<T> {
  /** Selected row keys (rowKey values); may include rows on other pages. */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Rows that cannot be selected get no checkbox (default: all rows are selectable). */
  isSelectable?: (row: T) => boolean;
}

export interface DataTableProps<T, S extends string = string> {
  rows: T[] | undefined;
  columns: Column<T, S>[];
  rowKey: (row: T) => string;
  /** First load or a user-triggered reload: shows skeletons (no rows yet) or dims the table. */
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle: string;
  emptyDescription?: string;
  sort?: SortState<S>;
  onSortChange?: (key: S) => void;
  /**
   * Action for a row (e.g. open a sheet). Clicking anywhere on the row is a mouse-only convenience; the
   * primary cell becomes a real <button> for keyboard and screen-reader users. Prefer `rowHref` for navigation.
   */
  onRowClick?: (row: T) => void;
  /** Accessible name of the primary-cell button / mobile card button (onRowClick without rowHref) and the row checkbox. */
  rowLabel?: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  /** Rendered instead of the table below the md breakpoint. */
  mobileCard?: (row: T) => ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Adds a checkbox column (header "Select all" with a mixed state) and a checkbox on mobile cards. */
  selection?: DataTableSelection<T>;
  /** Destination of a row: the primary cell wraps its content in a real <Link>, the mobile card becomes a link, and a mouse click on the row navigates. */
  rowHref?: (row: T) => string;
  /**
   * Column whose cell holds the row link / button. Defaults to the first column without `srOnlyHeader`.
   * That cell must not contain other links or buttons.
   */
  primaryColumnId?: string;
  /** Row actions on mobile cards, rendered next to (outside) the card's tap target. */
  mobileActions?: (row: T) => ReactNode;
  /** A background refresh failed: shows "Couldn't refresh. Showing data from {time}." with Retry. */
  stale?: { since: Date; onRetry: () => void };
  /** Total matching rows (all pages), announced politely as "{n} results" when it changes. */
  resultCount?: number;
}

/** Clicks on these never trigger the row's mouse convenience (they have their own action). */
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="checkbox"], [role="switch"], [role="menuitem"], [role="combobox"], [data-no-row-click]';

function StaleBanner({ since, onRetry, rootRef }: { since: Date; onRetry: () => void; rootRef?: Ref<HTMLDivElement> }) {
  const { t, locale } = useI18n();
  const u = t.uiFoundation;
  const sameDay = todayInAmman(since.getTime()) === todayInAmman();
  const time = sameDay ? formatTime(since, locale) : formatDateTime(since.toISOString(), locale);
  return (
    <div ref={rootRef} className="mx-3 my-2 flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--status-missing)]/40 bg-[color:var(--status-missing)]/10 px-3 py-2 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />
      <span className="min-w-0 flex-1">
        {u.staleBanner.split('{time}')[0]}
        <bdi className="tabular">{time}</bdi>
        {u.staleBanner.split('{time}')[1] ?? ''}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} className="max-md:min-h-10">
        <RotateCw aria-hidden />
        {u.retry}
      </Button>
    </div>
  );
}

export function DataTable<T, S extends string = string>({
  rows,
  columns,
  rowKey,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyDescription,
  sort,
  onSortChange,
  onRowClick,
  rowLabel,
  rowClassName,
  mobileCard,
  footer,
  className,
  selection,
  rowHref,
  primaryColumnId,
  mobileActions,
  stale,
  resultCount,
}: DataTableProps<T, S>) {
  const { t } = useI18n();
  const u = t.uiFoundation;
  const router = useRouter();

  // Retry removes the banner (and the focused button) once the refresh succeeds. React detaches the ref
  // before it removes the node, so the cleanup sees whether focus was inside; focus then moves to the
  // persistent status region at the same place, so the next Tab continues into the table.
  const statusRef = useRef<HTMLDivElement>(null);
  const bannerHadFocus = useRef(false);
  const bannerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    bannerHadFocus.current = false;
    return () => {
      bannerHadFocus.current = node.contains(document.activeElement);
    };
  }, []);
  useLayoutEffect(() => {
    if (!bannerHadFocus.current) return;
    bannerHadFocus.current = false;
    statusRef.current?.focus({ preventScroll: true });
  });

  // Live regions stay mounted across loading / empty / table states so changes are announced. The status
  // region also holds the table's place for focus (data-focus-anchor, lib/focus-fallback): a dialog opened
  // from the last remaining row returns focus here once that row is deleted.
  const live = (
    <>
      {resultCount !== undefined && (
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {loading ? '' : fmt(u.resultCount, { n: resultCount })}
        </p>
      )}
      <div ref={statusRef} role="status" tabIndex={-1} data-focus-anchor className={cn('outline-none', !stale && 'sr-only')}>
        {stale && rows && rows.length > 0 && <StaleBanner since={stale.since} onRetry={stale.onRetry} rootRef={bannerRef} />}
      </div>
    </>
  );

  // Same wrapper element in every state, so the live regions above keep their DOM node between states.
  if (error && !rows) return <div className="relative">{live}<ErrorState error={error} onRetry={onRetry} /></div>;
  // Skeletons, not "nothing here", while the first load (or a reload of an empty list) runs.
  if (loading && (!rows || rows.length === 0)) return <div className="relative">{live}<LoadingRows /></div>;
  if (!rows || rows.length === 0) {
    return (
      <div className="relative">
        {live}
        {error ? <ErrorState error={error} onRetry={onRetry} /> : <EmptyState title={emptyTitle} description={emptyDescription} />}
      </div>
    );
  }

  // The primary cell is the keyboard / screen-reader path: a real link (rowHref) or button (onRowClick).
  const primaryId = rowHref || onRowClick ? (primaryColumnId ?? columns.find((c) => !c.srOnlyHeader)?.id) : undefined;
  const rowAction: ((row: T) => void) | undefined = onRowClick ?? (rowHref ? (row: T) => router.push(rowHref(row)) : undefined);

  const onRowMouseClick = (event: MouseEvent<HTMLTableRowElement>, row: T) => {
    if (!rowAction) return;
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE)) return;
    // Don't hijack text selection.
    if (typeof window !== 'undefined' && (window.getSelection()?.toString() ?? '') !== '') return;
    if (rowHref && (event.metaKey || event.ctrlKey)) {
      window.open(rowHref(row), '_blank', 'noopener');
      return;
    }
    rowAction(row);
  };

  const selectable = selection ? rows.filter((r) => selection.isSelectable?.(r) ?? true) : [];
  const selectedVisible = selection ? selectable.filter((r) => selection.selected.has(rowKey(r))).length : 0;
  const headerState: boolean | 'indeterminate' =
    selectable.length > 0 && selectedVisible === selectable.length ? true : selectedVisible > 0 ? 'indeterminate' : false;

  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (headerState === true) selectable.forEach((r) => next.delete(rowKey(r)));
    else selectable.forEach((r) => next.add(rowKey(r)));
    selection.onChange(next);
  };
  const toggleRow = (row: T, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (on) next.add(rowKey(row));
    else next.delete(rowKey(row));
    selection.onChange(next);
  };
  const rowCheckbox = (row: T, mobile: boolean) => {
    if (!selection || !(selection.isSelectable?.(row) ?? true)) return null;
    const label = rowLabel?.(row);
    return (
      <Checkbox
        checked={selection.selected.has(rowKey(row))}
        onCheckedChange={(c) => toggleRow(row, c === true)}
        aria-label={label ? fmt(u.selectRow, { name: label }) : u.selectRowFallback}
        // Invisible padding makes the hit area 40px on phones and 36px in the table.
        className={cn("relative after:absolute after:content-['']", mobile ? 'after:-inset-2.5' : 'after:-inset-2')}
      />
    );
  };

  return (
    <div className={cn('relative transition-opacity', loading && 'opacity-60', className)} aria-busy={loading || undefined}>
      {live}
      {mobileCard && (
        <ul className="divide-y divide-tint/[0.06] md:hidden">
          {rows.map((row) => {
            const key = rowKey(row);
            const href = rowHref?.(row);
            const checkbox = rowCheckbox(row, true);
            const actions = mobileActions?.(row);
            const card = href ? (
              <Link href={href} className="block min-w-0 flex-1 rounded-lg px-4 py-3 hover:bg-tint/[0.03] focus-visible:-outline-offset-2">
                {mobileCard(row)}
              </Link>
            ) : onRowClick ? (
              <button
                type="button"
                className="block w-full min-w-0 flex-1 rounded-lg px-4 py-3 text-start hover:bg-tint/[0.03] focus-visible:-outline-offset-2"
                onClick={() => onRowClick(row)}
                aria-label={rowLabel?.(row)}
              >
                {mobileCard(row)}
              </button>
            ) : (
              <div className="min-w-0 flex-1 px-4 py-3">{mobileCard(row)}</div>
            );
            return (
              <li key={key} className={cn('flex items-center', selection?.selected.has(key) && 'bg-tint/[0.04]')}>
                {checkbox && <div className="flex shrink-0 items-center ps-4">{checkbox}</div>}
                {card}
                {actions && <div className="flex shrink-0 items-center gap-1 pe-3">{actions}</div>}
              </li>
            );
          })}
        </ul>
      )}
      <div className={cn(mobileCard && 'hidden md:block')}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selection && (
                <TableHead className="w-10 ps-4">
                  {selectable.length > 0 && (
                    <Checkbox
                      checked={headerState}
                      onCheckedChange={toggleAll}
                      aria-label={u.selectAll}
                      className="relative after:absolute after:-inset-2 after:content-['']"
                    />
                  )}
                </TableHead>
              )}
              {columns.map((col) => {
                const active = sort && col.sortKey && sort.key === col.sortKey;
                const ariaSort = active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <TableHead key={col.id} className={col.className} aria-sort={ariaSort}>
                    {col.srOnlyHeader ? (
                      <span className="sr-only">{col.header}</span>
                    ) : col.sortKey && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => col.sortKey && onSortChange(col.sortKey)}
                        className={cn(
                          '-mx-1.5 inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 py-1 hover:text-foreground',
                          active && 'text-foreground',
                        )}
                        aria-label={fmt(t.common.sortBy, { column: col.header })}
                      >
                        {col.header}
                        {active ? (
                          sort.order === 'asc' ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowUpDown className="size-3.5 opacity-60" aria-hidden />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const key = rowKey(row);
              const isSelected = selection?.selected.has(key) ?? false;
              return (
                <TableRow
                  key={key}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(rowAction && 'cursor-pointer', isSelected && 'bg-tint/[0.05]', rowClassName?.(row))}
                  onClick={rowAction ? (e) => onRowMouseClick(e, row) : undefined}
                >
                  {selection && <TableCell className="w-10 ps-4">{rowCheckbox(row, false)}</TableCell>}
                  {columns.map((col) => (
                    <TableCell key={col.id} className={col.className}>
                      {col.id === primaryId && rowHref ? (
                        <Link href={rowHref(row)} className="rounded-sm underline-offset-4 decoration-[color:var(--link)] hover:underline">
                          {col.cell(row)}
                        </Link>
                      ) : col.id === primaryId && onRowClick ? (
                        <button
                          type="button"
                          onClick={() => onRowClick(row)}
                          aria-label={rowLabel?.(row)}
                          className="max-w-full rounded-sm text-start underline-offset-4 decoration-[color:var(--link)] hover:underline"
                        >
                          {col.cell(row)}
                        </button>
                      ) : (
                        col.cell(row)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
          {footer && <TableFooter>{footer}</TableFooter>}
        </Table>
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPageChange, className }: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  const { t, dir } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <nav className={cn('flex items-center justify-between gap-3 px-4 py-3 text-sm', className)} aria-label={fmt(t.common.pageOf, { page, pages })}>
      <span className="text-muted-foreground tabular" dir="auto">
        {fmt(t.common.showing, { from, to, total })}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" className="max-md:size-10" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label={t.common.previous}>
          <Prev aria-hidden />
        </Button>
        <span className="text-muted-foreground tabular min-w-16 text-center text-xs">{fmt(t.common.pageOf, { page, pages })}</span>
        <Button variant="outline" size="icon-sm" className="max-md:size-10" onClick={() => onPageChange(page + 1)} disabled={page >= pages} aria-label={t.common.next}>
          <Next aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** Toggle helper: same column flips order, new column starts ascending. */
export function nextSort<S extends string>(current: SortState<S>, key: S): SortState<S> {
  return current.key === key ? { key, order: current.order === 'asc' ? 'desc' : 'asc' } : { key, order: 'asc' };
}

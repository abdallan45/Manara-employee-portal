'use client';

import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * Sticky bar for actions on the rows selected in a DataTable (`selection` prop). Place it right after
 * the table: it sticks above the mobile bottom navigation (bottom-20) and near the viewport bottom on
 * desktop (md:bottom-4). Hidden while nothing is selected; the count is announced politely.
 *
 * When the bar disappears while it has focus ("Clear selection", or a bulk action that clears the
 * selection), focus moves to `returnFocusRef` (e.g. the list heading or a filter) or, by default, stays at
 * the bar's place in the page, so the next Tab continues from there instead of the top of the document.
 */
export function BulkActionBar({ count, onClear, children, className, returnFocusRef }: {
  count: number;
  onClear: () => void;
  /** Action buttons, e.g. <Button size="sm">Approve</Button>. */
  children?: ReactNode;
  className?: string;
  /** Where focus goes when the bar closes while focused; defaults to the bar's own position. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const u = t.uiFoundation;
  const label = fmt(u.selectedCount, { n: count });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hadFocus = useRef(false);

  // React detaches the ref before it removes the node, so this sees whether focus was inside the bar.
  const barRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    hadFocus.current = false;
    return () => {
      hadFocus.current = node.contains(document.activeElement);
    };
  }, []);

  useLayoutEffect(() => {
    if (count > 0 || !hadFocus.current) return;
    hadFocus.current = false;
    const target = returnFocusRef?.current;
    (target?.isConnected ? target : anchorRef.current)?.focus({ preventScroll: true });
  }, [count, returnFocusRef]);

  return (
    <>
      {/* Persistent live region: it exists before the bar appears, so the first count is announced too.
          It doubles as the focus anchor when the bar closes while focused, and data-focus-anchor makes it
          where a dialog opened from the bar returns focus once the bar is gone (lib/focus-fallback). */}
      <span ref={anchorRef} tabIndex={-1} data-focus-anchor className="sr-only" aria-live="polite" aria-atomic="true">
        {count > 0 ? label : ''}
      </span>
      {count > 0 && (
        <div
          ref={barRef}
          role="region"
          aria-label={u.bulkActions}
          className={cn(
            'bg-popover/95 sticky bottom-20 z-20 mx-auto mt-3 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-tint/15 px-3 py-2 shadow-2xl backdrop-blur md:bottom-4 print:hidden',
            className,
          )}
        >
          <span className="tabular px-1 text-sm font-semibold" dir="auto">
            {label}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onClear} className="min-h-10 md:min-h-8">
            <X aria-hidden />
            {u.clearSelection}
          </Button>
          <div className="ms-auto flex flex-wrap items-center gap-2">{children}</div>
        </div>
      )}
    </>
  );
}

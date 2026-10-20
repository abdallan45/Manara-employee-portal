'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Inbox, Lock, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

export function EmptyState({ title, description, icon: Icon = Inbox, action, className }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <div className="flex size-12 items-center justify-center rounded-2xl border border-tint/[0.06] bg-tint/[0.03]">
        <Icon className="text-muted-foreground size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && <p className="text-muted-foreground max-w-sm text-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, className, compact = false }: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const { t, errorMessage } = useI18n();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-2xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10">
        <AlertTriangle className="size-5 text-[color:var(--status-absent)]" aria-hidden />
      </div>
      <p className="max-w-md text-sm">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden />
          {t.common.retry}
        </Button>
      )}
    </div>
  );
}

/**
 * Page-level "no permission" state with a way out (no dead ends). Use it instead of an EmptyState with
 * the FORBIDDEN error text. Defaults to a button back to My day.
 */
export function ForbiddenState({ homeHref = '/', homeLabel, className }: {
  homeHref?: string;
  /** Name of the destination page; defaults to "My day". */
  homeLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const u = t.uiFoundation;
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-16 text-center', className)}>
      <div className="flex size-12 items-center justify-center rounded-2xl border border-tint/[0.08] bg-tint/[0.03]">
        <Lock className="text-muted-foreground size-5" aria-hidden />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{u.forbiddenTitle}</h2>
        <p className="text-muted-foreground max-w-sm text-sm">{u.forbiddenBody}</p>
      </div>
      <Button asChild variant="outline">
        <Link href={homeHref}>{fmt(u.goTo, { homeLabel: homeLabel ?? t.nav.home })}</Link>
      </Button>
    </div>
  );
}

export function LoadingRows({ rows = 5, className }: { rows?: number; className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn('space-y-2 p-4', className)} aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.common.loading}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/**
 * Inline form error under a field. Not a live region by default: the FormErrorSummary (role="alert")
 * announces submit errors once, and the field's aria-describedby reads this text when the field gets focus.
 * A form without a FormErrorSummary passes `announce` so the error is spoken when it appears (role="alert").
 */
export function FieldError({ id, message, announce = false }: { id?: string; message?: string; announce?: boolean }) {
  if (!message) return null;
  return (
    <p id={id} role={announce ? 'alert' : undefined} className="text-xs text-[color:var(--status-absent)]">
      {message}
    </p>
  );
}

/** Focuses (and scrolls to) the first element whose id is in `ids` and exists. Returns whether one was found. */
export function focusFirstError(ids: string[]): boolean {
  if (typeof document === 'undefined') return false;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      return true;
    }
  }
  return false;
}

/**
 * Error summary shown above the form after a failed submit: role="alert", one link per field that moves
 * focus to it. Pair with focusFirstError(ids) in the submit handler.
 */
export function FormErrorSummary({ errors, className }: { errors: { id: string; message: string }[]; className?: string }) {
  const { t } = useI18n();
  if (errors.length === 0) return null;
  return (
    <div
      role="alert"
      className={cn('rounded-xl border border-[color:var(--status-absent)]/40 bg-[color:var(--status-absent)]/10 p-3 text-sm', className)}
    >
      <p className="font-semibold">{t.uiFoundation.errorSummaryTitle}</p>
      <ul className="mt-1.5 list-disc space-y-1 ps-5">
        {errors.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              className="underline underline-offset-4 decoration-[color:var(--status-absent)]/60 hover:decoration-current"
              onClick={(event) => {
                event.preventDefault();
                focusFirstError([e.id]);
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

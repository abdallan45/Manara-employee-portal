'use client';

import type { ReactNode } from 'react';

import { HelpTip } from '@/components/help-tip';
import { FieldError } from '@/components/states';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * Label + control + error + hint. The control must use `id` and `aria-describedby={describedBy}`
 * (and may spread `aria-required={required}`). The error and the hint show together, error first, and
 * both are referenced by aria-describedby so the fix is read when the field gets focus. A form that has no
 * FormErrorSummary sets `announceError` so the error is spoken when it appears.
 */
export function FormField({ id, label, hint, error, announceError, optional, required, className, children }: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  /** Speak the error when it appears (role="alert"); only for forms without a FormErrorSummary. */
  announceError?: boolean;
  optional?: boolean;
  /** Adds an asterisk (hidden from screen readers) and a screen-reader-only "(required)". */
  required?: boolean;
  className?: string;
  children: (props: { id: string; describedBy: string | undefined; invalid: true | undefined; required: true | undefined }) => ReactNode;
}) {
  const { t } = useI18n();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <div className="flex items-center gap-1">
      <Label htmlFor={id}>
        <span>
          {label}
          {required && (
            <>
              <span aria-hidden className="ms-0.5 text-[color:var(--status-absent)]">
                *
              </span>
              <span className="sr-only"> {t.uiFoundation.required}</span>
            </>
          )}
        </span>
        {optional && <span className="text-muted-foreground text-xs font-normal">({t.common.optional})</span>}
      </Label>
      {hint && <HelpTip text={hint} />}
      </div>
      {children({ id, describedBy, invalid: error ? true : undefined, required: required ? true : undefined })}
      <FieldError id={errorId} message={error} announce={announceError} />
      {hint && (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Checkbox / switch row used for multi-selects (roles, departments) and boolean flags. The whole row is
 * the click target (a <label>); the description is announced as a description, not as part of the name.
 * `checked="indeterminate"` shows the mixed state (checkbox kind only).
 */
export function CheckRow({ id, checked, onCheckedChange, label, description, disabled, kind = 'checkbox', className }: {
  id: string;
  checked: boolean | 'indeterminate';
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  kind?: 'checkbox' | 'switch';
  className?: string;
}) {
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <label
      htmlFor={id}
      data-disabled={disabled || undefined}
      className={cn(
        'flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-tint/[0.08] bg-tint/[0.02] p-3 transition-colors hover:bg-tint/[0.04] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[disabled]:hover:bg-tint/[0.02]',
        className,
      )}
    >
      {kind === 'switch' ? (
        <Switch
          id={id}
          checked={checked === true}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descId}
          className="mt-0.5"
        />
      ) : (
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(c) => onCheckedChange(c === true)}
          disabled={disabled}
          aria-labelledby={labelId}
          aria-describedby={descId}
          className="mt-0.5"
        />
      )}
      <span className="flex min-w-0 items-start gap-1">
        <span id={labelId} className="text-foreground text-sm leading-snug font-medium">
          {label}
        </span>
        {description && (
          <>
            <HelpTip text={description} className="-mt-0.5" />
            <span id={descId} className="sr-only">
              {description}
            </span>
          </>
        )}
      </span>
    </label>
  );
}

'use client';

import { Fragment, type ReactNode } from 'react';
import { Ban, CircleCheck, CircleX, Clock, Lock, type LucideIcon } from 'lucide-react';
import { STANDARD_DAY_MINUTES, type LeaveApprovalStepDto, type LeaveBalanceDto, type LeaveUnit, type RequestStatus } from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { FieldError } from '@/components/states';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime, formatMinutes, formatNumber, localized } from '@/lib/format';
import { fmt, type Locale } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

const STATUS_CLASS: Record<RequestStatus, string> = {
  PENDING: 'text-[color:var(--status-break)] bg-[color:var(--status-break)]/10 border-[color:var(--status-break)]/25',
  APPROVED: 'text-[color:var(--status-working)] bg-[color:var(--status-working)]/10 border-[color:var(--status-working)]/25',
  REJECTED: 'text-[color:var(--status-absent)] bg-[color:var(--status-absent)]/10 border-[color:var(--status-absent)]/25',
  CANCELLED: 'text-[color:var(--status-none)] bg-tint/[0.04] border-tint/10',
};

/**
 * Renders a dictionary template whose placeholders are React nodes, e.g.
 * <Interpolate text="Working since {time}" vars={{ time: <bdi>08:02</bdi> }} />. Durations can go through
 * <Minutes> this way, so Arabic reads hours before minutes inside a sentence. Unknown placeholders stay as typed.
 */
export function Interpolate({ text, vars }: { text: string; vars: Record<string, ReactNode> }) {
  const parts = text.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1];
        return <Fragment key={i}>{key !== undefined && key in vars ? vars[key] : part}</Fragment>;
      })}
    </>
  );
}

/** One icon per status, so the status never depends on colour alone. */
const STATUS_ICON: Record<RequestStatus, LucideIcon> = { PENDING: Clock, APPROVED: CircleCheck, REJECTED: CircleX, CANCELLED: Ban };

/**
 * Request status pill (Pending clock, Approved check, Rejected x, Cancelled ban). `waitingFor` adds a
 * sub-label under a pending badge, e.g. "Waiting for HR · step 2 of 2" (see useWaitingFor).
 */
export function RequestStatusBadge({ status, waitingFor, className }: { status: RequestStatus; waitingFor?: string; className?: string }) {
  const { t } = useI18n();
  const Icon = STATUS_ICON[status];
  const showWaiting = status === 'PENDING' && !!waitingFor;
  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        STATUS_CLASS[status],
        !showWaiting && className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {t.requests.status[status]}
    </span>
  );
  if (!showWaiting) return badge;
  return (
    <span className={cn('inline-flex flex-col items-start gap-1', className)}>
      {badge}
      <span className="text-muted-foreground text-xs">{waitingFor}</span>
    </span>
  );
}

/**
 * Who a pending request waits for: level 1 is the manager, level 2 is HR (leave with two approval levels).
 * A sensitive leave type never has a manager step: every level is HR (`isSensitive`).
 */
export function useWaitingFor() {
  const { t } = useI18n();
  const s = t.employeeSelfService.requests;
  return (r: { status: RequestStatus; currentLevel?: number; approvalLevels?: number; isSensitive?: boolean }): string | undefined => {
    if (r.status !== 'PENDING') return undefined;
    const levels = r.approvalLevels ?? 1;
    const level = Math.min(r.currentLevel ?? 1, levels);
    const who = level >= 2 || r.isSensitive ? s.waitingHr : s.waitingManager;
    return levels > 1 ? fmt(s.waitingStep, { who, level, levels }) : who;
  };
}

const pluralRulesCache = new Map<Locale, Intl.PluralRules>();
function pluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale === 'ar' ? 'ar' : 'en');
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

export type PluralForms = { zero: string; one: string; two: string; few: string; many: string; other: string };

/**
 * Picks the plural form for `n` (Arabic: يوم واحد / يومان / 3 أيام / 11 يوماً) and fills {n}.
 * Intl.PluralRules ignores the sign, so a negative amount never uses a form without {n} (Arabic "one" /
 * "two" are words only and would drop the minus): it falls back to "other", e.g. "-2 يوم".
 */
export function formatCount(n: number, forms: PluralForms, locale: Locale): string {
  let rule = pluralRules(locale).select(n) as keyof PluralForms;
  if (n < 0 && !(forms[rule] ?? '').includes('{n}')) rule = 'other';
  return fmt(forms[rule] ?? forms.other, { n: formatNumber(n, locale, { maximumFractionDigits: 1 }) });
}

/** Day counts with correct plural agreement, e.g. "12 days" / "12 يوماً". */
export function useDayCount() {
  const { t, locale } = useI18n();
  return (n: number, forms: PluralForms = t.employeeSelfService.dayCount): string => formatCount(n, forms, locale);
}

/**
 * Leave amounts: days (of {@link STANDARD_DAY_MINUTES}) for day-based types, hours and minutes for hourly ones.
 * `style: 'long'` writes days in words with plural agreement ("12 days" / "12 يوماً"); the default keeps "12 d".
 */
export function useLeaveAmount(style: 'short' | 'long' = 'short') {
  const { t, locale, units } = useI18n();
  return (minutes: number, unit: LeaveUnit = 'DAY'): string => {
    if (unit === 'HOUR') return formatMinutes(minutes, units);
    // `|| 0` turns a rounded -0 (e.g. -10 minutes) into 0, so it never reads "-0 days".
    const days = Math.round((minutes / STANDARD_DAY_MINUTES) * 10) / 10 || 0;
    if (style === 'long') return formatCount(days, t.employeeSelfService.dayCount, locale);
    return fmt(t.leave.daysValue, { n: formatNumber(days, locale, { maximumFractionDigits: 1 }) });
  };
}

/** Approval / rejection steps, oldest first. */
export function DecisionList({ steps, levels }: { steps: LeaveApprovalStepDto[]; levels?: number }) {
  const { t, locale } = useI18n();
  if (steps.length === 0) return <p className="text-muted-foreground text-sm">{t.requests.noHistory}</p>;
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => {
        const Icon = s.decision === 'APPROVED' ? CircleCheck : s.decision === 'REJECTED' ? CircleX : Clock;
        const color = s.decision === 'APPROVED' ? 'var(--status-working)' : s.decision === 'REJECTED' ? 'var(--status-absent)' : 'var(--status-break)';
        return (
          <li key={`${s.createdAt}-${i}`} className="flex gap-3">
            <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} aria-hidden />
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="font-medium">
                {t.requests.status[s.decision]} · <bdi>{localized(locale, s.approver.name, s.approver.nameAr) || s.approver.username}</bdi>
              </p>
              <p className="text-muted-foreground text-xs">
                {levels && levels > 1 ? `${fmt(t.requests.level, { level: s.level, levels })} · ` : ''}
                {formatDateTime(s.createdAt, locale)}
              </p>
              {s.comment && (
                <p className="text-muted-foreground rounded-lg bg-tint/[0.03] px-2.5 py-1.5 whitespace-pre-wrap" dir="auto">
                  {s.comment}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Small label/value pair used in request cards and the approval sheet. */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 space-y-0.5', className)}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

/** Rejection reason shown inline on a rejected request card or row. */
export function RejectedReason({ reason, className }: { reason: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  if (!reason) return null;
  const [before = '', after = ''] = t.employeeSelfService.requests.rejectedReason.split('{reason}');
  return (
    <p className={cn('text-xs text-[color:var(--status-absent)]', className)}>
      {before}
      <bdi className="whitespace-pre-wrap">{reason}</bdi>
      {after}
    </p>
  );
}

/**
 * One leave balance: what is available, with the ledger sums behind it. `action` renders under the figures.
 * `amountStyle="long"` writes days in words ("12 days" / "12 يوماً"), as on the employee's own pages.
 */
export function BalanceCard({ balance: b, action, amountStyle = 'short' }: { balance: LeaveBalanceDto; action?: ReactNode; amountStyle?: 'short' | 'long' }) {
  const { t, locale } = useI18n();
  const amount = useLeaveAmount(amountStyle);
  const unit = b.leaveType.unit;
  const total = Math.max(1, b.accrued + b.carriedOver + Math.max(0, b.adjusted));
  const usedPct = Math.min(100, Math.round(((b.used + b.pending) / total) * 100));
  return (
    <Card className="gap-3 py-4">
      <CardContent className="space-y-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-medium">{localized(locale, b.leaveType.name, b.leaveType.nameAr)}</p>
          {b.leaveType.isSensitive && (
            <span className="shrink-0" title={t.leave.sensitiveHint}>
              <Lock className="text-muted-foreground size-3.5" aria-hidden />
              <span className="sr-only">{t.leave.sensitiveHint}</span>
            </span>
          )}
        </div>
        <div>
          <p className="text-muted-foreground text-xs">{t.leave.available}</p>
          <p className="num text-2xl font-bold" dir="auto">{amount(b.available, unit)}</p>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-tint/[0.06]" aria-hidden>
          <div className="bg-brand-gradient h-full rounded-full" style={{ width: `${usedPct}%` }} />
        </div>
        <dl className="text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt>{t.leave.accrued}</dt>
          <dd className="tabular text-end" dir="auto">{amount(b.accrued, unit)}</dd>
          {b.carriedOver !== 0 && (
            <>
              <dt>{t.leave.carriedOver}</dt>
              <dd className="tabular text-end" dir="auto">{amount(b.carriedOver, unit)}</dd>
            </>
          )}
          {b.adjusted !== 0 && (
            <>
              <dt>{t.leave.adjusted}</dt>
              <dd className="tabular text-end" dir="auto">{amount(b.adjusted, unit)}</dd>
            </>
          )}
          <dt>{t.leave.used}</dt>
          <dd className="tabular text-end" dir="auto">{amount(b.used, unit)}</dd>
          <dt>{t.leave.pending}</dt>
          <dd className="tabular text-end" dir="auto">{amount(b.pending, unit)}</dd>
        </dl>
        {action}
      </CardContent>
    </Card>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  description?: string;
}

/**
 * Two or three mutually exclusive choices as native radio buttons (no dropdown). `segmented` renders a
 * one-line toggle; `cards` renders stacked cards with a description. The first radio carries `id`, so
 * focusFirstError([id]) lands on the group.
 */
export function ChoiceGroup<V extends string>({ id, label, value, onChange, options, variant = 'segmented', error, hint, className }: {
  id: string;
  label: string;
  value: V | '';
  onChange: (value: V) => void;
  options: ChoiceOption<V>[];
  variant?: 'segmented' | 'cards';
  error?: string;
  hint?: string;
  className?: string;
}) {
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  const name = `${id}-choice`;
  return (
    <fieldset className={cn('grid min-w-0 content-start gap-1.5', className)} aria-describedby={describedBy} aria-invalid={error ? true : undefined}>
      <legend className="mb-1.5 flex items-center gap-1 text-sm leading-none font-medium">
        {label}
        {hint && <HelpTip text={hint} />}
      </legend>
      <div
        className={cn(
          variant === 'segmented'
            ? 'border-input grid auto-cols-fr grid-flow-col gap-1 rounded-xl border bg-tint/[0.03] p-1'
            : 'grid gap-2 sm:auto-cols-fr sm:grid-flow-col',
          error && 'border-destructive',
        )}
      >
        {options.map((opt, i) => {
          const checked = value === opt.value;
          const inputId = i === 0 ? id : `${id}-${opt.value}`;
          const descId = opt.description ? `${inputId}-desc` : undefined;
          return (
            <label
              key={opt.value}
              htmlFor={inputId}
              className={cn(
                'relative flex cursor-pointer transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--focus)]',
                variant === 'segmented'
                  ? 'text-muted-foreground min-h-10 items-center justify-center rounded-lg px-3 text-center text-sm font-medium hover:text-foreground'
                  : 'items-start gap-3 rounded-xl border border-tint/[0.1] bg-tint/[0.02] p-3 hover:bg-tint/[0.04]',
                checked &&
                  (variant === 'segmented'
                    ? 'bg-primary/15 text-foreground ring-primary/60 ring-1'
                    : 'border-primary/60 bg-primary/10'),
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={opt.value}
                checked={checked}
                onChange={() => onChange(opt.value)}
                aria-describedby={descId}
                className={cn(variant === 'segmented' ? 'sr-only' : 'accent-primary mt-0.5 size-4 shrink-0')}
              />
              <span className={cn(variant === 'cards' && 'flex min-w-0 items-center gap-1')}>
                <span className={cn(variant === 'cards' && 'text-sm font-medium')}>{opt.label}</span>
                {opt.description && (
                  <>
                    <HelpTip text={opt.description} />
                    <span id={descId} className="sr-only">
                      {opt.description}
                    </span>
                  </>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <FieldError id={errorId} message={error} />
      {hint && (
        <p id={hintId} className="sr-only">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

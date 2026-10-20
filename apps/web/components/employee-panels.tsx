'use client';

// Employee page sections shared by /admin/employees/view: the Leave tab (entitlements, balances,
// adjustments and ledger history in one table), leave balances (older card view) and direct
// attendance corrections.

import { Fragment, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { AlarmClockOff, ChevronDown, History, Loader2, Pencil, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS, STANDARD_DAY_MINUTES,
  type ApprovalItemDto, type CorrectableSessionDto, type CorrectionRequestDto, type DirectCorrectionInput, type LeaveBalanceDto,
  type LeaveEntitlementRowDto, type LeaveLedgerEntryDto, type LeaveRequestDto, type LeaveUnit, type Paginated,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { CorrectionForm, type CorrectionDraft } from '@/components/correction-form';
import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { EntitlementForm } from '@/components/leave-entitlements';
import { LeaveDocuments } from '@/components/leave-documents';
import { BalanceCard, RequestStatusBadge, useLeaveAmount } from '@/components/request-bits';
import { EmptyState, ErrorState, LoadingRows, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiDelete, apiPost, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatNumber, formatTime, formatWorkDate, localized, parseLocaleNumber, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

export interface EmployeeRef {
  id: string;
  name: string;
  subtitle?: string;
}

const thisYearNow = () => Number(todayInAmman().slice(0, 4));

/** Balances of one year (managers: their departments, sensitive types hidden). HR can post ledger adjustments. */
export function LeaveBalances({ employee, initialYear }: { employee: EmployeeRef; initialYear: number }) {
  const { t } = useI18n();
  const { can } = useAuth();
  // POST /leave/adjustments needs leave.approve (checked by the caller) with company-wide scope.
  const canAdjust = can(PERMISSIONS.ATTENDANCE_READ_ALL);
  const [year, setYear] = useState(initialYear);
  const [adjusting, setAdjusting] = useState<LeaveBalanceDto | null>(null);
  const [dirty, setDirty] = useState(false);
  const balances = useApi<LeaveBalanceDto[]>(`/leave/employees/${encodeURIComponent(employee.id)}/balances`, { year });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-28" aria-label={t.leave.year}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[initialYear - 1, initialYear, initialYear + 1].map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {balances.error && !balances.data ? (
        <ErrorState compact error={balances.error} onRetry={() => void balances.refetch()} />
      ) : !balances.data ? (
        <LoadingRows rows={3} className="px-0" />
      ) : balances.data.length === 0 ? (
        <EmptyState title={t.leave.noBalances} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {balances.data.map((b) => (
            <BalanceCard
              key={b.leaveType.id}
              balance={b}
              action={
                canAdjust && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setDirty(false);
                      setAdjusting(b);
                    }}
                  >
                    <SlidersHorizontal aria-hidden />
                    {t.leave.adjust}
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}

      <Dialog open={adjusting !== null} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent dirty={dirty}>
          <DialogHeader>
            <DialogTitle>{t.leave.adjustTitle}</DialogTitle>
            <DialogDescription>{fmt(t.leave.adjustDescription, { name: employee.name })}</DialogDescription>
          </DialogHeader>
          {adjusting && (
            <AdjustmentForm
              key={`${adjusting.leaveType.id}-${adjusting.year}`}
              employeeId={employee.id}
              balance={adjusting}
              onDirtyChange={setDirty}
              onCancel={() => setAdjusting(null)}
              onSaved={(updated) => {
                setAdjusting(null);
                balances.setData((balances.data ?? []).map((b) => (b.leaveType.id === updated.leaveType.id ? updated : b)));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A number in the leave unit (days of 8 h, or hours) with the unit inside the field. */
function AmountInput({ id, describedBy, invalid, required, unit, value, onChange, onBlur }: {
  id: string;
  describedBy: string | undefined;
  invalid: true | undefined;
  required?: true;
  unit: LeaveUnit;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
}) {
  const h = useI18n().t.employeeHub.entitlementForm;
  return (
    <div className="relative">
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="pe-16"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required}
      />
      <span className="text-muted-foreground pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden>
        {unit === 'HOUR' ? h.unitHours : h.unitDays}
      </span>
    </div>
  );
}

/**
 * HR ledger adjustment (opening balance, correction) for one leave type and year. With `choices` the
 * leave type can be picked (the header's "Adjust leave" action). Positive amounts are typed; the two
 * radio cards say whether they are added or deducted.
 */
export function AdjustmentForm({ employeeId, balance, choices, onCancel, onSaved, onDirtyChange }: {
  employeeId: string;
  balance: LeaveBalanceDto;
  /** Balances to choose the leave type from; omit to fix the type to `balance`. */
  choices?: LeaveBalanceDto[];
  onCancel: () => void;
  onSaved: (b: LeaveBalanceDto) => void;
  /** True once the user changed something (pass it on to DialogContent `dirty`). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const a = t.employeeHub.adjust;
  const amount = useLeaveAmount();
  const radioName = useId();
  const [typeId, setTypeId] = useState(balance.leaveType.id);
  const current = choices?.find((c) => c.leaveType.id === typeId) ?? balance;
  const unit = current.leaveType.unit;
  const perUnit = unit === 'HOUR' ? 60 : STANDARD_DAY_MINUTES;
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const touched = () => onDirtyChange?.(true);

  // Typed in days (8 h) or hours like the rest of the leave UI; the ledger stores signed minutes.
  const n = parseLocaleNumber(value);
  const magnitude = n !== null && n > 0 ? Math.round(n * perUnit) : 0;
  const minutes = direction === 'debit' ? -magnitude : magnitude;
  const amountError = () => (magnitude <= 0 || magnitude > 100000 ? t.leave.amountInvalid : undefined);
  const noteError = () => (note.trim().length < 3 ? t.leave.noteInvalid : undefined);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    const ae = amountError();
    if (ae) v.minutes = ae;
    const ne = noteError();
    if (ne) v.note = ne;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      focusFirstError([...(v.minutes ? ['adj-amount'] : []), ...(v.note ? ['adj-note'] : [])]);
      return;
    }
    setSaving(true);
    try {
      const updated = await apiPost<LeaveBalanceDto>('/leave/adjustments', {
        employeeId, leaveTypeId: current.leaveType.id, year: current.year, minutes, note: note.trim(),
      });
      toast.success(t.leave.adjustedToast);
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(fieldErrorsFrom(err.details));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { value: 'credit' as const, label: unit === 'HOUR' ? a.addHours : a.addDays, hint: a.addHint },
    { value: 'debit' as const, label: unit === 'HOUR' ? a.deductHours : a.deductDays, hint: a.deductHint },
  ];

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {choices && choices.length > 1 ? (
        <FormField id="adj-type" label={t.leave.type}>
          {({ id, describedBy }) => (
            <Select
              value={typeId}
              onValueChange={(v) => {
                setTypeId(v);
                touched();
              }}
            >
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.leaveType.id} value={c.leaveType.id}>
                    {localized(locale, c.leaveType.name, c.leaveType.nameAr)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      ) : (
        <p className="text-sm font-medium">{localized(locale, current.leaveType.name, current.leaveType.nameAr)}</p>
      )}
      <p className="text-muted-foreground -mt-2 text-sm">
        {current.year} · {fmt(a.remainingNow, { n: amount(current.available, unit) })}
      </p>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">{a.direction}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => (
            <label
              key={o.value}
              className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-tint/10 bg-tint/[0.02] p-3 has-[:checked]:border-[color:var(--brand-soft)] has-[:checked]:bg-tint/[0.06]"
            >
              <input
                type="radio"
                name={radioName}
                value={o.value}
                checked={direction === o.value}
                onChange={() => {
                  setDirection(o.value);
                  touched();
                }}
                className="mt-0.5 size-4 accent-[color:var(--brand-soft)]"
              />
              <span className="flex items-center gap-1">
                <span className="text-sm font-semibold">{o.label}</span>
                <HelpTip text={o.hint} />
                <span className="sr-only">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <FormField
        id="adj-amount"
        label={unit === 'HOUR' ? t.leave.amountHours : t.leave.amountDays}
        required
        error={errors.minutes || undefined}
      >
        {({ id, describedBy, invalid, required }) => (
          <div className="grid gap-1">
            <AmountInput
              id={id}
              describedBy={[describedBy, magnitude > 0 ? `${id}-equivalent` : undefined].filter(Boolean).join(' ') || undefined}
              invalid={invalid}
              required={required}
              unit={unit}
              value={value}
              onChange={(v) => {
                setValue(v);
                touched();
              }}
              onBlur={() => value && setErrors((x) => ({ ...x, minutes: amountError() ?? '' }))}
            />
            {/* A live figure that follows the input, so it stays visible (not behind a "?"). */}
            {magnitude > 0 && (
              <p id={`${id}-equivalent`} className="text-muted-foreground tabular text-xs">
                {fmt(t.leave.minutesEquivalent, { sign: minutes < 0 ? '−' : '+', n: formatNumber(magnitude, locale) })}
              </p>
            )}
          </div>
        )}
      </FormField>
      <FormField id="adj-note" label={t.leave.note} required error={errors.note || undefined} hint={t.leave.noteHint}>
        {({ id, describedBy, invalid, required }) => (
          <Textarea
            id={id}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              touched();
            }}
            onBlur={() => note && setErrors((x) => ({ ...x, note: noteError() ?? '' }))}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            aria-required={required}
            maxLength={500}
            rows={2}
          />
        )}
      </FormField>
      <p className={cn('text-sm font-medium', magnitude <= 0 && 'sr-only')} aria-live="polite">
        {magnitude > 0 ? fmt(a.remainingAfter, { n: amount(current.available + minutes, unit) }) : ''}
      </p>
      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t.common.cancel}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {saving ? t.common.saving : t.common.save}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ───────────────────────────── Leave tab ─────────────────────────────

type Entitlement = LeaveEntitlementRowDto['entitlements'][number];

/** "Accrual", "Leave taken"… plus what an automatic row covers. */
function useLedgerText() {
  const { t, locale } = useI18n();
  const l = t.employeeHub.leave;
  return (e: LeaveLedgerEntryDto): { what: string; detail: string | null } => {
    const what = l.kinds[e.kind];
    if (e.kind === 'ACCRUAL' && e.period) {
      return { what, detail: /^\d{4}-\d{2}$/.test(e.period) ? fmt(l.periodMonth, { period: formatMonth(e.period, locale) }) : fmt(l.periodYear, { period: e.period }) };
    }
    if (e.kind === 'CARRYOVER' && e.period) return { what, detail: fmt(l.carriedFrom, { period: e.period }) };
    return { what, detail: e.note };
  };
}

const formatMonth = (period: string, locale: 'en' | 'ar') =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`));

function signed(minutes: number, unit: LeaveUnit, amount: (m: number, u: LeaveUnit) => string) {
  return `${minutes > 0 ? '+' : minutes < 0 ? '−' : ''}${amount(Math.abs(minutes), unit)}`;
}

/** Ledger rows of one leave type: date, what happened, ± amount, reason, by whom. */
function LedgerHistory({ id, entries, unit, year }: { id: string; entries: LeaveLedgerEntryDto[] | undefined; unit: LeaveUnit; year: number }) {
  const { t, locale } = useI18n();
  const l = t.employeeHub.leave;
  const amount = useLeaveAmount();
  const text = useLedgerText();
  if (!entries) return <LoadingRows rows={2} className="px-0" />;
  if (entries.length === 0) return <p id={id} className="text-muted-foreground text-sm">{fmt(l.historyEmpty, { year })}</p>;
  return (
    <ol id={id} className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06] bg-tint/[0.02]">
      {entries.map((e) => {
        const { what, detail } = text(e);
        return (
          <li key={e.id} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_6rem_8rem] sm:items-baseline sm:gap-3">
            <span className="text-muted-foreground tabular text-xs">{formatDateTime(e.createdAt, locale)}</span>
            <span className="min-w-0">
              <span className="font-medium">{what}</span>
              {detail && (
                <span className="text-muted-foreground block break-words text-xs" dir="auto">
                  {detail}
                </span>
              )}
            </span>
            {/* dir=auto like the other amounts: the Arabic unit sets RTL, so "+2 ي" and "1س 30د" read number first, hours first. */}
            <span
              className={cn('tabular font-semibold sm:text-end', e.minutes < 0 ? 'text-[color:var(--status-absent)]' : 'text-[color:var(--status-working)]')}
              dir="auto"
            >
              {signed(e.minutes, unit, amount)}
            </span>
            <span className="text-muted-foreground text-xs sm:text-end">
              {e.actor ? <span dir="ltr">{e.actor.username}</span> : l.system}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Entitlement amount with its source badge and, for a personal one, the reason as visible text. */
function EntitlementCell({ ent, balance, canEdit, onChange, onReset }: {
  ent: Entitlement | undefined;
  balance: LeaveBalanceDto;
  canEdit: boolean;
  onChange: () => void;
  onReset: () => void;
}) {
  const { t, locale } = useI18n();
  const l = t.employeeHub.leave;
  const amount = useLeaveAmount();
  const unit = balance.leaveType.unit;
  const typeName = localized(locale, balance.leaveType.name, balance.leaveType.nameAr);
  if (!ent) {
    // Managers: no entitlement API, show what was accrued for the year.
    return <span className="tabular font-medium" dir="auto">{amount(balance.accrued, unit)}</span>;
  }
  const value = amount(ent.effectiveMinutes, unit);
  return (
    <div className="grid justify-items-start gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="tabular font-semibold" dir="auto">{value}</span>
        {ent.custom ? (
          <Badge variant="outline" className="text-[color:var(--brand-soft)]">{fmt(l.personalSince, { year: ent.custom.fromYear })}</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">{l.companyDefault}</Badge>
        )}
      </div>
      {ent.custom?.note && (
        <p className="text-muted-foreground max-w-56 text-xs break-words" dir="auto">
          {ent.custom.note}
        </p>
      )}
      {balance.accrued !== ent.effectiveMinutes && (
        <p className="text-muted-foreground text-xs">{fmt(l.accruedSoFar, { amount: amount(balance.accrued, unit) })}</p>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" size="sm" className="-ms-2 max-md:min-h-10" onClick={onChange} aria-label={`${l.changeEntitlement}: ${typeName}`}>
            <Pencil aria-hidden />
            {l.changeEntitlement}
          </Button>
          {ent.custom && (
            <Button variant="ghost" size="sm" className="max-md:min-h-10" onClick={onReset} aria-label={`${l.backToDefault}: ${typeName}`}>
              <RotateCcw aria-hidden />
              {l.backToDefault}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Leave tab of the employee page: one year, one table with a row per leave type (entitlement,
 * carried over, adjustments, used, pending, remaining) and its ledger history, then the employee's leave
 * requests with their documents. HR (company-wide leave approvers) can change entitlements and adjust
 * balances; every change refreshes entitlements, balances and history together. Managers read only.
 */
export function EmployeeLeavePanel({ employee, openAdjust = false, onAdjustOpened, onChanged }: {
  employee: EmployeeRef;
  /**
   * Open "Adjust balance" once the balances are loaded: `true` (or '1') with a leave type picker (the page
   * header's quick action), a leave type id for that type (the &adjust=<leaveTypeId> deep link; an unknown
   * id falls back to the picker). Falsy does nothing.
   */
  openAdjust?: boolean | string;
  /** Called when that request was taken, so the page can clear it. */
  onAdjustOpened?: () => void;
  /** After any change, so the page can refresh its own leave figures. */
  onChanged?: () => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const { can } = useAuth();
  const l = t.employeeHub.leave;
  const amount = useLeaveAmount();
  const canEdit = can(PERMISSIONS.LEAVE_APPROVE) && can(PERMISSIONS.ATTENDANCE_READ_ALL);
  const thisYear = thisYearNow();
  const [year, setYear] = useState(thisYear);
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());
  const [entTarget, setEntTarget] = useState<LeaveBalanceDto | null>(null);
  const [adjusting, setAdjusting] = useState<{ balance: LeaveBalanceDto; pick: boolean } | null>(null);
  const [resetting, setResetting] = useState<{ balance: LeaveBalanceDto; customId: string; fromYear: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const enc = encodeURIComponent(employee.id);
  const historyBase = useId();

  const balances = useApi<LeaveBalanceDto[]>(`/leave/employees/${enc}/balances`, { year });
  const ents = useApi<LeaveEntitlementRowDto[]>(canEdit ? '/leave/entitlements' : null, { year, employeeId: employee.id });
  const ledger = useApi<LeaveLedgerEntryDto[]>(`/leave/employees/${enc}/ledger`, { year });

  const refresh = async () => {
    await Promise.all([balances.refetch(), ents.refetch(), ledger.refetch()]);
    onChanged?.();
  };

  // The header's "Adjust leave" (or an &adjust= link) opens the dialog here once the balances are loaded.
  const balancesLoaded = balances.data !== undefined;
  useEffect(() => {
    if (!openAdjust || !balancesLoaded) return;
    onAdjustOpened?.();
    const list = balances.data ?? [];
    const wanted = typeof openAdjust === 'string' ? list.find((b) => b.leaveType.id === openAdjust) : undefined;
    const target = wanted ?? list[0];
    if (canEdit && target) {
      setDirty(false);
      setAdjusting({ balance: target, pick: !wanted });
    }
  }, [openAdjust, balancesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = ents.data?.[0];
  const entOf = (typeId: string) => row?.entitlements.find((x) => x.leaveTypeId === typeId);
  const entriesOf = (typeId: string) => ledger.data?.filter((e) => e.leaveTypeId === typeId);
  const typeName = (b: LeaveBalanceDto) => localized(locale, b.leaveType.name, b.leaveType.nameAr);
  const toggleHistory = (typeId: string) =>
    setOpenHistory((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  const openEntitlement = (b: LeaveBalanceDto) => {
    setDirty(false);
    setEntTarget(b);
  };
  const openAdjustFor = (b: LeaveBalanceDto) => {
    setDirty(false);
    setAdjusting({ balance: b, pick: false });
  };
  const openReset = (b: LeaveBalanceDto) => {
    const x = entOf(b.leaveType.id);
    if (x?.custom) setResetting({ balance: b, customId: x.custom.id, fromYear: x.custom.fromYear });
  };

  const historyButton = (b: LeaveBalanceDto) => {
    const open = openHistory.has(b.leaveType.id);
    return (
      <Button
        variant="ghost"
        size="sm"
        className="max-md:min-h-10"
        aria-expanded={open}
        aria-controls={`${historyBase}-${b.leaveType.id}`}
        aria-label={`${l.history}: ${typeName(b)}`}
        onClick={() => toggleHistory(b.leaveType.id)}
      >
        <History aria-hidden />
        {l.history}
        <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>
    );
  };
  const adjustButton = (b: LeaveBalanceDto) =>
    canEdit && (
      <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => openAdjustFor(b)} aria-label={`${l.adjustBalance}: ${typeName(b)}`}>
        <SlidersHorizontal aria-hidden />
        {l.adjustBalance}
      </Button>
    );

  const figures = (b: LeaveBalanceDto): [string, ReactNode][] => [
    [l.cols.carried, amount(b.carriedOver, b.leaveType.unit)],
    [l.cols.adjustments, b.adjusted === 0 ? amount(0, b.leaveType.unit) : signed(b.adjusted, b.leaveType.unit, amount)],
    [l.cols.used, amount(b.used, b.leaveType.unit)],
    [l.cols.pending, amount(b.pending, b.leaveType.unit)],
  ];

  const yearSelect = (
    <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
      <SelectTrigger className="w-28" aria-label={t.leave.year}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  let body: ReactNode;
  if (balances.error && !balances.data) body = <ErrorState compact error={balances.error} onRetry={() => void balances.refetch()} />;
  else if (!balances.data || (canEdit && !ents.data && !ents.error)) body = <LoadingRows rows={3} className="px-0" />;
  else if (balances.data.length === 0) body = <EmptyState title={t.leave.noBalances} />;
  else {
    const list = balances.data;
    body = (
      <>
        {/* md and up: one table, a row per leave type with its history underneath. */}
        <div className={cn('hidden md:block', (balances.refreshing || ledger.refreshing) && 'opacity-70 transition-opacity')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{l.cols.type}</TableHead>
                <TableHead>{canEdit ? l.cols.entitlement : t.leave.accrued}</TableHead>
                <TableHead className="text-end">{l.cols.carried}</TableHead>
                <TableHead className="text-end">{l.cols.adjustments}</TableHead>
                <TableHead className="text-end">{l.cols.used}</TableHead>
                <TableHead className="text-end">{l.cols.pending}</TableHead>
                <TableHead className="text-end">{l.cols.remaining}</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">{t.common.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((b) => {
                const unit = b.leaveType.unit;
                const open = openHistory.has(b.leaveType.id);
                return (
                  <Fragment key={b.leaveType.id}>
                    <TableRow className="align-top">
                      <TableCell className="font-medium whitespace-normal">{typeName(b)}</TableCell>
                      <TableCell className="whitespace-normal">
                        <EntitlementCell ent={entOf(b.leaveType.id)} balance={b} canEdit={canEdit} onChange={() => openEntitlement(b)} onReset={() => openReset(b)} />
                      </TableCell>
                      {figures(b).map(([label, v]) => (
                        <TableCell key={label} className="tabular text-end" dir="auto">
                          {v}
                        </TableCell>
                      ))}
                      <TableCell className="tabular text-end text-base font-bold" dir="auto">
                        {amount(b.available, unit)}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex flex-wrap justify-end gap-1">
                          {adjustButton(b)}
                          {historyButton(b)}
                        </div>
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="whitespace-normal">
                          <LedgerHistory id={`${historyBase}-${b.leaveType.id}`} entries={entriesOf(b.leaveType.id)} unit={unit} year={year} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Below md: one card per leave type with the same figures. */}
        <ul className="grid gap-3 md:hidden">
          {list.map((b) => {
            const unit = b.leaveType.unit;
            const open = openHistory.has(b.leaveType.id);
            return (
              <li key={b.leaveType.id} className="space-y-3 rounded-2xl border border-tint/[0.06] bg-tint/[0.02] p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold">{typeName(b)}</p>
                  <div className="text-end">
                    <p className="text-muted-foreground text-xs">{l.cols.remaining}</p>
                    <p className="tabular text-xl font-bold" dir="auto">{amount(b.available, unit)}</p>
                  </div>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1 text-xs">{canEdit ? l.cols.entitlement : t.leave.accrued}</p>
                  <EntitlementCell ent={entOf(b.leaveType.id)} balance={b} canEdit={canEdit} onChange={() => openEntitlement(b)} onReset={() => openReset(b)} />
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  {figures(b).map(([label, v]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="tabular" dir="auto">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-wrap gap-2">
                  {adjustButton(b)}
                  {historyButton(b)}
                </div>
                {open && <LedgerHistory id={`${historyBase}-${b.leaveType.id}`} entries={entriesOf(b.leaveType.id)} unit={unit} year={year} />}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  const entBalance = entTarget;
  const entRow = entBalance ? entOf(entBalance.leaveType.id) : undefined;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{l.title}</h2>
              {!canEdit && <p className="text-muted-foreground text-xs">{l.readOnly}</p>}
            </div>
            {yearSelect}
          </div>
          {body}
        </CardContent>
      </Card>

      <EmployeeLeaveRequests employeeId={employee.id} year={year} canManageDocuments={canEdit} onChanged={() => void refresh()} />

      <Dialog open={entTarget !== null} onOpenChange={(o) => !o && setEntTarget(null)}>
        <DialogContent dirty={dirty}>
          <DialogHeader>
            <DialogTitle>{l.changeEntitlement}</DialogTitle>
            <DialogDescription>{entBalance ? fmt(l.entitlementFor, { type: typeName(entBalance), name: employee.name }) : ''}</DialogDescription>
          </DialogHeader>
          {entBalance && row && entRow && (
            <EntitlementForm
              key={`${entBalance.leaveType.id}-${year}`}
              target={{ employees: [row.employee], leaveTypeId: entBalance.leaveType.id, current: entRow.effectiveMinutes }}
              types={[entBalance.leaveType]}
              year={year}
              lockType
              context={{
                defaultMinutes: entRow.defaultMinutes,
                custom: entRow.custom ? { fromYear: entRow.custom.fromYear, minutes: entRow.custom.minutes } : null,
                balance: { accrued: entBalance.accrued, available: entBalance.available },
                hireDate: row.employee.hireDate,
              }}
              onDirtyChange={setDirty}
              onCancel={() => setEntTarget(null)}
              onSaved={() => {
                setEntTarget(null);
                toast.success(l.entitlementSavedToast);
                void refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={adjusting !== null} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent dirty={dirty}>
          <DialogHeader>
            <DialogTitle>{t.leave.adjustTitle}</DialogTitle>
            <DialogDescription>{fmt(t.leave.adjustDescription, { name: employee.name })}</DialogDescription>
          </DialogHeader>
          {adjusting && (
            <AdjustmentForm
              key={`${adjusting.balance.leaveType.id}-${adjusting.balance.year}-${adjusting.pick}`}
              employeeId={employee.id}
              balance={adjusting.balance}
              choices={adjusting.pick ? balances.data : undefined}
              onDirtyChange={setDirty}
              onCancel={() => setAdjusting(null)}
              onSaved={() => {
                setAdjusting(null);
                void refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(o) => !o && setResetting(null)}
        title={resetting ? fmt(t.entitlements.resetTitle, { type: typeName(resetting.balance) }) : ''}
        description={resetting ? fmt(t.entitlements.resetBody, { year: resetting.fromYear, name: employee.name }) : ''}
        confirmLabel={l.backToDefault}
        cancelLabel={l.keepPersonal}
        onConfirm={async () => {
          if (!resetting) return false;
          try {
            await apiDelete<void>(`/leave/entitlements/${encodeURIComponent(resetting.customId)}`);
            toast.success(t.entitlements.resetToast);
            void refresh();
            return true;
          } catch (err) {
            toast.error(errorMessage(err));
            return false;
          }
        }}
      />
    </div>
  );
}

/** This employee's leave requests of the year (Approval Center data), with their supporting documents. */
function EmployeeLeaveRequests({ employeeId, year, canManageDocuments, onChanged }: {
  employeeId: string;
  year: number;
  canManageDocuments: boolean;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const l = t.employeeHub.leave;
  const amount = useLeaveAmount();
  const q = { kind: 'LEAVE', employeeId, page: 1, pageSize: 100 };
  const pending = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'PENDING' });
  const approved = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'APPROVED' });
  const rejected = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'REJECTED' });
  const states = [pending, approved, rejected];
  const failed = states.find((s) => s.error && !s.data);
  const loaded = states.every((s) => s.data);
  const items = states
    .flatMap((s) => s.data?.items ?? [])
    .map((i) => i.leave)
    .filter((r): r is LeaveRequestDto => !!r && Number(r.startDate.slice(0, 4)) === year)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const refetch = () => {
    for (const s of states) void s.refetch();
    onChanged();
  };

  const dates = (r: LeaveRequestDto) =>
    r.startDate === r.endDate ? formatWorkDate(r.startDate, locale) : `${formatWorkDate(r.startDate, locale)} – ${formatWorkDate(r.endDate, locale)}`;

  return (
    <Card>
      <CardContent className="space-y-3">
        <h2 className="font-semibold">{fmt(l.requestsTitle, { year })}</h2>
        {failed ? (
          <ErrorState compact error={failed.error} onRetry={refetch} />
        ) : !loaded ? (
          <LoadingRows rows={2} className="px-0" />
        ) : items.length === 0 ? (
          <EmptyState title={fmt(l.requestsEmpty, { year })} />
        ) : (
          <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
            {items.map((r) => (
              <li key={r.id} className="space-y-3 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{r.leaveType ? localized(locale, r.leaveType.name, r.leaveType.nameAr) : t.leave.confidential}</p>
                    <p className="text-muted-foreground tabular text-xs">
                      {dates(r)} · <span dir="auto">{amount(r.minutes, r.leaveType?.unit ?? 'DAY')}</span>
                    </p>
                    {r.reason && (
                      <p className="text-muted-foreground text-sm break-words" dir="auto">
                        {r.reason}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RequestStatusBadge status={r.status} />
                    {r.status === 'PENDING' && (
                      <Link href={`/admin/approvals?kind=LEAVE&id=${encodeURIComponent(r.id)}`} className="text-link text-sm underline-offset-4 hover:underline">
                        {l.openInApprovals}
                      </Link>
                    )}
                  </div>
                </div>
                {!r.confidential && (r.documents.length > 0 || canManageDocuments || r.leaveType?.requiresAttachment) && (
                  <LeaveDocuments
                    requestId={r.id}
                    documents={r.documents}
                    canAdd={canManageDocuments}
                    canRemove={canManageDocuments ? () => true : undefined}
                    missingWarning={!!r.leaveType?.requiresAttachment && r.documents.length === 0}
                    onChanged={refetch}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────── Corrections ─────────────────────────────

/**
 * The correction a day needs: add the missing check-out, fix the check-in, or add a whole work period.
 * Lateness comes from the day's first check-in, so the check-in fix targets the earliest work period
 * (the sessions endpoint lists newest first). Days outside the sessions window (last 31 days) have no
 * sessions here; callers only offer Fix on such a day when it is absent.
 */
export function draftForDay(sessions: CorrectableSessionDto[], workDate: string): CorrectionDraft {
  const ofDay = sessions.filter((s) => s.workDate === workDate);
  const missing = ofDay.find((s) => s.status === 'MISSING_CHECKOUT');
  if (missing) return { kind: 'MISSING_CHECK_OUT', sessionId: missing.id };
  const first = [...ofDay].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  if (first) return { kind: 'WRONG_TIME', sessionId: first.id, eventType: 'CHECK_IN' };
  return { kind: 'MISSING_CHECK_IN', date: workDate };
}

/** HR's direct correction dialog (applies at once), shared by the Overview alerts and the Attendance tab. */
export function DirectCorrectionDialog({ employee, sessions, draft, onClose, onApplied }: {
  employee: EmployeeRef;
  sessions: CorrectableSessionDto[];
  draft: CorrectionDraft | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useI18n();
  const apply = async (body: Omit<DirectCorrectionInput, 'employeeId'>) => {
    const input: DirectCorrectionInput = { ...body, employeeId: employee.id };
    await apiPost<CorrectionRequestDto>('/corrections/direct', input);
    toast.success(t.corrections.direct.appliedToast);
    onClose();
    onApplied();
  };
  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.corrections.direct.title}</DialogTitle>
          <DialogDescription>{fmt(t.corrections.direct.description, { name: employee.name })}</DialogDescription>
        </DialogHeader>
        {draft && (
          <CorrectionForm
            key={`${draft.kind}-${draft.sessionId ?? ''}-${draft.eventType ?? ''}`}
            initial={draft}
            sessions={sessions}
            allowPending
            reasonHint={t.corrections.direct.reasonHint}
            submitLabel={t.corrections.direct.apply}
            submittingLabel={t.corrections.direct.applying}
            onCancel={onClose}
            onSubmit={apply}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * HR: the employee's sessions of the last 31 days (missing check-outs highlighted) and corrections
 * applied at once. `fixDay` (from the days table's Fix button) opens the matching correction; change
 * its `seq` to open it again for the same day.
 */
export function DirectCorrections({ employee, onApplied, fixDay }: {
  employee: EmployeeRef;
  onApplied: () => void;
  fixDay?: { workDate: string; seq: number } | null;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);
  const [handledSeq, setHandledSeq] = useState<number | null>(null);
  const base = `/corrections/employees/${encodeURIComponent(employee.id)}`;
  const sessions = useApi<CorrectableSessionDto[]>(`${base}/sessions`);
  const history = useApi<CorrectionRequestDto[]>(`${base}/requests`);
  const missing = (sessions.data ?? []).filter((s) => s.status === 'MISSING_CHECKOUT').length;

  if (fixDay && fixDay.seq !== handledSeq && sessions.data) {
    setHandledSeq(fixDay.seq);
    setDraft(draftForDay(sessions.data, fixDay.workDate));
  }

  const proposed = (r: CorrectionRequestDto) =>
    r.proposedEndTime ? `${formatDateTime(r.proposedTime, locale)} – ${formatTime(r.proposedEndTime, locale)}` : formatDateTime(r.proposedTime, locale);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">{t.corrections.direct.sessionsTitle}</h3>
          {missing > 0 && (
            <p className="text-xs text-[color:var(--status-missing)]">{fmt(t.corrections.direct.missingCount, { n: formatNumber(missing, locale) })}</p>
          )}
        </div>
        <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => setDraft({ kind: 'MISSING_CHECK_IN' })}>
          <Plus aria-hidden />
          {t.employeeHub.attendance.addPeriod}
        </Button>
      </div>

      {sessions.error && !sessions.data ? (
        <ErrorState compact error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : !sessions.data ? (
        <LoadingRows rows={3} className="px-0" />
      ) : sessions.data.length === 0 ? (
        <EmptyState title={t.corrections.noSessions} />
      ) : (
        <ul className="divide-y divide-tint/[0.05] overflow-hidden rounded-xl border border-tint/[0.06]">
          {sessions.data.map((s) => {
            const isMissing = s.status === 'MISSING_CHECKOUT';
            return (
              <li
                key={s.id}
                className={cn('flex flex-wrap items-center justify-between gap-3 px-3 py-2.5', isMissing && 'bg-[color:var(--status-missing)]/[0.07]')}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {isMissing && <AlarmClockOff className="size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{formatWorkDate(s.workDate, locale)}</p>
                    <p className="text-muted-foreground tabular text-xs">
                      <bdi>{formatTime(s.startedAt, locale)}</bdi>–<bdi>{s.endedAt ? formatTime(s.endedAt, locale) : '—'}</bdi>
                    </p>
                  </div>
                  <Badge variant="outline" className={cn(isMissing && 'border-[color:var(--status-missing)]/25 text-[color:var(--status-missing)]')}>
                    {t.corrections.sessionStatus[s.status]}
                  </Badge>
                  {s.pendingCorrection && <span className="text-muted-foreground text-xs">{t.corrections.direct.employeeRequestPending}</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {isMissing ? (
                    <Button size="sm" className="max-md:min-h-10" onClick={() => setDraft({ kind: 'MISSING_CHECK_OUT', sessionId: s.id })}>
                      {t.corrections.direct.addCheckOut}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => setDraft({ kind: 'WRONG_TIME', sessionId: s.id, eventType: 'CHECK_IN' })}>
                        {t.corrections.direct.fixCheckIn}
                      </Button>
                      {s.status === 'CLOSED' && (
                        <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => setDraft({ kind: 'WRONG_TIME', sessionId: s.id, eventType: 'CHECK_OUT' })}>
                          {t.corrections.direct.fixCheckOut}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <h3 className="font-medium">{t.corrections.direct.historyTitle}</h3>
          <HelpTip text={t.corrections.appendOnly} />
        </div>
        <p className="sr-only">{t.corrections.appendOnly}</p>
        {history.error && !history.data ? (
          <ErrorState compact error={history.error} onRetry={() => void history.refetch()} />
        ) : !history.data ? (
          <LoadingRows rows={2} className="px-0" />
        ) : history.data.length === 0 ? (
          <EmptyState title={t.corrections.direct.historyEmpty} />
        ) : (
          <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
            {history.data.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium">
                    {t.corrections.kinds[r.kind]}
                    {r.kind === 'WRONG_TIME' && <span className="text-muted-foreground"> · {t.corrections.eventTypes[r.eventType]}</span>}
                  </p>
                  <p className="text-muted-foreground tabular text-xs">{proposed(r)}</p>
                  <p className="text-muted-foreground text-xs">
                    {r.direct ? t.corrections.direct.byHr : t.corrections.direct.byRequest}
                    {r.decidedBy && (
                      <>
                        {' · '}
                        <span dir="ltr">{r.decidedBy.username}</span>
                      </>
                    )}
                    {' · '}
                    <span dir="auto">{r.reason}</span>
                  </p>
                </div>
                <RequestStatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <DirectCorrectionDialog
        employee={employee}
        sessions={sessions.data ?? []}
        draft={draft}
        onClose={() => setDraft(null)}
        onApplied={() => {
          void sessions.refetch();
          void history.refetch();
          onApplied();
        }}
      />
    </div>
  );
}


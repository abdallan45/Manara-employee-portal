'use client';

import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { MANAGER_STEP, STANDARD_DAY_MINUTES, type ApprovalStep, type CreateLeaveTypeInput, type LeaveAccrual, type LeaveTypeDto, type LeaveUnit, type RoleDto } from '@workforce/shared';

import { ChainEditor, useChainSummary } from '@/components/approval-chain';
import { DataTable, type Column } from '@/components/data-table';
import { CheckRow, FormField } from '@/components/form-field';
import { useLeaveAmount } from '@/components/request-bits';
import { ActiveBadge } from '@/components/status-badge';
import { FormErrorSummary, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { localized, parseLocaleNumber } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const CODE_RE = /^[A-Z0-9_]{1,40}$/;
const UNITS: LeaveUnit[] = ['DAY', 'HALF_DAY', 'HOUR'];
const ACCRUALS: LeaveAccrual[] = ['YEARLY', 'MONTHLY', 'NONE'];
const MAX_DAYS = 366;

/** Amounts are typed in days (8 h) for day-based types and in hours for hourly ones; the API stores minutes. */
const minutesPer = (unit: LeaveUnit) => (unit === 'HOUR' ? 60 : STANDARD_DAY_MINUTES);
const toAmount = (minutes: number, unit: LeaveUnit) => String(Math.round((minutes / minutesPer(unit)) * 100) / 100);
/** Typed amount (any digit script, "." or "٫") -> minutes, or null when it is not a valid amount. */
function toMinutes(value: string, unit: LeaveUnit): number | null {
  const n = value.trim() ? parseLocaleNumber(value) : 0;
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  const minutes = Math.round(n * minutesPer(unit));
  return minutes <= MAX_DAYS * STANDARD_DAY_MINUTES ? minutes : null;
}
/** A suggested code from the English name: "Annual leave" -> "ANNUAL_LEAVE". */
const codeFrom = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Text input with its unit inside the field (end side). */
function UnitInput({ unit, wrapperClassName, className, ...props }: ComponentProps<typeof Input> & { unit: string; wrapperClassName?: string }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input type="text" autoComplete="off" className={cn('tabular pe-14', className)} {...props} />
      <span aria-hidden className="text-muted-foreground pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm">
        {unit}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 border-t border-tint/[0.08] pt-4 first:border-t-0 first:pt-0">
      <legend className="float-start mb-1 w-full text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

export function LeaveTypesTab() {
  const { t, locale } = useI18n();
  const l = t.settings.leaveTypes;
  const amount = useLeaveAmount();
  const list = useApi<LeaveTypeDto[]>('/leave/types', { includeInactive: 'true' });
  const [editing, setEditing] = useState<LeaveTypeDto | 'new' | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const nameOf = (x: LeaveTypeDto) => localized(locale, x.name, x.nameAr);
  const roles = useApi<RoleDto[]>('/roles');
  const chainSummary = useChainSummary(roles.data);
  const entitlement = (x: LeaveTypeDto) =>
    x.tracksBalance ? (
      <div className="grid">
        <span className="tabular" dir="auto">{amount(x.annualEntitlementMinutes, x.unit)}</span>
        <span className="text-muted-foreground text-xs">{l.accruals[x.accrual]}</span>
      </div>
    ) : (
      <span className="text-muted-foreground">{l.accruals.NONE}</span>
    );

  const flags = (x: LeaveTypeDto) => (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline" className={x.isPaid ? 'text-[color:var(--status-working)]' : undefined}>
        {x.isPaid ? t.home.paid : t.home.unpaid}
      </Badge>
      {x.isRemoteWork && <Badge variant="outline" className="text-[color:var(--brand-soft)]">{l.isRemoteWork}</Badge>}
      {x.isSensitive && <Badge variant="outline">{l.isSensitive}</Badge>}
      {x.requiresAttachment && <Badge variant="outline">{l.requiresAttachment}</Badge>}
    </div>
  );

  const close = () => {
    setEditing(null);
    setFormDirty(false);
  };

  const columns: Column<LeaveTypeDto>[] = [
    {
      id: 'name',
      header: t.common.name,
      cell: (x) => (
        <span className="grid">
          <span className="font-medium">
            <bdi>{nameOf(x)}</bdi>
          </span>
          <span className="text-muted-foreground text-xs">{l.units[x.unit]}</span>
        </span>
      ),
    },
    { id: 'code', header: t.common.code, cell: (x) => <span className="tabular text-muted-foreground" dir="ltr">{x.code}</span> },
    { id: 'entitlement', header: l.entitlementCol, cell: entitlement },
    { id: 'approval', header: t.approvalChains.leaveTypes.chainColumn, cell: (x) => <span className="text-muted-foreground text-xs">{chainSummary(x.approvalSteps)}</span> },
    { id: 'flags', header: l.flags, cell: flags },
    { id: 'active', header: t.common.status, cell: (x) => <ActiveBadge active={x.isActive} /> },
    {
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-12 text-end',
      cell: (x) => (
        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(x)} aria-label={`${t.common.edit}: ${nameOf(x)}`}>
          <Pencil aria-hidden />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* The note about existing balances (l.changeNote) is the section's "?" next to the page title. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {l.add}
        </Button>
      </div>
      <Card className="gap-0 py-0">
        <DataTable
          rows={list.data}
          columns={columns}
          rowKey={(x) => x.id}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={l.empty}
          onRowClick={(x) => setEditing(x)}
          rowLabel={(x) => `${t.common.edit}: ${nameOf(x)}`}
          mobileCard={(x) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">
                  <bdi>{nameOf(x)}</bdi>
                </p>
                <ActiveBadge active={x.isActive} />
              </div>
              <p className="text-muted-foreground text-xs">{l.units[x.unit]}</p>
              {entitlement(x)}
              {flags(x)}
            </div>
          )}
        />
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? l.createTitle : l.editTitle}</DialogTitle>
            <DialogDescription>{t.settings.tabs.leaveTypes}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <LeaveTypeForm
              key={editing === 'new' ? 'new' : editing.id}
              existing={editing === 'new' ? null : editing}
              roles={roles.data ?? []}
              onDirtyChange={setFormDirty}
              onCancel={close}
              onSaved={() => {
                close();
                void list.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LeaveTypeForm({ existing, roles, onCancel, onSaved, onDirtyChange }: {
  existing: LeaveTypeDto | null;
  roles: RoleDto[];
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, errorMessage } = useI18n();
  const l = t.settings.leaveTypes;
  const w = t.adminWorkflows;
  const [initial] = useState(() => ({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    nameAr: existing?.nameAr ?? '',
    unit: existing?.unit ?? ('DAY' as LeaveUnit),
    accrual: existing?.accrual ?? ('YEARLY' as LeaveAccrual),
    entitlement: toAmount(existing?.annualEntitlementMinutes ?? 0, existing?.unit ?? 'DAY'),
    carryover: toAmount(existing?.carryoverMaxMinutes ?? 0, existing?.unit ?? 'DAY'),
    approvalSteps: existing?.approvalSteps ?? [MANAGER_STEP],
    isPaid: existing?.isPaid ?? true,
    requiresAttachment: existing?.requiresAttachment ?? false,
    isSensitive: existing?.isSensitive ?? false,
    isRemoteWork: existing?.isRemoteWork ?? false,
    isActive: existing?.isActive ?? true,
  }));
  const [code, setCode] = useState(initial.code);
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState(initial.name);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [unit, setUnit] = useState<LeaveUnit>(initial.unit);
  const [accrual, setAccrual] = useState<LeaveAccrual>(initial.accrual);
  const [entitlement, setEntitlement] = useState(initial.entitlement);
  const [carryover, setCarryover] = useState(initial.carryover);
  const [approvalSteps, setApprovalSteps] = useState<ApprovalStep[]>(initial.approvalSteps);
  const [isPaid, setIsPaid] = useState(initial.isPaid);
  const [requiresAttachment, setRequiresAttachment] = useState(initial.requiresAttachment);
  const [isSensitive, setIsSensitive] = useState(initial.isSensitive);
  const [isRemoteWork, setIsRemoteWork] = useState(initial.isRemoteWork);
  const [isActive, setIsActive] = useState(initial.isActive);
  // Advanced (remote work, code) is open for a new type (the code is needed) and when remote work is on.
  const [advancedOpen, setAdvancedOpen] = useState(existing === null || initial.isRemoteWork);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The summary appears after a submit attempt; blur checks only mark the field.
  const [submitted, setSubmitted] = useState(false);
  const noBalance = accrual === 'NONE';

  const dirty =
    code !== initial.code || name !== initial.name || nameAr !== initial.nameAr || unit !== initial.unit || accrual !== initial.accrual ||
    entitlement !== initial.entitlement || carryover !== initial.carryover || approvalSteps.join() !== initial.approvalSteps.join() ||
    isPaid !== initial.isPaid || requiresAttachment !== initial.requiresAttachment || isSensitive !== initial.isSensitive ||
    isRemoteWork !== initial.isRemoteWork || isActive !== initial.isActive;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Keep the typed amounts meaning the same number of minutes when the unit (days ↔ hours) changes.
  const changeUnit = (next: LeaveUnit) => {
    const convert = (v: string) => {
      const m = toMinutes(v, unit);
      return m === null ? v : toAmount(m, next);
    };
    setEntitlement(convert);
    setCarryover(convert);
    setUnit(next);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const v: Record<string, string> = {};
    const entitlementMinutes = noBalance ? 0 : toMinutes(entitlement, unit);
    const carryoverMinutes = noBalance ? 0 : toMinutes(carryover, unit);
    if (!name.trim()) v.name = t.employees.required;
    if (entitlementMinutes === null) v.annualEntitlementMinutes = l.amountInvalid;
    if (carryoverMinutes === null) v.carryoverMaxMinutes = l.amountInvalid;
    if (!existing && !CODE_RE.test(code.trim())) v.code = w.leaveTypes.codeInvalid;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length || entitlementMinutes === null || carryoverMinutes === null) {
      if (v.code) setAdvancedOpen(true);
      // Focus after the Advanced section has opened.
      window.setTimeout(() => focusFirstError(['lt-name', 'lt-entitlement', 'lt-carryover', 'lt-code'].filter((id) => v[FIELD_OF[id]!])), 0);
      return;
    }

    const shared = {
      name: name.trim(), isPaid, unit, accrual, annualEntitlementMinutes: entitlementMinutes, carryoverMaxMinutes: carryoverMinutes,
      requiresAttachment, approvalSteps, isSensitive, isRemoteWork, isActive,
    };
    setSaving(true);
    try {
      if (existing) {
        await api<LeaveTypeDto>(`/leave/types/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: { ...shared, nameAr: nameAr.trim() || null } });
      } else {
        const body: CreateLeaveTypeInput = { ...shared, code: code.trim(), nameAr: nameAr.trim() || null };
        await api<LeaveTypeDto>('/leave/types', { method: 'POST', body });
      }
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const fe = fieldErrorsFrom(err.details);
        // Localized messages only; the API's English field text is not shown.
        setErrors(Object.fromEntries(Object.keys(fe).map((k) => [k, k === 'code' ? w.leaveTypes.codeInvalid : k.endsWith('Minutes') ? l.amountInvalid : t.errors.VALIDATION_FAILED])));
      }
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setErrors({ code: t.errors.CONFLICT });
        setAdvancedOpen(true);
      }
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const amountUnit = unit === 'HOUR' ? w.units.hours : w.units.days;
  const amountHint = unit === 'HOUR' ? l.inHours : l.inDays;
  const summary = (['lt-name', 'lt-entitlement', 'lt-carryover', 'lt-code'] as const)
    .filter((id) => errors[FIELD_OF[id]!])
    .map((id) => ({ id, message: errors[FIELD_OF[id]!]! }));

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <FormErrorSummary errors={submitted ? summary : []} />

      <Section title={w.leaveTypes.basics}>
        <FormField id="lt-name" label={t.common.name} error={errors.name} required>
          {({ id, describedBy, invalid, required }) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!existing && !codeTouched) setCode(codeFrom(e.target.value));
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required}
              maxLength={120}
              dir="auto"
            />
          )}
        </FormField>
        <FormField id="lt-nameAr" label={t.common.nameAr} optional error={errors.nameAr}>
          {({ id, describedBy, invalid }) => <Input id={id} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} />}
        </FormField>
        <FormField id="lt-unit" label={l.unit} error={errors.unit}>
          {({ id, describedBy, invalid }) => (
            <Select value={unit} onValueChange={(v) => changeUnit(v as LeaveUnit)}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {l.units[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <div className="grid gap-2">
          <CheckRow id="lt-paid" checked={isPaid} onCheckedChange={setIsPaid} label={l.isPaid} />
          <CheckRow id="lt-active" checked={isActive} onCheckedChange={setIsActive} label={l.isActive} description={l.isActiveHint} />
        </div>
      </Section>

      <Section title={w.leaveTypes.balance}>
        <FormField
          id="lt-accrual"
          label={l.accrual}
          error={errors.accrual}
          hint={isRemoteWork ? w.leaveTypes.remoteNoBalance : noBalance ? l.noBalanceHint : l.accrualHint}
        >
          {({ id, describedBy, invalid }) => (
            <Select value={accrual} onValueChange={(v) => setAccrual(v as LeaveAccrual)} disabled={isRemoteWork}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCRUALS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {l.accruals[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        {!noBalance && (
          <>
            <div className="grid gap-1.5">
              <FormField id="lt-entitlement" label={l.entitlement} error={errors.annualEntitlementMinutes} hint={amountHint}>
                {({ id, describedBy, invalid }) => (
                  <UnitInput
                    id={id}
                    unit={amountUnit}
                    inputMode="decimal"
                    wrapperClassName="w-40"
                    value={entitlement}
                    onChange={(e) => setEntitlement(e.target.value)}
                    onBlur={() => setErrors((er) => ({ ...er, annualEntitlementMinutes: toMinutes(entitlement, unit) === null ? l.amountInvalid : '' }))}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                  />
                )}
              </FormField>
              {existing && (
                <p className="text-muted-foreground text-xs">
                  {w.leaveTypes.appliesFromNow}{' '}
                  <Link href="/admin/employees" className="text-link underline-offset-4 hover:underline">
                    {w.leaveTypes.adjustLink}
                  </Link>
                </p>
              )}
            </div>
            <FormField id="lt-carryover" label={l.carryover} error={errors.carryoverMaxMinutes} hint={l.carryoverHint}>
              {({ id, describedBy, invalid }) => (
                <UnitInput
                  id={id}
                  unit={amountUnit}
                  inputMode="decimal"
                  wrapperClassName="w-40"
                  value={carryover}
                  onChange={(e) => setCarryover(e.target.value)}
                  onBlur={() => setErrors((er) => ({ ...er, carryoverMaxMinutes: toMinutes(carryover, unit) === null ? l.amountInvalid : '' }))}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </FormField>
          </>
        )}
      </Section>

      <Section title={w.leaveTypes.approvalRules}>
        <ChainEditor id="lt-chain" value={approvalSteps} onChange={setApprovalSteps} roles={roles} error={errors.approvalSteps} />
        {isSensitive && approvalSteps.includes(MANAGER_STEP) && (
          <p className="text-muted-foreground text-xs">{t.approvalChains.leaveTypes.sensitiveSkipsManager}</p>
        )}
        <div className="grid gap-2">
          <CheckRow id="lt-attachment" checked={requiresAttachment} onCheckedChange={setRequiresAttachment} label={l.requiresAttachment} />
          <CheckRow id="lt-sensitive" checked={isSensitive} onCheckedChange={setIsSensitive} label={l.isSensitive} description={l.isSensitiveHint} />
        </div>
      </Section>

      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        className="group border-t border-tint/[0.08] pt-4"
      >
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
          {w.leaveTypes.advanced}
        </summary>
        <div className="mt-3 grid gap-4">
          <CheckRow
            id="lt-remote"
            checked={isRemoteWork}
            onCheckedChange={(on) => {
              setIsRemoteWork(on);
              // Remote work keeps no balance (the API requires accrual NONE).
              if (on) setAccrual('NONE');
            }}
            label={l.isRemoteWork}
            description={l.isRemoteWorkHint}
          />
          <FormField id="lt-code" label={t.common.code} error={errors.code} hint={w.leaveTypes.codeHint} required={!existing}>
            {({ id, describedBy, invalid, required }) => (
              <Input
                id={id}
                dir="ltr"
                className="max-w-xs"
                value={code}
                disabled={existing !== null}
                onChange={(e) => {
                  setCodeTouched(true);
                  setCode(e.target.value.toUpperCase());
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required={required}
                maxLength={40}
                spellCheck={false}
                autoCapitalize="characters"
              />
            )}
          </FormField>
        </div>
      </details>

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
          {saving ? t.common.saving : existing ? t.common.save : t.common.create}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Field id -> the error key it shows (API field names). */
const FIELD_OF: Record<string, string> = {
  'lt-name': 'name',
  'lt-entitlement': 'annualEntitlementMinutes',
  'lt-carryover': 'carryoverMaxMinutes',
  'lt-code': 'code',
};

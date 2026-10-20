'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Loader2, Pencil, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import {
  STANDARD_DAY_MINUTES, type DepartmentDto, type LeaveEntitlementRowDto, type LeaveTypeDto, type LeaveUnit,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmployeeLink } from '@/components/employee-link';
import { FormField } from '@/components/form-field';
import { useLeaveAmount } from '@/components/request-bits';
import { EmptyState, ErrorState, LoadingRows, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiDelete, apiPost, fieldErrorsFrom } from '@/lib/api';
import { formatNumber, formatWorkDate, localized, parseLocaleNumber, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const ALL = '__all';
export const minutesPer = (unit: LeaveUnit) => (unit === 'HOUR' ? 60 : STANDARD_DAY_MINUTES);
const MAX_ENTITLEMENT_MINUTES = 366 * STANDARD_DAY_MINUTES;
const REASON_MIN = 3;

type EntitlementEmployee = LeaveEntitlementRowDto['employee'];

/** Who gets the entitlement, for which type, and the amount the form starts from (minutes). */
export interface EntitlementTarget {
  employees: EntitlementEmployee[];
  leaveTypeId: string;
  current: number;
}

/** One employee's figures for the dialog's summary line and its live "remaining after the change" preview. */
export interface EntitlementContext {
  /** The type's default for everyone (minutes). */
  defaultMinutes: number;
  /** The personal entitlement in force for `year`, if any. */
  custom: { fromYear: number; minutes: number } | null;
  /** Balance of `year` (minutes); without it no preview is shown. */
  balance?: { accrued: number; available: number };
  hireDate: string | null;
}

interface Resetting {
  employee: EntitlementEmployee;
  type: LeaveTypeDto;
  customId: string;
  fromYear: number;
}

/** Minutes -> the number typed in the form (days of 8 h or hours), at most two decimals. */
const toUnitValue = (minutes: number, unit: LeaveUnit) => String(Math.round((minutes / minutesPer(unit)) * 100) / 100);

// Mirrors the API's accrual schedule (apps/api leave-math.ts) so the dialog can preview the balance.
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function yearlyAccrual(entitlement: number, year: number, hireDate: string | null): number {
  if (entitlement <= 0) return 0;
  if (!hireDate) return entitlement;
  const hireYear = Number(hireDate.slice(0, 4));
  if (year < hireYear) return 0;
  if (year > hireYear) return entitlement;
  const days = isLeap(year) ? 366 : 365;
  const d = new Date(`${hireDate}T00:00:00Z`);
  const dayOfYear = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  return Math.floor((entitlement * (days - dayOfYear + 1)) / days);
}
function monthlyAccrual(entitlement: number, year: number, hireDate: string | null, today: string): number {
  const thisYear = Number(today.slice(0, 4));
  const upTo = year < thisYear ? 12 : year === thisYear ? Number(today.slice(5, 7)) : 0;
  if (entitlement <= 0 || upTo < 1) return 0;
  const hireYear = hireDate ? Number(hireDate.slice(0, 4)) : null;
  if (hireYear !== null && year < hireYear) return 0;
  const first = hireYear === year ? Number(hireDate!.slice(5, 7)) : 1;
  if (first > upTo) return 0;
  return Math.floor((entitlement * upTo) / 12) - Math.floor((entitlement * (first - 1)) / 12);
}
/** What the accrual schedule grants in `year` by today with this yearly entitlement (minutes). */
export function accrualDue(type: Pick<LeaveTypeDto, 'accrual'>, entitlement: number, year: number, hireDate: string | null, today = todayInAmman()): number {
  return type.accrual === 'MONTHLY' ? monthlyAccrual(entitlement, year, hireDate, today) : yearlyAccrual(entitlement, year, hireDate);
}

/**
 * Leave entitlements per employee and type, with personal amounts for many employees at once (HR,
 * Settings). One person's entitlements are edited on their employee page (Leave tab); `employeeId`
 * still renders a compact list for older callers.
 */
export function LeaveEntitlements({ employeeId }: { employeeId?: string }) {
  const { t, locale, errorMessage } = useI18n();
  const e = t.entitlements;
  const h = t.employeeHub.entitlements;
  const amount = useLeaveAmount();
  const thisYear = Number(todayInAmman().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [departmentId, setDepartmentId] = useState(ALL);
  const [search, setSearch] = useState('');
  // Selected employees by id, kept across department and search filters (so the dialog can list them all).
  const [selected, setSelected] = useState<Map<string, EntitlementEmployee>>(new Map());
  const [target, setTarget] = useState<EntitlementTarget | null>(null);
  const [dirty, setDirty] = useState(false);
  const [resetting, setResetting] = useState<Resetting | null>(null);
  const single = employeeId !== undefined;

  const types = useApi<LeaveTypeDto[]>('/leave/types');
  const departments = useApi<DepartmentDto[]>(single ? null : '/departments');
  const list = useApi<LeaveEntitlementRowDto[]>('/leave/entitlements', {
    year, employeeId, departmentId: single || departmentId === ALL ? undefined : departmentId,
  });
  const typeById = useMemo(() => new Map((types.data ?? []).map((x) => [x.id, x])), [types.data]);
  const columns = (list.data?.[0]?.entitlements ?? []).map((x) => typeById.get(x.leaveTypeId)).filter((x): x is LeaveTypeDto => !!x);
  const nameOf = (emp: EntitlementEmployee) => localized(locale, emp.fullName, emp.fullNameAr);
  const typeName = (type: LeaveTypeDto) => localized(locale, type.name, type.nameAr);
  const q = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter(
    (r) => !q || r.employee.fullName.toLowerCase().includes(q) || (r.employee.fullNameAr ?? '').includes(q) || r.employee.employeeCode.toLowerCase().includes(q),
  );
  const shownIds = new Set(rows.map((r) => r.employee.id));
  const hiddenSelected = [...selected.keys()].filter((id) => !shownIds.has(id)).length;
  const shownSelected = rows.filter((r) => selected.has(r.employee.id)).length;
  const allShown: boolean | 'indeterminate' = rows.length > 0 && shownSelected === rows.length ? true : shownSelected > 0 ? 'indeterminate' : false;

  const toggle = (emp: EntitlementEmployee, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(emp.id, emp);
      else next.delete(emp.id);
      return next;
    });
  const toggleShown = (on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (on) next.set(r.employee.id, r.employee);
        else next.delete(r.employee.id);
      }
      return next;
    });

  const openFor = (employees: EntitlementEmployee[], leaveTypeId?: string) => {
    const typeId = leaveTypeId ?? columns[0]?.id ?? '';
    const first = list.data?.find((r) => r.employee.id === employees[0]?.id)?.entitlements.find((x) => x.leaveTypeId === typeId);
    setDirty(false);
    setTarget({ employees, leaveTypeId: typeId, current: first?.effectiveMinutes ?? typeById.get(typeId)?.annualEntitlementMinutes ?? 0 });
  };

  const yearSelect = (
    <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
      <SelectTrigger className="w-28" aria-label={e.year}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (list.error && !list.data) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data || !types.data) return <LoadingRows rows={4} />;

  // One employee (older callers): a compact list per leave type.
  if (single) {
    const row = list.data[0];
    if (!row) return null;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{fmt(e.onEmployeePage, { year })}</p>
          {yearSelect}
        </div>
        <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
          {row.entitlements.map((x) => {
            const type = typeById.get(x.leaveTypeId);
            if (!type) return null;
            return (
              <li key={x.leaveTypeId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{typeName(type)}</span>
                <span className="tabular text-sm font-semibold" dir="auto">{amount(x.effectiveMinutes, type.unit)}</span>
                {x.custom ? (
                  <Badge variant="outline" className="text-[color:var(--brand-soft)]">{fmt(e.customSince, { year: x.custom.fromYear })}</Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">{e.default}</Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => openFor([row.employee], x.leaveTypeId)}>
                  <Pencil aria-hidden />
                  {e.change}
                </Button>
                {x.custom && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setResetting({ employee: row.employee, type, customId: x.custom!.id, fromYear: x.custom!.fromYear })}
                    aria-label={`${e.resetDefault}: ${typeName(type)}`}
                  >
                    <RotateCcw aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {dialogs()}
      </div>
    );
  }

  function dialogs() {
    const names = target?.employees.map(nameOf) ?? [];
    return (
      <>
        <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
          <DialogContent dirty={dirty}>
            <DialogHeader>
              <DialogTitle>{e.dialogTitle}</DialogTitle>
              <DialogDescription>
                {target && (target.employees.length <= 3 ? fmt(e.dialogFor, { names: names.join(t.portalVisibility.listSeparator) }) : fmt(e.dialogForMany, { n: target.employees.length }))}
              </DialogDescription>
            </DialogHeader>
            {target && target.employees.length > 3 && (
              <details className="rounded-xl border border-tint/[0.06] bg-tint/[0.02] px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">{fmt(h.showNames, { n: formatNumber(target.employees.length, locale) })}</summary>
                <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto ps-5">
                  {target.employees.map((emp) => (
                    <li key={emp.id}>
                      <bdi>{nameOf(emp)}</bdi>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {target && (
              <EntitlementForm
                key={`${target.leaveTypeId}-${target.employees.length}`}
                target={target}
                types={columns}
                year={year}
                onDirtyChange={setDirty}
                onCancel={() => setTarget(null)}
                onSaved={(n) => {
                  setTarget(null);
                  setSelected(new Map());
                  toast.success(fmt(e.savedToast, { n }));
                  void list.refetch();
                }}
              />
            )}
          </DialogContent>
        </Dialog>
        <ConfirmDialog
          open={resetting !== null}
          onOpenChange={(o) => !o && setResetting(null)}
          title={resetting ? fmt(e.resetTitle, { type: typeName(resetting.type) }) : ''}
          description={resetting ? fmt(e.resetBody, { year: resetting.fromYear, name: nameOf(resetting.employee) }) : ''}
          confirmLabel={e.resetDefault}
          cancelLabel={t.employeeHub.leave.keepPersonal}
          onConfirm={async () => {
            if (!resetting) return false;
            try {
              await apiDelete<void>(`/leave/entitlements/${encodeURIComponent(resetting.customId)}`);
              toast.success(e.resetToast);
              void list.refetch();
              return true;
            } catch (err) {
              toast.error(errorMessage(err));
              return false;
            }
          }}
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* The intro (h.intro) is the section's "?" next to the page title. */}
      <p className="text-sm">
        <Link href="/admin/employees" className="text-link underline underline-offset-4">
          {h.onePerson}
        </Link>
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">{e.year}</Label>
          {yearSelect}
        </div>
        <div className="grid gap-1.5">
          <Label id="ent-dept" className="text-xs">{t.live.department}</Label>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="w-48" aria-labelledby="ent-dept">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t.live.allDepartments}</SelectItem>
              {(departments.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {localized(locale, d.name, d.nameAr)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ent-search" className="text-xs">{t.common.search}</Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
            <Input id="ent-search" className="w-56 ps-9" value={search} onChange={(ev) => setSearch(ev.target.value)} />
          </div>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-3">
          {selected.size > 0 && (
            <span className="text-muted-foreground text-sm" aria-live="polite">
              {hiddenSelected > 0
                ? fmt(h.selectedHidden, { n: formatNumber(selected.size, locale), h: formatNumber(hiddenSelected, locale) })
                : fmt(e.selected, { n: formatNumber(selected.size, locale) })}
            </span>
          )}
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Map())}>
              {t.uiFoundation.clearSelection}
            </Button>
          )}
          <Button onClick={() => openFor([...selected.values()])} disabled={selected.size === 0}>
            <SlidersHorizontal aria-hidden />
            {e.setFor}
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        {rows.length === 0 ? (
          <EmptyState title={e.empty} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allShown} onCheckedChange={(c) => toggleShown(c === true)} aria-label={e.selectAll} />
                </TableHead>
                <TableHead>{t.reports.cols.employee}</TableHead>
                {columns.map((type) => (
                  <TableHead key={type.id} className="text-center">
                    {typeName(type)}
                    <span className="text-muted-foreground block text-xs font-normal" dir="auto">
                      {e.default}: {amount(type.annualEntitlementMinutes, type.unit)}
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.employee.id} data-state={selected.has(r.employee.id) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox checked={selected.has(r.employee.id)} onCheckedChange={(c) => toggle(r.employee, c === true)} aria-label={nameOf(r.employee)} />
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">
                      <EmployeeLink id={r.employee.id} name={r.employee.fullName} nameAr={r.employee.fullNameAr} tab="leave" from="/admin/settings?tab=entitlements" />
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span dir="ltr">{r.employee.employeeCode}</span>
                      {r.employee.departmentName && (
                        <>
                          {' · '}
                          <bdi>{localized(locale, r.employee.departmentName, r.employee.departmentNameAr)}</bdi>
                        </>
                      )}
                      {r.employee.hireDate && ` · ${fmt(e.hired, { date: formatWorkDate(r.employee.hireDate, locale) })}`}
                    </p>
                  </TableCell>
                  {columns.map((type) => {
                    const x = r.entitlements.find((y) => y.leaveTypeId === type.id)!;
                    const value = amount(x.effectiveMinutes, type.unit);
                    return (
                      <TableCell key={type.id} className="text-center align-top">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openFor([r.employee], type.id)}
                            className={cn(
                              'tabular min-h-8 rounded-md px-2 py-1 text-sm hover:bg-tint/[0.06]',
                              x.custom ? 'font-semibold text-[color:var(--brand-soft)]' : 'text-muted-foreground',
                            )}
                            aria-label={fmt(h.cellLabel, { amount: value, name: nameOf(r.employee), type: typeName(type) })}
                            dir="auto"
                          >
                            {value}
                            {x.custom && <span className="ms-1 align-super text-xs" aria-hidden>●</span>}
                          </button>
                          {x.custom && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-8"
                              onClick={() => setResetting({ employee: r.employee, type, customId: x.custom!.id, fromYear: x.custom!.fromYear })}
                              aria-label={`${e.resetDefault}: ${nameOf(r.employee)} · ${typeName(type)}`}
                            >
                              <RotateCcw className="size-3.5" aria-hidden />
                            </Button>
                          )}
                        </div>
                        {x.custom && (
                          <p className="text-muted-foreground mx-auto max-w-40 text-xs">
                            {fmt(e.customSince, { year: x.custom.fromYear })}
                            {x.custom.note && (
                              <>
                                {' - '}
                                <bdi>{x.custom.note}</bdi>
                              </>
                            )}
                          </p>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {dialogs()}
    </div>
  );
}

/**
 * Personal yearly entitlement for one or several employees. From an employee's row pass `lockType`
 * (the type is shown as text) and `context` (summary line and live preview of what remains). In the
 * bulk dialog, changing the type resets the amount to that type's default in its own unit.
 */
export function EntitlementForm({ target, types, year, onCancel, onSaved, lockType = false, context, onDirtyChange }: {
  target: EntitlementTarget;
  types: LeaveTypeDto[];
  year: number;
  onCancel: () => void;
  onSaved: (n: number) => void;
  lockType?: boolean;
  context?: EntitlementContext;
  /** True once the user changed something (pass it on to DialogContent `dirty`). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const e = t.entitlements;
  const h = t.employeeHub.entitlementForm;
  const amount = useLeaveAmount();
  const [leaveTypeId, setLeaveTypeId] = useState(target.leaveTypeId);
  const type = types.find((x) => x.id === leaveTypeId);
  const unit = type?.unit ?? 'DAY';
  const [value, setValue] = useState(toUnitValue(target.current, unit));
  const [fromYear, setFromYear] = useState(String(year));
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const touched = () => onDirtyChange?.(true);
  const parsed = parseLocaleNumber(value);
  const minutes = parsed === null ? null : Math.round(parsed * minutesPer(unit));
  const amountError = (): string | undefined =>
    parsed === null || parsed < 0 || minutes === null || minutes > MAX_ENTITLEMENT_MINUTES ? e.invalidAmount : undefined;
  const noteError = (): string | undefined => (note.trim().length < REASON_MIN ? h.reasonRequired : undefined);

  const changeType = (id: string) => {
    setLeaveTypeId(id);
    const next = types.find((x) => x.id === id);
    // A stale amount in the previous type's unit would be wrong: start from the new type's default.
    if (next) setValue(toUnitValue(next.annualEntitlementMinutes, next.unit));
    setErrors((v) => ({ ...v, annualEntitlementMinutes: '' }));
    touched();
  };

  // Live preview for one employee: what remains in `year` once the new amount applies to it.
  let preview: string | null = null;
  if (context?.balance && type && target.employees.length === 1 && minutes !== null && !amountError()) {
    const from = Number(fromYear);
    const laterPersonal = context.custom !== null && context.custom.fromYear > from && context.custom.fromYear <= year;
    if (from > year || laterPersonal) {
      preview = from > year ? fmt(h.notThisYear, { year: from }) : null;
    } else {
      const due = accrualDue(type, minutes, year, context.hireDate);
      const after = context.balance.available + (due - context.balance.accrued);
      const n = amount(after, unit);
      preview = year === Number(todayInAmman().slice(0, 4)) ? fmt(h.remainingAfter, { n }) : fmt(h.remainingAfterYear, { n, year });
    }
  }

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    const v: Record<string, string> = {};
    const a = amountError();
    if (a) v.annualEntitlementMinutes = a;
    const n = noteError();
    if (n) v.note = n;
    if (!target.employees.length) v.employeeIds = e.noneSelected;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      focusFirstError([...(v.annualEntitlementMinutes ? ['ent-amount'] : []), ...(v.note ? ['ent-note'] : [])]);
      return;
    }
    setSaving(true);
    try {
      const res = await apiPost<{ updated: number }>('/leave/entitlements', {
        employeeIds: target.employees.map((x) => x.id), leaveTypeId, fromYear: Number(fromYear), annualEntitlementMinutes: minutes, note: note.trim(),
      });
      onSaved(res.updated);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(fieldErrorsFrom(err.details));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const typeLabel = type ? localized(locale, type.name, type.nameAr) : '';
  const summary = context && type
    ? context.custom
      ? fmt(h.summarySince, { default: amount(context.defaultMinutes, unit), current: amount(context.custom.minutes, unit), year: context.custom.fromYear })
      : fmt(h.summary, { default: amount(context.defaultMinutes, unit), current: amount(context.defaultMinutes, unit) })
    : null;

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {lockType ? (
        <div className="grid gap-1">
          <p className="text-muted-foreground text-xs">{e.leaveType}</p>
          <p className="font-medium">{typeLabel}</p>
        </div>
      ) : (
        <FormField id="ent-type" label={e.leaveType}>
          {({ id, describedBy }) => (
            <Select value={leaveTypeId} onValueChange={changeType}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {localized(locale, x.name, x.nameAr)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      )}
      {summary && <p className="text-muted-foreground -mt-2 text-sm">{summary}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="ent-amount" label={e.amount} required hint={unit === 'HOUR' ? e.inHours : e.inDays} error={errors.annualEntitlementMinutes || undefined}>
          {({ id, describedBy, invalid, required }) => (
            <div className="relative">
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                className="pe-16"
                value={value}
                onChange={(ev) => {
                  setValue(ev.target.value);
                  touched();
                }}
                onBlur={() => setErrors((v) => ({ ...v, annualEntitlementMinutes: amountError() ?? '' }))}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required={required}
              />
              <span className="text-muted-foreground pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm" aria-hidden>
                {unit === 'HOUR' ? h.unitHours : h.unitDays}
              </span>
            </div>
          )}
        </FormField>
        <FormField id="ent-year" label={h.fromYear} hint={e.fromYearHint}>
          {({ id, describedBy }) => (
            <Select
              value={fromYear}
              onValueChange={(v) => {
                setFromYear(v);
                touched();
              }}
            >
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[year - 1, year, year + 1].map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
      </div>
      <FormField id="ent-note" label={h.reason} required hint={h.reasonHint} error={errors.note || undefined}>
        {({ id, describedBy, invalid, required }) => (
          <Textarea
            id={id}
            rows={2}
            maxLength={300}
            value={note}
            placeholder={e.notePlaceholder}
            onChange={(ev) => {
              setNote(ev.target.value);
              touched();
            }}
            onBlur={() => note && setErrors((v) => ({ ...v, note: noteError() ?? '' }))}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            aria-required={required}
          />
        )}
      </FormField>
      <p className={cn('text-sm font-medium', !preview && 'sr-only')} aria-live="polite">
        {preview ?? ''}
      </p>
      {(formError || errors.employeeIds) && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError ?? errors.employeeIds}
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

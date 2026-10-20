'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Building2, CalendarX, Loader2, Plus, Search, Trash2, User, X } from 'lucide-react';
import { toast } from 'sonner';
import type { DepartmentDto, EmployeeDto, Paginated, ScheduleAssignmentDto, ScheduleDto } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { EmployeeLink } from '@/components/employee-link';
import { FormField } from '@/components/form-field';
import { FormErrorSummary, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api, apiDelete, apiPost, fieldErrorsFrom } from '@/lib/api';
import { addDays, formatNumber, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { normalize } from '@/lib/search-normalize';
import { useApi, type ApiState } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';

/**
 * Search normalisation for Arabic and Latin names: lower case, no diacritics or tatweel, أإآ->ا, ة->ه, ى->ي,
 * Arabic-Indic digits -> 0-9 (the same folding as the server's employee search), plus Latin accents.
 */
export function normalizeName(value: string | null | undefined): string {
  return normalize((value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
}

/** Matches shown in the picker. */
const PICKER_MAX = 8;
/** Rows asked from the server per search; the best PICKER_MAX of them are shown. */
const PICKER_FETCH = 50;

/** 0 = the code or a name starts with the query, 1 = a word starts with it, 2 = elsewhere (server match). */
function pickerRank(e: EmployeeDto, q: string): number {
  const texts = [e.employeeCode, e.fullName, e.fullNameAr].map(normalizeName).filter(Boolean);
  if (texts.some((x) => x.startsWith(q))) return 0;
  if (texts.some((x) => x.split(' ').some((w) => w.startsWith(q)))) return 1;
  return 2;
}

const pickerMatches = (e: EmployeeDto, q: string) =>
  [e.employeeCode, e.fullName, e.fullNameAr, e.user?.username].some((x) => normalizeName(x).includes(q));

/**
 * DialogContent `onEscapeKeyDown` for dialogs holding an EmployeePicker. Radix handles Escape on the
 * document before the input sees it, so without this an Escape meant to close the suggestions would
 * dismiss the whole dialog; the picker's own key handler then closes the list.
 */
export function keepDialogOnListEscape(event: globalThis.KeyboardEvent) {
  const el = event.target instanceof Element ? event.target : null;
  if (el?.closest('[role="combobox"][aria-expanded="true"]')) event.preventDefault();
}

type Status = 'active' | 'upcoming' | 'ended';
const statusOf = (a: ScheduleAssignmentDto, today: string): Status =>
  a.validFrom > today ? 'upcoming' : a.validTo !== null && a.validTo < today ? 'ended' : 'active';
const STATUS_ORDER: Record<Status, number> = { active: 0, upcoming: 1, ended: 2 };

export function AssignmentsTab({ schedules }: { schedules: ApiState<ScheduleDto[]> }) {
  const { t, locale, errorMessage } = useI18n();
  const s = t.schedules;
  const today = todayInAmman();
  const list = useApi<ScheduleAssignmentDto[]>('/schedules/assignments');
  const [assigning, setAssigning] = useState(false);
  /** The Assign form differs from its initial values: closing it asks before discarding. */
  const [dirty, setDirty] = useState(false);
  const [ending, setEnding] = useState<ScheduleAssignmentDto | null>(null);
  const [deleting, setDeleting] = useState<ScheduleAssignmentDto | null>(null);

  const who = (a: ScheduleAssignmentDto) =>
    a.employee ? localized(locale, a.employee.fullName, a.employee.fullNameAr) : a.department ? localized(locale, a.department.name, a.department.nameAr) : '—';
  const rows = list.data ? [...list.data].sort((x, y) => STATUS_ORDER[statusOf(x, today)] - STATUS_ORDER[statusOf(y, today)]) : undefined;
  const statusBadge = (a: ScheduleAssignmentDto) => {
    const st = statusOf(a, today);
    const label = st === 'active' ? s.statusActive : st === 'upcoming' ? s.statusUpcoming : s.statusEnded;
    const color = st === 'active' ? 'text-[color:var(--status-working)]' : st === 'upcoming' ? 'text-[color:var(--status-break)]' : 'text-muted-foreground';
    return <Badge variant="outline" className={color}>{label}</Badge>;
  };

  const columns: Column<ScheduleAssignmentDto>[] = [
    {
      id: 'who',
      header: s.target,
      cell: (a) => (
        <div className="flex items-center gap-2">
          {a.employee ? <User className="text-muted-foreground size-4 shrink-0" aria-hidden /> : <Building2 className="text-muted-foreground size-4 shrink-0" aria-hidden />}
          <div className="min-w-0">
            <p className="truncate font-medium">
              {a.employee && a.employeeId ? (
                <EmployeeLink id={a.employeeId} name={a.employee.fullName} nameAr={a.employee.fullNameAr} tab="schedule" from="/admin/settings?tab=assignments" />
              ) : (
                <bdi>{who(a)}</bdi>
              )}
            </p>
            <p className="text-muted-foreground text-xs">
              {a.employee ? <span dir="ltr">{a.employee.employeeCode}</span> : s.targetDepartment}
            </p>
          </div>
        </div>
      ),
    },
    { id: 'schedule', header: s.schedule, cell: (a) => <span className="font-medium">{a.scheduleName}</span> },
    { id: 'from', header: s.validFrom, cell: (a) => <span className="tabular">{formatWorkDate(a.validFrom, locale)}</span> },
    { id: 'to', header: s.validTo, cell: (a) => <span className="tabular text-muted-foreground">{a.validTo ? formatWorkDate(a.validTo, locale) : s.openEnded}</span> },
    { id: 'status', header: t.common.status, cell: statusBadge },
    {
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-24 text-end',
      cell: (a) => {
        const st = statusOf(a, today);
        return (
          <div className="flex justify-end gap-1">
            {st === 'active' && (
              <Button variant="ghost" size="sm" onClick={() => setEnding(a)}>
                <CalendarX aria-hidden />
                {s.endAssignment}
              </Button>
            )}
            {st === 'upcoming' && (
              <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(a)} aria-label={`${t.common.delete}: ${who(a)}`}>
                <Trash2 aria-hidden />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {/* The precedence explanation (s.assignHint) is the section's "?" next to the page title. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button
          onClick={() => {
            setDirty(false);
            setAssigning(true);
          }}
          disabled={!schedules.data?.length}
        >
          <Plus aria-hidden />
          {s.assign}
        </Button>
      </div>
      <Card className="gap-0 py-0">
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(a) => a.id}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={s.assignmentsEmpty}
          mobileCard={(a) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">
                  {a.employee && a.employeeId ? (
                    <EmployeeLink id={a.employeeId} name={a.employee.fullName} nameAr={a.employee.fullNameAr} tab="schedule" from="/admin/settings?tab=assignments" />
                  ) : (
                    <bdi>{who(a)}</bdi>
                  )}
                </p>
                {statusBadge(a)}
              </div>
              <p className="text-muted-foreground text-xs">
                {a.scheduleName} · {formatWorkDate(a.validFrom, locale)} → {a.validTo ? formatWorkDate(a.validTo, locale) : s.openEnded}
              </p>
            </div>
          )}
        />
      </Card>

      <Dialog
        open={assigning}
        onOpenChange={(o) => {
          setAssigning(o);
          if (!o) setDirty(false);
        }}
      >
        {/* Escape in the employee picker closes its suggestions first (Radix sees Escape before the input does). */}
        <DialogContent closeLabel={t.common.close} dirty={assigning && dirty} onEscapeKeyDown={keepDialogOnListEscape}>
          <DialogHeader>
            <DialogTitle>{s.assignTitle}</DialogTitle>
            <DialogDescription>{s.assignHint}</DialogDescription>
          </DialogHeader>
          {assigning && (
            <AssignForm
              schedules={schedules.data ?? []}
              onDirtyChange={setDirty}
              onCancel={() => {
                setAssigning(false);
                setDirty(false);
              }}
              onSaved={() => {
                setAssigning(false);
                setDirty(false);
                void list.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={ending !== null} onOpenChange={(o) => !o && setEnding(null)}>
        <DialogContent closeLabel={t.common.close}>
          <DialogHeader>
            <DialogTitle>{s.endTitle}</DialogTitle>
            <DialogDescription>{s.endBody}</DialogDescription>
          </DialogHeader>
          {ending && (
            <EndForm
              assignment={ending}
              onCancel={() => setEnding(null)}
              onSaved={() => {
                setEnding(null);
                void list.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={s.deleteTitle}
        description={s.deleteBody}
        confirmLabel={t.common.delete}
        onConfirm={async () => {
          if (!deleting) return false;
          try {
            await apiDelete<void>(`/schedules/assignments/${encodeURIComponent(deleting.id)}`);
            toast.success(s.deletedToast);
            void list.refetch();
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

/**
 * Searchable employee picker: a combobox input whose text is sent to the server's employee search
 * (code, names in both languages with Arabic letters folded, username), so every active employee can be
 * found, not only the first page. The best eight matches are listed; a note says when there are more.
 * Choosing moves focus to "Change", and "Change" moves it back to the input, so keyboard and screen-reader
 * users keep their place. Dialogs holding the picker pass `onEscapeKeyDown={keepDialogOnListEscape}`.
 */
function EmployeePicker({ id, describedBy, invalid, value, onChange }: {
  id: string;
  describedBy: string | undefined;
  invalid: true | undefined;
  value: string;
  onChange: (id: string) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const h = t.employeeHub.assign;
  const listId = useId();
  const label = (e: EmployeeDto) => localized(locale, e.fullName, e.fullNameAr);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The employee picked here; a preset `value` (not picked here) is loaded by id instead. */
  const [chosen, setChosen] = useState<EmployeeDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the input and the read-only view have swapped (the focused element unmounts). */
  const pendingFocus = useRef<'change' | 'input' | null>(null);

  const typed = query.trim();
  const searched = useDebounced(typed, 250);
  const results = useApi<Paginated<EmployeeDto>>(searched ? '/employees' : null, { status: 'active', search: searched, page: 1, pageSize: PICKER_FETCH });
  const preset = useApi<EmployeeDto>(value && chosen?.id !== value ? `/employees/${encodeURIComponent(value)}` : null);
  const selected = chosen?.id === value ? chosen : preset.data?.id === value ? preset.data : undefined;
  /** The list on screen answers exactly what is typed (no debounce or request still pending). */
  const settled = searched === typed && !results.loading && !results.refreshing;

  const matches = useMemo(() => {
    const q = normalizeName(typed);
    if (!q) return [];
    const items = results.data?.items ?? [];
    // While the next search is pending, narrow the previous results to what is typed now.
    const hits = settled ? items : items.filter((e) => pickerMatches(e, q));
    return hits
      .map((e, i) => ({ e, i, r: pickerRank(e, q) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, PICKER_MAX)
      .map((x) => x.e);
  }, [results.data, typed, settled]);
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const total = settled ? (results.data?.total ?? 0) : 0;

  const showingSelection = value !== '';
  useEffect(() => {
    const target = pendingFocus.current === 'change' ? changeRef.current : pendingFocus.current === 'input' ? inputRef.current : null;
    pendingFocus.current = null;
    target?.focus();
  }, [showingSelection]);

  const choose = (e: EmployeeDto) => {
    pendingFocus.current = 'change';
    setChosen(e);
    onChange(e.id);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setOpen(true);
      setActive(Math.min(activeIndex + 1, Math.max(0, matches.length - 1)));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (ev.key === 'Enter') {
      if (open && matches[activeIndex]) {
        ev.preventDefault();
        choose(matches[activeIndex]);
      }
    } else if (ev.key === 'Escape') {
      if (open) {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
      }
    }
  };

  if (showingSelection) {
    return (
      <div className="flex min-h-10 items-center justify-between gap-2 rounded-xl border border-tint/10 bg-tint/[0.03] px-3.5 py-1.5">
        <span id={id} className="min-w-0 text-sm" tabIndex={-1} aria-describedby={describedBy}>
          {selected ? (
            <>
              <bdi className="font-medium">{label(selected)}</bdi>
              <span dir="ltr" className="text-muted-foreground ms-1.5 text-xs">
                {selected.employeeCode}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{preset.error ? errorMessage(preset.error) : t.common.loading}</span>
          )}
        </span>
        <Button
          ref={changeRef}
          type="button"
          variant="ghost"
          size="sm"
          aria-describedby={id}
          onClick={() => {
            pendingFocus.current = 'input';
            onChange('');
          }}
        >
          <X aria-hidden />
          {h.changeEmployee}
        </Button>
      </div>
    );
  }

  const showList = open && typed.length > 0;
  let status: string | null = null;
  if (matches.length === 0) status = results.error && settled ? errorMessage(results.error) : settled ? h.noMatches : t.common.loading;
  return (
    <div className="relative">
      <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && matches[activeIndex] ? `${listId}-${matches[activeIndex].id}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        autoComplete="off"
        className="ps-9"
        placeholder={h.searchPlaceholder}
        value={query}
        onChange={(ev) => {
          setQuery(ev.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        // mousedown is prevented so a click inside the popup does not blur the input (which closes it).
        <div
          className="bg-popover absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-tint/10 shadow-xl"
          onMouseDown={(ev) => ev.preventDefault()}
        >
          <ul id={listId} role="listbox" aria-label={t.schedules.employee} className="max-h-72 overflow-y-auto p-1">
            {status !== null ? (
              <li className="text-muted-foreground px-3 py-2 text-sm" role="presentation">
                {status}
              </li>
            ) : (
              matches.map((e, i) => (
                <li
                  key={e.id}
                  id={`${listId}-${e.id}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={cn('flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-sm', i === activeIndex && 'bg-tint/[0.09]')}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    choose(e);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="min-w-0">
                    <bdi className="font-medium">{label(e)}</bdi>
                    {e.departmentName && (
                      <span className="text-muted-foreground block truncate text-xs">
                        <bdi>{localized(locale, e.departmentName, e.departmentNameAr)}</bdi>
                      </span>
                    )}
                  </span>
                  <span dir="ltr" className="text-muted-foreground shrink-0 text-xs">
                    {e.employeeCode}
                  </span>
                </li>
              ))
            )}
          </ul>
          {status === null && total > matches.length && (
            <p className="text-muted-foreground border-t border-tint/[0.06] px-3 py-1.5 text-xs">
              {fmt(h.moreMatches, { shown: formatNumber(matches.length, locale), total: formatNumber(total, locale) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type AssignField = 'departmentId' | 'employeeId' | 'scheduleId' | 'validFrom' | 'validTo';
/** Visual order of the fields, for the error summary and for focusing the first invalid one. */
const ASSIGN_FIELDS: readonly AssignField[] = ['departmentId', 'employeeId', 'scheduleId', 'validFrom', 'validTo'];
const ASSIGN_FIELD_IDS: Record<AssignField, string> = {
  departmentId: 'as-dept', employeeId: 'as-emp', scheduleId: 'as-schedule', validFrom: 'as-from', validTo: 'as-to',
};

/**
 * Assign a schedule to a department or one employee. On an employee page pass `initialEmployeeId` and
 * `lockTarget` (the target is fixed to that employee and shown read-only), plus `currentScheduleLabel`
 * to say what the new schedule replaces. A dialog holding it without `lockTarget` passes
 * `onEscapeKeyDown={keepDialogOnListEscape}` so Escape in the employee picker only closes its list.
 */
export function AssignForm({ schedules, onCancel, onSaved, initialEmployeeId, lockTarget = false, currentScheduleLabel, onDirtyChange }: {
  schedules: ScheduleDto[];
  onCancel: () => void;
  onSaved: () => void;
  initialEmployeeId?: string;
  /** Target fixed to the employee `initialEmployeeId`; the picker is replaced by their name. */
  lockTarget?: boolean;
  /** The schedule in force now, e.g. "Morning shift (from the department)". */
  currentScheduleLabel?: string;
  /** Reports whether the form differs from its initial values (for DialogContent `dirty`). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const s = t.schedules;
  const locked = lockTarget && !!initialEmployeeId;
  const initialScheduleId = schedules.find((x) => !x.isDefault)?.id ?? schedules[0]?.id ?? '';
  const today = todayInAmman();
  const [target, setTargetState] = useState<'department' | 'employee'>(initialEmployeeId ? 'employee' : 'department');
  const [departmentId, setDepartmentIdState] = useState('');
  const [employeeId, setEmployeeIdState] = useState(initialEmployeeId ?? '');
  const [scheduleId, setScheduleIdState] = useState(initialScheduleId);
  const [validFrom, setValidFromState] = useState(today);
  const [validTo, setValidToState] = useState('');
  const [errors, setErrors] = useState<Partial<Record<AssignField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const departments = useApi<DepartmentDto[]>(locked ? null : '/departments');
  const lockedEmployee = useApi<EmployeeDto>(locked ? `/employees/${encodeURIComponent(initialEmployeeId!)}` : null);

  // Setters that also report dirtiness to the dialog.
  const touch = <V,>(set: (v: V) => void) => (v: V) => {
    set(v);
    onDirtyChange?.(true);
  };
  const setTarget = touch(setTargetState);
  const setDepartmentId = touch(setDepartmentIdState);
  const setEmployeeId = touch(setEmployeeIdState);
  const setScheduleId = touch(setScheduleIdState);
  const setValidFrom = touch(setValidFromState);
  const setValidTo = touch(setValidToState);

  /** Fields on screen now, in visual order. */
  const visible = ASSIGN_FIELDS.filter((f) =>
    f === 'departmentId' ? !locked && target === 'department' : f === 'employeeId' ? !locked && target === 'employee' : true,
  );
  const labelOf: Record<AssignField, string> = { departmentId: s.department, employeeId: s.employee, scheduleId: s.schedule, validFrom: s.validFrom, validTo: s.validTo };
  const summary = visible.filter((f) => errors[f]).map((f) => ({ id: ASSIGN_FIELD_IDS[f], message: `${labelOf[f]}: ${errors[f]}` }));
  const focusFirst = (v: Partial<Record<AssignField, string>>) => focusFirstError(visible.filter((f) => v[f]).map((f) => ASSIGN_FIELD_IDS[f]));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Partial<Record<AssignField, string>> = {};
    if (target === 'department' && !departmentId) v.departmentId = t.employees.required;
    if (target === 'employee' && !employeeId) v.employeeId = t.employees.required;
    if (!scheduleId) v.scheduleId = t.employees.required;
    if (!validFrom) v.validFrom = t.employees.required;
    if (validTo && validTo < validFrom) v.validTo = t.myAttendance.rangeInvalid;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      // The summary (role="alert") announces the errors; focus goes to the first invalid field.
      focusFirst(v);
      return;
    }
    setSaving(true);
    try {
      await apiPost<ScheduleAssignmentDto>(`/schedules/${encodeURIComponent(scheduleId)}/assignments`, {
        ...(target === 'department' ? { departmentId } : { employeeId }),
        validFrom,
        ...(validTo ? { validTo } : {}),
      });
      toast.success(s.assignedToast);
      onSaved();
    } catch (err) {
      const raw = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? fieldErrorsFrom(err.details) : {};
      const fieldErrors: Partial<Record<AssignField, string>> = {};
      for (const f of visible) if (raw[f]) fieldErrors[f] = raw[f];
      if (Object.keys(fieldErrors).length) {
        setErrors(fieldErrors);
        focusFirst(fieldErrors);
      } else setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const lockedName = lockedEmployee.data ? localized(locale, lockedEmployee.data.fullName, lockedEmployee.data.fullNameAr) : '';

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={summary} />
      {locked ? (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{s.employee}</p>
          <p className="min-h-10 rounded-xl border border-tint/10 bg-tint/[0.02] px-3.5 py-2 text-sm">
            {lockedEmployee.data ? (
              <>
                <bdi className="font-medium">{lockedName}</bdi>
                <span dir="ltr" className="text-muted-foreground ms-1.5 text-xs">
                  {lockedEmployee.data.employeeCode}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">{t.common.loading}</span>
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="as-target" label={s.target}>
            {({ id, describedBy }) => (
              <Select value={target} onValueChange={(v) => setTarget(v as 'department' | 'employee')}>
                <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="department">{s.targetDepartment}</SelectItem>
                  <SelectItem value="employee">{s.targetEmployee}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          {target === 'department' ? (
            <FormField id={ASSIGN_FIELD_IDS.departmentId} label={s.department} error={errors.departmentId}>
              {({ id, describedBy, invalid }) => (
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                    <SelectValue placeholder={s.department} />
                  </SelectTrigger>
                  <SelectContent>
                    {(departments.data ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {localized(locale, d.name, d.nameAr)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          ) : (
            <FormField id={ASSIGN_FIELD_IDS.employeeId} label={s.employee} error={errors.employeeId}>
              {({ id, describedBy, invalid }) => <EmployeePicker id={id} describedBy={describedBy} invalid={invalid} value={employeeId} onChange={setEmployeeId} />}
            </FormField>
          )}
        </div>
      )}
      <FormField id={ASSIGN_FIELD_IDS.scheduleId} label={s.schedule} error={errors.scheduleId}>
        {({ id, describedBy, invalid }) => (
          <Select value={scheduleId} onValueChange={setScheduleId}>
            <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
              <SelectValue placeholder={s.schedule} />
            </SelectTrigger>
            <SelectContent>
              {schedules.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={ASSIGN_FIELD_IDS.validFrom} label={s.validFrom} error={errors.validFrom}>
          {({ id, describedBy, invalid }) => <Input id={id} type="date" dir="ltr" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
        <FormField id={ASSIGN_FIELD_IDS.validTo} label={s.validTo} optional hint={s.validToHint} error={errors.validTo}>
          {({ id, describedBy, invalid }) => <Input id={id} type="date" dir="ltr" value={validTo} min={validFrom} onChange={(e) => setValidTo(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
        </FormField>
      </div>
      {currentScheduleLabel && (
        <p className="text-muted-foreground rounded-xl border border-tint/[0.06] bg-tint/[0.02] px-3 py-2 text-sm">
          {fmt(t.employeeHub.assign.currently, { label: currentScheduleLabel, date: validFrom ? formatWorkDate(validFrom, locale) : '—' })}
        </p>
      )}
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
          {saving ? t.common.saving : s.assign}
        </Button>
      </DialogFooter>
    </form>
  );
}

const END_FIELD_ID = 'end-last';

/** End an assignment: its last day (past attendance keeps it). */
export function EndForm({ assignment, onCancel, onSaved }: { assignment: ScheduleAssignmentDto; onCancel: () => void; onSaved: () => void }) {
  const { t, errorMessage } = useI18n();
  const s = t.schedules;
  const yesterday = addDays(todayInAmman(), -1);
  const [lastDay, setLastDay] = useState(yesterday < assignment.validFrom ? assignment.validFrom : yesterday);
  /** Error of the last-day field; anything else goes to formError. */
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!lastDay || lastDay < assignment.validFrom) {
      setError(lastDay ? t.myAttendance.rangeInvalid : t.employees.required);
      focusFirstError([END_FIELD_ID]);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api<ScheduleAssignmentDto>(`/schedules/assignments/${encodeURIComponent(assignment.id)}`, { method: 'PATCH', body: { validTo: lastDay } });
      toast.success(s.endedToast);
      onSaved();
    } catch (err) {
      // The API's only field error here is "validTo before validFrom", which rangeInvalid already words.
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && fieldErrorsFrom(err.details).validTo) {
        setError(t.myAttendance.rangeInvalid);
        focusFirstError([END_FIELD_ID]);
      } else setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={error ? [{ id: END_FIELD_ID, message: `${s.lastDay}: ${error}` }] : []} />
      <FormField id={END_FIELD_ID} label={s.lastDay} error={error ?? undefined}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="date" dir="ltr" value={lastDay} min={assignment.validFrom} onChange={(e) => setLastDay(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>
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
          {s.endAssignment}
        </Button>
      </DialogFooter>
    </form>
  );
}

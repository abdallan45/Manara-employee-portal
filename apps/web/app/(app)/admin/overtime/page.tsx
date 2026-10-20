'use client';

import { Suspense, useId, useMemo, useState, type ComponentProps, type FormEvent } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { CheckCheck, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS, type DepartmentDto, type DirectOvertimeResultDto, type EmployeeDto, type OvertimeCandidateDto, type OvertimeCompensation,
} from '@workforce/shared';

import { BulkActionBar } from '@/components/bulk-action-bar';
import { DataTable, type Column } from '@/components/data-table';
import { DateRangePicker, type DateRange } from '@/components/date-range';
import { Minutes, TimeRange } from '@/components/duration';
import { EmployeeLink } from '@/components/employee-link';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { ForbiddenState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDays, formatMinutes, formatNumber, formatWeekday, formatWorkDate, localized, parseLocaleNumber, startOfMonth, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { APPROVALS_CHANGED_EVENT } from '@/lib/use-nav-counts';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';

const ALL = '__all';
type StateFilter = 'open' | 'requested' | 'approved' | 'all';
const STATES: StateFilter[] = ['open', 'requested', 'approved', 'all'];
const keyOf = (c: OvertimeCandidateDto) => `${c.employee.id}|${c.workDate}`;

/** Which candidates each state filter shows. "Needs decision" = nobody requested or approved it yet (the dashboard callout's count). */
const MATCHES: Record<StateFilter, (c: OvertimeCandidateDto) => boolean> = {
  open: (c) => c.canApprove && !c.request,
  requested: (c) => c.request?.status === 'PENDING',
  approved: (c) => c.request?.status === 'APPROVED',
  all: () => true,
};

export default function OvertimeApprovalPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.OVERTIME_APPROVE)) return <ForbiddenState />;
  // Filters live in the URL (dashboard callout, employee page links, Back) - useSearchParams needs Suspense.
  return (
    <Suspense fallback={<LoadingRows />}>
      <OvertimeApproval />
    </Suspense>
  );
}

function useCurrentUrl(): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** Text input with its unit inside the field (end side); digits in any script are parsed with parseLocaleNumber. */
function UnitInput({ unit, wrapperClassName, className, ...props }: ComponentProps<typeof Input> & { unit: string; wrapperClassName?: string }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input type="text" autoComplete="off" className={cn('tabular pe-12', className)} {...props} />
      <span aria-hidden className="text-muted-foreground pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm">
        {unit}
      </span>
    </div>
  );
}

function OvertimeApproval() {
  const { t, locale, units } = useI18n();
  const { can } = useAuth();
  const o = t.overtimeAdmin;
  const w = t.adminWorkflows.overtime;
  const yesterday = addDays(todayInAmman(), -1);
  const [url, setUrl] = useUrlState({ from: startOfMonth(yesterday), to: yesterday, state: 'open', departmentId: '', employeeId: '' });
  const state: StateFilter = STATES.includes(url.state as StateFilter) ? (url.state as StateFilter) : 'open';
  const { from, to, departmentId, employeeId } = url;
  const range = useMemo<DateRange>(() => ({ from, to }), [from, to]);
  const currentUrl = useCurrentUrl();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState<OvertimeCandidateDto[] | null>(null);
  const [formDirty, setFormDirty] = useState(false);

  const departments = useApi<DepartmentDto[]>('/departments');
  const list = useApi<OvertimeCandidateDto[]>('/overtime/candidates', {
    from, to, departmentId: departmentId || undefined, employeeId: employeeId || undefined,
  });
  // Name for the "Employee: …" chip even when that employee has no rows in the period.
  const employee = useApi<EmployeeDto>(employeeId && can(PERMISSIONS.EMPLOYEES_READ) ? `/employees/${encodeURIComponent(employeeId)}` : null);

  const all = list.data;
  const rows = useMemo(() => all?.filter((c) => (!employeeId || c.employee.id === employeeId) && MATCHES[state](c)), [all, employeeId, state]);
  const approvable = (rows ?? []).filter((c) => c.canApprove);
  const chosen = approvable.filter((c) => selected.has(keyOf(c)));
  const nameOf = (c: OvertimeCandidateDto) => localized(locale, c.employee.fullName, c.employee.fullNameAr);
  const employeeRef = all?.find((c) => c.employee.id === employeeId)?.employee;
  const employeeName = employeeRef
    ? localized(locale, employeeRef.fullName, employeeRef.fullNameAr)
    : employee.data
      ? localized(locale, employee.data.fullName, employee.data.fullNameAr)
      : '…';

  const update = (patch: Partial<typeof url>) => {
    setSelected(new Set());
    setUrl(patch);
  };

  const stateBadge = (c: OvertimeCandidateDto) => {
    if (c.request?.status === 'APPROVED') {
      return <Badge variant="outline" className="text-[color:var(--status-working)]">{fmt(o.approved, { duration: formatMinutes(c.request.approvedMinutes ?? c.request.minutes, units) })}</Badge>;
    }
    if (c.request?.status === 'PENDING') {
      const label = fmt(o.pending, { duration: formatMinutes(c.request.minutes, units) });
      return (
        <Link
          href={`/admin/approvals?${new URLSearchParams({ kind: 'OVERTIME', id: c.request.id }).toString()}`}
          aria-label={fmt(w.openRequest, { label })}
          className="inline-flex min-h-6 items-center rounded-full"
        >
          <Badge variant="outline" className="text-[color:var(--status-break)] underline-offset-4 hover:underline">
            {label}
          </Badge>
        </Link>
      );
    }
    return <span className="text-muted-foreground text-xs">{o.none}</span>;
  };

  const columns: Column<OvertimeCandidateDto>[] = [
    {
      id: 'employee',
      header: t.reports.cols.employee,
      cell: (c) => (
        <div className="min-w-0">
          <EmployeeLink id={c.employee.id} name={c.employee.fullName} nameAr={c.employee.fullNameAr} tab="overtime" from={currentUrl} className="block truncate" />
          <p className="text-muted-foreground text-xs">
            <span dir="ltr">{c.employee.employeeCode}</span>
            {c.employee.departmentName && <> · <bdi>{localized(locale, c.employee.departmentName, c.employee.departmentNameAr)}</bdi></>}
          </p>
        </div>
      ),
    },
    {
      id: 'date',
      header: t.common.date,
      cell: (c) => (
        <div>
          <p className="tabular">{formatWorkDate(c.workDate, locale)}</p>
          <p className="text-muted-foreground text-xs">
            {formatWeekday(c.workDate, locale)}
            {c.kind !== 'REGULAR' && ` · ${t.overtime.kinds[c.kind]}`}
          </p>
        </div>
      ),
    },
    { id: 'times', header: o.times, cell: (c) => <TimeRange start={c.firstIn} end={c.lastOut} endFallback="—" className="text-muted-foreground" /> },
    { id: 'extra', header: o.extra, cell: (c) => <Minutes value={c.extraMinutes} className="font-semibold text-[color:var(--status-working)]" /> },
    { id: 'state', header: o.state, cell: stateBadge },
    {
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-28 text-end',
      cell: (c) =>
        c.canApprove ? (
          <Button size="sm" variant="outline" onClick={() => setApproving([c])} aria-label={`${o.approve}: ${nameOf(c)} · ${formatWorkDate(c.workDate, locale)}`}>
            <CheckCheck aria-hidden />
            {o.approve}
          </Button>
        ) : c.request?.status !== 'APPROVED' ? (
          <span className="text-muted-foreground text-xs">{o.own}</span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={o.title} description={[o.subtitle, o.intro].join('\n')} />
      <Card className="py-4">
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-4">
            <DateRangePicker value={range} onChange={(r) => update({ from: r.from, to: r.to })} />
            <div className="grid gap-1.5">
              <Label id="ot-dept" className="text-xs">{t.live.department}</Label>
              <Select value={departmentId || ALL} onValueChange={(v) => update({ departmentId: v === ALL ? '' : v })}>
                <SelectTrigger className="w-48" aria-labelledby="ot-dept">
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
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-labelledby="ot-state-label" className="flex flex-wrap items-center gap-2">
              <span id="ot-state-label" className="text-muted-foreground text-xs">{w.stateLabel}</span>
              {STATES.map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={state === s}
                  className={cn('max-md:min-h-10', state === s && 'border-tint/40 bg-tint/[0.1]')}
                  onClick={() => state !== s && update({ state: s })}
                >
                  {w.states[s]}
                </Button>
              ))}
            </div>
            {employeeId && (
              <span className="inline-flex items-center gap-1 rounded-full border border-tint/20 bg-tint/[0.05] py-0.5 ps-3 pe-1 text-sm">
                <span>
                  {w.employeeChip.split('{name}')[0]}
                  <bdi className="font-medium">{employeeName}</bdi>
                  {w.employeeChip.split('{name}')[1] ?? ''}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 max-md:size-10"
                  onClick={() => update({ employeeId: '' })}
                  aria-label={fmt(w.removeEmployee, { name: employeeName })}
                >
                  <X aria-hidden />
                </Button>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <MobileSelectAll keys={approvable.map(keyOf)} selected={selected} onChange={setSelected} />
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={keyOf}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={state === 'open' ? w.emptyOpen : o.empty}
          rowLabel={(c) => `${nameOf(c)} · ${formatWorkDate(c.workDate, locale)}`}
          selection={{ selected, onChange: setSelected, isSelectable: (c) => c.canApprove }}
          stale={list.stale && list.lastUpdatedAt ? { since: list.lastUpdatedAt, onRetry: () => void list.refetch() } : undefined}
          resultCount={rows?.length}
          mobileCard={(c) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <EmployeeLink id={c.employee.id} name={c.employee.fullName} nameAr={c.employee.fullNameAr} tab="overtime" from={currentUrl} className="min-w-0 truncate" />
                <Minutes value={c.extraMinutes} className="font-semibold text-[color:var(--status-working)]" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  {formatWorkDate(c.workDate, locale)} · {formatWeekday(c.workDate, locale)}
                </span>
                {stateBadge(c)}
              </div>
            </div>
          )}
          mobileActions={(c) =>
            c.canApprove ? (
              <Button size="sm" variant="outline" className="min-h-10" onClick={() => setApproving([c])} aria-label={`${o.approve}: ${nameOf(c)} · ${formatWorkDate(c.workDate, locale)}`}>
                {o.approve}
              </Button>
            ) : null
          }
        />
      </Card>

      <BulkActionBar count={chosen.length} onClear={() => setSelected(new Set())}>
        <Button type="button" size="sm" className="min-h-10 md:min-h-8" onClick={() => setApproving(chosen)}>
          <CheckCheck aria-hidden />
          {w.approveSelected}
        </Button>
      </BulkActionBar>

      <Dialog
        open={approving !== null}
        onOpenChange={(v) => {
          if (!v) {
            setApproving(null);
            setFormDirty(false);
          }
        }}
      >
        <DialogContent dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{o.dialogTitle}</DialogTitle>
            <DialogDescription>
              {approving?.length === 1 ? fmt(o.dialogOne, { name: nameOf(approving[0]!), date: formatWorkDate(approving[0]!.workDate, locale) }) : fmt(o.dialogMany, { n: approving?.length ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          {approving && (
            <ApproveForm
              items={approving}
              onDirtyChange={setFormDirty}
              onCancel={() => {
                setApproving(null);
                setFormDirty(false);
              }}
              onDone={(res) => {
                setApproving(null);
                setFormDirty(false);
                setSelected(new Set());
                void list.refetch();
                // Days that had a pending request approve that request too: the Approval Center badge drops.
                if (res.approved > 0) window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Phones get cards instead of the table, so they have no header checkbox: this row selects or clears every
 * day in the list that you can approve. Hidden from md, where the table header does the same.
 */
function MobileSelectAll({ keys, selected, onChange }: { keys: string[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  if (keys.length === 0) return null;
  const on = keys.filter((k) => selected.has(k)).length;
  const state: boolean | 'indeterminate' = on === keys.length ? true : on > 0 ? 'indeterminate' : false;
  const toggle = () => {
    const next = new Set(selected);
    if (state === true) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
    onChange(next);
  };
  return (
    <div className="flex items-center gap-3 border-b border-tint/[0.05] ps-4 md:hidden">
      <Checkbox id={id} checked={state} onCheckedChange={toggle} className="relative after:absolute after:-inset-2.5 after:content-['']" />
      <label htmlFor={id} className="flex min-h-12 flex-1 cursor-pointer items-center pe-4 text-sm font-medium">
        {fmt(t.adminWorkflows.selectAllCount, { n: formatNumber(keys.length, locale) })}
      </label>
    </div>
  );
}

function ApproveForm({ items, onCancel, onDone, onDirtyChange }: {
  items: OvertimeCandidateDto[];
  onCancel: () => void;
  onDone: (res: DirectOvertimeResultDto) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, units, errorMessage } = useI18n();
  const o = t.overtimeAdmin;
  const single = items.length === 1 ? items[0]! : null;
  const initialMinutes = String(single?.extraMinutes ?? '');
  const [minutes, setMinutes] = useState(initialMinutes);
  const [compensation, setCompensation] = useState<OvertimeCompensation>('PAY');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [minutesError, setMinutesError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const markDirty = (next: { minutes?: string; compensation?: OvertimeCompensation; comment?: string }) => {
    const m = next.minutes ?? minutes;
    const c = next.compensation ?? compensation;
    const n = next.comment ?? comment;
    onDirtyChange(m !== initialMinutes || c !== 'PAY' || n.trim() !== '');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseLocaleNumber(minutes);
    if (single && (n === null || !Number.isInteger(n) || n < 1 || n > single.extraMinutes)) {
      setMinutesError(fmt(o.minutesHint, { duration: formatMinutes(single.extraMinutes, units) }));
      document.getElementById('ot-minutes')?.focus();
      return;
    }
    setMinutesError(undefined);
    setSaving(true);
    setError(null);
    try {
      const res = await apiPost<DirectOvertimeResultDto>('/overtime/direct', {
        items: items.map((c) => ({ employeeId: c.employee.id, workDate: c.workDate, ...(single && n !== null ? { minutes: n } : {}) })),
        compensation,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (res.failed === 0) toast.success(fmt(o.doneToast, { n: res.approved }));
      else {
        const first = res.results.find((r) => !r.ok);
        const reason = first?.error ? (t.errors as Record<string, string>)[first.error] : undefined;
        toast.warning(`${fmt(o.partialToast, { ok: res.approved, failed: res.failed })}${reason ? ` - ${reason}` : ''}`);
      }
      onDone(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {single ? (
        <FormField id="ot-minutes" label={o.minutes} hint={fmt(o.minutesHint, { duration: formatMinutes(single.extraMinutes, units) })} error={minutesError}>
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={t.adminWorkflows.units.min}
              inputMode="numeric"
              wrapperClassName="w-36"
              value={minutes}
              onChange={(e) => {
                setMinutes(e.target.value);
                markDirty({ minutes: e.target.value });
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
      ) : (
        <p className="text-muted-foreground text-sm">{o.manyHint}</p>
      )}
      <FormField id="ot-comp" label={o.compensation}>
        {({ id, describedBy }) => (
          <Select
            value={compensation}
            onValueChange={(v) => {
              setCompensation(v as OvertimeCompensation);
              markDirty({ compensation: v as OvertimeCompensation });
            }}
          >
            <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PAY">{t.overtime.compensationTypes.PAY}</SelectItem>
              <SelectItem value="TIME_OFF">{t.overtime.compensationTypes.TIME_OFF}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
      <FormField id="ot-comment" label={o.comment} optional>
        {({ id, describedBy }) => (
          <Input
            id={id}
            value={comment}
            placeholder={o.commentPlaceholder}
            onChange={(e) => {
              setComment(e.target.value);
              markDirty({ comment: e.target.value });
            }}
            aria-describedby={describedBy}
            maxLength={1000}
            dir="auto"
          />
        )}
      </FormField>
      {error && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t.common.cancel}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {o.approve}
        </Button>
      </DialogFooter>
    </form>
  );
}

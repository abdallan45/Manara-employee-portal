'use client';

import { useEffect, useState, type ComponentProps, type FormEvent } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { BreakTypeDto } from '@workforce/shared';

import { DataTable, type Column } from '@/components/data-table';
import { CheckRow, FormField } from '@/components/form-field';
import { ActiveBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { fmt } from '@/lib/i18n/dictionaries';
import { parseLocaleNumber } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const CODE_RE = /^[A-Z0-9_]{1,40}$/;

export function BreakTypesTab() {
  const { t, locale } = useI18n();
  const b = t.settings.breakTypes;
  const list = useApi<BreakTypeDto[]>('/break-types', { includeInactive: 'true' });
  const [editing, setEditing] = useState<BreakTypeDto | 'new' | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const close = () => {
    setEditing(null);
    setFormDirty(false);
  };
  const nameOf = (x: BreakTypeDto) => (locale === 'ar' && x.nameAr) || x.name;

  const flags = (x: BreakTypeDto) => (
    <div className="flex flex-wrap gap-1">
      <Badge variant="outline" className={x.isPaid ? 'text-[color:var(--status-working)]' : undefined}>
        {x.isPaid ? t.home.paid : t.home.unpaid}
      </Badge>
      {x.countsAsWork && <Badge variant="outline">{b.countsAsWork}</Badge>}
      {x.requiresApproval && <Badge variant="outline">{b.requiresApproval}</Badge>}
    </div>
  );

  const columns: Column<BreakTypeDto>[] = [
    { id: 'name', header: t.common.name, cell: (x) => <span className="font-medium"><bdi>{nameOf(x)}</bdi></span> },
    { id: 'code', header: t.common.code, cell: (x) => <span className="tabular text-muted-foreground" dir="ltr">{x.code}</span> },
    { id: 'limit', header: b.limit, cell: (x) => <span className="tabular">{x.maxMinutes !== null ? fmt(t.home.breakLimit, { n: x.maxMinutes }) : t.home.noLimit}</span> },
    { id: 'flags', header: b.flags, cell: flags },
    { id: 'notify', header: b.notifyAfter, cell: (x) => <span className="tabular text-muted-foreground">{x.notifyAfterMinutes ?? '—'}</span> },
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
      <div className="flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {b.add}
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
          emptyTitle={b.empty}
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
              <p className="text-muted-foreground text-xs">{x.maxMinutes !== null ? fmt(t.home.breakLimit, { n: x.maxMinutes }) : t.home.noLimit}</p>
              {flags(x)}
            </div>
          )}
        />
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? b.createTitle : b.editTitle}</DialogTitle>
            <DialogDescription>{t.settings.tabs.breakTypes}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <BreakTypeForm
              key={editing === 'new' ? 'new' : editing.id}
              existing={editing === 'new' ? null : editing}
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

/** Empty -> no value; otherwise whole minutes 1–1440 typed in any digit script (١٥ = 15). */
function parseOptionalMinutes(v: string): number | null | 'invalid' {
  if (!v.trim()) return null;
  const n = parseLocaleNumber(v);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 1440 ? n : 'invalid';
}

/** Text input with its unit inside the field (end side). */
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

function BreakTypeForm({ existing, onCancel, onSaved, onDirtyChange }: {
  existing: BreakTypeDto | null;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, errorMessage } = useI18n();
  const b = t.settings.breakTypes;
  const w = t.adminWorkflows;
  const [code, setCode] = useState(existing?.code ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [nameAr, setNameAr] = useState(existing?.nameAr ?? '');
  const [maxMinutes, setMaxMinutes] = useState(existing?.maxMinutes?.toString() ?? '');
  const [notifyAfter, setNotifyAfter] = useState(existing?.notifyAfterMinutes?.toString() ?? '');
  const [isPaid, setIsPaid] = useState(existing?.isPaid ?? false);
  const [requiresApproval, setRequiresApproval] = useState(existing?.requiresApproval ?? false);
  const [countsAsWork, setCountsAsWork] = useState(existing?.countsAsWork ?? false);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rangeMessage = fmt(w.wholeNumberRange, { min: 1, max: 1440 });

  const dirty =
    code !== (existing?.code ?? '') || name !== (existing?.name ?? '') || nameAr !== (existing?.nameAr ?? '') ||
    maxMinutes !== (existing?.maxMinutes?.toString() ?? '') || notifyAfter !== (existing?.notifyAfterMinutes?.toString() ?? '') ||
    isPaid !== (existing?.isPaid ?? false) || requiresApproval !== (existing?.requiresApproval ?? false) ||
    countsAsWork !== (existing?.countsAsWork ?? false) || isActive !== (existing?.isActive ?? true);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    const max = parseOptionalMinutes(maxMinutes);
    const notify = parseOptionalMinutes(notifyAfter);
    if (!existing && !CODE_RE.test(code.trim())) v.code = w.leaveTypes.codeInvalid;
    if (!name.trim()) v.name = t.employees.required;
    if (max === 'invalid') v.maxMinutes = rangeMessage;
    if (notify === 'invalid') v.notifyAfterMinutes = rangeMessage;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length || max === 'invalid' || notify === 'invalid') {
      const order: [string, string][] = [['code', 'bt-code'], ['name', 'bt-name'], ['maxMinutes', 'bt-max'], ['notifyAfterMinutes', 'bt-notify']];
      document.getElementById(order.find(([k]) => v[k])?.[1] ?? '')?.focus();
      return;
    }

    const shared = { name: name.trim(), maxMinutes: max, notifyAfterMinutes: notify, isPaid, requiresApproval, countsAsWork, isActive };
    setSaving(true);
    try {
      if (existing) {
        await api<BreakTypeDto>(`/break-types/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: { ...shared, nameAr: nameAr.trim() || null } });
      } else {
        await api<BreakTypeDto>('/break-types', { method: 'POST', body: { ...shared, code: code.trim(), ...(nameAr.trim() ? { nameAr: nameAr.trim() } : {}) } });
      }
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // Localized messages only; the API's English field text is not shown.
        const fe = fieldErrorsFrom(err.details);
        setErrors(Object.fromEntries(Object.keys(fe).map((k) => [k, k.endsWith('Minutes') ? rangeMessage : k === 'code' ? w.leaveTypes.codeInvalid : t.errors.VALIDATION_FAILED])));
      }
      if (err instanceof ApiError && err.code === 'CONFLICT') setErrors({ code: t.errors.CONFLICT });
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="bt-code" label={t.common.code} error={errors.code} hint={w.leaveTypes.codeHint}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              dir="ltr"
              value={code}
              disabled={existing !== null}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              maxLength={40}
            />
          )}
        </FormField>
        <FormField id="bt-name" label={t.common.name} error={errors.name}>
          {({ id, describedBy, invalid }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} dir="auto" />}
        </FormField>
        <FormField id="bt-nameAr" label={t.common.nameAr} optional error={errors.nameAr}>
          {({ id, describedBy, invalid }) => <Input id={id} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} />}
        </FormField>
        <FormField id="bt-max" label={b.maxMinutes} optional error={errors.maxMinutes || undefined} hint={`${b.maxMinutesHint} ${fmt(w.rangeOnly, { min: 1, max: 1440 })}`}>
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={w.units.min}
              inputMode="numeric"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
              onBlur={() => setErrors((er) => ({ ...er, maxMinutes: parseOptionalMinutes(maxMinutes) === 'invalid' ? rangeMessage : '' }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        <FormField id="bt-notify" label={b.notifyAfter} optional error={errors.notifyAfterMinutes || undefined} hint={`${b.notifyAfterHint} ${fmt(w.rangeOnly, { min: 1, max: 1440 })}`}>
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={w.units.min}
              inputMode="numeric"
              value={notifyAfter}
              onChange={(e) => setNotifyAfter(e.target.value)}
              onBlur={() => setErrors((er) => ({ ...er, notifyAfterMinutes: parseOptionalMinutes(notifyAfter) === 'invalid' ? rangeMessage : '' }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {/* Applied on Save, so these are checkboxes, not switches. */}
        <CheckRow id="bt-paid" checked={isPaid} onCheckedChange={setIsPaid} label={b.isPaid} description={b.isPaidHint} />
        <CheckRow id="bt-counts" checked={countsAsWork} onCheckedChange={setCountsAsWork} label={b.countsAsWork} />
        <CheckRow id="bt-approval" checked={requiresApproval} onCheckedChange={setRequiresApproval} label={b.requiresApproval} />
        <CheckRow id="bt-active" checked={isActive} onCheckedChange={setIsActive} label={b.isActive} />
      </div>
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

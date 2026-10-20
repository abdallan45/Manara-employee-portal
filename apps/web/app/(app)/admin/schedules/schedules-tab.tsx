'use client';

import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { Copy, Loader2, Pencil, Plus, Star } from 'lucide-react';
import { toast } from 'sonner';
import type { ScheduleDto } from '@workforce/shared';

import { Minutes, TimeRange } from '@/components/duration';
import { CheckRow, FormField } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { parseLocaleNumber } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import type { ApiState } from '@/lib/use-api';
import { cn } from '@/lib/utils';
import { fromHHMM, spanMinutes, toHHMM } from './schedule-time';

/** Work week starts on Sunday in Jordan. */
const WEEK = [0, 1, 2, 3, 4, 5, 6];

export function SchedulesTab({ schedules }: { schedules: ApiState<ScheduleDto[]> }) {
  const { t } = useI18n();
  const s = t.schedules;
  const [editing, setEditing] = useState<ScheduleDto | 'new' | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const close = () => {
    setEditing(null);
    setFormDirty(false);
  };

  return (
    <div className="space-y-4">
      {/* The type explanation (s.typeHint) is the section's "?" next to the page title. */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {s.add}
        </Button>
      </div>
      {schedules.error && !schedules.data ? (
        <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : !schedules.data ? (
        <LoadingRows rows={3} />
      ) : schedules.data.length === 0 ? (
        <Card className="py-0">
          <EmptyState title={s.empty} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {schedules.data.map((x) => (
            <ScheduleCard key={x.id} schedule={x} onEdit={() => setEditing(x)} />
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent dirty={formDirty} className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? s.createTitle : s.editTitle}</DialogTitle>
            <DialogDescription>{s.typeHint}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <ScheduleForm
              key={editing === 'new' ? 'new' : editing.id}
              existing={editing === 'new' ? null : editing}
              onDirtyChange={setFormDirty}
              onCancel={close}
              onSaved={() => {
                close();
                void schedules.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Fills "{duration}" in a template with a <Minutes> element (each number isolated for Arabic). */
function withDuration(template: string, minutes: number): ReactNode {
  const [before, after] = template.split('{duration}');
  return (
    <>
      {before}
      <Minutes value={minutes} dimZero={false} />
      {after}
    </>
  );
}

function ScheduleCard({ schedule: x, onEdit }: { schedule: ScheduleDto; onEdit: () => void }) {
  const { t } = useI18n();
  const s = t.schedules;
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="truncate">
              <bdi>{x.name}</bdi>
            </span>
            {x.isDefault && (
              <Badge variant="outline" className="gap-1 text-[color:var(--status-break)]">
                <Star className="size-3" aria-hidden />
                {s.default}
              </Badge>
            )}
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            {t.scheduleType[x.type]} · {withDuration(s.weeklyTotal, x.weeklyRequiredMinutes)}
            {x.includedBreakMinutes > 0 && <> ({withDuration(s.includedShort, x.includedBreakMinutes)})</>}
            {x.graceMinutes > 0 && ` · ${s.grace}: ${x.graceMinutes}`}
            {x.coreStartMinute !== null && x.coreEndMinute !== null && (
              <>
                {' · '}
                {s.coreHours}: <TimeRange start={toHHMM(x.coreStartMinute)} end={toHHMM(x.coreEndMinute)} />
              </>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`${t.common.edit}: ${x.name}`}>
          <Pencil aria-hidden />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-7 gap-1.5">
          {WEEK.map((wd) => {
            const d = x.days.find((y) => y.weekday === wd);
            const works = d?.isWorkday ?? false;
            return (
              <li
                key={wd}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center',
                  works ? 'border-[color:var(--brand-soft)]/20 bg-tint/[0.04]' : 'border-tint/[0.04] opacity-50',
                )}
              >
                <span className="text-xs font-semibold">{s.weekdaysShort[wd]}</span>
                {works ? (
                  d!.startMinute !== null ? (
                    <span className="tabular grid text-xs leading-tight">
                      <bdi>{toHHMM(d!.startMinute)}</bdi>
                      <bdi>{toHHMM(d!.endMinute)}</bdi>
                    </span>
                  ) : (
                    <Minutes value={d!.requiredMinutes} className="text-xs" />
                  )
                ) : (
                  <span className="text-muted-foreground text-xs">{s.off}</span>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

interface DayDraft {
  works: boolean;
  start: string;
  end: string;
  hours: string;
}

const draftFrom = (x: ScheduleDto | null): DayDraft[] =>
  WEEK.map((wd) => {
    const d = x?.days.find((y) => y.weekday === wd);
    if (!x) return { works: wd <= 4, start: '09:00', end: '18:00', hours: '9' };
    return {
      works: d?.isWorkday ?? false,
      start: toHHMM(d?.startMinute) || '09:00',
      end: toHHMM(d?.endMinute) || '17:00',
      hours: d ? String(Math.round((d.requiredMinutes / 60) * 100) / 100) : '8',
    };
  });

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

/** Whole minutes 0–240 typed in any digit script (١٥ = 15), or null. */
function minutesOf(value: string): number | null {
  const n = parseLocaleNumber(value);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 240 ? n : null;
}

function ScheduleForm({ existing, onCancel, onSaved, onDirtyChange }: {
  existing: ScheduleDto | null;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, errorMessage } = useI18n();
  const s = t.schedules;
  const w = t.adminWorkflows;
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<'FIXED' | 'FLEXIBLE'>(existing?.type ?? 'FIXED');
  const [grace, setGrace] = useState(String(existing?.graceMinutes ?? 10));
  const [includedBreak, setIncludedBreak] = useState(String(existing?.includedBreakMinutes ?? 60));
  const [coreStart, setCoreStart] = useState(toHHMM(existing?.coreStartMinute));
  const [coreEnd, setCoreEnd] = useState(toHHMM(existing?.coreEndMinute));
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [days, setDays] = useState<DayDraft[]>(() => draftFrom(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [initial] = useState(() =>
    JSON.stringify([
      existing?.name ?? '', existing?.type ?? 'FIXED', String(existing?.graceMinutes ?? 10), String(existing?.includedBreakMinutes ?? 60),
      toHHMM(existing?.coreStartMinute), toHHMM(existing?.coreEndMinute), existing?.isDefault ?? false, draftFrom(existing),
    ]),
  );
  const dirty = JSON.stringify([name, type, grace, includedBreak, coreStart, coreEnd, isDefault, days]) !== initial;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const rangeMessage = fmt(w.wholeNumberRange, { min: 0, max: 240 });

  const setDay = (wd: number, patch: Partial<DayDraft>) => setDays((all) => all.map((d, i) => (i === wd ? { ...d, ...patch } : d)));
  /** Minutes required on a day: the shift length for fixed schedules, the typed hours for flexible ones. */
  const required = (d: DayDraft): number | null => {
    if (!d.works) return 0;
    if (type === 'FIXED') {
      const a = fromHHMM(d.start);
      const b = fromHHMM(d.end);
      return a === null || b === null || a === b ? null : spanMinutes(a, b);
    }
    const h = parseLocaleNumber(d.hours);
    return h !== null && h > 0 && h <= 24 ? Math.round(h * 60) : null;
  };
  const weekly = days.reduce((sum, d) => sum + (required(d) ?? 0), 0);

  const firstWorkday = days.findIndex((d) => d.works);
  const copyFirst = () => {
    const first = days[firstWorkday];
    if (first) setDays((all) => all.map((d) => (d.works ? { ...d, start: first.start, end: first.end, hours: first.hours } : d)));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!name.trim()) v.name = t.employees.required;
    const g = minutesOf(grace);
    if (g === null) v.graceMinutes = rangeMessage;
    const ib = minutesOf(includedBreak);
    if (ib === null) v.includedBreakMinutes = rangeMessage;
    if (!days.some((d) => d.works)) v.days = s.noWorkdays;
    if (days.some((d) => d.works && required(d) === null)) v.days = type === 'FIXED' ? s.invalidTime : s.invalidHours;
    const cs = type === 'FLEXIBLE' && coreStart ? fromHHMM(coreStart) : null;
    const ce = type === 'FLEXIBLE' && coreEnd ? fromHHMM(coreEnd) : null;
    if (type === 'FLEXIBLE' && (cs === null) !== (ce === null)) v.core = s.invalidCore;
    if (cs !== null && ce !== null && ce <= cs) v.core = s.invalidCore;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length || g === null || ib === null) {
      const order: [string, string][] = [['name', 'sc-name'], ['graceMinutes', 'sc-grace'], ['includedBreakMinutes', 'sc-break'], ['core', 'sc-core-start']];
      document.getElementById(order.find(([k]) => v[k])?.[1] ?? '')?.focus();
      return;
    }

    const body = {
      name: name.trim(), type, graceMinutes: g, includedBreakMinutes: ib, isDefault, coreStartMinute: cs, coreEndMinute: ce,
      days: days.map((d, weekday) =>
        d.works
          ? {
              weekday, isWorkday: true, requiredMinutes: required(d)!,
              startMinute: type === 'FIXED' ? fromHHMM(d.start) : null,
              endMinute: type === 'FIXED' ? fromHHMM(d.end) : null,
            }
          : { weekday, isWorkday: false, requiredMinutes: 0, startMinute: null, endMinute: null }),
    };
    setSaving(true);
    try {
      if (existing) await api<ScheduleDto>(`/schedules/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body });
      else await api<ScheduleDto>('/schedules', { method: 'POST', body });
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // Localized messages only; the API's English field text is not shown.
        const fe = fieldErrorsFrom(err.details);
        setErrors(Object.fromEntries(Object.keys(fe).map((k) => [k, k.endsWith('Minutes') ? rangeMessage : t.errors.VALIDATION_FAILED])));
      }
      if (err instanceof ApiError && err.code === 'CONFLICT') setErrors({ name: t.errors.CONFLICT });
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id="sc-name" label={t.common.name} error={errors.name} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} dir="auto" />}
        </FormField>
        <FormField id="sc-type" label={s.type}>
          {({ id, describedBy }) => (
            <Select value={type} onValueChange={(v) => setType(v as 'FIXED' | 'FLEXIBLE')}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FIXED">{t.scheduleType.FIXED}</SelectItem>
                <SelectItem value="FLEXIBLE">{t.scheduleType.FLEXIBLE}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField id="sc-grace" label={s.grace} hint={s.graceHint} error={errors.graceMinutes}>
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={w.units.min}
              inputMode="numeric"
              value={grace}
              onChange={(e) => setGrace(e.target.value)}
              onBlur={() => setErrors((er) => ({ ...er, graceMinutes: minutesOf(grace) === null ? rangeMessage : '' }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        <FormField id="sc-break" label={s.includedBreak} hint={s.includedBreakHint} error={errors.includedBreakMinutes} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={w.units.min}
              inputMode="numeric"
              wrapperClassName="max-w-40"
              value={includedBreak}
              onChange={(e) => setIncludedBreak(e.target.value)}
              onBlur={() => setErrors((er) => ({ ...er, includedBreakMinutes: minutesOf(includedBreak) === null ? rangeMessage : '' }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        {type === 'FLEXIBLE' && (
          <>
            <FormField id="sc-core-start" label={s.coreStart} hint={s.coreHint} error={errors.core} optional>
              {({ id, describedBy, invalid }) => <Input id={id} type="time" dir="ltr" value={coreStart} onChange={(e) => setCoreStart(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />}
            </FormField>
            <FormField id="sc-core-end" label={s.coreEnd} optional>
              {({ id, describedBy }) => <Input id={id} type="time" dir="ltr" value={coreEnd} onChange={(e) => setCoreEnd(e.target.value)} aria-describedby={describedBy} />}
            </FormField>
          </>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{s.days}</p>
          {firstWorkday >= 0 && (
            <Button type="button" variant="outline" size="sm" className="max-md:min-h-10" onClick={copyFirst}>
              <Copy aria-hidden />
              {fmt(w.schedules.copyDay, { day: s.weekdays[firstWorkday] ?? '' })}
            </Button>
          )}
        </div>
        <div className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
          {days.map((d, wd) => {
            const req = required(d);
            const a = fromHHMM(d.start);
            const b = fromHHMM(d.end);
            return (
              <div key={wd} className={cn('flex flex-wrap items-center gap-3 px-3 py-2', !d.works && 'opacity-60')}>
                <label className="flex w-32 items-center gap-2 text-sm font-medium">
                  <Checkbox checked={d.works} onCheckedChange={(c) => setDay(wd, { works: c === true })} aria-label={`${s.workday}: ${s.weekdays[wd]}`} />
                  {s.weekdays[wd]}
                </label>
                {d.works ? (
                  type === 'FIXED' ? (
                    <>
                      <Input type="time" dir="ltr" className="w-28" value={d.start} onChange={(e) => setDay(wd, { start: e.target.value })} aria-label={`${s.start}: ${s.weekdays[wd]}`} />
                      <span className="text-muted-foreground">–</span>
                      <Input type="time" dir="ltr" className="w-28" value={d.end} onChange={(e) => setDay(wd, { end: e.target.value })} aria-label={`${s.end}: ${s.weekdays[wd]}`} />
                      <Minutes value={req} className="text-muted-foreground text-xs" dimZero={false} />
                      {a !== null && b !== null && b < a && <span className="text-xs text-[color:var(--status-break)]">{s.overnight}</span>}
                    </>
                  ) : (
                    <>
                      <UnitInput
                        inputMode="decimal"
                        unit={w.units.hours}
                        wrapperClassName="w-28"
                        value={d.hours}
                        onChange={(e) => setDay(wd, { hours: e.target.value })}
                        aria-label={`${s.hours}: ${s.weekdays[wd]}`}
                      />
                    </>
                  )
                ) : (
                  <span className="text-muted-foreground text-sm">{s.off}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">{withDuration(s.weeklyTotal, weekly)}</p>
          {errors.days && (
            <p role="alert" className="text-xs text-[color:var(--status-absent)]">
              {errors.days}
            </p>
          )}
        </div>
      </div>

      {/* Applied on Save, so this is a checkbox, not a switch. */}
      <CheckRow id="sc-default" checked={isDefault} onCheckedChange={setIsDefault} label={s.isDefault} description={s.isDefaultHint} />

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

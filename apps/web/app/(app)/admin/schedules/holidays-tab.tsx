'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { HolidayDto } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckRow, FormField } from '@/components/form-field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiError, api, apiDelete, apiPost } from '@/lib/api';
import { addDays, daysBetween, formatNumber, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
/** Weekday of a calendar date (0 = Sunday), independent of the browser's time zone. */
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).getUTCDay();
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** The API accepts holidays of up to 31 days in one range. */
const MAX_SPAN_DAYS = 31;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A holiday as people think of it: consecutive days with the same name (e.g. a four-day Eid). */
interface HolidayGroup {
  name: string;
  items: HolidayDto[];
}

type Editing = { kind: 'new'; date: string } | { kind: 'edit'; group: HolidayGroup };

/** Every date from `from` to `to` (inclusive). */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Consecutive runs of sorted dates: ['01','02','05'] -> [['01','02'], ['05']]. */
function runsOf(dates: string[]): { from: string; to: string }[] {
  const runs: { from: string; to: string }[] = [];
  for (const d of dates) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d;
    else runs.push({ from: d, to: d });
  }
  return runs;
}

export function HolidaysTab() {
  const { t, locale, errorMessage } = useI18n();
  const h = t.schedules.holidays;
  const today = todayInAmman();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const list = useApi<HolidayDto[]>('/holidays', { year });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  // All days of the holiday being deleted (a multi-day holiday such as Eid goes in one step).
  const [deleting, setDeleting] = useState<HolidayDto[] | null>(null);
  const nameOf = (x: HolidayDto) => localized(locale, x.name, x.nameAr);
  const intlLocale = locale === 'ar' ? 'ar' : 'en-GB';
  const monthName = (m: number) => new Intl.DateTimeFormat(intlLocale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, m, 1)));
  // Narrow weekday names from Intl ("S M T…" / "ح ن ث…"), Sunday first: never cut-off words.
  const weekdayHeaders = useMemo(() => {
    const f = new Intl.DateTimeFormat(intlLocale, { weekday: 'narrow', timeZone: 'UTC' });
    // 1 January 2023 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i))));
  }, [intlLocale]);

  const groups = useMemo(() => {
    const out: HolidayGroup[] = [];
    for (const x of list.data ?? []) {
      const last = out[out.length - 1];
      const prev = last?.items[last.items.length - 1];
      if (last && prev && last.name === x.name && addDays(prev.date, 1) === x.date) last.items.push(x);
      else out.push({ name: x.name, items: [x] });
    }
    return out;
  }, [list.data]);
  /** Any day of a group opens the whole group. */
  const groupByDate = useMemo(() => {
    const map = new Map<string, HolidayGroup>();
    for (const g of groups) for (const x of g.items) map.set(x.date, g);
    return map;
  }, [groups]);

  const close = () => {
    setEditing(null);
    setFormDirty(false);
  };
  const rangeLabel = (items: HolidayDto[]) =>
    items.length > 1 ? `${formatWorkDate(items[0]!.date, locale)} – ${formatWorkDate(items[items.length - 1]!.date, locale)}` : formatWorkDate(items[0]?.date, locale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon-sm" className="max-md:size-10" onClick={() => setYear((y) => y - 1)} aria-label={`${h.year} ${year - 1}`}>
            {locale === 'ar' ? <ChevronRight aria-hidden /> : <ChevronLeft aria-hidden />}
          </Button>
          <span className="tabular w-16 text-center text-lg font-bold">{year}</span>
          <Button variant="outline" size="icon-sm" className="max-md:size-10" onClick={() => setYear((y) => y + 1)} aria-label={`${h.year} ${year + 1}`}>
            {locale === 'ar' ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
          </Button>
        </div>
        {/* "Click a day to add a holiday" (h.clickHint) is the section's "?" next to the page title. */}
        <Button onClick={() => setEditing({ kind: 'new', date: year === Number(today.slice(0, 4)) ? today : `${year}-01-01` })}>
          <Plus aria-hidden />
          {h.add}
        </Button>
      </div>

      {list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 12 }, (_, m) => {
              const blanks = weekdayOf(year, m, 1);
              return (
                <Card key={m} className="gap-2 py-3">
                  <CardHeader className="px-3">
                    <CardTitle className="text-sm">{monthName(m)}</CardTitle>
                  </CardHeader>
                  <CardContent className="px-3">
                    <div className="grid grid-cols-7 gap-0.5 text-center">
                      {weekdayHeaders.map((w, i) => (
                        <span key={i} className="text-muted-foreground pb-1 text-xs" aria-hidden>
                          {w}
                        </span>
                      ))}
                      {Array.from({ length: blanks }, (_, i) => (
                        <span key={`b${i}`} />
                      ))}
                      {Array.from({ length: daysIn(year, m) }, (_, i) => {
                        const d = i + 1;
                        const date = iso(year, m, d);
                        const group = groupByDate.get(date);
                        const holiday = group?.items.find((x) => x.date === date);
                        const wd = weekdayOf(year, m, d);
                        return (
                          <button
                            key={date}
                            type="button"
                            onClick={() => setEditing(group ? { kind: 'edit', group } : { kind: 'new', date })}
                            title={holiday ? nameOf(holiday) : undefined}
                            aria-label={`${formatWorkDate(date, locale, 'long')}${holiday ? ` - ${nameOf(holiday)}` : ''}`}
                            className={cn(
                              'tabular flex aspect-square min-h-6 items-center justify-center rounded-md text-xs hover:bg-tint/[0.08]',
                              (wd === 5 || wd === 6) && !holiday && 'text-muted-foreground',
                              holiday && 'bg-brand-gradient font-bold text-white',
                              date === today && !holiday && 'ring-1 ring-[color:var(--brand-soft)]',
                            )}
                          >
                            {formatNumber(d, locale)}
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="h-fit gap-3">
            <CardHeader>
              <CardTitle>{fmt(h.list, { year })}</CardTitle>
              <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="bg-brand-gradient size-3 rounded" aria-hidden />
                  {h.legendHoliday}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-3 rounded ring-1 ring-[color:var(--brand-soft)]" aria-hidden />
                  {h.legendToday}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {groups.length === 0 ? (
                <EmptyState title={h.empty} />
              ) : (
                <ul className="divide-y divide-tint/[0.05]">
                  {groups.map((g) => (
                    <li key={g.items[0]!.id} className="flex items-center gap-2 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          <bdi>{nameOf(g.items[0]!)}</bdi>
                        </p>
                        <p className="text-muted-foreground tabular text-xs">{rangeLabel(g.items)}</p>
                      </div>
                      {g.items.length > 1 && <Badge variant="outline">{fmt(h.days, { n: formatNumber(g.items.length, locale) })}</Badge>}
                      {!g.items[0]!.isPaid && <Badge variant="outline">{t.home.unpaid}</Badge>}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="max-md:size-10"
                        onClick={() => setEditing({ kind: 'edit', group: g })}
                        aria-label={`${t.common.edit}: ${nameOf(g.items[0]!)}`}
                      >
                        <Pencil aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{editing?.kind === 'edit' ? h.editTitle : h.createTitle}</DialogTitle>
            <DialogDescription>{editing?.kind === 'edit' ? rangeLabel(editing.group.items) : h.toHint}</DialogDescription>
          </DialogHeader>
          {editing && (
            <HolidayForm
              key={editing.kind === 'edit' ? editing.group.items[0]!.id : editing.date}
              editing={editing}
              onDirtyChange={setFormDirty}
              onCancel={close}
              onDelete={(items) => {
                close();
                setDeleting(items);
              }}
              onSaved={() => {
                close();
                void list.refetch();
              }}
              onPartial={(message) => {
                // Some days already changed: the open form's snapshot is stale, so a retry would diff against
                // days that no longer exist. Close it and reload; reopening the holiday starts from the server.
                close();
                void list.refetch();
                toast.warning(t.adminWorkflows.holidays.partialSaved, { description: message });
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={deleting?.length ? fmt(h.deleteTitle, { name: nameOf(deleting[0]!), date: rangeLabel(deleting) }) : ''}
        description={h.deleteBody}
        confirmLabel={t.common.delete}
        onConfirm={async () => {
          if (!deleting?.length) return false;
          try {
            for (const x of deleting) await apiDelete<unknown>(`/holidays/${encodeURIComponent(x.id)}`);
            toast.success(h.deletedToast);
            void list.refetch();
            return true;
          } catch (err) {
            toast.error(errorMessage(err));
            void list.refetch();
            return false;
          }
        }}
      />
    </div>
  );
}

function HolidayForm({ editing, onCancel, onSaved, onDelete, onDirtyChange, onPartial }: {
  editing: Editing;
  onCancel: () => void;
  onSaved: () => void;
  onDelete: (items: HolidayDto[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Some days were already changed when a later step failed (with the error text): close and reload. */
  onPartial: (message: string) => void;
}) {
  const { t, errorMessage } = useI18n();
  const h = t.schedules.holidays;
  const w = t.adminWorkflows.holidays;
  const group = editing.kind === 'edit' ? editing.group.items : null;
  const first = group?.[0] ?? null;
  const [initial] = useState(() => ({
    name: first?.name ?? '',
    nameAr: first?.nameAr ?? '',
    from: group ? group[0]!.date : editing.kind === 'new' ? editing.date : '',
    to: group ? group[group.length - 1]!.date : editing.kind === 'new' ? editing.date : '',
    isPaid: first?.isPaid ?? true,
  }));
  const [name, setName] = useState(initial.name);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [isPaid, setIsPaid] = useState(initial.isPaid);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = name !== initial.name || nameAr !== initial.nameAr || from !== initial.from || to !== initial.to || isPaid !== initial.isPaid;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!name.trim()) v.name = t.employees.required;
    if (!from) v.from = t.myAttendance.rangeInvalid;
    else if (!to || to < from) v.to = t.myAttendance.rangeInvalid;
    else if (daysBetween(from, to) > MAX_SPAN_DAYS) v.to = w.tooLong;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      document.getElementById(v.name ? 'ho-name' : v.from ? 'ho-from' : 'ho-to')?.focus();
      return;
    }
    const text = { name: name.trim(), nameAr: nameAr.trim() };
    setSaving(true);
    let changedSomething = false;
    try {
      if (!group) {
        await apiPost<HolidayDto[]>('/holidays/range', { from, to, name: text.name, ...(text.nameAr ? { nameAr: text.nameAr } : {}), isPaid });
        toast.success(h.addedToast);
      } else {
        // Save the whole group by difference: add new days, update kept ones, remove the rest.
        const wanted = datesBetween(from, to);
        const wantedSet = new Set(wanted);
        const existingDates = new Set(group.map((x) => x.date));
        const added = wanted.filter((d) => !existingDates.has(d));
        const kept = group.filter((x) => wantedSet.has(x.date));
        const removed = group.filter((x) => !wantedSet.has(x.date));
        // Additions first: they are the step that can clash with another holiday, before anything else changes.
        for (const run of runsOf(added)) {
          await apiPost<HolidayDto[]>('/holidays/range', { ...run, name: text.name, ...(text.nameAr ? { nameAr: text.nameAr } : {}), isPaid });
          changedSomething = true;
        }
        for (const x of kept) {
          if (x.name === text.name && (x.nameAr ?? '') === text.nameAr && x.isPaid === isPaid) continue;
          await api<HolidayDto>(`/holidays/${encodeURIComponent(x.id)}`, { method: 'PATCH', body: { name: text.name, nameAr: text.nameAr || null, isPaid } });
          changedSomething = true;
        }
        for (const x of removed) {
          await apiDelete<unknown>(`/holidays/${encodeURIComponent(x.id)}`);
          changedSomething = true;
        }
        toast.success(h.savedToast);
      }
      onSaved();
    } catch (err) {
      if (changedSomething) {
        onPartial(errorMessage(err));
        return;
      }
      if (err instanceof ApiError && err.code === 'CONFLICT') setErrors({ to: w.taken });
      else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors({ to: w.tooLong });
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="ho-name" label={h.name} error={errors.name} required>
          {({ id, describedBy, invalid, required }) => (
            <Input id={id} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} aria-required={required} maxLength={120} dir="auto" />
          )}
        </FormField>
        <FormField id="ho-nameAr" label={h.nameAr} optional>
          {({ id, describedBy }) => <Input id={id} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} maxLength={120} />}
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="ho-from" label={h.from} error={errors.from}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="date"
              value={from}
              onChange={(e) => {
                const next = e.target.value;
                // Moving the first day moves the last day with it, so the holiday keeps its length
                // (Eid 1–4 April moved to the 8th becomes 8–11 April, not a one-day holiday).
                if (DATE_RE.test(next) && DATE_RE.test(from) && DATE_RE.test(to) && to >= from) setTo(addDays(next, daysBetween(from, to) - 1));
                else if (to && next && to < next) setTo(next);
                setFrom(next);
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        <FormField id="ho-to" label={h.to} hint={group ? w.groupHint : h.toHint} error={errors.to}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
          )}
        </FormField>
      </div>
      {/* Applied on Save, so this is a checkbox, not a switch. */}
      <CheckRow id="ho-paid" checked={isPaid} onCheckedChange={setIsPaid} label={h.isPaid} />
      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}
      <DialogFooter className="sm:justify-between">
        {group ? (
          <Button type="button" variant="ghost" className="text-[color:var(--status-absent)]" onClick={() => onDelete(group)} disabled={saving}>
            <Trash2 aria-hidden />
            {t.common.delete}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? t.common.saving : group ? t.common.save : h.add}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { WORK_HOURS_RANGES, type CreateWorkHoursRuleInput, type WorkHoursRuleDto } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { ErrorState, LoadingRows, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, apiDelete, apiPost } from '@/lib/api';
import { formatMinutes, formatWorkDate, parseLocaleNumber, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

/** 540 -> "9:00" (the daily hours field shows and takes H:MM). */
export const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

/** "9:00", "8:30" or plain hours ("9", "8.5"), digits in any script, -> whole minutes, or null. */
export function parseHours(text: string): number | null {
  const parts = text.trim().split(':');
  const [hours = '', mins] = parts;
  if (parts.length > 2) return null;
  const h = parseLocaleNumber(hours);
  if (mins === undefined) return h === null || h < 0 || !Number.isInteger(h * 60) ? null : h * 60;
  const m = parseLocaleNumber(mins);
  if (h === null || m === null || !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

type Field = 'effectiveFrom' | 'daily' | 'break';
const ids: Record<Field, string> = { effectiveFrom: 'wh-from', daily: 'wh-daily', break: 'wh-break' };
const DAILY = WORK_HOURS_RANGES.dailyRequiredMinutes;
const BREAK = WORK_HOURS_RANGES.includedBreakMinutes;

/** The rule in force on a date: the latest effectiveFrom on or before it (rules sorted ascending). */
function ruleOn(rules: WorkHoursRuleDto[], date: string): WorkHoursRuleDto | null {
  let found: WorkHoursRuleDto | null = null;
  for (const r of rules) if (r.effectiveFrom <= date) found = r;
  return found;
}

/** Company working hours by date: the rule in force, every rule, and a form to change the hours from a date. */
export function WorkHoursCard() {
  const { t } = useI18n();
  const g = t.adminWorkflows.general;
  const rules = useApi<WorkHoursRuleDto[]>('/settings/work-hours');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-base">
          {g.hoursTitle}
          <HelpTip text={g.hoursHelp} />
        </CardTitle>
        <p className="sr-only">{g.hoursHelp}</p>
      </CardHeader>
      <CardContent>
        {rules.error && !rules.data ? (
          <ErrorState error={rules.error} onRetry={() => void rules.refetch()} compact />
        ) : !rules.data ? (
          <LoadingRows rows={3} className="px-0" />
        ) : (
          <WorkHoursBody rules={[...rules.data].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))} onChanged={() => void rules.refetch()} />
        )}
      </CardContent>
    </Card>
  );
}

function WorkHoursBody({ rules, onChanged }: { rules: WorkHoursRuleDto[]; onChanged: () => void }) {
  const { t, locale, units, errorMessage } = useI18n();
  const w = t.adminWorkflows;
  const g = w.general;
  const today = todayInAmman();
  const current = ruleOn(rules, today);

  const [from, setFrom] = useState(today);
  const [daily, setDaily] = useState(hoursText(current?.dailyRequiredMinutes ?? 540));
  const [brk, setBrk] = useState(String(current?.includedBreakMinutes ?? 60));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<WorkHoursRuleDto | null>(null);

  const describe = (r: { dailyRequiredMinutes: number; includedBreakMinutes: number }) => {
    const hours = formatMinutes(r.dailyRequiredMinutes, units);
    return r.includedBreakMinutes > 0
      ? fmt(g.hoursValue, { hours, break: formatMinutes(r.includedBreakMinutes, units) })
      : fmt(g.hoursNoBreak, { hours });
  };
  const fromLabel = (r: WorkHoursRuleDto, i: number) => (i === 0 ? g.fromStart : fmt(g.fromDate, { date: formatWorkDate(r.effectiveFrom, locale) }));
  const status = (r: WorkHoursRuleDto) =>
    r.effectiveFrom > today ? g.statusUpcoming : r.id === current?.id ? g.statusCurrent : g.statusPast;

  const check = (): { input: CreateWorkHoursRuleInput | null; found: Partial<Record<Field, string>> } => {
    const found: Partial<Record<Field, string>> = {};
    const d = parseHours(daily);
    const b = parseLocaleNumber(brk);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) found.effectiveFrom = g.effectiveFromInvalid;
    const dailyOk = d !== null && Number.isInteger(d) && d >= DAILY.min && d <= DAILY.max;
    if (!dailyOk) found.daily = fmt(g.dailyHoursInvalid, { min: hoursText(DAILY.min), max: hoursText(DAILY.max) });
    if (b === null || !Number.isInteger(b) || b < BREAK.min || b > BREAK.max || (dailyOk && b > d!)) found.break = fmt(g.breakInvalid, BREAK);
    const ok = Object.keys(found).length === 0;
    return { found, input: ok ? { effectiveFrom: from, dailyRequiredMinutes: d!, includedBreakMinutes: b! } : null };
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { input, found } = check();
    setErrors(found);
    if (!input) {
      focusFirstError((Object.keys(ids) as Field[]).filter((f) => found[f]).map((f) => ids[f]));
      return;
    }
    setSaving(true);
    try {
      await apiPost<WorkHoursRuleDto>('/settings/work-hours', input);
      toast.success(g.ruleSaved);
      onChanged();
    } catch (err) {
      // The API's English text is never shown: a rejected value gets the localized form message.
      setFormError(err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? w.saveFailed : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const replaces = rules.some((r) => r.effectiveFrom === from);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid content-start gap-4">
        {current && (
          <div>
            <p className="text-muted-foreground text-xs">{g.inForceToday}</p>
            <p className="text-lg font-semibold">{describe(current)}</p>
          </div>
        )}
        <div className="grid gap-2">
          <p className="text-sm font-medium">{g.rulesTitle}</p>
          <ul className="divide-tint/10 divide-y rounded-xl border border-tint/10">
            {rules.map((r, i) => (
              <li key={r.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm', r.id === current?.id && 'bg-tint/5')}>
                <span className="min-w-28 font-medium">{fromLabel(r, i)}</span>
                <span className="text-muted-foreground">{describe(r)}</span>
                <Badge variant={r.id === current?.id ? 'default' : 'outline'} className="ms-auto">{status(r)}</Badge>
                {i > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={fmt(g.deleteRule, { date: formatWorkDate(r.effectiveFrom, locale) })}
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <form onSubmit={onSubmit} noValidate className="grid content-start gap-4">
        <p className="text-sm font-medium">{g.addTitle}</p>
        <FormField id={ids.effectiveFrom} label={g.effectiveFrom} hint={g.effectiveFromHint} error={errors.effectiveFrom} required>
          {({ id, describedBy, invalid, required }) => (
            <Input
              id={id}
              type="date"
              dir="ltr"
              className="w-44"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required}
            />
          )}
        </FormField>
        <FormField id={ids.daily} label={g.dailyHours} hint={g.dailyHoursHint} error={errors.daily} required>
          {({ id, describedBy, invalid, required }) => (
            <UnitInput id={id} unit={w.units.hours} dir="ltr" value={daily} onChange={setDaily} describedBy={describedBy} invalid={invalid} required={required} />
          )}
        </FormField>
        <FormField id={ids.break} label={g.includedBreak} hint={g.includedBreakHint} error={errors.break} required>
          {({ id, describedBy, invalid, required }) => (
            <UnitInput id={id} unit={w.units.min} inputMode="numeric" value={brk} onChange={setBrk} describedBy={describedBy} invalid={invalid} required={required} />
          )}
        </FormField>
        <p className="text-muted-foreground text-xs">{g.hoursExample}</p>
        {replaces && <p className="text-sm">{g.replacesExisting}</p>}
        {formError && (
          <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
            {formError}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" className="min-h-10 md:min-h-8" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {g.saveRule}
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={deleting ? fmt(g.deleteRuleTitle, { date: formatWorkDate(deleting.effectiveFrom, locale) }) : ''}
        description={g.deleteRuleBody}
        confirmLabel={t.common.delete}
        onConfirm={async () => {
          if (!deleting) return false;
          try {
            await apiDelete<void>(`/settings/work-hours/${encodeURIComponent(deleting.id)}`);
            toast.success(g.ruleDeleted);
            onChanged();
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

/** Text input with its unit inside the field (end side). */
function UnitInput({ id, unit, value, onChange, describedBy, invalid, required, dir, inputMode = 'text' }: {
  id: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  describedBy: string | undefined;
  invalid: true | undefined;
  required: true | undefined;
  dir?: 'ltr';
  inputMode?: 'text' | 'numeric';
}) {
  return (
    <div className="relative w-40">
      <Input
        id={id}
        type="text"
        autoComplete="off"
        inputMode={inputMode}
        dir={dir}
        className="tabular pe-16"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-required={required}
      />
      <span aria-hidden className="text-muted-foreground pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm">
        {unit}
      </span>
    </div>
  );
}

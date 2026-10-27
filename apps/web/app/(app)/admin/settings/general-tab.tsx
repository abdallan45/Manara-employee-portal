'use client';

import { useState, type ComponentProps, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { SETTING_DEFAULTS, SETTING_RANGES, type RangedSettingKey, type SettingDto } from '@workforce/shared';

import { FormField } from '@/components/form-field';
import { ErrorState, FormErrorSummary, LoadingRows, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';
import { formatWorkDate, parseLocaleNumber, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDirtyGuard } from '@/lib/use-dirty-guard';
import { cn } from '@/lib/utils';

type TextKey = 'company.name' | 'company.timezone';
// The attendance limits live on the Office locations section.
type NumericKey = Exclude<RangedSettingKey, 'attendance.maxOpenSessionHours' | 'attendance.maxLocationAccuracyMeters'>;
type FieldKey = TextKey | NumericKey;
const DAILY_KEY = 'attendance.dailyRequiredMinutes';
const HOURS: NumericKey[] = [DAILY_KEY, 'attendance.includedBreakMinutes'];
const NUMERIC: NumericKey[] = ['auth.maxFailedLogins', 'auth.lockoutMinutes', 'auth.sessionHours', 'auth.idleMinutes'];
const FIELDS: FieldKey[] = ['company.name', 'company.timezone', ...HOURS, ...NUMERIC];
/** Common IANA zones for the datalist; Amman first. Any valid zone can be typed. */
const TIME_ZONES = [
  'Asia/Amman', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Baghdad', 'Asia/Beirut',
  'Asia/Damascus', 'Asia/Jerusalem', 'Africa/Cairo', 'Europe/Istanbul', 'Europe/London', 'Europe/Berlin', 'UTC',
];

const fieldId = (key: FieldKey) => `set-${key.replace(/\./g, '-')}`;

/** 540 -> "9:00" (the daily hours field shows and takes H:MM). */
const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

/** "9:00", "8:30" or plain hours ("9", "8.5"), digits in any script, -> whole minutes, or null. */
function parseHours(text: string): number | null {
  const parts = text.trim().split(':');
  const [hours = '', mins] = parts;
  if (parts.length > 2) return null;
  const h = parseLocaleNumber(hours);
  if (mins === undefined) return h === null || h < 0 || !Number.isInteger(h * 60) ? null : h * 60;
  const m = parseLocaleNumber(mins);
  if (h === null || m === null || !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
const isNeverChanged = (s: SettingDto | undefined) => !s || new Date(s.updatedAt).getTime() === 0;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The stored value as the text the field shows. */
function loadedText(key: FieldKey, setting: SettingDto | undefined): string {
  const value = setting?.value ?? SETTING_DEFAULTS[key];
  if (key === DAILY_KEY) return hoursText(typeof value === 'number' ? value : SETTING_DEFAULTS[DAILY_KEY]);
  return typeof value === 'number' || typeof value === 'string' ? String(value) : String(SETTING_DEFAULTS[key]);
}

/** Field text -> the value the API takes (numbers parsed from any digit script), or undefined when it is not valid. */
function parsedValue(key: FieldKey, text: string): string | number | undefined {
  if (key === 'company.name') {
    const v = text.trim();
    return v.length >= 1 && v.length <= 200 ? v : undefined;
  }
  if (key === 'company.timezone') {
    const v = text.trim();
    return v && isValidTimeZone(v) ? v : undefined;
  }
  const n = key === DAILY_KEY ? parseHours(text) : parseLocaleNumber(text);
  const { min, max } = SETTING_RANGES[key];
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Text input with its unit inside the field (end side); digits in any script are parsed with parseLocaleNumber. */
function UnitInput({ unit, wrapperClassName, className, ...props }: ComponentProps<typeof Input> & { unit: string; wrapperClassName?: string }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input type="text" autoComplete="off" className={cn('tabular pe-16', className)} {...props} />
      <span aria-hidden className="text-muted-foreground pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm">
        {unit}
      </span>
    </div>
  );
}

/** Company, working hours & sign-in: one form, one sticky "Unsaved changes · Discard · Save changes" bar. */
export function GeneralTab() {
  const settings = useApi<SettingDto[]>('/settings');

  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <LoadingRows rows={5} />;

  const onSaved = (saved: SettingDto[]) => {
    const keys = new Set(saved.map((s) => s.key));
    settings.setData([...(settings.data ?? []).filter((s) => !keys.has(s.key)), ...saved]);
  };
  return <GeneralForm settings={settings.data} onSaved={onSaved} />;
}

function GeneralForm({ settings, onSaved }: { settings: SettingDto[]; onSaved: (saved: SettingDto[]) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const g = t.settings.general;
  const w = t.adminWorkflows;
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const loaded = Object.fromEntries(FIELDS.map((k) => [k, loadedText(k, byKey.get(k))])) as Record<FieldKey, string>;
  const [draft, setDraft] = useState<Record<FieldKey, string>>(loaded);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The summary appears after a submit attempt; blur checks only mark the field.
  const [submitted, setSubmitted] = useState(false);

  /** A field is changed when its value differs from the stored one (١٥ and 15 are the same number). */
  const changed = (key: FieldKey) => {
    const v = parsedValue(key, draft[key]);
    return v === undefined ? draft[key].trim() !== loaded[key] : v !== parsedValue(key, loaded[key]);
  };
  const dirtyKeys = FIELDS.filter(changed);
  const dirty = dirtyKeys.length > 0;
  useDirtyGuard(dirty);

  const messageFor = (key: FieldKey): string => {
    if (key === 'company.name') return w.general.companyNameRequired;
    if (key === 'company.timezone') return w.general.timeZoneInvalid;
    if (key === DAILY_KEY) return fmt(w.general.dailyHoursInvalid, { min: hoursText(SETTING_RANGES[key].min), max: hoursText(SETTING_RANGES[key].max) });
    return fmt(w.wholeNumberRange, SETTING_RANGES[key]);
  };
  const validate = (key: FieldKey, text = draft[key]) => {
    const problem = parsedValue(key, text) === undefined ? messageFor(key) : undefined;
    setErrors((e) => ({ ...e, [key]: problem }));
    return problem;
  };
  const set = (key: FieldKey, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const discard = () => {
    setDraft(loaded);
    setErrors({});
    setFormError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const found: Partial<Record<FieldKey, string>> = {};
    for (const key of FIELDS) if (parsedValue(key, draft[key]) === undefined) found[key] = messageFor(key);
    setErrors(found);
    const bad = FIELDS.filter((k) => found[k]);
    if (bad.length) {
      focusFirstError(bad.map(fieldId));
      return;
    }
    if (!dirty) return;
    setSaving(true);
    const saved: SettingDto[] = [];
    const failed: Partial<Record<FieldKey, string>> = {};
    let otherError: string | null = null;
    for (const key of dirtyKeys) {
      try {
        saved.push(await api<SettingDto>(`/settings/${encodeURIComponent(key)}`, { method: 'PATCH', body: { value: parsedValue(key, draft[key]) } }));
      } catch (err) {
        // Never show the API's English text: a rejected value gets the field's localized message.
        if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') failed[key] = messageFor(key);
        else otherError = errorMessage(err);
      }
    }
    setSaving(false);
    if (saved.length) {
      onSaved(saved);
      // Show what was stored (e.g. "15" for "١٥").
      setDraft((d) => {
        const next = { ...d };
        for (const s of saved) next[s.key as FieldKey] = loadedText(s.key as FieldKey, s);
        return next;
      });
    }
    const failedKeys = FIELDS.filter((k) => failed[k]);
    if (failedKeys.length || otherError) {
      setErrors(failed);
      setFormError(otherError ?? w.saveFailed);
      if (failedKeys.length) focusFirstError(failedKeys.map(fieldId));
      return;
    }
    toast.success(t.common.savedToast);
  };

  const meta = (key: FieldKey) => {
    const s = byKey.get(key);
    if (isNeverChanged(s)) return <Badge variant="outline">{w.defaultBadge}</Badge>;
    const defaultText = loadedText(key, undefined);
    const isDefault = loaded[key] === defaultText;
    return (
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* updatedAt is UTC; the date shown is the Amman calendar day. */}
        <span>{fmt(w.changedOn, { date: formatWorkDate(todayInAmman(Date.parse(s!.updatedAt)), locale) })}</span>
        {!isDefault && (
          <Button type="button" variant="link" size="sm" className="h-6 px-0 text-xs" onClick={() => set(key, defaultText)}>
            {w.resetToDefault}
          </Button>
        )}
      </span>
    );
  };

  const numeric: Record<NumericKey, { label: string; hint: string; unit: string }> = {
    'attendance.dailyRequiredMinutes': { label: w.general.dailyHours, hint: w.general.dailyHoursHint, unit: w.units.hours },
    'attendance.includedBreakMinutes': { label: w.general.includedBreak, hint: w.general.includedBreakHint, unit: w.units.min },
    'auth.maxFailedLogins': { label: g.maxFailedLogins, hint: g.maxFailedLoginsHint, unit: w.units.tries },
    'auth.lockoutMinutes': { label: g.lockoutMinutes, hint: g.lockoutMinutesHint, unit: w.units.min },
    'auth.sessionHours': { label: g.sessionHours, hint: g.sessionHoursHint, unit: w.units.hours },
    'auth.idleMinutes': { label: t.accountSecurity.idleMinutes, hint: t.accountSecurity.idleMinutesHint, unit: w.units.min },
  };
  const summary = FIELDS.filter((k) => errors[k]).map((k) => ({ id: fieldId(k), message: errors[k]! }));

  const numericField = (key: NumericKey) => {
    const f = numeric[key];
    const range = SETTING_RANGES[key];
    const show = key === DAILY_KEY ? hoursText : String;
    return (
      <div key={key} className="grid gap-1.5">
        <FormField
          id={fieldId(key)}
          label={f.label}
          hint={`${f.hint} ${fmt(w.rangeHint, { min: show(range.min), max: show(range.max), default: show(SETTING_DEFAULTS[key]) })}`}
          error={errors[key]}
        >
          {({ id, describedBy, invalid }) => (
            <UnitInput
              id={id}
              unit={f.unit}
              inputMode={key === DAILY_KEY ? 'text' : 'numeric'}
              dir={key === DAILY_KEY ? 'ltr' : undefined}
              wrapperClassName="w-40"
              value={draft[key]}
              onChange={(e) => set(key, e.target.value)}
              onBlur={() => draft[key].trim() && validate(key)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        {meta(key)}
      </div>
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormErrorSummary errors={submitted ? summary : []} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{w.general.companyTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-1.5">
              <FormField id={fieldId('company.name')} label={w.general.companyName} hint={w.general.companyNameHint} error={errors['company.name']} required>
                {({ id, describedBy, invalid, required }) => (
                  <Input
                    id={id}
                    value={draft['company.name']}
                    onChange={(e) => set('company.name', e.target.value)}
                    onBlur={() => validate('company.name')}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    aria-required={required}
                    maxLength={200}
                    dir="auto"
                  />
                )}
              </FormField>
              {meta('company.name')}
            </div>
            <div className="grid gap-1.5">
              <FormField id={fieldId('company.timezone')} label={w.general.timeZone} hint={w.general.timeZoneHint} error={errors['company.timezone']} required>
                {({ id, describedBy, invalid, required }) => (
                  <>
                    <Input
                      id={id}
                      list="set-timezones"
                      dir="ltr"
                      className="max-w-xs"
                      value={draft['company.timezone']}
                      onChange={(e) => set('company.timezone', e.target.value)}
                      onBlur={() => validate('company.timezone')}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      aria-required={required}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoComplete="off"
                    />
                    <datalist id="set-timezones">
                      {TIME_ZONES.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </>
                )}
              </FormField>
              {meta('company.timezone')}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{w.general.signInTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">{NUMERIC.map(numericField)}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{w.general.hoursTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            {HOURS.map(numericField)}
            <p className="text-muted-foreground text-xs">{w.general.hoursExample}</p>
          </CardContent>
        </Card>
      </div>

      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}

      {dirty && (
        <div
          role="region"
          aria-label={w.unsavedChanges}
          className="bg-popover/95 sticky bottom-20 z-20 mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-tint/15 px-4 py-2 shadow-2xl backdrop-blur md:bottom-4"
        >
          <span className="text-sm font-semibold">{w.unsavedChanges}</span>
          <div className="ms-auto flex gap-2">
            <Button type="button" variant="ghost" className="min-h-10 md:min-h-8" size="sm" onClick={discard} disabled={saving}>
              {w.discard}
            </Button>
            <Button type="submit" size="sm" className="min-h-10 md:min-h-8" disabled={saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {w.saveChanges}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

'use client';

import { useState, type ComponentProps, type FormEvent } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { OvertimePolicyDto, UpdateOvertimePolicyInput } from '@workforce/shared';

import { CheckRow, FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { EmptyState, ErrorState, FormErrorSummary, LoadingRows, focusFirstError } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { formatNumber, parseLocaleNumber } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDirtyGuard } from '@/lib/use-dirty-guard';
import { cn } from '@/lib/utils';

/** What the API accepts, checked on the parsed number written out in Western digits. */
const MULTIPLIER_RE = /^\d{1,2}(\.\d{1,2})?$/;
type MultiplierKey = 'regularMultiplier' | 'weekendMultiplier' | 'holidayMultiplier';
const RATE_KEYS: MultiplierKey[] = ['regularMultiplier', 'weekendMultiplier', 'holidayMultiplier'];

/** "1.25" / "١٫٢٥" -> canonical "1.25", or null when it is not a multiplier the API accepts (1.00–10.00, two decimals). */
function multiplierOf(value: string): string | null {
  const n = parseLocaleNumber(value);
  if (n === null) return null;
  const text = String(n);
  if (!MULTIPLIER_RE.test(text)) return null;
  return n >= 1 && n <= 10 ? text : null;
}

/** Minimum request minutes: a whole number 1–480 typed in any digit script, or null. */
function minimumOf(value: string): number | null {
  const n = parseLocaleNumber(value);
  return n !== null && Number.isInteger(n) && n >= 1 && n <= 480 ? n : null;
}

interface Draft {
  rates: Record<MultiplierKey, string>;
  minimum: string;
  requiresPreApproval: boolean;
  allowRetroApproval: boolean;
  notes: string;
}

const draftOf = (p: OvertimePolicyDto): Draft => ({
  rates: { regularMultiplier: p.regularMultiplier, weekendMultiplier: p.weekendMultiplier, holidayMultiplier: p.holidayMultiplier },
  minimum: String(p.minimumMinutes),
  requiresPreApproval: p.requiresPreApproval,
  allowRetroApproval: p.allowRetroApproval,
  notes: p.notes ?? '',
});

/** Two drafts mean the same policy (١٫٢٥ = 1.25 = 1.250). */
function samePolicy(a: Draft, b: Draft): boolean {
  const rate = (v: string) => multiplierOf(v) ?? v.trim();
  return (
    RATE_KEYS.every((k) => rate(a.rates[k]) === rate(b.rates[k]) || parseLocaleNumber(a.rates[k]) === parseLocaleNumber(b.rates[k])) &&
    (minimumOf(a.minimum) ?? a.minimum.trim()) === (minimumOf(b.minimum) ?? b.minimum.trim()) &&
    a.requiresPreApproval === b.requiresPreApproval &&
    a.allowRetroApproval === b.allowRetroApproval &&
    a.notes.trim() === b.notes.trim()
  );
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

export function OvertimeTab() {
  const { t } = useI18n();
  const policy = useApi<OvertimePolicyDto>('/overtime/policy');

  if (policy.error && !policy.data) {
    if (policy.error.code === 'CONFLICT') return <EmptyState title={t.settings.overtime.empty} />;
    return <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />;
  }
  if (!policy.data) return <LoadingRows rows={6} />;
  return <PolicyForm key={policy.data.id} policy={policy.data} onSaved={policy.setData} />;
}

function PolicyForm({ policy, onSaved }: { policy: OvertimePolicyDto; onSaved: (p: OvertimePolicyDto) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const o = t.settings.overtime;
  const w = t.adminWorkflows;
  const [loaded, setLoaded] = useState<Draft>(() => draftOf(policy));
  const [draft, setDraft] = useState<Draft>(loaded);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The summary appears after a submit attempt; blur checks only mark the field.
  const [submitted, setSubmitted] = useState(false);
  const dirty = !samePolicy(draft, loaded);
  useDirtyGuard(dirty);

  const rateFields: { key: MultiplierKey; label: string; hint: string }[] = [
    { key: 'regularMultiplier', label: o.regular, hint: o.regularHint },
    { key: 'weekendMultiplier', label: o.weekend, hint: o.weekendHint },
    { key: 'holidayMultiplier', label: o.holiday, hint: o.holidayHint },
  ];

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const validateRate = (key: MultiplierKey) =>
    setErrors((e) => ({ ...e, [key]: draft.rates[key].trim() && multiplierOf(draft.rates[key]) === null ? o.multiplierInvalid : '' }));

  const discard = () => {
    setDraft(loaded);
    setErrors({});
    setFormError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const v: Record<string, string> = {};
    for (const f of rateFields) if (multiplierOf(draft.rates[f.key]) === null) v[f.key] = o.multiplierInvalid;
    const min = minimumOf(draft.minimum);
    if (min === null) v.minimumMinutes = o.minimumInvalid;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length || min === null) {
      focusFirstError([...rateFields.filter((f) => v[f.key]).map((f) => `ot-${f.key}`), ...(v.minimumMinutes ? ['ot-minimum'] : [])]);
      return;
    }
    if (!dirty) return;

    const body: UpdateOvertimePolicyInput = {
      regularMultiplier: multiplierOf(draft.rates.regularMultiplier)!,
      weekendMultiplier: multiplierOf(draft.rates.weekendMultiplier)!,
      holidayMultiplier: multiplierOf(draft.rates.holidayMultiplier)!,
      minimumMinutes: min,
      requiresPreApproval: draft.requiresPreApproval,
      allowRetroApproval: draft.allowRetroApproval,
      notes: draft.notes.trim() || null,
    };
    setSaving(true);
    try {
      const saved = await api<OvertimePolicyDto>(`/overtime/policies/${encodeURIComponent(policy.id)}`, { method: 'PATCH', body });
      onSaved(saved);
      const next = draftOf(saved);
      setLoaded(next);
      setDraft(next);
      toast.success(t.common.savedToast);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const fe = fieldErrorsFrom(err.details);
        // Localized field messages only (the API's English text is not shown).
        setErrors({
          ...Object.fromEntries(RATE_KEYS.filter((k) => fe[k]).map((k) => [k, o.multiplierInvalid])),
          ...(fe.minimumMinutes ? { minimumMinutes: o.minimumInvalid } : {}),
        });
      }
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = [
    ...rateFields.filter((f) => errors[f.key]).map((f) => ({ id: `ot-${f.key}`, message: `${f.label}: ${errors[f.key]}` })),
    ...(errors.minimumMinutes ? [{ id: 'ot-minimum', message: `${o.minimumMinutes}: ${errors.minimumMinutes}` }] : []),
  ];

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div
        role="note"
        aria-labelledby="ot-statutory-title"
        aria-describedby="ot-statutory-note"
        className="flex items-center gap-2 rounded-xl border border-[color:var(--status-break)]/30 bg-[color:var(--status-break)]/10 px-3 py-2 text-sm"
      >
        <TriangleAlert className="size-4 shrink-0 text-[color:var(--status-break)]" aria-hidden />
        <p id="ot-statutory-title" className="min-w-0 font-semibold">
          {o.statutoryTitle}
        </p>
        <HelpTip text={o.statutoryNote} />
        <p id="ot-statutory-note" className="sr-only">
          {o.statutoryNote}
        </p>
      </div>

      <FormErrorSummary errors={submitted ? summary : []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {o.ratesTitle}
              <span className="text-muted-foreground text-sm font-normal">
                · <bdi>{policy.name}</bdi>
              </span>
              {policy.isDefault && <Badge variant="outline">{o.isDefault}</Badge>}
              <HelpTip text={o.existingNote} />
            </CardTitle>
            <p id="ot-existing-note" className="sr-only">
              {o.existingNote}
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            {rateFields.map((f) => {
              const m = multiplierOf(draft.rates[f.key]);
              const example = m === null ? null : Math.round(60 * Number(m));
              return (
                <FormField key={f.key} id={`ot-${f.key}`} label={f.label} error={errors[f.key] || undefined} hint={f.hint}>
                  {({ id, describedBy, invalid }) => (
                    <div className="space-y-1">
                      <UnitInput
                        id={id}
                        unit={w.units.times}
                        inputMode="decimal"
                        value={draft.rates[f.key]}
                        onChange={(e) => patch({ rates: { ...draft.rates, [f.key]: e.target.value } })}
                        onBlur={() => validateRate(f.key)}
                        aria-describedby={describedBy}
                        aria-invalid={invalid}
                        maxLength={6}
                      />
                      {example !== null && (
                        <p className="text-muted-foreground tabular text-xs">{fmt(o.multiplierExample, { n: formatNumber(example, locale) })}</p>
                      )}
                    </div>
                  )}
                </FormField>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{o.rulesTitle}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormField id="ot-minimum" label={o.minimumMinutes} error={errors.minimumMinutes || undefined} hint={`${o.minimumHint} ${fmt(w.rangeOnly, { min: 1, max: 480 })}`}>
              {({ id, describedBy, invalid }) => (
                <UnitInput
                  id={id}
                  unit={w.units.min}
                  inputMode="numeric"
                  wrapperClassName="w-36"
                  value={draft.minimum}
                  onChange={(e) => patch({ minimum: e.target.value })}
                  onBlur={() => setErrors((er) => ({ ...er, minimumMinutes: draft.minimum.trim() && minimumOf(draft.minimum) === null ? o.minimumInvalid : '' }))}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </FormField>
            {/* Applied on Save, so these are checkboxes, not switches. */}
            <CheckRow id="ot-pre" checked={draft.requiresPreApproval} onCheckedChange={(v) => patch({ requiresPreApproval: v })} label={o.requiresPreApproval} description={o.requiresPreApprovalHint} />
            <CheckRow id="ot-retro" checked={draft.allowRetroApproval} onCheckedChange={(v) => patch({ allowRetroApproval: v })} label={o.allowRetro} description={o.allowRetroHint} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent>
          <FormField id="ot-notes" label={o.notes} optional error={errors.notes} hint={o.notesHint}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} maxLength={2000} rows={3} dir="auto" />
            )}
          </FormField>
        </CardContent>
      </Card>

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
            <Button type="button" variant="ghost" size="sm" className="min-h-10 md:min-h-8" onClick={discard} disabled={saving}>
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

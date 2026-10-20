'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  MASCOT_MOODS,
  MASCOT_TRIGGERS,
  isMascotTime,
  type MascotArrival,
  type MascotConditions,
  type MascotGroupDto,
  type MascotGroupInput,
  type MascotMood,
  type MascotTrigger,
} from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { NouriaSvg } from '@/components/mascot/nouria-svg';
import { FormErrorSummary, focusFirstError } from '@/components/states';
import { CheckRow, FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { minutesOf } from '@/lib/mascot/context';
import { cn } from '@/lib/utils';

import { COMMON_ERROR_CODES, RELEVANT, breakTypeName, cleanConditions, withGroup } from './mascot-helpers';
import type { MascotStore } from './mascot-store';

const NAME_MAX = 120;
const ARRIVALS: MascotArrival[] = ['EARLY', 'ON_TIME', 'LATE'];
/** Sunday first, as the contract numbers them (Asia/Amman). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const INT_RE = /^-?\d+$/;

type TriState = 'any' | 'yes' | 'no';
const triOf = (v: boolean | undefined): TriState => (v === undefined ? 'any' : v ? 'yes' : 'no');
const boolOf = (v: TriState): boolean | undefined => (v === 'any' ? undefined : v === 'yes');

interface FormState {
  name: string;
  description: string;
  trigger: MascotTrigger;
  priority: string;
  moods: MascotMood[];
  isActive: boolean;
  timeFrom: string;
  timeTo: string;
  weekdays: number[];
  workday: TriState;
  arrival: MascotArrival[];
  earlyBefore: string;
  workMin: string;
  workMax: string;
  breakTypeCodes: string[];
  breakExceeded: TriState;
  errorCodes: string[];
}

function initialState(g: MascotGroupDto | null): FormState {
  const c: MascotConditions = g?.conditions ?? {};
  return {
    name: g?.name ?? '',
    description: g?.description ?? '',
    trigger: g?.trigger ?? 'CHECK_IN',
    priority: String(g?.priority ?? 0),
    moods: g?.moods ?? ['happy'],
    isActive: g?.isActive ?? true,
    timeFrom: c.timeFrom ?? '',
    timeTo: c.timeTo ?? '',
    weekdays: c.weekdays ?? [],
    workday: triOf(c.workday),
    arrival: c.arrival ?? [],
    earlyBefore: c.earlyBefore ?? '',
    workMin: c.workVsRequired?.min !== undefined ? String(c.workVsRequired.min) : '',
    workMax: c.workVsRequired?.max !== undefined ? String(c.workVsRequired.max) : '',
    breakTypeCodes: c.breakTypeCodes ?? [],
    breakExceeded: triOf(c.breakExceeded),
    errorCodes: c.errorCodes ?? [],
  };
}

/** Form field -> control id, in visual order (error summary and first-error focus follow it). */
const FIELD_IDS = {
  name: 'mg-name',
  description: 'mg-description',
  trigger: 'mg-trigger',
  priority: 'mg-priority',
  moods: 'mg-moods',
  timeFrom: 'mg-time-from',
  timeTo: 'mg-time-to',
  weekdays: 'mg-weekdays',
  workday: 'mg-workday',
  arrival: 'mg-arrival',
  earlyBefore: 'mg-early-before',
  workMin: 'mg-work-min',
  workMax: 'mg-work-max',
  breakTypeCodes: 'mg-break-types',
  breakExceeded: 'mg-break-exceeded',
  errorCodes: 'mg-error-custom',
} as const;
type FieldKey = keyof typeof FIELD_IDS;
const FIELD_ORDER = Object.keys(FIELD_IDS) as FieldKey[];

/** Server error keys (e.g. "conditions.timeFrom", "conditions.workVsRequired.min") -> form fields. */
function toFieldKey(serverKey: string): FieldKey | null {
  const k = serverKey.replace(/^conditions\./, '');
  if (k === 'workVsRequired.min' || k === 'workVsRequired') return 'workMin';
  if (k === 'workVsRequired.max') return 'workMax';
  const base = k.split(/[.[]/)[0] ?? k;
  return (FIELD_ORDER as string[]).includes(base) ? (base as FieldKey) : null;
}

export function GroupEditorDialog({ store, editing, onClose }: { store: MascotStore; editing: MascotGroupDto | 'new' | null; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.mascotAdmin.groups;
  const [dirty, setDirty] = useState(false);
  const close = () => {
    setDirty(false);
    onClose();
  };
  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent closeLabel={t.common.close} dirty={dirty} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing === 'new' ? m.createTitle : m.editTitle}</DialogTitle>
          <DialogDescription>{m.editorBody}</DialogDescription>
        </DialogHeader>
        {editing !== null && (
          <GroupForm key={editing === 'new' ? 'new' : editing.id} store={store} existing={editing === 'new' ? null : editing} onDirtyChange={setDirty} onDone={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Toggle chip (aria-pressed) used for days, moods, arrival, break types and error codes. */
function Chip({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors',
        pressed ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground border-border hover:bg-tint/[0.04] hover:text-foreground',
      )}
    >
      {pressed && <Check className="size-3.5" aria-hidden />}
      {children}
    </button>
  );
}

const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function ChipGroup({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5" role="group" aria-labelledby={`${id}-label`} aria-describedby={hint ? `${id}-hint` : undefined}>
      <div className="flex items-center gap-1">
        <span id={`${id}-label`} className="text-sm font-medium">
          {label}
        </span>
        {hint && <HelpTip text={hint} />}
      </div>
      <div id={id} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        {children}
      </div>
      {error && <p className="text-xs text-[color:var(--status-absent)]">{error}</p>}
      {hint && (
        <p id={`${id}-hint`} className="sr-only">
          {hint}
        </p>
      )}
    </div>
  );
}

function GroupForm({ store, existing, onDirtyChange, onDone }: {
  store: MascotStore;
  existing: MascotGroupDto | null;
  onDirtyChange: (dirty: boolean) => void;
  onDone: () => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const router = useRouter();
  const m = t.mascotAdmin;
  const e = m.editor;
  const [initial] = useState(() => initialState(existing));
  const [f, setF] = useState<FormState>(initial);
  const [errorCustom, setErrorCustom] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((p) => ({ ...p, [key]: value }));

  const dirty = JSON.stringify(f) !== JSON.stringify(initial) || errorCustom.trim() !== '';
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const relevant = new Set(RELEVANT[f.trigger]);
  const activeBreakTypes = useMemo(() => {
    const list = store.breakTypes ?? [];
    // Keep codes already chosen even if the type was switched off since.
    const codes = new Set([...list.filter((b) => b.isActive).map((b) => b.code), ...f.breakTypeCodes]);
    return [...codes];
  }, [store.breakTypes, f.breakTypeCodes]);

  const overnight = f.timeFrom && f.timeTo && isMascotTime(f.timeFrom) && isMascotTime(f.timeTo) && minutesOf(f.timeFrom) > minutesOf(f.timeTo);

  const labelOf: Record<FieldKey, string> = {
    name: e.name,
    description: e.description,
    trigger: e.trigger,
    priority: e.priority,
    moods: e.moods,
    timeFrom: e.timeFrom,
    timeTo: e.timeTo,
    weekdays: e.weekdays,
    workday: e.workday,
    arrival: e.arrival,
    earlyBefore: e.earlyBefore,
    workMin: e.workMin,
    workMax: e.workMax,
    breakTypeCodes: e.breakTypes,
    breakExceeded: e.breakExceeded,
    errorCodes: e.errorCodes,
  };
  const summary = FIELD_ORDER.filter((k) => errors[k]).map((k) => ({ id: FIELD_IDS[k], message: `${labelOf[k]}: ${errors[k]}` }));

  const addCustomCode = () => {
    const code = errorCustom.trim().toUpperCase().replace(/\s+/g, '_');
    if (!code) return;
    if (!f.errorCodes.includes(code)) set('errorCodes', [...f.errorCodes, code]);
    setErrorCustom('');
  };

  const validate = (): Partial<Record<FieldKey, string>> => {
    const v: Partial<Record<FieldKey, string>> = {};
    if (!f.name.trim()) v.name = e.required;
    else if (f.name.trim().length > NAME_MAX) v.name = fmt(e.nameTooLong, { n: NAME_MAX });
    if (!INT_RE.test(f.priority.trim())) v.priority = e.invalidNumber;
    if (relevant.has('timeFrom') && f.timeFrom && !isMascotTime(f.timeFrom)) v.timeFrom = e.invalidTime;
    if (relevant.has('timeTo') && f.timeTo && !isMascotTime(f.timeTo)) v.timeTo = e.invalidTime;
    if (relevant.has('earlyBefore') && f.earlyBefore && !isMascotTime(f.earlyBefore)) v.earlyBefore = e.invalidTime;
    if (relevant.has('workVsRequired')) {
      if (f.workMin.trim() && !INT_RE.test(f.workMin.trim())) v.workMin = e.invalidNumber;
      if (f.workMax.trim() && !INT_RE.test(f.workMax.trim())) v.workMax = e.invalidNumber;
      if (!v.workMin && !v.workMax && f.workMin.trim() && f.workMax.trim() && Number(f.workMin) > Number(f.workMax)) v.workMin = e.minAboveMax;
    }
    return v;
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const v = validate();
    setErrors(v);
    setFormError(null);
    const ids = FIELD_ORDER.filter((k) => v[k]).map((k) => FIELD_IDS[k]);
    if (ids.length) {
      focusFirstError(ids);
      return;
    }
    const pending = errorCustom.trim().toUpperCase().replace(/\s+/g, '_');
    const errorCodes = pending && !f.errorCodes.includes(pending) ? [...f.errorCodes, pending] : f.errorCodes;
    const conditions = cleanConditions(
      {
        timeFrom: f.timeFrom || undefined,
        timeTo: f.timeTo || undefined,
        weekdays: f.weekdays,
        workday: boolOf(f.workday),
        arrival: f.arrival,
        earlyBefore: f.arrival.includes('EARLY') ? f.earlyBefore || undefined : undefined,
        workVsRequired: { min: f.workMin.trim() ? Number(f.workMin) : undefined, max: f.workMax.trim() ? Number(f.workMax) : undefined },
        breakTypeCodes: f.breakTypeCodes,
        breakExceeded: boolOf(f.breakExceeded),
        errorCodes,
      },
      f.trigger,
    );
    const body: MascotGroupInput = {
      name: f.name.trim(),
      description: f.description.trim() || null,
      trigger: f.trigger,
      conditions,
      priority: Number(f.priority),
      moods: MASCOT_MOODS.filter((x) => f.moods.includes(x)),
      isActive: f.isActive,
    };
    setSaving(true);
    try {
      const saved = existing
        ? await api<MascotGroupDto>(`/mascot/groups/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body })
        : await api<MascotGroupDto>('/mascot/groups', { method: 'POST', body });
      store.update((c) => withGroup(c, saved));
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onDirtyChange(false);
      onDone();
      // A new group has no lines yet: go straight to them.
      if (!existing) router.push(`/admin/mascot?group=${encodeURIComponent(saved.id)}`);
    } catch (err) {
      const raw = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? fieldErrorsFrom(err.details) : {};
      const mapped: Partial<Record<FieldKey, string>> = {};
      const unmapped: string[] = [];
      for (const [k, msg] of Object.entries(raw)) {
        const key = toFieldKey(k);
        if (key) mapped[key] = msg;
        else unmapped.push(`${k}: ${msg}`);
      }
      const ids = FIELD_ORDER.filter((k) => mapped[k]).map((k) => FIELD_IDS[k]);
      setErrors(mapped);
      if (unmapped.length || !ids.length) setFormError(unmapped.length ? unmapped.join(' · ') : errorMessage(err));
      if (ids.length) focusFirstError(ids);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <FormErrorSummary errors={summary} />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={FIELD_IDS.name} label={e.name} error={errors.name} required className="sm:col-span-2">
          {({ id, describedBy, invalid, required }) => (
            <Input id={id} value={f.name} onChange={(ev) => set('name', ev.target.value)} placeholder={e.namePlaceholder} aria-describedby={describedBy} aria-invalid={invalid} aria-required={required} maxLength={NAME_MAX} />
          )}
        </FormField>
        <FormField id={FIELD_IDS.description} label={e.description} optional error={errors.description} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} rows={2} value={f.description} onChange={(ev) => set('description', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={500} />
          )}
        </FormField>
        <FormField id={FIELD_IDS.trigger} label={e.trigger} error={errors.trigger}>
          {({ id, describedBy }) => (
            <Select value={f.trigger} onValueChange={(v) => set('trigger', v as MascotTrigger)}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASCOT_TRIGGERS.map((tr) => (
                  <SelectItem key={tr} value={tr}>
                    {m.triggers[tr]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField id={FIELD_IDS.priority} label={e.priority} hint={e.priorityHint} error={errors.priority}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} dir="ltr" inputMode="numeric" value={f.priority} onChange={(ev) => set('priority', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} className="tabular" />
          )}
        </FormField>
      </div>

      <ChipGroup id={FIELD_IDS.moods} label={e.moods} hint={e.moodsHint} error={errors.moods}>
        {MASCOT_MOODS.map((mood) => (
          <Chip key={mood} pressed={f.moods.includes(mood)} onClick={() => set('moods', toggleIn(f.moods, mood))}>
            <span className="-ms-1 size-6 shrink-0" aria-hidden>
              <NouriaSvg mood={mood} compact />
            </span>
            {m.moods[mood]}
          </Chip>
        ))}
      </ChipGroup>

      <CheckRow id="mg-active" kind="switch" checked={f.isActive} onCheckedChange={(v) => set('isActive', v)} label={e.active} description={e.activeHint} />

      <fieldset className="grid gap-4 rounded-2xl border border-border p-4" aria-describedby="mg-conditions-hint">
        <legend className="flex items-center gap-1 px-1 text-sm font-semibold">
          {e.conditionsTitle}
          <HelpTip text={e.conditionsHint} />
        </legend>
        <p id="mg-conditions-hint" className="sr-only">
          {e.conditionsHint}
        </p>

        <div className="grid gap-1.5">
          <div className="grid grid-cols-2 gap-3">
            <FormField id={FIELD_IDS.timeFrom} label={e.timeFrom} optional error={errors.timeFrom}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="time" dir="ltr" value={f.timeFrom} onChange={(ev) => set('timeFrom', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
              )}
            </FormField>
            <FormField id={FIELD_IDS.timeTo} label={e.timeTo} optional error={errors.timeTo}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="time" dir="ltr" value={f.timeTo} onChange={(ev) => set('timeTo', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
              )}
            </FormField>
          </div>
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {overnight ? fmt(e.timeOvernight, { from: f.timeFrom, to: f.timeTo }) : e.timeHint}
          </p>
        </div>

        <ChipGroup id={FIELD_IDS.weekdays} label={e.weekdays} hint={e.weekdaysHint}>
          {WEEKDAYS.map((d) => (
            <Chip key={d} pressed={f.weekdays.includes(d)} onClick={() => set('weekdays', toggleIn(f.weekdays, d))}>
              {m.weekdaysShort[d]}
            </Chip>
          ))}
        </ChipGroup>

        {relevant.has('workday') && (
          <TriSelect id={FIELD_IDS.workday} label={e.workday} value={f.workday} onChange={(v) => set('workday', v)} options={{ any: e.workdayAny, yes: e.workdayYes, no: e.workdayNo }} />
        )}

        {relevant.has('arrival') && (
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem] sm:items-start">
            <ChipGroup id={FIELD_IDS.arrival} label={e.arrival} hint={e.arrivalHint}>
              {ARRIVALS.map((a) => (
                <Chip key={a} pressed={f.arrival.includes(a)} onClick={() => set('arrival', toggleIn(f.arrival, a))}>
                  {m.arrival[a]}
                </Chip>
              ))}
            </ChipGroup>
            {f.arrival.includes('EARLY') && (
              <FormField id={FIELD_IDS.earlyBefore} label={e.earlyBefore} hint={e.earlyBeforeHint} optional error={errors.earlyBefore}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="time" dir="ltr" value={f.earlyBefore} onChange={(ev) => set('earlyBefore', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </FormField>
            )}
          </div>
        )}

        {relevant.has('workVsRequired') && (
          <div className="grid gap-1.5" role="group" aria-labelledby="mg-work-title" aria-describedby="mg-work-hint">
            <p id="mg-work-title" className="flex items-center gap-1 text-sm font-medium">
              {e.workVsRequired}
              <HelpTip text={e.workHint} />
            </p>
            <div className="grid grid-cols-2 gap-3">
              <FormField id={FIELD_IDS.workMin} label={e.workMin} optional error={errors.workMin}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} dir="ltr" inputMode="numeric" value={f.workMin} onChange={(ev) => set('workMin', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} className="tabular" placeholder="60" />
                )}
              </FormField>
              <FormField id={FIELD_IDS.workMax} label={e.workMax} optional error={errors.workMax}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} dir="ltr" inputMode="numeric" value={f.workMax} onChange={(ev) => set('workMax', ev.target.value)} aria-describedby={describedBy} aria-invalid={invalid} className="tabular" placeholder="-120" />
                )}
              </FormField>
            </div>
            <p id="mg-work-hint" className="sr-only">
              {e.workHint}
            </p>
          </div>
        )}

        {relevant.has('breakTypeCodes') && (
          <ChipGroup id={FIELD_IDS.breakTypeCodes} label={e.breakTypes} hint={e.breakTypesHint} error={errors.breakTypeCodes}>
            {activeBreakTypes.map((code) => (
              <Chip key={code} pressed={f.breakTypeCodes.includes(code)} onClick={() => set('breakTypeCodes', toggleIn(f.breakTypeCodes, code))}>
                {breakTypeName(code, store.breakTypes, locale)}
              </Chip>
            ))}
          </ChipGroup>
        )}

        {relevant.has('breakExceeded') && (
          <TriSelect
            id={FIELD_IDS.breakExceeded}
            label={e.breakExceeded}
            value={f.breakExceeded}
            onChange={(v) => set('breakExceeded', v)}
            options={{ any: e.breakExceededAny, yes: e.breakExceededYes, no: e.breakExceededNo }}
          />
        )}

        {relevant.has('errorCodes') && (
          <div className="grid gap-3">
            <ChipGroup id="mg-error-codes" label={e.errorCodes} hint={e.errorCodesHint} error={errors.errorCodes}>
              {COMMON_ERROR_CODES.map((code) => (
                <Chip key={code} pressed={f.errorCodes.includes(code)} onClick={() => set('errorCodes', toggleIn(f.errorCodes, code))}>
                  <span>{e.errorLabels[code]}</span>
                  <span className="text-muted-foreground text-xs" dir="ltr">
                    {code}
                  </span>
                </Chip>
              ))}
              {f.errorCodes
                .filter((code) => !(COMMON_ERROR_CODES as readonly string[]).includes(code))
                .map((code) => (
                  <Chip key={code} pressed onClick={() => set('errorCodes', f.errorCodes.filter((x) => x !== code))} label={fmt(e.removeCode, { code })}>
                    <span dir="ltr">{code}</span>
                    <X className="size-3.5" aria-hidden />
                  </Chip>
                ))}
            </ChipGroup>
            <div className="grid gap-1.5">
              <Label htmlFor={FIELD_IDS.errorCodes}>{e.errorCustom}</Label>
              <div className="flex gap-2">
                <Input
                  id={FIELD_IDS.errorCodes}
                  dir="ltr"
                  value={errorCustom}
                  onChange={(ev) => setErrorCustom(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') {
                      ev.preventDefault();
                      addCustomCode();
                    }
                  }}
                  placeholder={e.errorCustomPlaceholder}
                  maxLength={64}
                />
                <Button type="button" variant="outline" onClick={addCustomCode} disabled={!errorCustom.trim()}>
                  <Plus aria-hidden />
                  {e.errorAdd}
                </Button>
              </div>
            </div>
          </div>
        )}
      </fieldset>

      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
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

function TriSelect({ id, label, value, onChange, options }: { id: string; label: string; value: TriState; onChange: (v: TriState) => void; options: Record<TriState, string> }) {
  return (
    <FormField id={id} label={label}>
      {({ id: controlId, describedBy }) => (
        <Select value={value} onValueChange={(v) => onChange(v as TriState)}>
          <SelectTrigger id={controlId} className="w-full sm:max-w-xs" aria-describedby={describedBy}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(options) as TriState[]).map((k) => (
              <SelectItem key={k} value={k}>
                {options[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}

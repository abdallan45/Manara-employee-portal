'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { CorrectableSessionDto, CorrectionKind, CreateCorrectionInput } from '@workforce/shared';

import { CheckRow, FormField } from '@/components/form-field';
import { ChoiceGroup, Interpolate } from '@/components/request-bits';
import { FormErrorSummary, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, fieldErrorsFrom } from '@/lib/api';
import { addDays, formatTime, formatWorkDate, toAmmanInput, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

type Punch = 'CHECK_IN' | 'CHECK_OUT';

export interface CorrectionDraft {
  kind: CorrectionKind;
  sessionId?: string;
  /** WRONG_TIME only: which punch to preselect. */
  eventType?: Punch;
  /** MISSING_CHECK_IN only: the day of the missing work period (YYYY-MM-DD). */
  date?: string;
}

/** Everything the form holds; a page can keep it (onChange) and pass it back (restore) to reopen a draft. */
export interface CorrectionFormState {
  kind: CorrectionKind;
  sessionId: string;
  eventType: Punch;
  /** WRONG_TIME: the corrected punch as company wall time "YYYY-MM-DDTHH:mm". */
  wrongTime: string;
  /** MISSING_CHECK_IN: the day of the work period. */
  date: string;
  /** MISSING_CHECK_IN: check-in time "HH:mm". */
  startTime: string;
  /** MISSING_CHECK_IN and MISSING_CHECK_OUT: check-out time "HH:mm". */
  endTime: string;
  /** The check-out falls on the day after the check-in (night shifts). */
  nextDay: boolean;
  reason: string;
}

const MAX_PERIOD_MINUTES = 24 * 60;

/** Company calendar date of an instant. */
const ammanDate = (iso: string) => toAmmanInput(iso).slice(0, 10);
/** Minutes between two company wall times "YYYY-MM-DDTHH:mm". */
const minutesBetween = (from: string, to: string) => (Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`)) / 60_000;

function recordedPunch(session: CorrectableSessionDto | undefined, punch: Punch): string | null {
  if (!session) return null;
  return punch === 'CHECK_OUT' ? session.endedAt : session.startedAt;
}

function initialState(initial: CorrectionDraft, sessions: CorrectableSessionDto[]): CorrectionFormState {
  const session = sessions.find((s) => s.id === initial.sessionId);
  const eventType: Punch = initial.eventType ?? (session && !session.endedAt ? 'CHECK_IN' : 'CHECK_OUT');
  const recorded = recordedPunch(session, eventType);
  return {
    kind: initial.kind,
    sessionId: session ? session.id : '',
    eventType,
    wrongTime: recorded ? toAmmanInput(recorded) : '',
    date: initial.date ?? (session ? ammanDate(session.startedAt) : todayInAmman()),
    startTime: '08:00',
    endTime: initial.kind === 'MISSING_CHECK_IN' ? '16:00' : '',
    nextDay: false,
    reason: '',
  };
}

/**
 * Correction form for one of the three kinds. The caller decides what submitting means: an employee's
 * request (POST /corrections/requests) or HR's direct correction (POST /corrections/direct).
 *
 * - Whole work period: one date, a check-in and a check-out time, and "Ends the next day".
 * - Missing check-out: the recorded check-in is shown; the check-out time is entered for that day (or the next).
 * - Wrong time: the recorded time is shown read-only and prefills the correct-time field, refilled when the
 *   punch changes.
 * `restore` reopens a draft kept by the page from `onChange` (state, dirty).
 */
export function CorrectionForm({ initial, sessions, allowPending = false, reasonHint, submitLabel, submittingLabel, onCancel, onSubmit, restore, onChange }: {
  initial: CorrectionDraft;
  sessions: CorrectableSessionDto[];
  /** HR may correct a session even while the employee's own request for it is waiting. */
  allowPending?: boolean;
  /** Overrides the default hint under the reason field. */
  reasonHint?: string;
  submitLabel: string;
  submittingLabel: string;
  onCancel: () => void;
  /** Throws on failure; validation errors are shown next to the fields. */
  onSubmit: (body: CreateCorrectionInput) => Promise<void>;
  /** A draft to reopen (from onChange). */
  restore?: CorrectionFormState;
  /** Every change, with whether the form differs from how it opened (pass `dirty` to DialogContent). */
  onChange?: (state: CorrectionFormState, dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService.corrections;
  const [base] = useState(() => initialState(initial, sessions));
  const [state, setState] = useState<CorrectionFormState>(() => restore ?? base);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const baseKey = useMemo(() => JSON.stringify(base), [base]);
  const dirty = JSON.stringify(state) !== baseKey;
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onChangeRef.current?.(state, dirty);
  }, [state, dirty]);

  const { kind, sessionId, eventType, wrongTime, date, startTime, endTime, nextDay, reason } = state;
  const patch = (p: Partial<CorrectionFormState>, clear: string[] = []) => {
    setState((x) => ({ ...x, ...p }));
    if (clear.length) {
      setErrors((e) => {
        if (!clear.some((k) => k in e)) return e;
        const next = { ...e };
        clear.forEach((k) => delete next[k]);
        return next;
      });
    }
  };

  const session = sessions.find((x) => x.id === sessionId);
  const eligible = sessions.filter((x) => (kind === 'MISSING_CHECK_OUT' ? x.status === 'MISSING_CHECKOUT' : x.status !== 'MISSING_CHECKOUT'));
  const sessionLabel = (x: CorrectableSessionDto) =>
    fmt(t.corrections.sessionOption, { date: formatWorkDate(x.workDate, locale), start: formatTime(x.startedAt, locale), end: x.endedAt ? formatTime(x.endedAt, locale) : t.corrections.open });

  const recorded = kind === 'WRONG_TIME' ? recordedPunch(session, eventType) : null;

  const pickKind = (k: CorrectionKind) => {
    const keep = session && (k === 'MISSING_CHECK_OUT' ? session.status === 'MISSING_CHECKOUT' : session.status !== 'MISSING_CHECKOUT');
    const nextSession = keep ? session : undefined;
    const punch: Punch = nextSession && !nextSession.endedAt ? 'CHECK_IN' : eventType;
    const rec = recordedPunch(nextSession, punch);
    patch(
      {
        kind: k,
        sessionId: nextSession?.id ?? '',
        eventType: punch,
        wrongTime: rec ? toAmmanInput(rec) : '',
        date: nextSession ? ammanDate(nextSession.startedAt) : date,
        endTime: k === 'MISSING_CHECK_IN' && !endTime ? '16:00' : endTime,
        nextDay: false,
      },
      ['workSessionId', 'proposedTime', 'proposedEndTime', 'date'],
    );
  };

  const pickSession = (id: string) => {
    const x = sessions.find((y) => y.id === id);
    const punch: Punch = x && !x.endedAt ? 'CHECK_IN' : eventType;
    const rec = recordedPunch(x, punch);
    patch({ sessionId: id, eventType: punch, wrongTime: rec ? toAmmanInput(rec) : '', date: x ? ammanDate(x.startedAt) : date, nextDay: false }, ['workSessionId', 'proposedTime']);
  };

  const pickPunch = (punch: Punch) => {
    // Refill the correct time with the recorded value of the newly chosen punch.
    const rec = recordedPunch(session, punch);
    patch({ eventType: punch, wrongTime: rec ? toAmmanInput(rec) : '' }, ['proposedTime']);
  };

  /** The check-out wall time implied by the day, the time and "Ends the next day". */
  const outAt = (day: string) => (endTime ? `${nextDay ? addDays(day, 1) : day}T${endTime}` : '');

  const validate = (): Record<string, string> => {
    const v: Record<string, string> = {};
    if (kind !== 'MISSING_CHECK_IN' && !sessionId) v.workSessionId = s.chooseWorkPeriod;
    if (kind === 'WRONG_TIME' && session) {
      const other = recordedPunch(session, eventType === 'CHECK_IN' ? 'CHECK_OUT' : 'CHECK_IN');
      if (!wrongTime) v.proposedTime = s.enterTime;
      else if (recorded && wrongTime === toAmmanInput(recorded)) v.proposedTime = s.sameAsRecorded;
      else if (other) {
        const otherAt = toAmmanInput(other);
        const span = eventType === 'CHECK_IN' ? minutesBetween(wrongTime, otherAt) : minutesBetween(otherAt, wrongTime);
        if (span <= 0) v.proposedTime = s.outAfterIn;
        else if (span > MAX_PERIOD_MINUTES) v.proposedTime = s.tooLong;
      }
    }
    if (kind === 'MISSING_CHECK_OUT' && session) {
      const out = outAt(ammanDate(session.startedAt));
      if (!out) v.proposedTime = s.enterTime;
      else {
        const span = minutesBetween(toAmmanInput(session.startedAt), out);
        if (span <= 0) v.proposedTime = s.outAfterIn;
        else if (span > MAX_PERIOD_MINUTES) v.proposedTime = s.tooLong;
      }
    }
    if (kind === 'MISSING_CHECK_IN') {
      if (!date) v.date = s.enterDate;
      if (!startTime) v.proposedTime = s.enterTime;
      if (!endTime) v.proposedEndTime = s.enterTime;
      if (date && startTime && endTime) {
        const span = minutesBetween(`${date}T${startTime}`, outAt(date));
        if (span <= 0) v.proposedEndTime = s.outAfterIn;
        else if (span > MAX_PERIOD_MINUTES) v.proposedEndTime = s.tooLong;
      }
    }
    if (reason.trim().length < 3) v.reason = t.requests.tooShort;
    return v;
  };

  const fieldIds: Record<string, string> = {
    workSessionId: 'corr-session',
    date: 'corr-date',
    proposedTime: kind === 'MISSING_CHECK_IN' ? 'corr-start' : 'corr-time',
    proposedEndTime: 'corr-end',
    reason: 'corr-reason',
  };
  const order = ['workSessionId', 'date', 'proposedTime', 'proposedEndTime', 'reason'];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validate();
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      focusFirstError(order.filter((k) => v[k]).map((k) => fieldIds[k] ?? k));
      return;
    }
    let body: CreateCorrectionInput;
    if (kind === 'MISSING_CHECK_IN') body = { kind, proposedTime: `${date}T${startTime}`, proposedEndTime: outAt(date), reason: reason.trim() };
    else if (kind === 'MISSING_CHECK_OUT') body = { kind, workSessionId: sessionId, proposedTime: outAt(session ? ammanDate(session.startedAt) : date), reason: reason.trim() };
    else body = { kind, workSessionId: sessionId, eventType, proposedTime: wrongTime, reason: reason.trim() };
    setSaving(true);
    try {
      await onSubmit(body);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(fieldErrorsFrom(err.details));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = order
    .filter((k) => errors[k])
    .map((k) => ({ id: fieldIds[k] ?? k, message: errors[k] ?? '' }));

  const recordedLine = (template: string, iso: string) => (
    <p className="text-muted-foreground rounded-lg bg-tint/[0.03] px-3 py-2 text-sm">
      <Interpolate text={template} vars={{ time: <bdi className="text-foreground tabular font-semibold">{formatTime(iso, locale)}</bdi> }} />
    </p>
  );

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={summary} />

      <ChoiceGroup
        id="corr-kind"
        label={t.corrections.kindLabel}
        value={kind}
        onChange={pickKind}
        variant="cards"
        options={(['MISSING_CHECK_OUT', 'WRONG_TIME', 'MISSING_CHECK_IN'] as const).map((k) => ({ value: k, label: s.kinds[k] }))}
      />

      {kind !== 'MISSING_CHECK_IN' && (
        <FormField id="corr-session" label={s.workPeriod} error={errors.workSessionId} required>
          {({ id, describedBy, invalid }) =>
            eligible.length === 0 ? (
              <p id={id} tabIndex={-1} className="text-muted-foreground text-sm">{s.noWorkPeriods}</p>
            ) : (
              <Select value={sessionId} onValueChange={pickSession}>
                <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                  <SelectValue placeholder={s.chooseWorkPeriod} />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((x) => (
                    <SelectItem key={x.id} value={x.id} disabled={x.pendingCorrection && !allowPending}>
                      {sessionLabel(x)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
        </FormField>
      )}

      {kind === 'WRONG_TIME' && (
        <>
          <ChoiceGroup
            id="corr-event"
            label={s.whichTime}
            value={eventType}
            onChange={pickPunch}
            options={[
              { value: 'CHECK_IN', label: t.corrections.eventTypes.CHECK_IN },
              { value: 'CHECK_OUT', label: t.corrections.eventTypes.CHECK_OUT },
            ]}
          />
          {recorded && recordedLine(s.recorded, recorded)}
          <FormField id="corr-time" label={t.corrections.proposedTime} hint={t.corrections.timezoneHint} error={errors.proposedTime} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="datetime-local"
                dir="ltr"
                value={wrongTime}
                onChange={(e) => patch({ wrongTime: e.target.value }, ['proposedTime'])}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
        </>
      )}

      {kind === 'MISSING_CHECK_OUT' && session && (
        <>
          {recordedLine(s.recordedCheckIn, session.startedAt)}
          <FormField id="corr-time" label={t.corrections.proposedEnd} hint={t.corrections.timezoneHint} error={errors.proposedTime} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                dir="ltr"
                value={endTime}
                onChange={(e) => patch({ endTime: e.target.value }, ['proposedTime'])}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <CheckRow id="corr-next-day" checked={nextDay} onCheckedChange={(c) => patch({ nextDay: c }, ['proposedTime'])} label={s.endsNextDay} />
        </>
      )}

      {kind === 'MISSING_CHECK_IN' && (
        <>
          <FormField id="corr-date" label={t.common.date} error={errors.date} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="date"
                dir="ltr"
                max={todayInAmman()}
                value={date}
                onChange={(e) => patch({ date: e.target.value }, ['date', 'proposedEndTime'])}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField id="corr-start" label={t.corrections.proposedStart} hint={t.corrections.timezoneHint} error={errors.proposedTime} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="time"
                  dir="ltr"
                  value={startTime}
                  onChange={(e) => patch({ startTime: e.target.value }, ['proposedTime', 'proposedEndTime'])}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </FormField>
            <FormField id="corr-end" label={t.corrections.proposedEnd} hint={t.corrections.timezoneHint} error={errors.proposedEndTime} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="time"
                  dir="ltr"
                  value={endTime}
                  onChange={(e) => patch({ endTime: e.target.value }, ['proposedEndTime'])}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </FormField>
          </div>
          <CheckRow id="corr-next-day" checked={nextDay} onCheckedChange={(c) => patch({ nextDay: c }, ['proposedEndTime'])} label={s.endsNextDay} />
        </>
      )}

      <FormField id="corr-reason" label={t.requests.reason} hint={reasonHint ?? t.requests.reasonHint} error={errors.reason} required>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            value={reason}
            onChange={(e) => patch({ reason: e.target.value }, e.target.value.trim().length >= 3 ? ['reason'] : [])}
            onBlur={() => reason.length > 0 && reason.trim().length < 3 && setErrors((x) => ({ ...x, reason: t.requests.tooShort }))}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            maxLength={1000}
            rows={3}
          />
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
          {saving ? submittingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

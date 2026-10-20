'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  type AttendanceStatusDto, type CreateOvertimeRequestInput, type DayMetrics, type HolidayDto, type OvertimeCompensation, type OvertimeKind,
  type OvertimePolicyDto, type OvertimeRequestDto,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { Minutes } from '@/components/duration';
import { FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { PageHeader } from '@/components/page-header';
import { ChoiceGroup, Interpolate, RejectedReason, RequestStatusBadge, useWaitingFor } from '@/components/request-bits';
import { EmptyState, ErrorState, FormErrorSummary, LoadingRows, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiPost, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { addDays, formatWorkDate, parseLocaleNumber, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { usePortal } from '@/lib/portal';
import { useApi } from '@/lib/use-api';
import { useUrlState } from '@/lib/use-url-state';

export default function MyOvertimePage() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  if (!user.employee || !can(PERMISSIONS.OVERTIME_SELF)) return <EmptyState title={t.home.noEmployee} description={t.employeeSelfService.noEmployeeBody} />;
  return (
    <Suspense fallback={<LoadingRows />}>
      <MyOvertime />
    </Suspense>
  );
}

const RECENT_DAYS = 14;

interface OvertimeDraft {
  workDate: string;
  hours: string;
  mins: string;
  compensation: OvertimeCompensation;
  reason: string;
  /** Where the duration came from: a typed value is never replaced by the recorded extra time. */
  durationSource: 'default' | 'recorded' | 'user';
}

function newDraft(workDate: string, minutes: number | null): OvertimeDraft {
  const m = minutes ?? 60;
  return { workDate, hours: String(Math.floor(m / 60)), mins: String(m % 60), compensation: 'PAY', reason: '', durationSource: minutes !== null ? 'recorded' : 'default' };
}

const draftKey = (d: OvertimeDraft) => JSON.stringify({ ...d, durationSource: '' });

const MULTIPLIER: Record<OvertimeKind, keyof Pick<OvertimePolicyDto, 'regularMultiplier' | 'weekendMultiplier' | 'holidayMultiplier'>> = {
  REGULAR: 'regularMultiplier',
  WEEKEND: 'weekendMultiplier',
  HOLIDAY: 'holidayMultiplier',
};

/** Roles that may read the holiday calendar (GET /holidays). */
const HOLIDAY_PERMISSIONS = [PERMISSIONS.SCHEDULES_MANAGE, PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.ATTENDANCE_READ_ALL];

/**
 * The kind of day the API will use for the multiplier (holiday beats rest day, as in overtimeKind()).
 * DayMetrics only says whether the day is a scheduled workday: a non-workday is a weekly rest day or a
 * public holiday. That is resolved from the holiday calendar when the user may read it, or from My day's
 * status when the day is today; otherwise `kind` is null (unknown rest day or holiday).
 * `pending` is true while that lookup is still loading.
 */
function useOvertimeKind(workDate: string, metrics: DayMetrics | undefined): { kind: OvertimeKind | null; pending: boolean } {
  const { can } = useAuth();
  const today = todayInAmman();
  const restDay = metrics !== undefined && !metrics.scheduled.isWorkday;
  const calendar = restDay && can(...HOLIDAY_PERMISSIONS);
  const ownStatus = restDay && !calendar && workDate === today && can(PERMISSIONS.ATTENDANCE_SELF);
  const holidays = useApi<HolidayDto[]>(calendar ? '/holidays' : null, { year: Number(workDate.slice(0, 4)) });
  const status = useApi<AttendanceStatusDto>(ownStatus ? '/attendance/me/status' : null);

  if (!metrics) return { kind: null, pending: true };
  if (metrics.scheduled.isWorkday) return { kind: 'REGULAR', pending: false };
  if (calendar) {
    if (!holidays.data) return { kind: null, pending: !holidays.error };
    const sameDay = holidays.data.filter((x) => x.date.slice(0, 10) === workDate);
    // A holiday for one location only may not be this employee's: the location is not known here.
    if (sameDay.some((x) => x.locationId === null)) return { kind: 'HOLIDAY', pending: false };
    return { kind: sameDay.length === 0 ? 'WEEKEND' : null, pending: false };
  }
  if (ownStatus) {
    if (!status.data) return { kind: null, pending: !status.error };
    // todayHoliday covers the employee's own location as well as company-wide holidays.
    return { kind: status.data.todayHoliday ? 'HOLIDAY' : 'WEEKEND', pending: false };
  }
  return { kind: null, pending: false };
}

function MyOvertime() {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const { isVisible } = usePortal();
  const showRecorded = isVisible('overtime.recorded');
  const showRequests = isVisible('overtime.requests');
  const today = todayInAmman();
  const [url, setUrl] = useUrlState({ new: '', date: '' });
  const [draft, setDraft] = useState<{ value: OvertimeDraft; base: string } | null>(null);
  const [cancelling, setCancelling] = useState<OvertimeRequestDto | null>(null);
  const waitingFor = useWaitingFor();

  const policy = useApi<OvertimePolicyDto>('/overtime/policy');
  const requests = useApi<OvertimeRequestDto[]>('/overtime/me/requests');
  const days = useApi<DayMetrics[]>('/attendance/me/days', { from: addDays(today, -RECENT_DAYS), to: addDays(today, -1) });

  const requestFor = new Map(
    (requests.data ?? []).filter((r) => r.status === 'PENDING' || r.status === 'APPROVED').map((r) => [r.workDate, r] as const),
  );
  const claimable = (days.data ?? []).filter((d) => d.extraMinutes > 0).reverse();

  const open = showRequests && url.new === '1';

  // Open (or restore) the draft; a link with ?date= starts from that day and its recorded extra time.
  useEffect(() => {
    if (!open) return;
    const wantedDate = /^\d{4}-\d{2}-\d{2}$/.test(url.date) ? url.date : '';
    setDraft((current) => {
      if (current && (!wantedDate || current.value.workDate === wantedDate)) return current;
      const recorded = wantedDate ? (days.data ?? []).find((d) => d.workDate === wantedDate)?.extraMinutes ?? null : null;
      const value = newDraft(wantedDate || today, recorded && recorded > 0 ? recorded : null);
      return { value, base: draftKey(value) };
    });
  }, [open, url.date, today, days.data]);

  const openForm = (date?: string) => setUrl({ new: '1', date: date ?? '' });
  const closeForm = (keepDraft: boolean) => {
    if (!keepDraft) setDraft(null);
    setUrl({ new: '', date: '' });
  };

  const cancel = async (r: OvertimeRequestDto) => {
    try {
      await apiPost<OvertimeRequestDto>(`/overtime/requests/${encodeURIComponent(r.id)}/cancel`);
      toast.success(s.requests.withdrawnToast);
      void requests.refetch();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const estimate = (r: OvertimeRequestDto) => (
    <Interpolate
      text={t.overtime.estimateValue}
      vars={{ duration: <Minutes value={r.estimate.baseMinutes} />, multiplier: <bdi>{r.estimate.multiplier}</bdi>, result: <Minutes value={r.estimate.compensatedMinutes} /> }}
    />
  );
  const timing = (r: OvertimeRequestDto) => (r.isPreApproval ? s.overtime.beforeWorking : s.overtime.afterWorking);
  const compensation = (c: OvertimeCompensation) => (c === 'PAY' ? s.overtime.paid : t.overtime.compensationTypes.TIME_OFF);
  const rejection = (r: OvertimeRequestDto) => (r.status === 'REJECTED' ? ([...r.approvals].reverse().find((a) => a.decision === 'REJECTED')?.comment ?? null) : null);

  const columns: Column<OvertimeRequestDto>[] = [
    { id: 'date', header: t.overtime.workDate, cell: (r) => <span className="tabular whitespace-nowrap">{formatWorkDate(r.workDate, locale)}</span> },
    { id: 'kind', header: t.common.details, cell: (r) => <span className="text-muted-foreground">{t.overtime.kinds[r.kind]} · {timing(r)}</span> },
    { id: 'minutes', header: t.overtime.duration, cell: (r) => <Minutes value={r.minutes} /> },
    { id: 'recorded', header: t.overtime.recorded, cell: (r) => (r.recordedExtraMinutes === null ? '—' : <Minutes value={r.recordedExtraMinutes} />) },
    { id: 'estimate', header: t.overtime.estimate, cell: (r) => <span className="tabular text-xs">{estimate(r)}</span> },
    { id: 'comp', header: t.overtime.compensation, cell: (r) => compensation(r.compensation) },
    {
      id: 'status', header: t.common.status, cell: (r) => (
        <div className="space-y-1">
          <RequestStatusBadge status={r.status} waitingFor={waitingFor({ status: r.status })} />
          <RejectedReason reason={rejection(r)} className="max-w-56" />
        </div>
      ),
    },
    {
      id: 'actions', header: t.common.actions, srOnlyHeader: true, className: 'w-12 text-end',
      cell: (r) => r.status === 'PENDING' && (
        <Button variant="ghost" size="icon-sm" onClick={() => setCancelling(r)} aria-label={`${s.requests.withdraw}: ${formatWorkDate(r.workDate, locale)}`}>
          <X aria-hidden />
        </Button>
      ),
    },
  ];

  const dirty = draft !== null && draftKey(draft.value) !== draft.base;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.overtime.title}
        description={t.overtime.subtitle}
        actions={
          showRequests ? (
            <Button onClick={() => openForm()}>
              <Plus aria-hidden />
              {s.overtime.requestOvertime}
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className={showRecorded ? 'gap-3 py-4' : 'gap-3 py-4 lg:col-span-3'}>
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-1 text-base">
              {t.overtime.policyTitle}
              <HelpTip text={t.overtime.policyNote} />
            </CardTitle>
            <p className="sr-only">{t.overtime.policyNote}</p>
          </CardHeader>
          <CardContent className="space-y-3 px-4">
            {policy.error && !policy.data ? (
              <ErrorState error={policy.error} onRetry={() => void policy.refetch()} compact />
            ) : !policy.data ? (
              <LoadingRows rows={2} className="p-0" />
            ) : (
              <>
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {([
                    [t.overtime.regular, policy.data.regularMultiplier],
                    [t.overtime.weekend, policy.data.weekendMultiplier],
                    [t.overtime.holiday, policy.data.holidayMultiplier],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-tint/[0.06] bg-tint/[0.02] p-2">
                      <dt className="text-muted-foreground text-xs">{label}</dt>
                      <dd className="num text-lg font-bold" dir="ltr">×{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-sm">
                  <Interpolate text={t.overtime.minimum} vars={{ duration: <Minutes value={policy.data.minimumMinutes} /> }} />
                </p>
                <p className="text-sm">{policy.data.requiresPreApproval && !policy.data.allowRetroApproval ? t.overtime.retroNotAllowed : t.overtime.retroAllowed}</p>
              </>
            )}
          </CardContent>
        </Card>

        {showRecorded && (
          <Card className="gap-0 py-0 lg:col-span-2">
            <CardHeader className="py-4">
              <CardTitle className="text-base">{t.overtime.recentTitle}</CardTitle>
            </CardHeader>
            {days.error && !days.data ? (
              <ErrorState error={days.error} onRetry={() => void days.refetch()} compact />
            ) : !days.data ? (
              <LoadingRows rows={3} />
            ) : claimable.length === 0 ? (
              <EmptyState title={t.overtime.recentEmpty} />
            ) : (
              <ul className="divide-y divide-tint/[0.05]">
                {claimable.map((d) => {
                  const request = requestFor.get(d.workDate);
                  return (
                    <li key={d.workDate} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="font-medium">{formatWorkDate(d.workDate, locale, 'long')}</p>
                        <p className="text-muted-foreground text-xs">
                          {t.overtime.recorded}: <Minutes value={d.extraMinutes} />
                        </p>
                      </div>
                      {request ? (
                        <RequestStatusBadge status={request.status} />
                      ) : showRequests ? (
                        <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => openForm(d.workDate)}>
                          {s.overtime.requestIt}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
      </div>

      {showRequests ? (
        <Card className="gap-0 py-0">
          <CardHeader className="py-4">
            <CardTitle className="text-base">{t.overtime.requestsTitle}</CardTitle>
          </CardHeader>
          {requests.data && requests.data.length === 0 ? (
            <EmptyState
              title={s.overtime.noRequestsTitle}
              description={s.overtime.noRequestsBody}
              action={
                <Button onClick={() => openForm()}>
                  <Plus aria-hidden />
                  {s.overtime.requestOvertime}
                </Button>
              }
            />
          ) : (
            <DataTable
              rows={requests.data}
              columns={columns}
              rowKey={(r) => r.id}
              loading={requests.loading || requests.refreshing}
              error={requests.error}
              onRetry={() => void requests.refetch()}
              emptyTitle={s.overtime.noRequestsTitle}
              mobileCard={(r) => (
                <div className="min-w-0 space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">
                      <span className="tabular">{formatWorkDate(r.workDate, locale)}</span> · <Minutes value={r.minutes} />
                    </p>
                    <RequestStatusBadge status={r.status} waitingFor={waitingFor({ status: r.status })} className="items-end text-end" />
                  </div>
                  <p className="text-muted-foreground text-xs">{timing(r)} · {compensation(r.compensation)}</p>
                  <p className="text-muted-foreground text-xs">{estimate(r)}</p>
                  <RejectedReason reason={rejection(r)} />
                </div>
              )}
              mobileActions={(r) =>
                r.status === 'PENDING' ? (
                  <Button variant="ghost" size="sm" className="min-h-10" onClick={() => setCancelling(r)}>
                    {s.requests.withdraw}
                  </Button>
                ) : null
              }
            />
          )}
        </Card>
      ) : (
        <Card>
          <CardContent>
            <p className="text-muted-foreground text-sm">{s.overtime.handledByHr}</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(o) => !o && closeForm(false)}>
        <DialogContent dirty={dirty} discardTitle={s.requests.discardTitle} discardConfirmLabel={s.requests.discard}>
          <DialogHeader>
            <DialogTitle>{s.overtime.requestOvertime}</DialogTitle>
            <DialogDescription>{s.approvalNote}</DialogDescription>
          </DialogHeader>
          {open && draft && (
            <OvertimeForm
              draft={draft.value}
              policy={policy.data}
              onChange={(patch) => setDraft((d) => (d ? { ...d, value: { ...d.value, ...patch } } : d))}
              onCancel={() => closeForm(true)}
              onSaved={() => {
                closeForm(false);
                void requests.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        destructive
        title={s.requests.withdrawTitle}
        description={s.requests.withdrawBody}
        confirmLabel={s.requests.withdraw}
        cancelLabel={s.requests.keep}
        onConfirm={() => (cancelling ? cancel(cancelling) : false)}
      />
    </div>
  );
}

function OvertimeForm({ draft, policy, onChange, onCancel, onSaved }: {
  draft: OvertimeDraft;
  policy: OvertimePolicyDto | undefined;
  onChange: (patch: Partial<OvertimeDraft>) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const today = todayInAmman();
  const { workDate, hours, mins, compensation, reason, durationSource } = draft;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(workDate);
  const past = validDate && workDate < today;
  // The chosen day's figures: the kind of day (multiplier) and, for a past day, the recorded extra time.
  const day = useApi<DayMetrics[]>(validDate ? '/attendance/me/days' : null, { from: workDate, to: workDate });
  const metrics = day.data?.find((d) => d.workDate === workDate);
  const recorded = past && metrics ? metrics.extraMinutes : null;

  // Prefill a past day with its recorded extra time, unless the employee typed a duration.
  useEffect(() => {
    if (recorded === null || recorded <= 0 || durationSource === 'user') return;
    const next = { hours: String(Math.floor(recorded / 60)), mins: String(recorded % 60) };
    if (next.hours === hours && next.mins === mins) return;
    onChange({ ...next, durationSource: 'recorded' });
  }, [recorded, durationSource, hours, mins, onChange]);

  const h = parseLocaleNumber(hours || '0');
  const m = parseLocaleNumber(mins || '0');
  const hoursOk = h !== null && Number.isInteger(h) && h >= 0 && h <= 24;
  const minsOk = m !== null && Number.isInteger(m) && m >= 0 && m <= 59;
  const total = hoursOk && minsOk ? (h ?? 0) * 60 + (m ?? 0) : null;

  const { kind: knownKind, pending: kindPending } = useOvertimeKind(workDate, metrics);
  // An unknown rest day or holiday still has one figure when both multipliers are the same.
  const sameRestRates = !!policy && Number(policy.weekendMultiplier) === Number(policy.holidayMultiplier);
  const kind: OvertimeKind | null = knownKind ?? (metrics && sameRestRates ? 'WEEKEND' : null);
  const kindLabel = knownKind ? t.overtime.kinds[knownKind] : s.overtime.restOrHoliday;
  const multiplierText = policy && kind ? policy[MULTIPLIER[kind]] : null;
  const multiplier = multiplierText ? Number(multiplierText) : NaN;

  const durationError = (): string | undefined => {
    if (!hoursOk) return s.overtime.hoursInvalid;
    if (!minsOk) return s.overtime.minutesInvalid;
    if (total === null || total < 1 || total > 1440) return t.overtime.durationInvalid;
    return undefined;
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!validDate) v.workDate = t.employeeSelfService.corrections.enterDate;
    const d = durationError();
    if (d) v.minutes = d;
    if (reason.trim().length < 3) v.reason = t.requests.tooShort;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      focusFirstError([v.workDate && 'ot-date', v.minutes && (hoursOk ? 'ot-minutes' : 'ot-hours'), v.reason && 'ot-reason'].filter((x): x is string => !!x));
      return;
    }
    setSaving(true);
    try {
      const body: CreateOvertimeRequestInput = { workDate, minutes: total ?? 0, compensation, reason: reason.trim() };
      await apiPost<OvertimeRequestDto>('/overtime/requests', body);
      toast.success(t.requests.submittedToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(fieldErrorsFrom(err.details));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = [
    errors.workDate && { id: 'ot-date', message: errors.workDate },
    errors.minutes && { id: hoursOk ? 'ot-minutes' : 'ot-hours', message: errors.minutes },
    errors.reason && { id: 'ot-reason', message: errors.reason },
  ].filter((x): x is { id: string; message: string } => !!x);

  const clear = (key: string) => setErrors((x) => {
    if (!(key in x)) return x;
    const next = { ...x };
    delete next[key];
    return next;
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={summary} />
      <FormField id="ot-date" label={t.overtime.workDate} hint={workDate >= today ? t.overtime.futureHint : t.overtime.pastHint} error={errors.workDate} required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="date"
            dir="ltr"
            value={workDate}
            onChange={(e) => {
              onChange({ workDate: e.target.value });
              clear('workDate');
            }}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </FormField>
      {past && metrics && (
        <p className="text-muted-foreground -mt-2 text-sm">
          {metrics.extraMinutes > 0 ? (
            <Interpolate text={s.overtime.recordedThatDay} vars={{ d: <Minutes value={metrics.extraMinutes} className="text-foreground font-semibold" /> }} />
          ) : (
            s.overtime.nothingRecorded
          )}
        </p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <FormField id="ot-hours" label={t.overtime.hours} error={errors.minutes && !hoursOk ? errors.minutes : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              value={hours}
              onChange={(e) => {
                onChange({ hours: e.target.value, durationSource: 'user' });
                clear('minutes');
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        <FormField id="ot-minutes" label={t.overtime.minutes} error={errors.minutes && hoursOk ? errors.minutes : undefined}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              value={mins}
              onChange={(e) => {
                onChange({ mins: e.target.value, durationSource: 'user' });
                clear('minutes');
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
      </div>

      {/* What the request is worth, before it is sent. */}
      {total !== null && total > 0 && policy && !kindPending && (Number.isFinite(multiplier) || metrics) && (
        <div className="rounded-xl border border-tint/[0.06] bg-tint/[0.02] p-3 text-sm" aria-live="polite">
          {Number.isFinite(multiplier) ? (
            <>
              <p className="font-medium">
                <Interpolate
                  text={compensation === 'PAY' ? s.overtime.previewPaid : s.overtime.previewTimeOff}
                  vars={{ duration: <Minutes value={total} />, multiplier: <bdi>{multiplierText}</bdi>, result: <Minutes value={Math.round(total * multiplier)} /> }}
                />
              </p>
              <p className="text-muted-foreground text-xs">{fmt(s.overtime.rate, { kind: kindLabel })}</p>
            </>
          ) : (
            <>
              <p className="font-medium">
                <Interpolate
                  text={s.overtime.previewEither}
                  vars={{ duration: <Minutes value={total} />, weekend: <bdi>{policy.weekendMultiplier}</bdi>, holiday: <bdi>{policy.holidayMultiplier}</bdi> }}
                />{' '}
                <HelpTip text={s.overtime.exactAfterSend} />
              </p>
              <p className="sr-only">{s.overtime.exactAfterSend}</p>
            </>
          )}
        </div>
      )}

      <ChoiceGroup
        id="ot-comp"
        label={s.overtime.compensationLegend}
        value={compensation}
        onChange={(c) => onChange({ compensation: c })}
        variant="cards"
        options={[
          { value: 'PAY', label: s.overtime.paid, description: s.overtime.paidHint },
          { value: 'TIME_OFF', label: s.overtime.timeOff, description: s.overtime.timeOffHint },
        ]}
      />
      <FormField id="ot-reason" label={t.requests.reason} hint={t.requests.reasonHint} error={errors.reason} required>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            value={reason}
            onChange={(e) => {
              onChange({ reason: e.target.value });
              if (e.target.value.trim().length >= 3) clear('reason');
            }}
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
          {saving ? t.requests.submitting : t.requests.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

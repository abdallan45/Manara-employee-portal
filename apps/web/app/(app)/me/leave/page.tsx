'use client';

import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  LEAVE_MODES_BY_UNIT, PERMISSIONS,
  type CreateLeaveRequestInput, type HalfDay, type LeaveBalanceDto, type LeaveMode, type LeavePreviewDto, type LeaveRequestDto, type LeaveTypeDto,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { TimeRange } from '@/components/duration';
import { FormField } from '@/components/form-field';
import { DocumentPicker, LeaveDocuments, uploadLeaveDocument } from '@/components/leave-documents';
import { PageHeader } from '@/components/page-header';
import {
  BalanceCard, ChoiceGroup, DecisionList, Field, RejectedReason, RequestStatusBadge, useDayCount, useLeaveAmount, useWaitingFor,
} from '@/components/request-bits';
import { EmptyState, ErrorState, FormErrorSummary, LoadingRows, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiGet, apiPost, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { usePortal } from '@/lib/portal';
import { useApi } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { useUrlState } from '@/lib/use-url-state';

export default function MyLeavePage() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  if (!user.employee || !can(PERMISSIONS.LEAVE_SELF)) return <EmptyState title={t.home.noEmployee} description={t.employeeSelfService.noEmployeeBody} />;
  return (
    <Suspense fallback={<LoadingRows />}>
      <MyLeave />
    </Suspense>
  );
}

const typeName = (locale: 'en' | 'ar', type: LeaveTypeDto | null, fallback: string) => (type ? localized(locale, type.name, type.nameAr) : fallback);

/** Everything the request form holds, kept by the page so closing the dialog does not lose it. */
interface LeaveDraft {
  typeId: string;
  mode: LeaveMode;
  startDate: string;
  endDate: string;
  half: HalfDay;
  startTime: string;
  endTime: string;
  reason: string;
  files: File[];
}

function newDraft(types: LeaveTypeDto[], today: string, typeId?: string): LeaveDraft {
  // With more than one type nothing is preselected, so the employee picks the type on purpose.
  const preset = types.find((x) => x.id === typeId) ?? (types.length === 1 ? types[0] : undefined);
  return {
    typeId: preset?.id ?? '',
    mode: preset ? (LEAVE_MODES_BY_UNIT[preset.unit][0] ?? 'FULL_DAY') : 'FULL_DAY',
    startDate: today,
    endDate: today,
    half: 'FIRST',
    startTime: '09:00',
    endTime: '11:00',
    reason: '',
    files: [],
  };
}

const draftKey = (d: LeaveDraft) => JSON.stringify({ ...d, files: d.files.length });

function MyLeave() {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const { user } = useAuth();
  const { isVisible } = usePortal();
  const showRequests = isVisible('leave.requests');
  const showDocuments = isVisible('leave.documents');
  const today = todayInAmman();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [url, setUrl] = useUrlState({ new: '', type: '', request: '' });
  const [draft, setDraft] = useState<{ value: LeaveDraft; base: string } | null>(null);
  const [cancelling, setCancelling] = useState<LeaveRequestDto | null>(null);
  // Kept while the confirmation closes, so its text does not switch during the fade-out.
  const [cancelSensitive, setCancelSensitive] = useState(false);
  /** The request dialog names HR as the approver for a sensitive type (see sensitiveDraft below). */
  const [hrNote, setHrNote] = useState(false);
  const [fetched, setFetched] = useState<LeaveRequestDto | null>(null);
  const amount = useLeaveAmount('long');
  const waitingFor = useWaitingFor();

  const types = useApi<LeaveTypeDto[]>('/leave/types');
  const balances = useApi<LeaveBalanceDto[]>('/leave/me/balances', { year });
  const currentBalances = useApi<LeaveBalanceDto[]>(year !== thisYear ? '/leave/me/balances' : null, { year: thisYear });
  const requests = useApi<LeaveRequestDto[]>('/leave/me/requests');

  const creating = showRequests && url.new === '1';

  // Open (or restore) the draft when the form is opened, also from a link (?new=1&type=).
  useEffect(() => {
    if (!creating || !types.data) return;
    setDraft((current) => {
      if (!current) {
        const value = newDraft(types.data ?? [], today, url.type);
        return { value, base: draftKey(value) };
      }
      const wanted = url.type ? types.data?.find((x) => x.id === url.type) : undefined;
      if (wanted && current.value.typeId !== wanted.id) {
        return { ...current, value: { ...current.value, typeId: wanted.id, mode: LEAVE_MODES_BY_UNIT[wanted.unit][0] ?? 'FULL_DAY' } };
      }
      return current;
    });
  }, [creating, types.data, url.type, today]);

  // ?request=<id> opens that request; one that is not in the list is loaded on its own.
  const listed = url.request ? requests.data?.find((r) => r.id === url.request) : undefined;
  useEffect(() => {
    if (!url.request || listed || !requests.data) return;
    let alive = true;
    apiGet<LeaveRequestDto>(`/leave/requests/${encodeURIComponent(url.request)}`)
      .then((r) => alive && setFetched(r))
      .catch(() => alive && setFetched(null));
    return () => {
      alive = false;
    };
  }, [url.request, listed, requests.data]);
  const viewing = listed ?? (fetched && fetched.id === url.request ? fetched : null);

  const refresh = () => {
    void balances.refetch();
    void requests.refetch();
  };

  const openForm = (typeId?: string) => setUrl({ new: '1', type: typeId ?? '', request: '' });
  const closeForm = (keepDraft: boolean) => {
    if (!keepDraft) setDraft(null);
    setUrl({ new: '', type: '' });
  };

  const cancel = async (r: LeaveRequestDto) => {
    try {
      await apiPost<LeaveRequestDto>(`/leave/requests/${encodeURIComponent(r.id)}/cancel`);
      toast.success(s.requests.withdrawnToast);
      setUrl({ request: '' });
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const canCancel = (r: LeaveRequestDto) => r.status === 'PENDING' || (r.status === 'APPROVED' && new Date(r.startAt).getTime() > Date.now());
  const dates = (r: LeaveRequestDto) =>
    r.startDate === r.endDate ? formatWorkDate(r.startDate, locale) : `${formatWorkDate(r.startDate, locale)} – ${formatWorkDate(r.endDate, locale)}`;
  const modeLabel = (r: LeaveRequestDto) => (r.mode === 'HOURLY' ? <TimeRange start={r.startAt} end={r.endAt} /> : t.leave.modes[r.mode]);
  const waiting = (r: LeaveRequestDto) =>
    waitingFor({ status: r.status, currentLevel: r.currentLevel, approvalLevels: r.approvalLevels ?? undefined, isSensitive: r.leaveType?.isSensitive });

  const columns: Column<LeaveRequestDto>[] = [
    { id: 'dates', header: t.common.date, cell: (r) => <span className="tabular whitespace-nowrap">{dates(r)}</span> },
    { id: 'type', header: t.leave.type, cell: (r) => <bdi>{typeName(locale, r.leaveType, t.leave.confidential)}</bdi> },
    { id: 'mode', header: t.leave.mode, cell: (r) => <span className="text-muted-foreground">{modeLabel(r)}</span> },
    { id: 'amount', header: t.common.total, cell: (r) => <span className="tabular" dir="auto">{amount(r.minutes, r.leaveType?.unit)}</span> },
    {
      id: 'status', header: t.common.status, cell: (r) => (
        <div className="space-y-1">
          <RequestStatusBadge status={r.status} waitingFor={waiting(r)} />
          {r.status === 'REJECTED' && <RejectedReason reason={r.rejectionReason} className="max-w-56" />}
        </div>
      ),
    },
  ];

  const hasTypes = (types.data?.length ?? 0) > 0;
  const formBalances = (year === thisYear ? balances.data : currentBalances.data) ?? [];
  const dirty = draft !== null && draftKey(draft.value) !== draft.base;
  // A sensitive type is decided by HR only (no manager step), so the dialog says so. The last value is kept
  // while there is no draft, so the text does not switch while the dialog closes.
  const sensitiveDraft = draft ? (types.data?.find((x) => x.id === draft.value.typeId)?.isSensitive ?? false) : null;
  if (sensitiveDraft !== null && sensitiveDraft !== hrNote) setHrNote(sensitiveDraft);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.leave.title}
        description={t.leave.subtitle}
        actions={
          showRequests ? (
            <Button onClick={() => openForm()} disabled={!hasTypes}>
              <Plus aria-hidden />
              {s.leave.requestLeave}
            </Button>
          ) : undefined
        }
      />

      <section aria-labelledby="balances-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="balances-title" className="font-semibold">{fmt(t.leave.balancesTitle, { year })}</h2>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-28" aria-label={t.leave.year}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {balances.error && !balances.data ? (
          <Card className="py-0"><ErrorState error={balances.error} onRetry={() => void balances.refetch()} compact /></Card>
        ) : !balances.data ? (
          <LoadingRows rows={2} />
        ) : balances.data.length === 0 ? (
          <Card className="py-0"><EmptyState title={s.leave.noBalancesTitle} description={s.leave.noBalancesBody} /></Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {balances.data.map((b) => {
              const requestable = showRequests && year === thisYear && (types.data ?? []).some((x) => x.id === b.leaveType.id);
              return (
                <BalanceCard
                  key={b.leaveType.id}
                  balance={b}
                  amountStyle="long"
                  action={
                    requestable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full max-md:min-h-10"
                        onClick={() => openForm(b.leaveType.id)}
                        aria-label={`${s.leave.request}: ${localized(locale, b.leaveType.name, b.leaveType.nameAr)}`}
                      >
                        <Plus aria-hidden />
                        {s.leave.request}
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {showRequests ? (
        <Card className="gap-0 py-0">
          <CardHeader className="py-4">
            <CardTitle className="text-base">{t.leave.requestsTitle}</CardTitle>
          </CardHeader>
          {requests.data && requests.data.length === 0 ? (
            <EmptyState
              title={s.leave.noRequestsTitle}
              description={s.leave.noRequestsBody}
              action={
                hasTypes ? (
                  <Button onClick={() => openForm()}>
                    <Plus aria-hidden />
                    {s.leave.requestLeave}
                  </Button>
                ) : undefined
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
              emptyTitle={s.leave.noRequestsTitle}
              rowHref={(r) => `/me/leave?request=${encodeURIComponent(r.id)}`}
              mobileCard={(r) => (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate font-medium"><bdi>{typeName(locale, r.leaveType, t.leave.confidential)}</bdi></p>
                    <p className="text-muted-foreground text-xs">
                      <span className="tabular">{dates(r)}</span> · <span dir="auto">{amount(r.minutes, r.leaveType?.unit)}</span>
                    </p>
                    {r.status === 'REJECTED' && <RejectedReason reason={r.rejectionReason} />}
                  </div>
                  <RequestStatusBadge status={r.status} waitingFor={waiting(r)} className="items-end text-end" />
                </div>
              )}
            />
          )}
        </Card>
      ) : (
        <Card>
          <CardContent>
            <p className="text-muted-foreground text-sm">{s.leave.handledByHr}</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={creating} onOpenChange={(o) => !o && closeForm(false)}>
        <DialogContent className="sm:max-w-lg" dirty={dirty} discardTitle={s.requests.discardTitle} discardConfirmLabel={s.requests.discard}>
          <DialogHeader>
            <DialogTitle>{s.leave.requestLeave}</DialogTitle>
            <DialogDescription>{hrNote ? s.approvalNoteHr : s.approvalNote}</DialogDescription>
          </DialogHeader>
          {creating && types.data && draft && (
            <LeaveRequestForm
              types={types.data}
              balances={formBalances}
              draft={draft.value}
              showDocuments={showDocuments}
              onChange={(patch) => setDraft((d) => (d ? { ...d, value: { ...d.value, ...patch } } : d))}
              onCancel={() => closeForm(true)}
              onSaved={() => {
                closeForm(false);
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setUrl({ request: '' })}>
        <DialogContent>
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle><bdi>{typeName(locale, viewing.leaveType, t.leave.confidential)}</bdi></DialogTitle>
                <DialogDescription>{fmt(t.requests.submittedAt, { time: formatDateTime(viewing.createdAt, locale) })}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.common.date}><span className="tabular">{dates(viewing)}</span></Field>
                <Field label={t.leave.mode}>{modeLabel(viewing)}</Field>
                <Field label={t.common.total}><span dir="auto">{amount(viewing.minutes, viewing.leaveType?.unit)}</span></Field>
                <Field label={t.common.status}>
                  <RequestStatusBadge status={viewing.status} waitingFor={waiting(viewing)} />
                </Field>
                <Field label={t.requests.reason} className="col-span-2"><span className="font-normal whitespace-pre-wrap" dir="auto">{viewing.reason}</span></Field>
                {viewing.rejectionReason && (
                  <Field label={t.leave.rejectionReason} className="col-span-2"><span className="font-normal whitespace-pre-wrap" dir="auto">{viewing.rejectionReason}</span></Field>
                )}
              </div>
              {showDocuments && (
                <LeaveDocuments
                  requestId={viewing.id}
                  documents={viewing.documents}
                  canAdd={viewing.status === 'PENDING' || viewing.status === 'APPROVED'}
                  canRemove={(doc) => viewing.status === 'PENDING' && doc.uploadedById === user.id}
                  missingWarning={viewing.leaveType?.requiresAttachment ?? false}
                  onChanged={() => {
                    if (!listed) void apiGet<LeaveRequestDto>(`/leave/requests/${encodeURIComponent(viewing.id)}`).then(setFetched).catch(() => undefined);
                    void requests.refetch();
                  }}
                />
              )}
              <div className="space-y-2">
                <p className="text-sm font-semibold">{t.requests.history}</p>
                <DecisionList steps={viewing.approvals} levels={viewing.approvalLevels ?? undefined} />
              </div>
              <DialogFooter>
                {canCancel(viewing) && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setCancelSensitive(viewing.leaveType?.isSensitive ?? false);
                      setCancelling(viewing);
                    }}
                  >
                    {s.requests.withdraw}
                  </Button>
                )}
                <Button onClick={() => setUrl({ request: '' })}>{t.common.close}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        destructive
        title={s.requests.withdrawTitle}
        description={cancelSensitive ? s.requests.withdrawBodyLeaveHr : s.requests.withdrawBodyLeave}
        confirmLabel={s.requests.withdraw}
        cancelLabel={s.requests.keep}
        onConfirm={() => (cancelling ? cancel(cancelling) : false)}
      />
    </div>
  );
}

function LeaveRequestForm({ types, balances, draft, showDocuments, onChange, onCancel, onSaved }: {
  types: LeaveTypeDto[];
  balances: LeaveBalanceDto[];
  draft: LeaveDraft;
  showDocuments: boolean;
  onChange: (patch: Partial<LeaveDraft>) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const amount = useLeaveAmount('long');
  const dayCount = useDayCount();
  const { typeId, mode, startDate, endDate, half, startTime, endTime, reason, files } = draft;
  const type = types.find((x) => x.id === typeId) ?? null;
  const modes = type ? LEAVE_MODES_BY_UNIT[type.unit] : [];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ data?: LeavePreviewDto; error?: unknown; loading: boolean }>({ loading: false });

  const hourlyInvalid = mode === 'HOURLY' && !!startTime && !!endTime && endTime <= startTime;

  const body: CreateLeaveRequestInput | null = useMemo(() => {
    if (!type) return null;
    const base = { leaveTypeId: type.id, mode, startDate, reason: 'preview' };
    if (mode === 'FULL_DAY') return { ...base, endDate: endDate < startDate ? startDate : endDate };
    if (mode === 'HALF_DAY') return { ...base, half };
    if (hourlyInvalid) return null;
    return { ...base, startTime, endTime };
  }, [type, mode, startDate, endDate, half, startTime, endTime, hourlyInvalid]);
  const previewKey = useDebounced(body ? JSON.stringify(body) : '', 400);

  useEffect(() => {
    if (!previewKey) return;
    let alive = true;
    setPreview((p) => ({ ...p, loading: true }));
    apiPost<LeavePreviewDto>('/leave/requests/preview', JSON.parse(previewKey) as CreateLeaveRequestInput)
      .then((data) => alive && setPreview({ data, loading: false }))
      .catch((error: unknown) => alive && setPreview({ error, loading: false }));
    return () => {
      alive = false;
    };
  }, [previewKey]);

  const balanceOf = (id: string) => balances.find((b) => b.leaveType.id === id);
  const typeLabel = (x: LeaveTypeDto) => {
    const name = localized(locale, x.name, x.nameAr);
    const b = balanceOf(x.id);
    return x.tracksBalance && b ? fmt(s.leave.typeOption, { name, amount: amount(b.available, x.unit) }) : name;
  };

  const clearError = (...keys: string[]) => setErrors((e) => {
    if (!keys.some((k) => k in e)) return e;
    const next = { ...e };
    keys.forEach((k) => delete next[k]);
    return next;
  });

  const p = preview.data;
  const balanceProblem = p ? (p.overlaps.length > 0 ? t.leave.overlap : !p.sufficient && p.available !== null ? fmt(t.leave.insufficient, { available: amount(p.available, type?.unit) }) : null) : null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!type) v.leaveTypeId = s.leave.chooseType;
    if (mode === 'FULL_DAY' && endDate < startDate) v.endDate = s.leave.untilAfterFrom;
    if (hourlyInvalid) v.endTime = s.leave.untilAfterFrom;
    if (type && balanceProblem) v.dates = balanceProblem;
    if (reason.trim().length < 3) v.reason = t.requests.tooShort;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      focusFirstError(
        [v.leaveTypeId && 'leave-type', v.dates && 'leave-start', v.endDate && 'leave-end', v.endTime && 'leave-until', v.reason && 'leave-reason'].filter(
          (x): x is string => !!x,
        ),
      );
      return;
    }
    if (!body || !type) return;
    setSaving(true);
    try {
      const created = await apiPost<LeaveRequestDto>('/leave/requests', { ...body, reason: reason.trim() });
      let failed = 0;
      for (const f of showDocuments ? files : []) {
        try {
          await uploadLeaveDocument(created.id, f);
        } catch {
          failed++;
        }
      }
      if (failed) toast.warning(fmt(t.leave.documents.partialFailure, { n: failed }));
      else toast.success(t.requests.submittedToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(fieldErrorsFrom(err.details));
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const summary = [
    errors.leaveTypeId && { id: 'leave-type', message: errors.leaveTypeId },
    errors.dates && { id: 'leave-start', message: errors.dates },
    errors.endDate && { id: 'leave-end', message: errors.endDate },
    errors.endTime && { id: 'leave-until', message: errors.endTime },
    errors.reason && { id: 'leave-reason', message: errors.reason },
  ].filter((x): x is { id: string; message: string } => !!x);

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={summary} />

      <FormField id="leave-type" label={t.leave.type} error={errors.leaveTypeId} hint={type?.isSensitive ? t.leave.sensitiveHint : undefined} required>
        {({ id, describedBy, invalid }) => (
          <Select
            value={typeId}
            onValueChange={(v) => {
              const next = types.find((x) => x.id === v);
              const nextModes = next ? LEAVE_MODES_BY_UNIT[next.unit] : [];
              onChange({ typeId: v, mode: nextModes.includes(mode) ? mode : (nextModes[0] ?? 'FULL_DAY') });
              clearError('leaveTypeId', 'dates');
            }}
          >
            <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
              <SelectValue placeholder={s.leave.chooseType} />
            </SelectTrigger>
            <SelectContent>
              {types.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {typeLabel(x)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      {modes.length > 1 && (
        <ChoiceGroup
          id="leave-mode"
          label={t.leave.mode}
          value={mode}
          onChange={(m) => {
            onChange({ mode: m });
            clearError('endDate', 'endTime', 'dates');
          }}
          options={modes.map((m) => ({ value: m, label: t.leave.modes[m] }))}
          error={errors.mode}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="leave-start" label={mode === 'FULL_DAY' ? t.leave.startDate : t.leave.date} error={errors.startDate ?? errors.dates}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="date"
              dir="ltr"
              value={startDate}
              onChange={(e) => {
                const next = e.target.value;
                // Moving the start past the end moves the end along, instead of fixing it silently later.
                onChange(endDate < next ? { startDate: next, endDate: next } : { startDate: next });
                clearError('startDate', 'endDate', 'dates');
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid}
            />
          )}
        </FormField>
        {mode === 'FULL_DAY' && (
          <FormField id="leave-end" label={t.leave.endDate} error={errors.endDate}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="date"
                dir="ltr"
                min={startDate}
                value={endDate}
                onChange={(e) => {
                  onChange({ endDate: e.target.value });
                  clearError('endDate', 'dates');
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
        )}
        {mode === 'HALF_DAY' && (
          <ChoiceGroup
            id="leave-half"
            label={t.leave.halfLabel}
            value={half}
            onChange={(v) => onChange({ half: v })}
            options={[
              { value: 'FIRST', label: t.leave.half.FIRST },
              { value: 'SECOND', label: t.leave.half.SECOND },
            ]}
            error={errors.half}
          />
        )}
      </div>
      {mode === 'HOURLY' && (
        <div className="grid grid-cols-2 gap-4">
          <FormField id="leave-from" label={t.leave.startTime} error={errors.startTime}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                dir="ltr"
                value={startTime}
                onChange={(e) => {
                  onChange({ startTime: e.target.value });
                  clearError('startTime', 'endTime', 'dates');
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <FormField id="leave-until" label={t.leave.endTime} error={errors.endTime ?? (hourlyInvalid ? s.leave.untilAfterFrom : undefined)}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                dir="ltr"
                value={endTime}
                onChange={(e) => {
                  onChange({ endTime: e.target.value });
                  clearError('endTime', 'dates');
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
        </div>
      )}

      {/* Cost, remaining balance and overlaps, right under the dates they depend on. */}
      <div
        className={`rounded-xl border p-3 text-sm ${balanceProblem ? 'border-[color:var(--status-absent)]/40 bg-[color:var(--status-absent)]/10' : 'border-tint/[0.06] bg-tint/[0.02]'}`}
        aria-live="polite"
      >
        {!type ? (
          <span className="text-muted-foreground">{s.leave.chooseType}</span>
        ) : preview.loading && !p ? (
          <span className="text-muted-foreground">{t.leave.previewLoading}</span>
        ) : preview.error && !p ? (
          <span className="text-[color:var(--status-absent)]">{errorMessage(preview.error)}</span>
        ) : p ? (
          <div className="space-y-1">
            <p className="font-medium">
              {fmt(s.leave.previewDays, { days: dayCount(p.workdays, s.workingDayCount), duration: amount(p.minutes, type.unit) })}
            </p>
            {p.available === null ? (
              <p className="text-muted-foreground text-xs">{t.leave.noLimit}</p>
            ) : p.sufficient ? (
              <p className="text-muted-foreground text-xs">{fmt(t.leave.remaining, { value: amount(p.available - p.minutes, type.unit) })}</p>
            ) : (
              <p className="text-xs text-[color:var(--status-absent)]">{fmt(t.leave.insufficient, { available: amount(p.available, type.unit) })}</p>
            )}
            {p.overlaps.length > 0 && <p className="text-xs text-[color:var(--status-absent)]">{t.leave.overlap}</p>}
          </div>
        ) : balanceOf(type.id) ? (
          <span className="text-muted-foreground">
            {t.leave.available}: {amount(balanceOf(type.id)?.available ?? 0, type.unit)}
          </span>
        ) : (
          <span className="text-muted-foreground">{t.leave.previewLoading}</span>
        )}
      </div>

      <FormField id="leave-reason" label={t.requests.reason} hint={t.requests.reasonHint} error={errors.reason} required>
        {({ id, describedBy, invalid }) => (
          <Textarea
            id={id}
            value={reason}
            onChange={(e) => {
              onChange({ reason: e.target.value });
              if (e.target.value.trim().length >= 3) clearError('reason');
            }}
            onBlur={() => reason.length > 0 && reason.trim().length < 3 && setErrors((x) => ({ ...x, reason: t.requests.tooShort }))}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            maxLength={1000}
            rows={3}
          />
        )}
      </FormField>

      {showDocuments && <DocumentPicker files={files} onChange={(f) => onChange({ files: f })} expected={type?.requiresAttachment ?? false} error={errors.documents} />}

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

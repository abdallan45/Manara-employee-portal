'use client';

import { Suspense, useEffect, useState } from 'react';
import { AlarmClockOff, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  type CorrectableSessionDto, type CorrectionRequestDto,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { CorrectionForm, type CorrectionDraft, type CorrectionFormState } from '@/components/correction-form';
import { DataTable, type Column } from '@/components/data-table';
import { TimeRange } from '@/components/duration';
import { PageHeader } from '@/components/page-header';
import { RejectedReason, RequestStatusBadge, useWaitingFor } from '@/components/request-bits';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatTime, formatWorkDate, toAmmanInput } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useUrlState } from '@/lib/use-url-state';

export default function CorrectionsPage() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  if (!user.employee || !can(PERMISSIONS.ATTENDANCE_SELF)) return <EmptyState title={t.home.noEmployee} description={t.employeeSelfService.noEmployeeBody} />;
  return (
    <Suspense fallback={<LoadingRows />}>
      <Corrections />
    </Suspense>
  );
}

/** The form to open for ?new=1&session=&event=&date= (links from My day, My attendance and notifications). */
function draftFromUrl(url: { session: string; event: string; date: string }, sessions: CorrectableSessionDto[]): CorrectionDraft {
  const session = sessions.find((x) => x.id === url.session);
  if (session?.status === 'MISSING_CHECKOUT') return { kind: 'MISSING_CHECK_OUT', sessionId: session.id };
  if (session) {
    const eventType = url.event === 'CHECK_IN' || url.event === 'CHECK_OUT' ? url.event : undefined;
    return { kind: 'WRONG_TIME', sessionId: session.id, eventType };
  }
  if (url.date) return { kind: 'MISSING_CHECK_IN', date: url.date };
  // Nothing preselected: start with a missing check-out when there is one to fix.
  return sessions.some((x) => x.status === 'MISSING_CHECKOUT' && !x.pendingCorrection) ? { kind: 'MISSING_CHECK_OUT' } : { kind: 'WRONG_TIME' };
}

function Corrections() {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService;
  const [url, setUrl] = useUrlState({ new: '', session: '', event: '', date: '' });
  const [draft, setDraft] = useState<{ initial: CorrectionDraft; state?: CorrectionFormState; dirty: boolean } | null>(null);
  const [cancelling, setCancelling] = useState<CorrectionRequestDto | null>(null);
  const sessions = useApi<CorrectableSessionDto[]>('/corrections/me/sessions');
  const requests = useApi<CorrectionRequestDto[]>('/corrections/me/requests');
  const waitingFor = useWaitingFor();

  const open = url.new === '1';

  // Opening from a link prefills the form; a draft that was only closed (Cancel) is restored as it was.
  useEffect(() => {
    if (!open || !sessions.data) return;
    const wanted = draftFromUrl(url, sessions.data);
    setDraft((current) => {
      if (current && !url.session && !url.date) return current;
      if (current && current.initial.sessionId === wanted.sessionId && current.initial.eventType === wanted.eventType && current.initial.kind === wanted.kind) return current;
      return { initial: wanted, dirty: false };
    });
  }, [open, sessions.data, url]);

  const refresh = () => {
    void sessions.refetch();
    void requests.refetch();
  };
  const missing = (sessions.data ?? []).filter((x) => x.status === 'MISSING_CHECKOUT');

  const openForm = (d?: { session?: string; event?: string; date?: string }) =>
    setUrl({ new: '1', session: d?.session ?? '', event: d?.event ?? '', date: d?.date ?? '' });
  const closeForm = (keepDraft: boolean) => {
    if (!keepDraft) setDraft(null);
    setUrl({ new: '', session: '', event: '', date: '' });
  };

  const cancel = async (r: CorrectionRequestDto) => {
    try {
      await apiPost<CorrectionRequestDto>(`/corrections/requests/${encodeURIComponent(r.id)}/cancel`);
      toast.success(s.requests.withdrawnToast);
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const proposed = (r: CorrectionRequestDto) =>
    r.proposedEndTime ? (
      <span className="whitespace-nowrap">
        {formatWorkDate(toAmmanInput(r.proposedTime).slice(0, 10), locale)} · <TimeRange start={r.proposedTime} end={r.proposedEndTime} />
      </span>
    ) : (
      formatDateTime(r.proposedTime, locale)
    );

  const columns: Column<CorrectionRequestDto>[] = [
    { id: 'kind', header: t.corrections.kindLabel, cell: (r) => (
      <span>
        {s.corrections.kinds[r.kind]}
        {r.kind === 'WRONG_TIME' && <span className="text-muted-foreground"> · {t.corrections.eventTypes[r.eventType]}</span>}
      </span>
    ) },
    { id: 'session', header: t.corrections.recorded, cell: (r) => (
      <span className="tabular text-muted-foreground whitespace-nowrap">
        {r.session ? (
          <>
            {formatWorkDate(r.session.workDate, locale)} · <TimeRange start={r.session.startedAt} end={r.session.endedAt} endFallback="—" />
          </>
        ) : '—'}
      </span>
    ) },
    { id: 'proposed', header: t.corrections.proposed, cell: (r) => <span className="tabular">{proposed(r)}</span> },
    { id: 'status', header: t.common.status, cell: (r) => (
      <div className="space-y-1">
        <RequestStatusBadge status={r.status} waitingFor={waitingFor({ status: r.status })} />
        {r.status === 'REJECTED' ? (
          <RejectedReason reason={r.decisionComment} className="max-w-56" />
        ) : (
          r.decisionComment && <p className="text-muted-foreground max-w-56 text-xs" dir="auto">{r.decisionComment}</p>
        )}
      </div>
    ) },
    {
      id: 'actions', header: t.common.actions, srOnlyHeader: true, className: 'w-12 text-end',
      cell: (r) => r.status === 'PENDING' && (
        <Button variant="ghost" size="icon-sm" onClick={() => setCancelling(r)} aria-label={s.requests.withdraw}>
          <X aria-hidden />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.corrections.title}
        description={[s.corrections.subtitle, s.corrections.appendOnly].join('\n')}
        actions={
          <Button onClick={() => openForm()}>
            <Plus aria-hidden />
            {t.requests.newRequest}
          </Button>
        }
      />

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <CardTitle className="text-base">{s.corrections.attentionTitle}</CardTitle>
        </CardHeader>
        {sessions.error && !sessions.data ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} compact />
        ) : !sessions.data ? (
          <LoadingRows rows={2} />
        ) : missing.length === 0 ? (
          <EmptyState title={s.corrections.attentionEmpty} />
        ) : (
          <ul className="divide-y divide-tint/[0.05]">
            {missing.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <AlarmClockOff className="size-4 shrink-0 text-[color:var(--status-missing)]" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium">{formatWorkDate(x.workDate, locale, 'long')}</p>
                    <p className="text-muted-foreground text-xs">
                      {t.corrections.eventTypes.CHECK_IN}: <bdi className="tabular">{formatTime(x.startedAt, locale)}</bdi>
                    </p>
                  </div>
                </div>
                {x.pendingCorrection ? (
                  <span className="text-muted-foreground text-xs">{s.home.correctionPending}</span>
                ) : (
                  <Button size="sm" variant="outline" className="max-md:min-h-10" onClick={() => openForm({ session: x.id })}>
                    {s.home.fix}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <CardTitle className="text-base">{t.corrections.requestsTitle}</CardTitle>
        </CardHeader>
        {requests.data && requests.data.length === 0 ? (
          <EmptyState
            title={s.corrections.noRequestsTitle}
            description={s.corrections.noRequestsBody}
            action={
              <Button variant="outline" onClick={() => openForm()}>
                <Plus aria-hidden />
                {t.requests.newRequest}
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
            emptyTitle={s.corrections.noRequestsTitle}
            mobileCard={(r) => (
              <div className="min-w-0 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{s.corrections.kinds[r.kind]}</p>
                  <RequestStatusBadge status={r.status} waitingFor={waitingFor({ status: r.status })} className="items-end text-end" />
                </div>
                <p className="text-muted-foreground text-xs">{t.corrections.proposed}: <span className="tabular">{proposed(r)}</span></p>
                {r.status === 'REJECTED' ? (
                  <RejectedReason reason={r.decisionComment} />
                ) : (
                  r.decisionComment && <p className="text-muted-foreground text-xs" dir="auto">{r.decisionComment}</p>
                )}
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

      <Dialog open={open} onOpenChange={(o) => !o && closeForm(false)}>
        <DialogContent dirty={draft?.dirty ?? false} discardTitle={s.requests.discardTitle} discardConfirmLabel={s.requests.discard}>
          <DialogHeader>
            <DialogTitle>{s.requestCorrection}</DialogTitle>
            <DialogDescription>{s.approvalNote}</DialogDescription>
          </DialogHeader>
          {!sessions.data ? (
            sessions.error ? <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} compact /> : <LoadingRows rows={3} className="p-0" />
          ) : (
            draft && (
              <CorrectionForm
                key={`${draft.initial.kind}-${draft.initial.sessionId ?? ''}-${draft.initial.eventType ?? ''}-${draft.initial.date ?? ''}`}
                initial={draft.initial}
                restore={draft.state}
                sessions={sessions.data}
                submitLabel={t.requests.submit}
                submittingLabel={t.requests.submitting}
                onChange={(state, dirty) => setDraft((d) => (d ? { ...d, state, dirty } : d))}
                onCancel={() => closeForm(true)}
                onSubmit={async (body) => {
                  await apiPost<CorrectionRequestDto>('/corrections/requests', body);
                  toast.success(t.requests.submittedToast);
                  closeForm(false);
                  refresh();
                }}
              />
            )
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

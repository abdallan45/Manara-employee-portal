'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { ApprovalItemDto, OvertimeCandidateDto, OvertimeRequestDto, Paginated } from '@workforce/shared';

import { Minutes, TimeRange } from '@/components/duration';
import { RequestStatusBadge } from '@/components/request-bits';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { addDays, formatWorkDate, formatWeekday, todayInAmman } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';

/**
 * Overtime tab: the employee's overtime requests (every status) and the days of the last 30 with extra
 * time nobody requested. Decisions stay in one place: the primary action opens Overtime approval
 * filtered to this employee.
 */
export function OvertimeTab({ employeeId }: { employeeId: string }) {
  const { t, locale } = useI18n();
  const o = t.employeeHub.overtime;
  const today = todayInAmman();
  const from = addDays(today, -30);
  const to = addDays(today, -1);
  const q = { kind: 'OVERTIME', employeeId, page: 1, pageSize: 100 };
  const pending = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'PENDING' });
  const approved = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'APPROVED' });
  const rejected = useApi<Paginated<ApprovalItemDto>>('/approvals', { ...q, tab: 'REJECTED' });
  const candidates = useApi<OvertimeCandidateDto[]>('/overtime/candidates', { from, to, employeeId });

  const states = [pending, approved, rejected];
  const failed = states.find((s) => s.error && !s.data);
  const requests = states
    .flatMap((s) => s.data?.items ?? [])
    .map((i) => i.overtime)
    .filter((r): r is OvertimeRequestDto => !!r)
    .sort((a, b) => b.workDate.localeCompare(a.workDate));
  const unrequested = (candidates.data ?? []).filter((c) => c.request === null);
  const reviewHref = `/admin/overtime?${new URLSearchParams({ employeeId, from, to, state: 'open' }).toString()}`;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button asChild>
          <Link href={reviewHref}>
            {o.review}
            <ArrowUpRight className="rtl:-scale-x-100" aria-hidden />
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="font-semibold">{o.requestsTitle}</h2>
          {failed ? (
            <ErrorState compact error={failed.error} onRetry={() => states.forEach((s) => void s.refetch())} />
          ) : !states.every((s) => s.data) ? (
            <LoadingRows rows={2} className="px-0" />
          ) : requests.length === 0 ? (
            <EmptyState title={o.requestsEmpty} />
          ) : (
            <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">
                      {formatWeekday(r.workDate, locale)} · <span className="tabular">{formatWorkDate(r.workDate, locale)}</span>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {o.requested} <Minutes value={r.minutes} dimZero={false} />
                      {r.approvedMinutes !== null && (
                        <>
                          {' · '}
                          {o.approved} <Minutes value={r.approvedMinutes} dimZero={false} />
                        </>
                      )}
                      {' · '}
                      {t.overtime.compensationTypes[r.compensation]}
                    </p>
                    <p className="text-muted-foreground text-sm break-words" dir="auto">
                      {r.reason}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RequestStatusBadge status={r.status} />
                    {r.status === 'PENDING' && (
                      <Link href={`/admin/approvals?kind=OVERTIME&id=${encodeURIComponent(r.id)}`} className="text-link text-sm underline-offset-4 hover:underline">
                        {t.employeeHub.leave.openInApprovals}
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="font-semibold">{o.candidatesTitle}</h2>
          {candidates.error && !candidates.data ? (
            <ErrorState compact error={candidates.error} onRetry={() => void candidates.refetch()} />
          ) : !candidates.data ? (
            <LoadingRows rows={2} className="px-0" />
          ) : unrequested.length === 0 ? (
            <EmptyState title={o.candidatesEmpty} />
          ) : (
            <ul className="divide-y divide-tint/[0.05] rounded-xl border border-tint/[0.06]">
              {unrequested.map((c) => (
                <li key={c.workDate} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {formatWeekday(c.workDate, locale)} · <span className="tabular">{formatWorkDate(c.workDate, locale)}</span>
                    </p>
                    {(c.firstIn || c.lastOut) && <TimeRange start={c.firstIn} end={c.lastOut} className="text-muted-foreground text-xs" />}
                  </div>
                  <span className="text-[color:var(--status-working)]">
                    {o.extra} <Minutes value={c.extraMinutes} dimZero={false} className="font-semibold" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

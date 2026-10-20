'use client';

import { Suspense, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, CircleCheck, ExternalLink, Info, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS,
  type ApprovalItemDto, type ApprovalSummaryDto, type ApprovalTab, type BulkApproveResultDto, type LeaveBalanceDto, type Paginated, type RequestKind,
} from '@workforce/shared';

import { BulkActionBar } from '@/components/bulk-action-bar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, Pagination, type Column } from '@/components/data-table';
import { EmployeeLink, employeeHref, type EmployeeTab } from '@/components/employee-link';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { LeaveDocuments } from '@/components/leave-documents';
import { DecisionList, Field, RequestStatusBadge, useLeaveAmount } from '@/components/request-bits';
import { ForbiddenState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatMinutes, formatNumber, formatTime, formatWorkDate, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { APPROVAL_PERMISSIONS } from '@/lib/nav';
import { useApi } from '@/lib/use-api';
import { APPROVALS_CHANGED_EVENT } from '@/lib/use-nav-counts';
import { useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;
const TABS: ApprovalTab[] = ['PENDING', 'APPROVED', 'REJECTED'];
const KINDS: RequestKind[] = ['LEAVE', 'OVERTIME', 'CORRECTION'];
type KindFilter = RequestKind | 'all';
const KIND_FILTERS: KindFilter[] = ['all', ...KINDS];
const KIND_PATH: Record<RequestKind, string> = { LEAVE: 'leave', OVERTIME: 'overtime', CORRECTION: 'correction' };
/** Which employee-page tab shows the context of each request type. */
const KIND_TAB: Record<RequestKind, EmployeeTab> = { LEAVE: 'leave', OVERTIME: 'overtime', CORRECTION: 'attendance' };
const keyOf = (i: { kind: RequestKind; id: string }) => `${i.kind}:${i.id}`;
/** "Request n of m" in the sheet header (one sheet per page). */
const POSITION_ID = 'approval-position';

export default function ApprovalsPage() {
  const { can } = useAuth();
  if (!can(...APPROVAL_PERMISSIONS)) return <ForbiddenState />;
  // The Approval Center keeps its tab, type, page and open request in the URL (useSearchParams needs Suspense).
  return (
    <Suspense fallback={<LoadingRows />}>
      <ApprovalCenter />
    </Suspense>
  );
}

/** This page's URL (relative), optionally without some query keys: the `from` target of employee links. */
function useCurrentUrl(omit: string[] = []): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const qs = new URLSearchParams(params.toString());
  for (const key of omit) qs.delete(key);
  const s = qs.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/** "Waiting 2 days" / "بانتظار منذ يومين": hours under a day, days after that, with proper plural forms. */
function useWaitingAge() {
  const { t, locale } = useI18n();
  const a = t.adminWorkflows;
  return (iso: string): string => {
    const hours = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
    const rules = new Intl.PluralRules(locale === 'ar' ? 'ar' : 'en');
    const plural = (forms: Record<string, string>, n: number) =>
      fmt(forms[rules.select(n)] ?? forms.other ?? '', { n: formatNumber(n, locale) });
    const age = hours < 1 ? a.plural.underHour : hours < 24 ? plural(a.plural.hours, hours) : plural(a.plural.days, Math.floor(hours / 24));
    return fmt(a.approvals.waitingAge, { age });
  };
}

/** One-line description of what was requested, per request type. */
function useSummary() {
  const { t, locale, units } = useI18n();
  const amount = useLeaveAmount();
  return (item: ApprovalItemDto): string => {
    if (item.leave) {
      const l = item.leave;
      const type = l.leaveType ? localized(locale, l.leaveType.name, l.leaveType.nameAr) : t.leave.confidential;
      const dates = l.startDate === l.endDate ? formatWorkDate(l.startDate, locale) : `${formatWorkDate(l.startDate, locale)} – ${formatWorkDate(l.endDate, locale)}`;
      const time = l.mode === 'HOURLY' ? ` ${formatTime(l.startAt, locale)}–${formatTime(l.endAt, locale)}` : l.mode === 'HALF_DAY' ? ` (${t.leave.modes.HALF_DAY})` : '';
      return `${type} · ${dates}${time} · ${amount(l.minutes, l.leaveType?.unit)}`;
    }
    if (item.overtime) {
      const o = item.overtime;
      return `${formatWorkDate(o.workDate, locale)} · ${formatMinutes(o.minutes, units)} · ${t.overtime.kinds[o.kind]} · ${o.isPreApproval ? t.overtime.preApproval : t.overtime.retro}`;
    }
    if (item.correction) {
      const c = item.correction;
      const what = c.kind === 'WRONG_TIME' ? `${t.corrections.kinds.WRONG_TIME} (${t.corrections.eventTypes[c.eventType]})` : t.corrections.kinds[c.kind];
      const when = c.proposedEndTime ? `${formatDateTime(c.proposedTime, locale)} – ${formatTime(c.proposedEndTime, locale)}` : formatDateTime(c.proposedTime, locale);
      return `${what} · ${when}`;
    }
    return '';
  };
}

/**
 * Finds a request that is not on the current page (deep links from notifications): the whole pending list
 * first, then the newest decided ones. null when the viewer cannot see it (any more).
 */
async function findApproval(id: string, kind: KindFilter): Promise<ApprovalItemDto | null> {
  const want = kind === 'all' ? undefined : kind;
  const search = async (tab: ApprovalTab, pageSize: number) =>
    (await apiGet<Paginated<ApprovalItemDto>>('/approvals', { tab, kind: want, page: 1, pageSize })).items.find((i) => i.id === id);
  try {
    return (await search('PENDING', 100)) ?? (await search('APPROVED', PAGE_SIZE)) ?? (await search('REJECTED', PAGE_SIZE)) ?? null;
  } catch {
    return null;
  }
}

/** After a decision or a page jump: which item the sheet opens once the list has reloaded. */
interface Advance {
  /** The list data the step started from; the step completes on the next data. */
  base: Paginated<ApprovalItemDto> | undefined;
  pick: 'first' | 'last';
  /** The item just decided (it may still be in a stale list). */
  exclude?: string;
}

function ApprovalCenter() {
  const { t, locale, dir, errorMessage } = useI18n();
  const a = t.adminWorkflows.approvals;
  const summarize = useSummary();
  const waitingAge = useWaitingAge();
  const [url, setUrl] = useUrlState({ tab: 'PENDING', kind: 'all', page: '1', id: '' });
  const tab: ApprovalTab = TABS.includes(url.tab as ApprovalTab) ? (url.tab as ApprovalTab) : 'PENDING';
  const kind: KindFilter = KIND_FILTERS.includes(url.kind as KindFilter) ? (url.kind as KindFilter) : 'all';
  const page = Math.max(1, Number.parseInt(url.page, 10) || 1);
  const urlId = url.id;
  const listUrl = useCurrentUrl(['id']);
  const sheetUrl = useCurrentUrl();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [advance, setAdvance] = useState<Advance | null>(null);
  const [missing, setMissing] = useState(false);
  const [lookup, setLookup] = useState<{ id: string; item: ApprovalItemDto | null } | null>(null);
  const lookupFor = useRef<string | null>(null);
  /** The sheet moved to another request by Previous/Next/advance: its title takes focus so it is not lost. */
  const navigated = useRef(false);

  const list = useApi<Paginated<ApprovalItemDto>>('/approvals', { tab, kind: kind === 'all' ? undefined : kind, page, pageSize: PAGE_SIZE });
  const summary = useApi<ApprovalSummaryDto>('/approvals/summary');
  const items = list.data?.items;
  const actionable = (items ?? []).filter((i) => i.canAct);
  /** Previous/Next and "Request n of m" walk the requests you can decide (pending) or the whole list (decided tabs). */
  const queue = tab === 'PENDING' ? actionable : (items ?? []);

  const pendingFor = (k: KindFilter): number | null => {
    const p = summary.data?.pending;
    if (!p) return null;
    return k === 'all' ? p.total : k === 'LEAVE' ? p.leave : k === 'OVERTIME' ? p.overtime : p.correction;
  };

  // ── Open request: from the current page, else looked up (deep link) ──
  const fromList = urlId ? items?.find((i) => i.id === urlId) : undefined;
  const looked = !fromList && lookup && lookup.id === urlId ? lookup.item : null;
  const openItem = fromList ?? looked ?? undefined;

  useEffect(() => {
    if (!urlId || !items || list.loading) return;
    if (items.some((i) => i.id === urlId) || lookup?.id === urlId || lookupFor.current === urlId) return;
    lookupFor.current = urlId;
    void findApproval(urlId, kind).then((item) => {
      if (lookupFor.current !== urlId) return;
      lookupFor.current = null;
      setLookup({ id: urlId, item });
    });
  }, [urlId, items, list.loading, lookup?.id, kind]);

  // Not found anywhere: say so on the page instead of opening an empty sheet.
  useEffect(() => {
    if (lookup && lookup.item === null && lookup.id === urlId) {
      setMissing(true);
      setUrl({ id: '' });
    }
  }, [lookup, urlId, setUrl]);

  // Finish an advance once fresh list data has arrived.
  useEffect(() => {
    if (!advance || !list.data || list.data === advance.base) return;
    const data = list.data;
    const pool = (tab === 'PENDING' ? data.items.filter((i) => i.canAct) : data.items).filter((i) => keyOf(i) !== advance.exclude);
    const next = advance.pick === 'first' ? pool[0] : pool[pool.length - 1];
    if (next) {
      navigated.current = true;
      setAdvance(null);
      setUrl({ id: next.id });
      return;
    }
    if (data.items.length === 0 && page > 1) {
      // The last request of this page was decided: step back a page.
      setAdvance({ ...advance, base: data, pick: 'last' });
      setUrl({ page: String(page - 1) });
      return;
    }
    setAdvance(null);
    setDone(true);
  }, [advance, list.data, page, tab, setUrl]);

  const refresh = () => {
    void list.refetch();
    void summary.refetch();
  };

  const openRequest = (item: ApprovalItemDto) => {
    navigated.current = false;
    setDone(false);
    setMissing(false);
    setUrl({ id: item.id });
  };
  const closeSheet = () => {
    setDone(false);
    setAdvance(null);
    navigated.current = false;
    setUrl({ id: '' });
  };

  const changeFilter = (patch: { tab?: ApprovalTab; kind?: KindFilter; page?: number }) => {
    setSelected(new Set());
    setUrl({
      ...(patch.tab ? { tab: patch.tab } : {}),
      ...(patch.kind ? { kind: patch.kind } : {}),
      page: String(patch.page ?? 1),
      id: '',
    });
  };

  // ── Position and Previous / Next ──
  const qIndex = openItem ? queue.findIndex((i) => keyOf(i) === keyOf(openItem)) : -1;
  const offset = (page - 1) * PAGE_SIZE;
  const queueTotal = tab === 'PENDING' ? Math.max(pendingFor(kind) ?? 0, offset + actionable.length) : (list.data?.total ?? 0);
  const position = qIndex >= 0 ? { n: offset + qIndex + 1, m: queueTotal } : null;
  const goTo = (item: ApprovalItemDto) => {
    navigated.current = true;
    setUrl({ id: item.id });
  };
  const jumpPage = (nextPage: number, pick: Advance['pick']) => {
    setSelected(new Set());
    setAdvance({ base: list.data, pick });
    setUrl({ page: String(nextPage), id: '' });
  };
  const onPrevious = position
    ? qIndex > 0
      ? () => goTo(queue[qIndex - 1]!)
      : page > 1
        ? () => jumpPage(page - 1, 'last')
        : undefined
    : undefined;
  const onNext = position
    ? qIndex < queue.length - 1
      ? () => goTo(queue[qIndex + 1]!)
      : position.n < position.m
        ? () => jumpPage(page + 1, 'first')
        : undefined
    : undefined;

  /** After approve / reject: stay in the sheet and open the next request of this filter. */
  const onDecided = (decided: ApprovalItemDto) => {
    const key = keyOf(decided);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const index = queue.findIndex((i) => keyOf(i) === key);
    const rest = index >= 0 ? [...queue.slice(index + 1), ...queue.slice(0, index)] : queue;
    const next = rest.find((i) => i.canAct && keyOf(i) !== key);
    const base = list.data;
    refresh();
    if (next) {
      goTo(next);
      return;
    }
    const remaining = (pendingFor(kind) ?? 0) - 1;
    if (tab === 'PENDING' && remaining > actionable.length - 1) {
      // More requests on other pages: wait for the reloaded list.
      setAdvance({ base, pick: 'first', exclude: key });
      setUrl({ id: '' });
      return;
    }
    setDone(true);
    setUrl({ id: '' });
  };

  const bulkApprove = async () => {
    const chosen = actionable.filter((i) => selected.has(keyOf(i))).map((i) => ({ kind: i.kind, id: i.id }));
    try {
      const res = await api<BulkApproveResultDto>('/approvals/bulk-approve', { method: 'POST', body: { items: chosen } });
      const message = fmt(t.approvals.bulkResult, { approved: res.approved, failed: res.failed });
      if (res.failed) toast.warning(message);
      else toast.success(message);
      window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
      setSelected(new Set());
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const name = (i: ApprovalItemDto) => localized(locale, i.employee.fullName, i.employee.fullNameAr);
  const selectedCount = actionable.filter((i) => selected.has(keyOf(i))).length;

  const columns: Column<ApprovalItemDto>[] = [
    {
      id: 'employee',
      header: t.approvals.employee,
      cell: (i) => (
        <div className="min-w-0">
          <EmployeeLink id={i.employee.id} name={i.employee.fullName} nameAr={i.employee.fullNameAr} tab={KIND_TAB[i.kind]} from={listUrl} className="block truncate" />
          <p className="text-muted-foreground truncate text-xs">
            <span dir="ltr">{i.employee.employeeCode}</span>
            {i.employee.departmentName ? <> · <bdi>{localized(locale, i.employee.departmentName, i.employee.departmentNameAr)}</bdi></> : null}
          </p>
        </div>
      ),
    },
    // The request type is the row's button (the employee column holds a link, so it cannot be the primary cell).
    { id: 'kind', header: t.approvals.kindFilter, cell: (i) => <span className="font-medium whitespace-nowrap">{t.requests.kind[i.kind]}</span> },
    { id: 'summary', header: t.approvals.summary, cell: (i) => <span className="text-muted-foreground text-sm">{summarize(i)}</span> },
    {
      id: 'when',
      header: tab === 'PENDING' ? t.approvals.submitted : t.approvals.decided,
      cell: (i) => (
        <div className="grid">
          <span className="tabular text-muted-foreground whitespace-nowrap text-xs">{formatDateTime(tab === 'PENDING' ? i.submittedAt : i.decidedAt, locale)}</span>
          {tab === 'PENDING' && <span className="text-xs font-medium whitespace-nowrap">{waitingAge(i.submittedAt)}</span>}
        </div>
      ),
    },
    {
      id: 'status',
      header: t.common.status,
      cell: (i) => (tab === 'PENDING' && !i.canAct ? <span className="text-muted-foreground text-xs">{t.approvals.waiting}</span> : <RequestStatusBadge status={i.status} />),
    },
  ];

  const total = summary.data?.pending.total ?? 0;
  const sheetOpen = done || advance !== null || openItem !== undefined;

  return (
    <div className="space-y-6">
      <PageHeader title={t.approvals.title} description={t.approvals.subtitle} subtitle={summary.data ? fmt(t.approvals.pendingCount, { n: total }) : undefined} />

      <div className="flex flex-col gap-3">
        <Tabs value={tab} onValueChange={(v) => changeFilter({ tab: v as ApprovalTab, kind })}>
          <TabsList>
            {TABS.map((x) => (
              <TabsTrigger key={x} value={x}>
                {t.approvals.tabs[x]}
                {x === 'PENDING' && total > 0 && <span className="bg-brand-cta tabular rounded-full px-1.5 text-xs font-bold text-white">{total}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div role="group" aria-label={t.approvals.kindFilter} className="flex flex-wrap gap-2">
          {KIND_FILTERS.map((k) => {
            const n = tab === 'PENDING' ? pendingFor(k) : null;
            const label = a.chips[k];
            const active = kind === k;
            return (
              <Button
                key={k}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={active}
                className={cn('max-md:min-h-10', active && 'border-tint/40 bg-tint/[0.1]')}
                onClick={() => !active && changeFilter({ kind: k })}
              >
                <span className="tabular">{n === null ? label : fmt(a.chipCount, { label, n })}</span>
              </Button>
            );
          })}
        </div>
      </div>

      {kind === 'OVERTIME' && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-[color:var(--brand-soft)]/25 bg-tint/[0.03] p-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-[color:var(--brand-soft)]" aria-hidden />
          <Link href="/admin/overtime?state=open" className="text-link underline-offset-4 hover:underline">
            {a.overtimeBanner}
          </Link>
        </p>
      )}

      {missing && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-[color:var(--status-break)]/30 bg-[color:var(--status-break)]/10 p-3 text-sm">
          <Info className="size-4 shrink-0 text-[color:var(--status-break)]" aria-hidden />
          <span className="min-w-0 flex-1">{a.noLongerWaiting}</span>
          <Button type="button" variant="ghost" size="sm" className="max-md:min-h-10" onClick={() => setMissing(false)}>
            {a.dismiss}
          </Button>
        </div>
      )}

      <Card className="gap-0 py-0">
        {tab === 'PENDING' && <MobileSelectAll keys={actionable.map(keyOf)} selected={selected} onChange={setSelected} />}
        <DataTable
          rows={items}
          columns={columns}
          rowKey={keyOf}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={t.approvals.empty[tab]}
          onRowClick={openRequest}
          primaryColumnId="kind"
          rowLabel={(i) => `${t.requests.kind[i.kind]}: ${name(i)}`}
          selection={tab === 'PENDING' ? { selected, onChange: setSelected, isSelectable: (i) => i.canAct } : undefined}
          stale={list.stale && list.lastUpdatedAt ? { since: list.lastUpdatedAt, onRetry: () => void list.refetch() } : undefined}
          mobileCard={(i) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">
                  <bdi>{name(i)}</bdi>
                </p>
                {tab === 'PENDING' && !i.canAct ? <span className="text-muted-foreground text-xs">{t.approvals.waiting}</span> : <RequestStatusBadge status={i.status} />}
              </div>
              <p className="text-xs font-medium">{t.requests.kind[i.kind]}</p>
              <p className="text-muted-foreground text-xs">{summarize(i)}</p>
              {tab === 'PENDING' && <p className="text-xs font-medium">{waitingAge(i.submittedAt)}</p>}
            </div>
          )}
        />
        {list.data && (
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={(p) => changeFilter({ page: p })} className="border-t border-tint/[0.05]" />
        )}
      </Card>

      {tab === 'PENDING' && (
        <BulkActionBar count={selectedCount} onClear={() => setSelected(new Set())}>
          <Button type="button" size="sm" className="min-h-10 md:min-h-8" onClick={() => setBulkOpen(true)}>
            <Check aria-hidden />
            {a.approveSelected}
          </Button>
        </BulkActionBar>
      )}

      <Sheet open={sheetOpen} onOpenChange={(o) => !o && closeSheet()}>
        <SheetContent side={dir === 'rtl' ? 'left' : 'right'} className="w-full overflow-y-auto sm:max-w-md">
          {done ? (
            <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
              <CircleCheck className="size-10 text-[color:var(--status-working)]" aria-hidden />
              <SheetTitle className="text-base">{a.allDone}</SheetTitle>
              <SheetDescription className="sr-only">{t.approvals.title}</SheetDescription>
              <Button type="button" variant="outline" onClick={closeSheet}>
                {t.common.close}
              </Button>
            </div>
          ) : openItem ? (
            <ApprovalDetail
              key={keyOf(openItem)}
              item={openItem}
              position={position}
              onPrevious={onPrevious}
              onNext={onNext}
              onDecided={onDecided}
              onKeepPending={closeSheet}
              employeeHrefFrom={sheetUrl}
              notWaiting={looked !== null && !looked.canAct && looked.status !== 'PENDING'}
              focusTitle={navigated.current}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" aria-busy="true">
              <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden />
              <SheetTitle className="text-sm font-normal">{a.loadingNext}</SheetTitle>
              <SheetDescription className="sr-only">{t.approvals.title}</SheetDescription>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        title={fmt(t.approvals.bulkTitle, { n: selectedCount })}
        description={t.approvals.bulkBody}
        confirmLabel={a.approveSelected}
        onConfirm={bulkApprove}
      />
    </div>
  );
}

/**
 * Phones get cards instead of the table, so they have no header checkbox: this row selects or clears every
 * request on the page that you can decide. Hidden from md, where the table header does the same.
 */
function MobileSelectAll({ keys, selected, onChange }: { keys: string[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const { t, locale } = useI18n();
  const id = useId();
  if (keys.length === 0) return null;
  const on = keys.filter((k) => selected.has(k)).length;
  const state: boolean | 'indeterminate' = on === keys.length ? true : on > 0 ? 'indeterminate' : false;
  const toggle = () => {
    const next = new Set(selected);
    if (state === true) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
    onChange(next);
  };
  return (
    <div className="flex items-center gap-3 border-b border-tint/[0.05] ps-4 md:hidden">
      <Checkbox id={id} checked={state} onCheckedChange={toggle} className="relative after:absolute after:-inset-2.5 after:content-['']" />
      <label htmlFor={id} className="flex min-h-12 flex-1 cursor-pointer items-center pe-4 text-sm font-medium">
        {fmt(t.adminWorkflows.selectAllCount, { n: formatNumber(keys.length, locale) })}
      </label>
    </div>
  );
}

function ApprovalDetail({ item, position, onPrevious, onNext, onDecided, onKeepPending, employeeHrefFrom, notWaiting, focusTitle }: {
  item: ApprovalItemDto;
  position: { n: number; m: number } | null;
  onPrevious?: () => void;
  onNext?: () => void;
  onDecided: (item: ApprovalItemDto) => void;
  onKeepPending: () => void;
  /** The current URL (with this request open), so Back from the employee page reopens it. */
  employeeHrefFrom: string;
  /** Reached through a deep link but already decided. */
  notWaiting: boolean;
  focusTitle: boolean;
}) {
  const { t, locale, units, dir, errorMessage } = useI18n();
  const a = t.adminWorkflows.approvals;
  const summarize = useSummary();
  const { can } = useAuth();
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Moving to another request replaces the focused button; keep focus at the top of the new one.
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);

  const decide = async (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !comment.trim()) {
      setCommentError(t.approvals.rejectReasonRequired);
      document.getElementById('decision-comment')?.focus();
      return;
    }
    setCommentError(null);
    setError(null);
    setBusy(decision);
    try {
      await api<ApprovalItemDto>(`/approvals/${KIND_PATH[item.kind]}/${encodeURIComponent(item.id)}/${decision}`, {
        method: 'POST', body: { comment: comment.trim() || undefined },
      });
      toast.success(decision === 'approve' ? t.approvals.approvedToast : t.approvals.rejectedToast);
      window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
      onDecided(item);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const reason = item.leave?.reason ?? item.overtime?.reason ?? item.correction?.reason ?? null;
  const steps = item.leave?.approvals ?? item.overtime?.approvals ?? [];
  const Prev = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const Next = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const showBalance = item.status === 'PENDING' && !!item.leave?.leaveType?.tracksBalance && !item.leave.confidential && can(PERMISSIONS.LEAVE_APPROVE);

  return (
    <div className="flex flex-col gap-5 px-4 pb-6">
      {/* pe-12 keeps Next (and a long title) clear of the sheet's close button at the inline end. */}
      <SheetHeader className="px-0 pe-12">
        {position && (
          <div className="flex items-center gap-2">
            {/* The title takes focus on Previous / Next / advance; this is its description, so the position is read with it. */}
            <p id={POSITION_ID} className="text-muted-foreground tabular min-w-0 flex-1 text-xs font-medium">
              {fmt(a.position, { n: formatNumber(position.n, locale), m: formatNumber(position.m, locale) })}
            </p>
            <Button type="button" variant="outline" size="icon-sm" className="max-md:size-10" onClick={onPrevious} disabled={!onPrevious} aria-label={a.previousRequest}>
              <Prev aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon-sm" className="max-md:size-10" onClick={onNext} disabled={!onNext} aria-label={a.nextRequest}>
              <Next aria-hidden />
            </Button>
          </div>
        )}
        <SheetTitle ref={titleRef} tabIndex={-1} className="outline-none" aria-describedby={position ? POSITION_ID : undefined}>
          {t.requests.kind[item.kind]}
        </SheetTitle>
        <SheetDescription>
          <bdi>{localized(locale, item.employee.fullName, item.employee.fullNameAr)}</bdi> · <span dir="ltr">{item.employee.employeeCode}</span>
        </SheetDescription>
        {can(PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.EMPLOYEES_MANAGE) && (
          <Link
            href={employeeHref(item.employee.id, KIND_TAB[item.kind], employeeHrefFrom)}
            className="text-link inline-flex min-h-6 w-fit items-center gap-1.5 rounded-sm text-sm underline-offset-4 hover:underline"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {a.openEmployee}
          </Link>
        )}
      </SheetHeader>

      {notWaiting && (
        <p role="status" className="rounded-xl border border-[color:var(--status-break)]/30 bg-[color:var(--status-break)]/10 p-3 text-sm">
          {a.noLongerWaiting}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label={t.approvals.summary} className="col-span-2">{summarize(item)}</Field>
        {showBalance && item.leave && <LeaveBalanceLine item={item} />}
        <Field label={t.common.status}><RequestStatusBadge status={item.status} /></Field>
        <Field label={t.approvals.submitted}><span className="tabular">{formatDateTime(item.submittedAt, locale)}</span></Field>
        {/* approvalLevels is null on confidential rows shown to managers: no "level x of y" then. */}
        {item.leave && item.leave.approvalLevels !== null && item.leave.approvalLevels > 1 && item.status === 'PENDING' && (
          <Field label={t.common.details}>{fmt(t.requests.level, { level: item.leave.currentLevel, levels: item.leave.approvalLevels })}</Field>
        )}
        {item.overtime && (
          <>
            <Field label={t.overtime.recorded}><span dir="auto">{item.overtime.recordedExtraMinutes === null ? '—' : formatMinutes(item.overtime.recordedExtraMinutes, units)}</span></Field>
            <Field label={t.overtime.compensation}>{t.overtime.compensationTypes[item.overtime.compensation]}</Field>
            <Field label={t.overtime.estimate} className="col-span-2">
              <span dir="auto">
                {fmt(t.overtime.estimateValue, {
                  duration: formatMinutes(item.overtime.estimate.baseMinutes, units),
                  multiplier: item.overtime.estimate.multiplier,
                  result: formatMinutes(item.overtime.estimate.compensatedMinutes, units),
                })}
              </span>
            </Field>
          </>
        )}
        {item.correction?.session && (
          <Field label={t.corrections.recorded} className="col-span-2">
            <span className="tabular">
              {formatWorkDate(item.correction.session.workDate, locale)} · {formatTime(item.correction.session.startedAt, locale)}–
              {item.correction.session.endedAt ? formatTime(item.correction.session.endedAt, locale) : '—'}
            </span>
          </Field>
        )}
        {item.leave?.confidential ? (
          <Field label={t.requests.reason} className="col-span-2"><span className="text-muted-foreground font-normal">{t.leave.sensitiveHint}</span></Field>
        ) : (
          reason && <Field label={t.requests.reason} className="col-span-2"><span className="font-normal whitespace-pre-wrap" dir="auto">{reason}</span></Field>
        )}
        {item.leave?.rejectionReason && (
          <Field label={t.leave.rejectionReason} className="col-span-2"><span className="font-normal whitespace-pre-wrap" dir="auto">{item.leave.rejectionReason}</span></Field>
        )}
        {item.correction?.decisionComment && (
          <Field label={t.requests.comment} className="col-span-2"><span className="font-normal whitespace-pre-wrap" dir="auto">{item.correction.decisionComment}</span></Field>
        )}
      </div>

      {item.leave && !item.leave.confidential && (
        <LeaveDocuments requestId={item.leave.id} documents={item.leave.documents} missingWarning={item.leave.leaveType?.requiresAttachment ?? false} />
      )}

      {item.kind !== 'CORRECTION' && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">{t.requests.history}</p>
          <DecisionList steps={steps} levels={item.leave?.approvalLevels ?? undefined} />
        </div>
      )}

      {item.canAct ? (
        <div className="space-y-3 rounded-2xl border border-tint/[0.06] bg-tint/[0.02] p-4">
          <p className="text-sm font-semibold">{t.approvals.yourTurn}</p>
          <FormField id="decision-comment" label={t.approvals.commentLabel} hint={t.approvals.rejectReasonRequired} error={commentError ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} value={comment} onChange={(e) => setComment(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={1000} rows={3} dir="auto" />
            )}
          </FormField>
          {error && (
            <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button className="min-w-32 flex-1" onClick={() => void decide('approve')} disabled={busy !== null}>
              {busy === 'approve' ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              {a.approve}
            </Button>
            <Button className="min-w-32 flex-1" variant="outline" onClick={() => void decide('reject')} disabled={busy !== null}>
              {busy === 'reject' ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
              {a.rejectRequest}
            </Button>
          </div>
          <Button type="button" variant="ghost" className="w-full" onClick={onKeepPending} disabled={busy !== null}>
            {a.keepPending}
          </Button>
        </div>
      ) : (
        item.status === 'PENDING' && <p className="text-muted-foreground text-sm">{t.approvals.waiting}</p>
      )}
    </div>
  );
}

/** "Balance: 14 days -> 12 days after approval" for leave types that keep a balance, in the request's year. */
function LeaveBalanceLine({ item }: { item: ApprovalItemDto }) {
  const { t } = useI18n();
  const a = t.adminWorkflows.approvals;
  const amount = useLeaveAmount();
  const leave = item.leave!;
  const year = Number(leave.startDate.slice(0, 4));
  const balances = useApi<LeaveBalanceDto[]>(`/leave/employees/${encodeURIComponent(item.employee.id)}/balances`, { year });
  const balance = balances.data?.find((b) => b.leaveType.id === leave.leaveType?.id);

  if (balances.loading) {
    return (
      <p className="text-muted-foreground col-span-2 text-xs" aria-live="polite">
        {a.balanceLoading}
      </p>
    );
  }
  if (!balance || !balance.leaveType.tracksBalance) return null;
  const unit = balance.leaveType.unit;
  // `available` already holds this pending request back, so the remaining balance before the decision adds it again.
  const before = balance.available + leave.minutes;
  const after = balance.available;
  const [head, tail] = a.balanceLine.split('{available}');
  const [mid, end] = (tail ?? '').split('{after}');
  return (
    <p className={cn('col-span-2 rounded-xl border border-tint/[0.08] bg-tint/[0.03] px-3 py-2 text-sm', after < 0 && 'border-[color:var(--status-absent)]/40')}>
      {head}
      <bdi className="tabular font-semibold">{amount(before, unit)}</bdi>
      {mid}
      <bdi className={cn('tabular font-semibold', after < 0 && 'text-[color:var(--status-absent)]')}>{amount(after, unit)}</bdi>
      {end}
    </p>
  );
}

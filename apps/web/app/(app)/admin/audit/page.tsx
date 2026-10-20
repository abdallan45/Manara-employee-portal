'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, Loader2, Search, ShieldCheck, ShieldX } from 'lucide-react';
import { PERMISSIONS, type AuditLogDto, type AuditVerifyResult, type Paginated } from '@workforce/shared';

import { Pagination } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, ForbiddenState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

/** Amman local calendar date -> ISO instant at the start / end of that day (Jordan is UTC+3 year-round). */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00+03:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999+03:00`).toISOString() : undefined);

export default function AuditPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.AUDIT_READ)) return <ForbiddenState />;
  return <Audit />;
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return (
    <pre className="max-h-64 overflow-auto rounded-xl bg-black/30 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all" dir="ltr">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Audit() {
  const { t, locale, errorMessage } = useI18n();
  const a = t.audit;
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ state: 'idle' | 'busy' } | { state: 'done'; result: AuditVerifyResult } | { state: 'error'; message: string }>({ state: 'idle' });
  const debouncedEntity = useDebounced(entityType.trim());
  const debouncedAction = useDebounced(action.trim());

  const logs = useApi<Paginated<AuditLogDto>>('/audit-logs', {
    entityType: debouncedEntity,
    action: debouncedAction,
    from: dayStart(from),
    to: dayEnd(to),
    page,
    pageSize: PAGE_SIZE,
  });

  const runVerify = async () => {
    setVerify({ state: 'busy' });
    try {
      const result = await apiGet<AuditVerifyResult>('/audit-logs/verify');
      setVerify({ state: 'done', result });
    } catch (err) {
      setVerify({ state: 'error', message: errorMessage(err) });
    }
  };

  const filterInput = (id: string, label: string, value: string, set: (v: string) => void, type = 'text') => (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        dir={type === 'text' ? 'ltr' : undefined}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setPage(1);
        }}
      />
    </div>
  );

  const rows = logs.data?.items;
  return (
    <div className="space-y-6">
      <PageHeader
        title={a.title}
        description={a.subtitle}
        actions={
          <Button variant="outline" onClick={() => void runVerify()} disabled={verify.state === 'busy'}>
            {verify.state === 'busy' ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
            {verify.state === 'busy' ? a.verifying : a.verify}
          </Button>
        }
      />

      {(verify.state === 'done' || verify.state === 'error') && (
        <div
          role="status"
          className={cn(
            'flex items-center gap-3 rounded-2xl border p-4 text-sm',
            verify.state === 'done' && verify.result.valid
              ? 'border-[color:var(--status-working)]/30 bg-[color:var(--status-working)]/10'
              : 'border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10',
          )}
        >
          {verify.state === 'done' && verify.result.valid ? (
            <ShieldCheck className="size-5 shrink-0 text-[color:var(--status-working)]" aria-hidden />
          ) : (
            <ShieldX className="size-5 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
          )}
          <p className="font-medium">
            {verify.state === 'error'
              ? verify.message
              : verify.result.valid
                ? fmt(a.verifyOk, { n: verify.result.checked })
                : fmt(a.verifyBroken, { seq: verify.result.brokenAtSeq ?? '?', n: verify.result.checked })}
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {filterInput('audit-entity', a.entityType, entityType, setEntityType)}
        {filterInput('audit-action', a.action, action, setAction)}
        {filterInput('audit-from', t.common.from, from, setFrom, 'date')}
        {filterInput('audit-to', t.common.to, to, setTo, 'date')}
      </div>

      <Card className="gap-0 py-0">
        {logs.error && !rows ? (
          <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
        ) : !rows ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState icon={Search} title={a.empty} />
        ) : (
          <div className={cn('transition-opacity', (logs.loading || logs.refreshing) && 'opacity-60')}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{a.cols.seq}</TableHead>
                  <TableHead>{a.cols.time}</TableHead>
                  <TableHead>{a.cols.actor}</TableHead>
                  <TableHead>{a.cols.action}</TableHead>
                  <TableHead>{a.cols.entity}</TableHead>
                  <TableHead>{a.cols.ip}</TableHead>
                  <TableHead>
                    <span className="sr-only">{a.showChanges}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const open = expanded === r.id;
                  return (
                    <Fragment key={r.id}>
                      <TableRow>
                        <TableCell className="tabular text-muted-foreground">{r.seq}</TableCell>
                        <TableCell className="tabular">{formatDateTime(r.createdAt, locale)}</TableCell>
                        <TableCell dir="ltr" className="text-start">
                          {r.actor?.username ?? <span className="text-muted-foreground">{a.system}</span>}
                        </TableCell>
                        <TableCell>
                          <code className="rounded-md bg-tint/[0.05] px-1.5 py-0.5 text-xs" dir="ltr">
                            {r.action}
                          </code>
                        </TableCell>
                        <TableCell>
                          <span>{r.entityType}</span>
                          {r.entityId && (
                            <span className="text-muted-foreground ms-1 font-mono text-xs" dir="ltr" title={r.entityId}>
                              {r.entityId.slice(0, 8)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular" dir="ltr">
                          {r.ipAddress ?? '—'}
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setExpanded(open ? null : r.id)}
                            aria-expanded={open}
                            aria-controls={`audit-${r.id}`}
                            aria-label={open ? a.hideChanges : a.showChanges}
                          >
                            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
                          </Button>
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow id={`audit-${r.id}`} className="hover:bg-transparent">
                          <TableCell colSpan={7} className="whitespace-normal">
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="space-y-1.5">
                                <p className="text-muted-foreground text-xs font-semibold">{a.before}</p>
                                <Json value={r.before} />
                              </div>
                              <div className="space-y-1.5">
                                <p className="text-muted-foreground text-xs font-semibold">{a.after}</p>
                                <Json value={r.after} />
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {logs.data && <Pagination page={logs.data.page} pageSize={logs.data.pageSize} total={logs.data.total} onPageChange={setPage} className="border-t border-tint/[0.05]" />}
      </Card>
    </div>
  );
}

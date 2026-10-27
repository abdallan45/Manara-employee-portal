'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2, Pencil, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  PERMISSIONS, type EmployeeDto, type EmployeeTeamDto, type Paginated, type RequestEmployeeRef, type RoleDto, type UpdateEmployeeTeamInput,
} from '@workforce/shared';

import { EmployeeLink } from '@/components/employee-link';
import { HelpTip } from '@/components/help-tip';
import { ErrorState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatNumber, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { normalize } from '@/lib/search-normalize';
import { useApi } from '@/lib/use-api';

const APPROVE_PERMISSIONS: string[] = [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.OVERTIME_APPROVE, PERMISSIONS.CORRECTIONS_APPROVE];
const TEAM_READ: string[] = [PERMISSIONS.ATTENDANCE_READ_TEAM, PERMISSIONS.ATTENDANCE_READ_ALL];

/** A person who can be picked for a team (active employees, plus current members even if inactive). */
interface Candidate extends RequestEmployeeRef { managerId: string | null }

/**
 * Team tab: who this employee is responsible for as a manager. Direct reports (their direct manager is this
 * employee, supervised automatically) and the employees their login supervises explicitly (project manager).
 */
export function TeamTab({ employee, name, from, canManage }: {
  employee: EmployeeDto;
  name: string;
  from: string | null;
  canManage: boolean;
}) {
  const { t, locale } = useI18n();
  const m = t.managerTeam;
  const enc = encodeURIComponent(employee.id);
  const team = useApi<EmployeeTeamDto>(`/employees/${enc}/team`);
  const roles = useApi<RoleDto[]>('/roles');
  const [editing, setEditing] = useState(false);

  // Warnings come from the person's roles: without approve / team-read permission the team does nothing.
  const perms = useMemo(() => {
    const keys = new Set(employee.user?.roles.map((r) => r.key) ?? []);
    return new Set((roles.data ?? []).filter((r) => keys.has(r.key)).flatMap((r) => r.permissions));
  }, [employee.user, roles.data]);

  if (team.error && !team.data) return <ErrorState error={team.error} onRetry={() => void team.refetch()} />;
  if (!team.data) return <LoadingRows rows={4} />;
  const data = team.data;
  const size = data.directReports.length + data.supervised.length;
  const showWarnings = size > 0 && Boolean(roles.data) && Boolean(employee.user);
  const noApprove = showWarnings && !APPROVE_PERMISSIONS.some((p) => perms.has(p));
  const noTeamRead = showWarnings && !TEAM_READ.some((p) => perms.has(p));

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1 font-semibold">
            {m.title}
            <HelpTip text={m.help} />
            <span className="text-muted-foreground ms-1 text-sm font-normal">{fmt(m.count, { n: formatNumber(size, locale) })}</span>
          </h2>
          {canManage && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {m.edit}
            </Button>
          )}
        </div>
        <p className="sr-only">{m.help}</p>

        {(noApprove || noTeamRead) && (
          <div className="flex flex-wrap gap-2" role="status">
            {noApprove && <Warning label={m.noApprove} help={m.noApproveHelp} />}
            {noTeamRead && <Warning label={m.noTeamRead} help={m.noTeamReadHelp} />}
          </div>
        )}
        {!data.hasUser && <p className="text-muted-foreground text-sm">{m.noLogin}</p>}

        <MemberList title={m.directReports} help={m.directReportsHelp} empty={m.noDirectReports} rows={data.directReports} from={from} />
        <MemberList title={m.supervised} help={m.supervisedHelp} empty={m.noSupervised} rows={data.supervised} from={from} />
      </CardContent>

      {canManage && (
        <TeamDialog
          open={editing}
          onOpenChange={setEditing}
          employeeId={employee.id}
          name={name}
          team={data}
          onSaved={() => {
            setEditing(false);
            void team.refetch();
          }}
        />
      )}
    </Card>
  );
}

function Warning({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className="border-[color:var(--status-break)]/40 text-[color:var(--status-break)]">
        <AlertTriangle aria-hidden />
        {label}
      </Badge>
      <HelpTip text={help} />
      <span className="sr-only">{help}</span>
    </span>
  );
}

function MemberList({ title, help, empty, rows, from }: { title: string; help: string; empty: string; rows: RequestEmployeeRef[]; from: string | null }) {
  const { locale } = useI18n();
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1 text-sm font-medium">
        {title}
        <HelpTip text={help} />
      </h3>
      <p className="sr-only">{help}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="divide-tint/[0.06] divide-y rounded-xl border border-tint/[0.08]">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2 text-sm">
              <EmployeeLink id={r.id} name={r.fullName} nameAr={r.fullNameAr} from={from ?? undefined} />
              <span className="text-muted-foreground text-xs">
                <span dir="ltr">{r.employeeCode}</span>
                {r.departmentName && (
                  <>
                    {' · '}
                    <bdi>{localized(locale, r.departmentName, r.departmentNameAr)}</bdi>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamDialog({ open, onOpenChange, employeeId, name, team, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  name: string;
  team: EmployeeTeamDto;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const m = t.managerTeam;
  const [dirty, setDirty] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setDirty(false);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-2xl" dirty={open && dirty}>
        <DialogHeader>
          <DialogTitle>{fmt(m.editTitle, { name })}</DialogTitle>
          <DialogDescription>{fmt(m.editDescription, { name })}</DialogDescription>
        </DialogHeader>
        {open && (
          <TeamForm
            employeeId={employeeId}
            team={team}
            onDirtyChange={setDirty}
            onCancel={() => {
              setDirty(false);
              onOpenChange(false);
            }}
            onSaved={() => {
              setDirty(false);
              onSaved();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TeamForm({ employeeId, team, onDirtyChange, onCancel, onSaved }: {
  employeeId: string;
  team: EmployeeTeamDto;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const m = t.managerTeam;
  const employees = useApi<Paginated<EmployeeDto>>('/employees', { status: 'active', page: 1, pageSize: 200 });
  const [direct, setDirect] = useState<string[]>(() => team.directReports.map((r) => r.id));
  const [supervised, setSupervised] = useState<string[]>(() => team.supervised.map((r) => r.id));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const initialDirect = team.directReports.map((r) => r.id).sort().join();
  const initialSupervised = team.supervised.map((r) => r.id).sort().join();
  const dirty = [...direct].sort().join() !== initialDirect || [...supervised].sort().join() !== initialSupervised;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const candidates = useMemo<Candidate[]>(() => {
    const out = new Map<string, Candidate>();
    for (const e of employees.data?.items ?? []) {
      if (e.id === employeeId) continue;
      out.set(e.id, {
        id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, fullNameAr: e.fullNameAr,
        departmentId: e.departmentId, departmentName: e.departmentName, departmentNameAr: e.departmentNameAr, managerId: e.managerId,
      });
    }
    for (const r of team.directReports) if (!out.has(r.id)) out.set(r.id, { ...r, managerId: employeeId });
    for (const r of team.supervised) if (!out.has(r.id)) out.set(r.id, { ...r, managerId: null });
    return [...out.values()].sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  }, [employees.data, team, employeeId]);
  const byId = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const body: UpdateEmployeeTeamInput = { directReportIds: direct };
      // Direct reports are supervised automatically; only a login can supervise anyone else.
      if (team.hasUser) body.supervisedEmployeeIds = supervised.filter((id) => !direct.includes(id));
      await api<EmployeeTeamDto>(`/employees/${encodeURIComponent(employeeId)}/team`, { method: 'PUT', body });
      toast.success(m.saved);
      onSaved();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (employees.error && !employees.data) return <ErrorState compact error={employees.error} onRetry={() => void employees.refetch()} />;
  if (!employees.data) return <LoadingRows rows={6} className="px-0" />;

  return (
    <form onSubmit={save} className="grid gap-6" noValidate>
      <Picker
        id="team-direct"
        title={m.directReports}
        help={`${m.directReportsHelp} ${m.moveNote}`}
        candidates={candidates}
        selected={direct}
        onChange={setDirect}
        note={(c) => (c.managerId && c.managerId !== employeeId && byId.get(c.managerId)
          ? fmt(m.otherManager, { name: localized(locale, byId.get(c.managerId)!.fullName, byId.get(c.managerId)!.fullNameAr) })
          : null)}
      />
      {team.hasUser ? (
        <Picker
          id="team-supervised"
          title={m.supervised}
          help={m.supervisedHelp}
          candidates={candidates}
          selected={supervised.filter((id) => !direct.includes(id))}
          locked={direct}
          lockedLabel={m.alreadyDirect}
          onChange={setSupervised}
        />
      ) : (
        <p className="text-muted-foreground text-sm">{m.noLogin}</p>
      )}

      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t.common.cancel}
        </Button>
        <Button type="submit" disabled={saving || !dirty}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {saving ? t.common.saving : t.common.save}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Searchable checklist of employees; `locked` ids are shown checked and cannot be changed here. */
function Picker({ id, title, help, candidates, selected, onChange, locked = [], lockedLabel, note }: {
  id: string;
  title: string;
  help: string;
  candidates: Candidate[];
  selected: string[];
  onChange: (ids: string[]) => void;
  locked?: string[];
  lockedLabel?: string;
  note?: (c: Candidate) => string | null;
}) {
  const { t, locale } = useI18n();
  const m = t.managerTeam;
  const [query, setQuery] = useState('');
  const q = normalize(query.trim());
  const shown = candidates.filter((c) => !q || [c.fullName, c.fullNameAr ?? '', c.employeeCode].some((v) => normalize(v).includes(q)));
  // Chosen people first so the current team is visible without scrolling.
  const rank = (c: Candidate) => (selected.includes(c.id) ? 0 : locked.includes(c.id) ? 1 : 2);
  const ordered = [...shown].sort((a, b) => rank(a) - rank(b));
  const toggle = (cid: string, on: boolean) => onChange(on ? [...new Set([...selected, cid])] : selected.filter((x) => x !== cid));

  return (
    <fieldset className="grid gap-2" aria-describedby={`${id}-help`}>
      <legend className="mb-1 flex items-center gap-1 text-sm font-medium">
        {title}
        <HelpTip text={help} />
        <span className="text-muted-foreground ms-1 text-xs font-normal" aria-live="polite">
          {fmt(m.selected, { n: formatNumber(selected.length, locale) })}
        </span>
      </legend>
      <p id={`${id}-help`} className="sr-only">{help}</p>
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
        <Input
          id={`${id}-search`}
          type="search"
          className="ps-9"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder={m.search}
          aria-label={`${title}: ${m.search}`}
          autoComplete="off"
        />
      </div>
      {ordered.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m.noMatches}</p>
      ) : (
        <ul className="divide-tint/[0.06] max-h-56 divide-y overflow-y-auto rounded-xl border border-tint/[0.08]">
          {ordered.map((c) => {
            const isLocked = locked.includes(c.id);
            const checked = isLocked || selected.includes(c.id);
            const extra = isLocked ? lockedLabel : note?.(c);
            const label = localized(locale, c.fullName, c.fullNameAr);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm has-[:disabled]:cursor-default has-[:disabled]:opacity-70">
                  <Checkbox checked={checked} disabled={isLocked} onCheckedChange={(v) => toggle(c.id, v === true)} aria-label={label} />
                  <span className="min-w-0 flex-1">
                    <bdi className="font-medium">{label}</bdi>
                    <span className="text-muted-foreground block text-xs">
                      <span dir="ltr">{c.employeeCode}</span>
                      {c.departmentName && (
                        <>
                          {' · '}
                          <bdi>{localized(locale, c.departmentName, c.departmentNameAr)}</bdi>
                        </>
                      )}
                      {extra && ` · ${extra}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

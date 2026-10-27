'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Lock, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES, type CreateRoleInput, type RoleDto, type UpdateRoleInput } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckRow, FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { PageHeader } from '@/components/page-header';
import { ChoiceGroup } from '@/components/request-bits';
import { ErrorState, ForbiddenState, LoadingRows } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, apiDelete } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatNumber, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const P = PERMISSIONS;
const KEY_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const NONE = '__none';

/** Permissions shown as one "No / Only their team / Everyone" choice. */
const SCOPES = {
  attendance: { team: P.ATTENDANCE_READ_TEAM, all: P.ATTENDANCE_READ_ALL },
  reports: { team: P.REPORTS_READ_TEAM, all: P.REPORTS_READ_ALL },
} as const;
type ScopeKey = keyof typeof SCOPES;
type ScopeValue = 'none' | 'team' | 'all';

/** The permission matrix, grouped in plain language. Scope pairs are rendered as one choice. */
const GROUPS: { id: 'self' | 'see' | 'approve' | 'people' | 'setup'; scopes?: ScopeKey[]; permissions: string[] }[] = [
  { id: 'self', permissions: [P.ATTENDANCE_SELF, P.LEAVE_SELF, P.OVERTIME_SELF] },
  { id: 'see', scopes: ['attendance', 'reports'], permissions: [P.DASHBOARD_READ, P.EMPLOYEES_READ, P.REPORTS_EXPORT, P.AUDIT_READ] },
  { id: 'approve', permissions: [P.LEAVE_APPROVE, P.OVERTIME_APPROVE, P.CORRECTIONS_APPROVE, P.ATTENDANCE_CORRECT, P.TIMESHEETS_CLOSE] },
  { id: 'people', permissions: [P.EMPLOYEES_MANAGE, P.DEPARTMENTS_MANAGE, P.USERS_MANAGE, P.ROLES_MANAGE] },
  { id: 'setup', permissions: [P.SCHEDULES_MANAGE, P.BREAK_TYPES_MANAGE, P.OFFICES_MANAGE, P.SETTINGS_MANAGE, P.MASCOT_MANAGE] },
];

const scopeOf = (perms: Set<string>, key: ScopeKey): ScopeValue =>
  perms.has(SCOPES[key].all) ? 'all' : perms.has(SCOPES[key].team) ? 'team' : 'none';

function withScope(perms: Set<string>, key: ScopeKey, value: ScopeValue): Set<string> {
  const next = new Set(perms);
  next.delete(SCOPES[key].team);
  next.delete(SCOPES[key].all);
  if (value !== 'none') next.add(SCOPES[key][value]);
  return next;
}

export default function RolesPage() {
  const { can } = useAuth();
  if (!can(P.ROLES_MANAGE)) return <ForbiddenState />;
  return <Roles />;
}

function Roles() {
  const { t, locale } = useI18n();
  const r = t.approvalChains.roles;
  const list = useApi<RoleDto[]>('/roles');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const roles = list.data ?? [];
  const selected = roles.find((x) => x.id === selectedId) ?? roles[0] ?? null;
  const nameOf = (x: RoleDto) => localized(locale, x.name, x.nameAr);

  const pick = (id: string) => {
    if (dirty && !window.confirm(r.changed)) return;
    setDirty(false);
    setSelectedId(id);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={r.title}
        description={`${r.subtitle} ${r.teamExplained}`}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {r.add}
          </Button>
        }
      />

      {list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <LoadingRows rows={6} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <nav aria-label={r.title} className="grid content-start gap-2">
            {roles.map((x) => {
              const active = selected?.id === x.id;
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => pick(x.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex min-h-12 items-center gap-3 rounded-xl border border-tint/[0.08] bg-tint/[0.02] px-3 py-2 text-start transition-colors hover:bg-tint/[0.05]',
                    active && 'border-primary/50 bg-primary/10',
                  )}
                >
                  <ShieldCheck className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium"><bdi>{nameOf(x)}</bdi></span>
                    <span className="text-muted-foreground block text-xs">
                      <span dir="ltr">{x.key}</span> · {x.isSystem ? r.builtIn : r.custom}
                    </span>
                  </span>
                  <span className="text-muted-foreground inline-flex items-center gap-1 text-xs" title={r.users}>
                    <Users className="size-3.5" aria-hidden />
                    <span className="tabular">{formatNumber(x.userCount, locale)}</span>
                    <span className="sr-only">{fmt(r.usersCount, { n: x.userCount })}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          {selected ? (
            <RoleEditor
              key={selected.id}
              role={selected}
              onDirtyChange={setDirty}
              onSaved={() => {
                setDirty(false);
                void list.refetch();
              }}
              onDeleted={() => {
                setDirty(false);
                setSelectedId(null);
                void list.refetch();
              }}
            />
          ) : (
            <p className="text-muted-foreground text-sm">{r.selectRole}</p>
          )}
        </div>
      )}

      <CreateRoleDialog
        open={creating}
        roles={roles}
        onOpenChange={setCreating}
        onCreated={(role) => {
          setCreating(false);
          setDirty(false);
          setSelectedId(role.id);
          void list.refetch();
        }}
      />
    </div>
  );
}

/** Permission matrix for one role: scope choices and grouped checkboxes, each explained in a "?" tip. */
function PermissionMatrix({ value, onChange, disabled, idPrefix }: { value: Set<string>; onChange: (next: Set<string>) => void; disabled?: boolean; idPrefix: string }) {
  const { t } = useI18n();
  const r = t.approvalChains.roles;
  const toggle = (key: string, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };
  return (
    <div className="grid gap-5">
      {GROUPS.map((g) => (
        <fieldset key={g.id} className="grid gap-2 border-t border-tint/[0.08] pt-4 first:border-t-0 first:pt-0">
          <legend className="float-start mb-1 w-full text-sm font-semibold">{r.groups[g.id]}</legend>
          {g.scopes?.map((s) => (
            <ChoiceGroup<ScopeValue>
              key={s}
              id={`${idPrefix}-scope-${s}`}
              label={r.scopes[s].label}
              hint={`${r.scopes[s].help}\n\n${r.teamExplained}`}
              value={scopeOf(value, s)}
              onChange={(v) => !disabled && onChange(withScope(value, s, v))}
              options={[
                { value: 'none', label: r.scopeNone },
                { value: 'team', label: r.scopeTeam },
                { value: 'all', label: r.scopeAll },
              ]}
            />
          ))}
          <div className="grid gap-2 sm:grid-cols-2">
            {g.permissions.map((p) => (
              <CheckRow
                key={p}
                id={`${idPrefix}-${p}`}
                checked={value.has(p)}
                onCheckedChange={(c) => toggle(p, c)}
                label={r.perms[p]?.label ?? p}
                description={r.perms[p]?.help}
                disabled={disabled}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function RoleEditor({ role, onSaved, onDeleted, onDirtyChange }: { role: RoleDto; onSaved: () => void; onDeleted: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const r = t.approvalChains.roles;
  const locked = role.key === SYSTEM_ROLES.SUPER_ADMIN;
  const initial = useMemo(() => ({ name: role.name, nameAr: role.nameAr ?? '', description: role.description ?? '', permissions: [...role.permissions].sort().join() }), [role]);
  const [name, setName] = useState(initial.name);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [description, setDescription] = useState(initial.description);
  const [perms, setPerms] = useState(() => new Set(role.permissions));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);
  const dirty = name !== initial.name || nameAr !== initial.nameAr || description !== initial.description || [...perms].sort().join() !== initial.permissions;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError(t.employees.required);
      document.getElementById('role-name')?.focus();
      return;
    }
    setNameError(undefined);
    setSaving(true);
    setError(null);
    try {
      const body: UpdateRoleInput = {
        name: name.trim(), nameAr: nameAr.trim() || null, description: description.trim() || null,
        ...(locked ? {} : { permissions: [...perms] }),
      };
      await api<RoleDto>(`/roles/${encodeURIComponent(role.id)}`, { method: 'PATCH', body });
      toast.success(r.saved);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await apiDelete<void>(`/roles/${encodeURIComponent(role.id)}`);
      toast.success(r.deleted);
      onDeleted();
      return true;
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { reason?: string; users?: number; uses?: string[] } | undefined) : undefined;
      if (details?.reason === 'ASSIGNED') toast.error(fmt(r.deleteAssigned, { n: details.users ?? 0 }));
      else if (details?.reason === 'IN_APPROVAL_CHAIN') {
        const uses = (details.uses ?? []).map((u) => (u === 'pendingRequests' ? r.pendingRequests : u.replace(/^leaveType:/, ''))).join(locale === 'ar' ? '، ' : ', ');
        toast.error(fmt(r.deleteInChain, { uses }));
      } else toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <form onSubmit={save} className="grid gap-5" noValidate>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold"><bdi>{localized(locale, role.name, role.nameAr)}</bdi></h2>
              <p className="text-muted-foreground text-xs">
                <span dir="ltr">{role.key}</span> · {fmt(r.usersCount, { n: formatNumber(role.userCount, locale) })}
              </p>
              {t.approvalChains.roleHelp[role.key] && <p className="text-muted-foreground mt-1 text-sm">{t.approvalChains.roleHelp[role.key]}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{role.isSystem ? r.builtIn : r.custom}</Badge>
              {!role.isSystem && (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDeleting(true)} aria-label={`${t.common.delete}: ${localized(locale, role.name, role.nameAr)}`}>
                  <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="role-name" label={r.name} required error={nameError}>
              {({ id, describedBy, invalid, required }) => (
                <Input id={id} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} aria-required={required} maxLength={80} dir="auto" />
              )}
            </FormField>
            <FormField id="role-nameAr" label={r.nameAr} optional>
              {({ id, describedBy }) => <Input id={id} value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} maxLength={80} dir="rtl" lang="ar" />}
            </FormField>
            <FormField id="role-description" label={r.description} optional className="sm:col-span-2">
              {({ id, describedBy }) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby={describedBy} maxLength={500} rows={2} dir="auto" />}
            </FormField>
          </div>

          <div className="grid gap-3">
            <p className="flex items-center gap-1 text-sm font-semibold">
              {r.permissions}
              <HelpTip text={r.teamExplained} />
            </p>
            {locked && (
              <p className="flex items-center gap-2 rounded-xl border border-tint/[0.08] bg-tint/[0.03] p-3 text-sm">
                <Lock className="size-4 shrink-0" aria-hidden />
                {r.locked}
              </p>
            )}
            <PermissionMatrix value={locked ? new Set(ALL_PERMISSIONS) : perms} onChange={setPerms} disabled={locked} idPrefix={`perm-${role.key}`} />
          </div>

          {error && (
            <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {saving ? t.common.saving : r.save}
            </Button>
            {dirty && <span className="text-muted-foreground text-xs">{r.changed}</span>}
          </div>
        </form>
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={fmt(r.deleteTitle, { name: localized(locale, role.name, role.nameAr) })}
          description={r.deleteBody}
          confirmLabel={t.common.delete}
          destructive
          onConfirm={remove}
        />
      </CardContent>
    </Card>
  );
}

function CreateRoleDialog({ open, roles, onOpenChange, onCreated }: { open: boolean; roles: RoleDto[]; onOpenChange: (open: boolean) => void; onCreated: (role: RoleDto) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const r = t.approvalChains.roles;
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState(NONE);
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<{ key?: string; name?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey('');
    setName('');
    setNameAr('');
    setDescription('');
    setCopyFrom(NONE);
    setPerms(new Set());
    setErrors({});
    setFormError(null);
  }, [open]);

  const startFrom = (id: string) => {
    setCopyFrom(id);
    setPerms(new Set(roles.find((x) => x.id === id)?.permissions ?? []));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v: { key?: string; name?: string } = {};
    if (!KEY_RE.test(key.trim())) v.key = r.keyInvalid;
    if (!name.trim()) v.name = t.employees.required;
    setErrors(v);
    setFormError(null);
    if (v.key || v.name) {
      document.getElementById(v.key ? 'new-role-key' : 'new-role-name')?.focus();
      return;
    }
    setSaving(true);
    try {
      const body: CreateRoleInput = { key: key.trim(), name: name.trim(), nameAr: nameAr.trim() || null, description: description.trim() || null, permissions: [...perms] };
      const role = await api<RoleDto>('/roles', { method: 'POST', body });
      toast.success(r.created);
      onCreated(role);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') setErrors({ key: t.errors.CONFLICT });
      else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors({ key: r.keyInvalid });
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{r.createTitle}</DialogTitle>
          <DialogDescription>{r.subtitle}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="new-role-name" label={r.name} required error={errors.name}>
              {({ id, describedBy, invalid, required }) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setKey(e.target.value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^[^A-Z]+|_+$/g, '').slice(0, 40));
                  }}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  aria-required={required}
                  maxLength={80}
                  dir="auto"
                />
              )}
            </FormField>
            <FormField id="new-role-nameAr" label={r.nameAr} optional>
              {({ id, describedBy }) => <Input id={id} value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} maxLength={80} dir="rtl" lang="ar" />}
            </FormField>
            <FormField id="new-role-key" label={r.key} required error={errors.key} hint={r.keyHelp}>
              {({ id, describedBy, invalid, required }) => (
                <Input id={id} value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} aria-describedby={describedBy} aria-invalid={invalid} aria-required={required} maxLength={40} dir="ltr" autoComplete="off" />
              )}
            </FormField>
            <FormField id="new-role-copy" label={r.copyFrom} optional>
              {({ id, describedBy }) => (
                <Select value={copyFrom} onValueChange={startFrom}>
                  <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{r.copyNone}</SelectItem>
                    {roles.filter((x) => x.key !== SYSTEM_ROLES.SUPER_ADMIN).map((x) => (
                      <SelectItem key={x.id} value={x.id}>{localized(locale, x.name, x.nameAr)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField id="new-role-description" label={r.description} optional className="sm:col-span-2">
              {({ id, describedBy }) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby={describedBy} maxLength={500} rows={2} dir="auto" />}
            </FormField>
          </div>
          <div className="grid gap-3">
            <p className="text-sm font-semibold">{r.permissions}</p>
            <PermissionMatrix value={perms} onChange={setPerms} idPrefix="new-perm" />
          </div>
          {formError && (
            <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {saving ? t.common.saving : t.common.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

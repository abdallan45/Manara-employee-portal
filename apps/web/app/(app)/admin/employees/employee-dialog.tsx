'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  SYSTEM_ROLES,
  type CreateEmployeeInput,
  type DepartmentDto,
  type EmployeeDto,
  type Paginated,
  type RoleDto,
  type UpdateEmployeeInput,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckRow, FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import { ErrorState, FormErrorSummary, LoadingRows, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { CHANGE_PASSWORD_PATH } from '@/lib/nav';
import { useApi } from '@/lib/use-api';

const NONE = '__none';
const PASSWORD_MIN = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FormState {
  employeeCode: string;
  fullName: string;
  fullNameAr: string;
  email: string;
  phone: string;
  jobTitle: string;
  departmentId: string;
  managerId: string;
  hireDate: string;
  username: string;
  password: string;
  roleKeys: string[];
  managedDepartmentIds: string[];
}

type FieldKey = keyof FormState;
type Errors = Partial<Record<FieldKey, string>>;

/** Fields in the order they appear (Personal, Job, Access): the first invalid one gets focus. */
const FIELD_ORDER: FieldKey[] = ['fullName', 'fullNameAr', 'email', 'phone', 'employeeCode', 'jobTitle', 'departmentId', 'managerId', 'hireDate', 'username', 'password', 'roleKeys'];
/** Roles that open company-wide HR access: adding one asks for confirmation first. */
const PRIVILEGED: string[] = [SYSTEM_ROLES.SUPER_ADMIN, SYSTEM_ROLES.HR_ADMIN];

const EMPTY: FormState = {
  employeeCode: '',
  fullName: '',
  fullNameAr: '',
  email: '',
  phone: '',
  jobTitle: '',
  departmentId: NONE,
  managerId: NONE,
  hireDate: '',
  username: '',
  password: '',
  roleKeys: [SYSTEM_ROLES.EMPLOYEE],
  managedDepartmentIds: [],
};

function fromEmployee(e: EmployeeDto): FormState {
  const roles = e.user?.roles ?? [];
  return {
    employeeCode: e.employeeCode,
    fullName: e.fullName,
    fullNameAr: e.fullNameAr ?? '',
    email: e.email ?? '',
    phone: e.phone ?? '',
    jobTitle: e.jobTitle ?? '',
    departmentId: e.departmentId ?? NONE,
    managerId: e.managerId ?? NONE,
    hireDate: e.hireDate?.slice(0, 10) ?? '',
    username: e.user?.username ?? '',
    password: '',
    roleKeys: Array.from(new Set(roles.map((r) => r.key))),
    managedDepartmentIds: roles.filter((r) => r.key === SYSTEM_ROLES.DEPARTMENT_MANAGER && r.departmentId).map((r) => r.departmentId as string),
  };
}

/**
 * Create (employeeId = null) or edit an employee. `focusField="password"` focuses the new-password field
 * once the form is loaded (the employee page's "Reset password").
 */
export function EmployeeDialog({ open, employeeId, onOpenChange, onSaved, focusField }: {
  open: boolean;
  employeeId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (employee: EmployeeDto) => void;
  focusField?: 'password';
}) {
  const { t } = useI18n();
  const h = t.employeeHub.dialog;
  const editing = employeeId !== null;
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
          <DialogTitle>{editing ? t.employees.editTitle : t.employees.createTitle}</DialogTitle>
          <DialogDescription>{editing ? h.editDescription : h.createDescription}</DialogDescription>
        </DialogHeader>
        {open && (
          <EmployeeFormLoader
            key={employeeId ?? 'new'}
            employeeId={employeeId}
            focusField={focusField}
            onDirtyChange={setDirty}
            onCancel={() => {
              setDirty(false);
              onOpenChange(false);
            }}
            onSaved={(e) => {
              setDirty(false);
              onSaved(e);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmployeeFormLoader({ employeeId, focusField, onDirtyChange, onCancel, onSaved }: {
  employeeId: string | null;
  focusField?: 'password';
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: (e: EmployeeDto) => void;
}) {
  const existing = useApi<EmployeeDto>(employeeId ? `/employees/${encodeURIComponent(employeeId)}` : null);
  if (employeeId && existing.error && !existing.data) return <ErrorState compact error={existing.error} onRetry={() => void existing.refetch()} />;
  if (employeeId && !existing.data) return <LoadingRows rows={6} className="px-0" />;
  return <EmployeeForm existing={existing.data ?? null} focusField={focusField} onDirtyChange={onDirtyChange} onCancel={onCancel} onSaved={onSaved} />;
}

function EmployeeForm({ existing, focusField, onDirtyChange, onCancel, onSaved }: {
  existing: EmployeeDto | null;
  focusField?: 'password';
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: (e: EmployeeDto) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const { user: me } = useAuth();
  const f = t.employees.fields;
  const h = t.employeeHub.dialog;
  const sec = t.accountSecurity;
  // Nobody sets their own password here (the API answers 403): the signed-in user gets a link instead.
  const isSelf = existing !== null && (existing.user?.id === me.id || existing.id === me.employee?.id);
  const [initial] = useState<FormState>(() => (existing ? fromEmployee(existing) : EMPTY));
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmGrant, setConfirmGrant] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (focusField === 'password') document.getElementById('emp-password')?.focus();
  }, [focusField]);

  const roles = useApi<RoleDto[]>('/roles');
  const departments = useApi<DepartmentDto[]>('/departments');
  const managers = useApi<Paginated<EmployeeDto>>('/employees', { status: 'active', page: 1, pageSize: 200 });

  const isManager = form.roleKeys.includes(SYSTEM_ROLES.DEPARTMENT_MANAGER);
  const managerOptions = useMemo(() => (managers.data?.items ?? []).filter((m) => m.id !== existing?.id), [managers.data, existing]);

  useEffect(() => {
    if (!isManager && form.managedDepartmentIds.length > 0) setForm((s) => ({ ...s, managedDepartmentIds: [] }));
  }, [isManager, form.managedDepartmentIds.length]);

  const set = <K extends FieldKey>(key: K, value: FormState[K]) => {
    setForm((s) => ({ ...s, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const toggle = (key: 'roleKeys' | 'managedDepartmentIds', value: string, on: boolean) =>
    set(key, on ? Array.from(new Set([...form[key], value])) : form[key].filter((v) => v !== value));

  const validate = (): Errors => {
    const e: Errors = {};
    if (!form.employeeCode.trim()) e.employeeCode = t.employees.required;
    if (!form.fullName.trim()) e.fullName = t.employees.required;
    if (!form.username.trim()) e.username = t.employees.required;
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) e.email = t.employees.invalidEmail;
    if (!existing && !form.password) e.password = t.employees.required;
    else if (form.password && form.password.length < PASSWORD_MIN) e.password = t.employees.passwordTooShort;
    if (form.roleKeys.length === 0) e.roleKeys = t.employees.rolesRequired;
    return e;
  };

  const idOf = (key: FieldKey) =>
    key === 'departmentId' ? 'emp-department' : key === 'managerId' ? 'emp-manager' : key === 'roleKeys' ? `role-${roles.data?.[0]?.key ?? ''}` : `emp-${key}`;
  const labelOf = (key: FieldKey): string =>
    key === 'roleKeys' ? f.roles : key === 'password' && existing ? f.newPassword : ((f as Record<string, string>)[key] ?? key);
  const addsPrivileged = form.roleKeys.some((k) => PRIVILEGED.includes(k) && !initial.roleKeys.includes(k));

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    const v = validate();
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length > 0) {
      focusFirstError(FIELD_ORDER.filter((k) => v[k]).map(idOf));
      return;
    }
    if (addsPrivileged) {
      setConfirmGrant(true);
      return;
    }
    void save();
  };

  const save = async (): Promise<boolean> => {
    // Empty optional strings mean "clear" for the API.
    const common = {
      employeeCode: form.employeeCode.trim(),
      fullName: form.fullName.trim(),
      fullNameAr: form.fullNameAr.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      jobTitle: form.jobTitle.trim(),
      departmentId: form.departmentId === NONE ? null : form.departmentId,
      managerId: form.managerId === NONE ? null : form.managerId,
      hireDate: form.hireDate,
      username: form.username.trim().toLowerCase(),
      roleKeys: form.roleKeys,
      managedDepartmentIds: isManager ? form.managedDepartmentIds : [],
    };

    setSaving(true);
    try {
      let saved: EmployeeDto;
      if (existing) {
        const body: UpdateEmployeeInput = { ...common, ...(form.password && !isSelf ? { password: form.password } : {}) };
        saved = await api<EmployeeDto>(`/employees/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body });
        toast.success(fmt(t.employees.updatedToast, { name: localized(locale, saved.fullName, saved.fullNameAr) }));
      } else {
        const body: CreateEmployeeInput = {
          ...common,
          fullNameAr: common.fullNameAr || undefined,
          email: common.email || undefined,
          phone: common.phone || undefined,
          jobTitle: common.jobTitle || undefined,
          hireDate: common.hireDate || undefined,
          password: form.password,
        };
        saved = await api<EmployeeDto>('/employees', { method: 'POST', body });
        toast.success(fmt(t.employees.createdToast, { name: localized(locale, saved.fullName, saved.fullNameAr) }));
      }
      onSaved(saved);
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'EMPLOYEE_CODE_TAKEN') {
          setErrors({ employeeCode: t.errors.EMPLOYEE_CODE_TAKEN });
          focusFirstError(['emp-employeeCode']);
        } else if (err.code === 'USERNAME_TAKEN') {
          setErrors({ username: t.errors.USERNAME_TAKEN });
          focusFirstError(['emp-username']);
        }
        else if (err.code === 'VALIDATION_FAILED') {
          const fe = fieldErrorsFrom(err.details);
          const known: Errors = {};
          for (const [k, msg] of Object.entries(fe)) if (k in form) known[k as FieldKey] = msg;
          setErrors(known);
          setFormError(errorMessage(err));
        } else setFormError(errorMessage(err));
      } else setFormError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const text = (key: Exclude<FieldKey, 'roleKeys' | 'managedDepartmentIds' | 'departmentId' | 'managerId'>, label: string, opts: { optional?: boolean; required?: boolean; type?: string; ltr?: boolean; hint?: string; autoComplete?: string } = {}) => (
    <FormField id={`emp-${key}`} label={label} optional={opts.optional} required={opts.required} error={errors[key]} hint={opts.hint}>
      {({ id, describedBy, invalid, required }) => (
        <Input
          id={id}
          type={opts.type ?? 'text'}
          dir={opts.ltr ? 'ltr' : undefined}
          value={form[key]}
          onChange={(e) => set(key, e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          aria-required={required}
          autoComplete={opts.autoComplete ?? 'off'}
        />
      )}
    </FormField>
  );

  const deptName = (d: DepartmentDto) => (locale === 'ar' && d.nameAr) || d.name;

  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <FormErrorSummary errors={FIELD_ORDER.filter((k) => errors[k]).map((k) => ({ id: idOf(k), message: `${labelOf(k)}: ${errors[k]}` }))} />

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="text-brand-soft mb-3 text-xs font-semibold tracking-wider uppercase">{h.sectionPersonal}</legend>
        {text('fullName', f.fullName, { required: true })}
        {text('fullNameAr', f.fullNameAr, { optional: true })}
        {text('email', f.email, { optional: true, type: 'email', ltr: true })}
        {text('phone', f.phone, { optional: true, type: 'tel', ltr: true })}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="text-brand-soft mb-3 text-xs font-semibold tracking-wider uppercase">{h.sectionJob}</legend>
        {text('employeeCode', f.employeeCode, { ltr: true, required: true })}
        {text('jobTitle', f.jobTitle, { optional: true })}
        <FormField id="emp-department" label={f.department} optional error={errors.departmentId}>
          {({ id, describedBy }) => (
            <Select value={form.departmentId} onValueChange={(v) => set('departmentId', v)}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t.employees.noDepartment}</SelectItem>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {deptName(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField id="emp-manager" label={f.manager} optional error={errors.managerId}>
          {({ id, describedBy }) => (
            <Select value={form.managerId} onValueChange={(v) => set('managerId', v)}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t.employees.noManager}</SelectItem>
                {managerOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {(locale === 'ar' && m.fullNameAr) || m.fullName} · {m.employeeCode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        {text('hireDate', f.hireDate, { optional: true, type: 'date' })}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="text-brand-soft mb-3 text-xs font-semibold tracking-wider uppercase">{h.sectionAccess}</legend>
        {text('username', f.username, { ltr: true, required: true })}
        {isSelf ? (
          <div className="grid content-start gap-1.5">
            <p className="text-sm font-medium">{f.newPassword}</p>
            <p className="text-muted-foreground text-xs">{sec.ownPasswordNote}</p>
            <Button asChild variant="outline" size="sm" className="justify-self-start">
              <Link id="emp-password" href={CHANGE_PASSWORD_PATH}>
                <KeyRound aria-hidden />
                {sec.ownPasswordLink}
              </Link>
            </Button>
          </div>
        ) : (
          text('password', existing ? f.newPassword : f.password, {
            type: 'password',
            ltr: true,
            optional: Boolean(existing),
            required: !existing,
            hint: `${existing ? t.employees.passwordEditHint : t.employees.passwordHint} ${sec.adminSetHint}`,
            autoComplete: 'new-password',
          })
        )}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="sr-only">{f.roles}</legend>
        <p className="text-sm font-medium">{f.roles}</p>
        {roles.error && !roles.data ? (
          <ErrorState compact error={roles.error} onRetry={() => void roles.refetch()} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={f.roles} aria-describedby={errors.roleKeys ? 'emp-roles-error' : undefined}>
            {(roles.data ?? []).map((r) => (
              <CheckRow
                key={r.id}
                id={`role-${r.key}`}
                checked={form.roleKeys.includes(r.key)}
                onCheckedChange={(c) => toggle('roleKeys', r.key, c)}
                label={t.employeeHub.roles[r.key] ?? r.name}
                description={r.description ?? undefined}
              />
            ))}
          </div>
        )}
        {errors.roleKeys && (
          <p id="emp-roles-error" className="text-xs text-[color:var(--status-absent)]">
            {errors.roleKeys}
          </p>
        )}
        {isManager && (
          <div className="grid gap-2">
            <p className="flex items-center gap-1 text-sm font-medium">
              {f.managedDepartments}
              <HelpTip text={t.employees.managedHint} />
            </p>
            <p id="managed-depts-hint" className="sr-only">
              {t.employees.managedHint}
            </p>
            <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={f.managedDepartments} aria-describedby="managed-depts-hint">
              {(departments.data ?? []).map((d) => (
                <CheckRow
                  key={d.id}
                  id={`mdept-${d.id}`}
                  checked={form.managedDepartmentIds.includes(d.id)}
                  onCheckedChange={(c) => toggle('managedDepartmentIds', d.id, c)}
                  label={deptName(d)}
                />
              ))}
            </div>
          </div>
        )}
      </fieldset>

      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}

      <ConfirmDialog
        open={confirmGrant}
        onOpenChange={setConfirmGrant}
        title={fmt(h.grantTitle, { name: localized(locale, form.fullName.trim(), form.fullNameAr.trim()) || h.newEmployee })}
        description={h.grantBody}
        confirmLabel={h.grantConfirm}
        onConfirm={async () => {
          // Close either way: a failed save shows its errors in the form behind.
          await save();
          return true;
        }}
      />

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
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

'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, type DepartmentDto } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { FormField } from '@/components/form-field';
import { PageHeader } from '@/components/page-header';
import { ForbiddenState, FormErrorSummary, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, api, apiDelete, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';

const NONE = '__none';
const CODE_RE = /^[A-Z0-9_-]{2,32}$/;
/** Form field -> control id, in visual order (error summary and first-error focus follow it). */
const FIELD_IDS = { code: 'dept-code', name: 'dept-name', nameAr: 'dept-nameAr', parentId: 'dept-parent' } as const;
type FieldKey = keyof typeof FIELD_IDS;
const FIELD_ORDER = Object.keys(FIELD_IDS) as FieldKey[];
const errorIds = (v: Record<string, string>) => FIELD_ORDER.filter((k) => v[k]).map((k) => FIELD_IDS[k]);

export default function DepartmentsPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.DEPARTMENTS_MANAGE)) return <ForbiddenState />;
  return <Departments />;
}

function Departments() {
  const { t, locale, errorMessage } = useI18n();
  const list = useApi<DepartmentDto[]>('/departments');
  const [editing, setEditing] = useState<DepartmentDto | 'new' | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [deleting, setDeleting] = useState<DepartmentDto | null>(null);

  const nameOf = (d: DepartmentDto) => (locale === 'ar' && d.nameAr) || d.name;
  const byId = new Map((list.data ?? []).map((d) => [d.id, d]));

  const close = () => {
    setEditing(null);
    setFormDirty(false);
  };

  const remove = async (d: DepartmentDto) => {
    try {
      await apiDelete<void>(`/departments/${encodeURIComponent(d.id)}`);
      toast.success(t.common.deletedToast);
      void list.refetch();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'CONFLICT' ? `${t.errors.CONFLICT} ${t.departments.deleteBody}` : errorMessage(err));
      return false;
    }
  };

  const columns: Column<DepartmentDto>[] = [
    { id: 'code', header: t.common.code, cell: (d) => <span className="tabular font-medium" dir="ltr">{d.code}</span> },
    { id: 'name', header: t.common.name, cell: (d) => d.name },
    { id: 'nameAr', header: t.common.nameAr, cell: (d) => <span lang="ar">{d.nameAr ?? '—'}</span> },
    { id: 'parent', header: t.departments.parent, cell: (d) => <span className="text-muted-foreground">{d.parentId ? (byId.get(d.parentId) ? nameOf(byId.get(d.parentId) as DepartmentDto) : '—') : t.departments.noParent}</span> },
    { id: 'count', header: t.departments.employeeCount, cell: (d) => <span className="tabular">{d.employeeCount}</span> },
    {
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-24 text-end',
      cell: (d) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(d)} aria-label={`${t.common.edit}: ${nameOf(d)}`}>
            <Pencil aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(d)} aria-label={`${t.common.delete}: ${nameOf(d)}`}>
            <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.departments.title}
        description={t.departments.subtitle}
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t.departments.add}
          </Button>
        }
      />
      <Card className="gap-0 py-0">
        <DataTable
          rows={list.data}
          columns={columns}
          rowKey={(d) => d.id}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={t.departments.empty}
          mobileCard={(d) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{nameOf(d)}</p>
                <p className="text-muted-foreground text-xs">
                  <span dir="ltr">{d.code}</span> · {t.departments.employeeCount}: {d.employeeCount}
                </p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => setEditing(d)} aria-label={`${t.common.edit}: ${nameOf(d)}`}>
                  <Pencil aria-hidden />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(d)} aria-label={`${t.common.delete}: ${nameOf(d)}`}>
                  <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
                </Button>
              </div>
            </div>
          )}
        />
      </Card>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent closeLabel={t.common.close} dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? t.departments.createTitle : t.departments.editTitle}</DialogTitle>
            <DialogDescription>{t.departments.subtitle}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <DepartmentForm
              key={editing === 'new' ? 'new' : editing.id}
              existing={editing === 'new' ? null : editing}
              all={list.data ?? []}
              onDirtyChange={setFormDirty}
              onCancel={close}
              onSaved={() => {
                close();
                void list.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={deleting ? fmt(t.departments.deleteTitle, { name: nameOf(deleting) }) : ''}
        description={t.departments.deleteBody}
        confirmLabel={t.common.delete}
        onConfirm={() => (deleting ? remove(deleting) : false)}
      />
    </div>
  );
}

function DepartmentForm({ existing, all, onCancel, onSaved, onDirtyChange }: {
  existing: DepartmentDto | null;
  all: DepartmentDto[];
  onCancel: () => void;
  onSaved: () => void;
  /** Typed changes: the dialog then asks before Esc, an outside click or the close button drops them. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const [initial] = useState(() => ({ code: existing?.code ?? '', name: existing?.name ?? '', nameAr: existing?.nameAr ?? '', parentId: existing?.parentId ?? NONE }));
  const [code, setCode] = useState(initial.code);
  const [name, setName] = useState(initial.name);
  const [nameAr, setNameAr] = useState(initial.nameAr);
  const [parentId, setParentId] = useState(initial.parentId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = code !== initial.code || name !== initial.name || nameAr !== initial.nameAr || parentId !== initial.parentId;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const labelOf: Record<FieldKey, string> = { code: t.common.code, name: t.common.name, nameAr: t.common.nameAr, parentId: t.departments.parent };
  const summary = FIELD_ORDER.filter((k) => errors[k]).map((k) => ({ id: FIELD_IDS[k], message: `${labelOf[k]}: ${errors[k]}` }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    const normalized = code.trim().toUpperCase();
    if (!CODE_RE.test(normalized)) v.code = t.uiFoundation.deptCodeInvalid;
    if (!name.trim()) v.name = t.employees.required;
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      // The summary (role="alert") announces the errors; focus goes to the first invalid field.
      focusFirstError(errorIds(v));
      return;
    }
    const body = { code: normalized, name: name.trim(), nameAr: nameAr.trim() || null, parentId: parentId === NONE ? null : parentId };
    setSaving(true);
    try {
      if (existing) await api<DepartmentDto>(`/departments/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body });
      else await api<DepartmentDto>('/departments', { method: 'POST', body });
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onSaved();
    } catch (err) {
      const fieldErrors = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? fieldErrorsFrom(err.details) : {};
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setErrors({ code: t.errors.CONFLICT });
        focusFirstError([FIELD_IDS.code]);
      } else if (errorIds(fieldErrors).length > 0) {
        setErrors(fieldErrors);
        focusFirstError(errorIds(fieldErrors));
      } else setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormErrorSummary errors={summary} />
      <FormField id="dept-code" label={t.common.code} error={errors.code} hint="A-Z 0-9 _ -">
        {({ id, describedBy, invalid }) => (
          <Input id={id} dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-describedby={describedBy} aria-invalid={invalid} maxLength={32} />
        )}
      </FormField>
      <FormField id="dept-name" label={t.common.name} error={errors.name}>
        {({ id, describedBy, invalid }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} />}
      </FormField>
      <FormField id="dept-nameAr" label={t.common.nameAr} optional error={errors.nameAr}>
        {({ id, describedBy, invalid }) => <Input id={id} dir="rtl" lang="ar" value={nameAr} onChange={(e) => setNameAr(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} />}
      </FormField>
      <FormField id="dept-parent" label={t.departments.parent} optional error={errors.parentId}>
        {({ id, describedBy }) => (
          <Select value={parentId} onValueChange={setParentId}>
            <SelectTrigger id={id} className="w-full" aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t.departments.noParent}</SelectItem>
              {all
                .filter((d) => d.id !== existing?.id)
                .map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {(locale === 'ar' && d.nameAr) || d.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
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
          {saving ? t.common.saving : existing ? t.common.save : t.common.create}
        </Button>
      </DialogFooter>
    </form>
  );
}

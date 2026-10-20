'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Maximize2, MoreHorizontal, Pencil, Plus, Power, PowerOff, Search } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS, type DepartmentDto, type EmployeeDto, type Paginated } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, Pagination, type Column } from '@/components/data-table';
import { employeeHref } from '@/components/employee-link';
import { PageHeader } from '@/components/page-header';
import { ForbiddenState } from '@/components/states';
import { ActiveBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDebounced } from '@/lib/use-debounced';
import { EmployeeDialog } from './employee-dialog';

const PAGE_SIZE = 25;
const ALL = '__all';
type StatusFilter = 'active' | 'inactive' | 'all';

export default function EmployeesPage() {
  const { can } = useAuth();
  if (!can(PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.EMPLOYEES_MANAGE)) return <ForbiddenState />;
  return (
    <Suspense fallback={null}>
      <Employees />
    </Suspense>
  );
}

function Employees() {
  const { can } = useAuth();
  const { t, locale, errorMessage } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const canManage = can(PERMISSIONS.EMPLOYEES_MANAGE);

  // ?id=<uuid> opens the edit dialog (deep-linkable without dynamic routes); ?new=1 opens create.
  const editId = params.get('id');
  const creating = params.get('new') === '1';
  const dialogOpen = canManage && (creating || editId !== null);

  // Search, department, status and page live in the URL (?q=&departmentId=&status=&page=), so reloads,
  // Back and the employee page's breadcrumb return to the same list.
  const urlQ = params.get('q') ?? '';
  const departmentId = params.get('departmentId') ?? ALL;
  const rawStatus = params.get('status');
  const status: StatusFilter = rawStatus === 'inactive' || rawStatus === 'all' ? rawStatus : 'active';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(urlQ);
  const [confirm, setConfirm] = useState<EmployeeDto | null>(null);
  const debounced = useDebounced(search.trim());

  const departments = useApi<DepartmentDto[]>('/departments');
  const list = useApi<Paginated<EmployeeDto>>('/employees', {
    search: urlQ || undefined,
    departmentId: departmentId === ALL ? undefined : departmentId,
    status,
    page,
    pageSize: PAGE_SIZE,
  });

  const setQuery = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const closeDialog = () => setQuery({ id: null, new: null });

  /** ?q= values written from the box that the URL may not show yet (router.replace commits later). */
  const ownWrites = useRef<string[]>([]);

  // The typed search reaches the URL once typing pauses; a new search starts at page 1.
  useEffect(() => {
    if (debounced !== urlQ) {
      ownWrites.current.push(debounced);
      setQuery({ q: debounced || null, page: null });
    }
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  // A navigation to this list with another ?q= (sidebar, command palette, a breadcrumb) keeps this
  // component mounted, so the box follows the URL. A change that is one of our own writes landing (perhaps
  // after the user typed on) is not a navigation and leaves the box alone.
  useEffect(() => {
    const own = ownWrites.current.indexOf(urlQ);
    if (own >= 0) {
      ownWrites.current = ownWrites.current.slice(own + 1);
      return;
    }
    ownWrites.current = [];
    if (urlQ !== debounced) setSearch(urlQ);
  }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps

  /** This list's URL without dialog params: the employee page's breadcrumb comes back here. */
  const listUrl = (() => {
    const q = new URLSearchParams(params.toString());
    q.delete('id');
    q.delete('new');
    const s = q.toString();
    return s ? `${pathname}?${s}` : pathname;
  })();
  const profileHref = (e: EmployeeDto) => employeeHref(e.id, undefined, listUrl);
  const roleLabel = (key: string) => t.employeeHub.roles[key] ?? key;

  const nameOf = (e: EmployeeDto) => (locale === 'ar' && e.fullNameAr) || e.fullName;

  const toggleActive = async (e: EmployeeDto) => {
    try {
      await apiPost<EmployeeDto>(`/employees/${encodeURIComponent(e.id)}/${e.isActive ? 'deactivate' : 'activate'}`);
      toast.success(fmt(e.isActive ? t.employees.deactivatedToast : t.employees.activatedToast, { name: nameOf(e) }));
      void list.refetch();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  const c = t.employees.cols;
  const columns: Column<EmployeeDto>[] = [
    {
      id: 'employee',
      header: c.employee,
      cell: (e) => (
        <div className="min-w-0">
          <p className="max-w-[16rem] truncate font-medium">
            <bdi>{nameOf(e)}</bdi>
          </p>
          {e.email && (
            <p className="text-muted-foreground max-w-[16rem] truncate text-xs" dir="ltr">
              {e.email}
            </p>
          )}
        </div>
      ),
    },
    { id: 'code', header: c.code, cell: (e) => <span className="tabular" dir="ltr">{e.employeeCode}</span> },
    { id: 'department', header: c.department, cell: (e) => <span className="text-muted-foreground">{localized(locale, e.departmentName, e.departmentNameAr) || '—'}</span> },
    { id: 'job', header: c.jobTitle, cell: (e) => <span className="text-muted-foreground">{e.jobTitle ?? '—'}</span> },
    {
      id: 'username',
      header: c.username,
      cell: (e) => (e.user ? <span dir="ltr">{e.user.username}</span> : <span className="text-muted-foreground">{t.employees.noAccount}</span>),
    },
    {
      id: 'roles',
      header: c.roles,
      cell: (e) => (
        <div className="flex flex-wrap gap-1">
          {Array.from(new Set((e.user?.roles ?? []).map((r) => r.key))).map((k) => (
            <Badge key={k} variant="outline" className="text-xs">
              {roleLabel(k)}
            </Badge>
          ))}
        </div>
      ),
    },
    { id: 'lastLogin', header: c.lastLogin, cell: (e) => <span className="text-muted-foreground tabular">{e.user?.lastLoginAt ? formatDateTime(e.user.lastLoginAt, locale) : t.employees.never}</span> },
    { id: 'status', header: c.status, cell: (e) => <ActiveBadge active={e.isActive} /> },
  ];
  if (canManage) {
    columns.push({
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-12 text-end',
      cell: (e) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${nameOf(e)}`} onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(ev) => ev.stopPropagation()}>
            <DropdownMenuItem asChild>
              <Link href={profileHref(e)}>
                <Maximize2 aria-hidden />
                {t.employeeProfile.openFull}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setQuery({ id: e.id, new: null })}>
              <Pencil aria-hidden />
              {t.common.edit}
            </DropdownMenuItem>
            <DropdownMenuItem variant={e.isActive ? 'destructive' : 'default'} onSelect={() => setConfirm(e)}>
              {e.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
              {e.isActive ? t.employees.deactivate : t.employees.activate}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.employees.title}
        description={t.employees.subtitle}
        actions={
          canManage && (
            <Button onClick={() => setQuery({ new: '1', id: null })}>
              <Plus aria-hidden />
              {t.employees.add}
            </Button>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="emp-search" className="text-xs">
            {t.common.search}
          </Label>
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
            <Input
              id="emp-search"
              className="ps-9"
              placeholder={t.employees.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label id="emp-dept-label" className="text-xs">
            {t.live.department}
          </Label>
          <Select
            value={departmentId}
            onValueChange={(v) => setQuery({ departmentId: v === ALL ? null : v, page: null })}
          >
            <SelectTrigger className="w-full" aria-labelledby="emp-dept-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t.live.allDepartments}</SelectItem>
              {(departments.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {(locale === 'ar' && d.nameAr) || d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label id="emp-status-label" className="text-xs">
            {t.employees.filterStatus}
          </Label>
          <Select
            value={status}
            onValueChange={(v) => setQuery({ status: v === 'active' ? null : v, page: null })}
          >
            <SelectTrigger className="w-full" aria-labelledby="emp-status-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t.common.active}</SelectItem>
              <SelectItem value="inactive">{t.common.inactive}</SelectItem>
              <SelectItem value="all">{t.common.all}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <DataTable
          rows={list.data?.items}
          columns={columns}
          rowKey={(e) => e.id}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={urlQ || departmentId !== ALL || status !== 'active' ? t.common.noResults : t.employees.empty}
          rowHref={profileHref}
          primaryColumnId="employee"
          resultCount={list.data?.total}
          mobileCard={(e) => (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  <bdi>{nameOf(e)}</bdi>
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  <span dir="ltr">{e.employeeCode}</span>
                  {e.departmentName ? ` · ${localized(locale, e.departmentName, e.departmentNameAr)}` : ''}
                  {e.jobTitle ? ` · ${e.jobTitle}` : ''}
                </p>
              </div>
              <ActiveBadge active={e.isActive} />
            </div>
          )}
        />
        {list.data && (
          <Pagination
            page={list.data.page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onPageChange={(n) => setQuery({ page: n === 1 ? null : String(n) })}
            className="border-t border-tint/[0.05]"
          />
        )}
      </Card>

      <EmployeeDialog
        open={dialogOpen}
        employeeId={creating ? null : editId}
        onOpenChange={(o) => !o && closeDialog()}
        onSaved={(saved) => {
          if (creating) {
            // Take ?new=1 out of the list's own history entry first (synchronously, so the push below cannot
            // overtake it), or Back from the new employee's page would open an empty create dialog again.
            // A null state lets Next copy its own entry state and sync useSearchParams, which closes the dialog.
            // The live pathname keeps the export's trailing slash, which a raw replaceState would not add.
            const entry = new URLSearchParams(window.location.search);
            entry.delete('new');
            entry.delete('id');
            const qs = entry.toString();
            window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
            // A new employee lands on their Overview with the setup checklist; the breadcrumb returns to this list.
            router.push(`${employeeHref(saved.id, 'overview', listUrl)}&welcome=1`);
            return;
          }
          closeDialog();
          void list.refetch();
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        destructive={confirm?.isActive ?? false}
        title={confirm ? fmt(confirm.isActive ? t.employeeHub.page.deactivateTitle : t.employeeHub.page.activateTitle, { name: nameOf(confirm) }) : ''}
        description={confirm?.isActive ? t.employeeHub.page.deactivateBody : t.employeeHub.page.activateBody}
        confirmLabel={confirm?.isActive ? t.employeeHub.page.deactivateConfirm : t.employeeHub.page.activateConfirm}
        cancelLabel={confirm?.isActive ? t.employeeHub.page.keepActive : t.employeeHub.page.keepInactive}
        onConfirm={() => (confirm ? toggleActive(confirm) : false)}
      />
    </div>
  );
}

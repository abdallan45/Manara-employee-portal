'use client';

import type { ReactNode } from 'react';
import { Copy, Mail, Pencil, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { SYSTEM_ROLES, type DepartmentDto, type EmployeeDto } from '@workforce/shared';

import { EmployeeLink } from '@/components/employee-link';
import { ActiveBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime, formatMinutes, formatNumber, formatWorkDate, localized, todayInAmman } from '@/lib/format';
import { fmt, type Dictionary } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';

type Plural = Dictionary['employeeHub']['profile']['years'];

/** "3 years 2 months" / "3 سنوات و2 شهران" between the hire date and today (null before the hire date). */
export function tenureText(hireDate: string, today: string, locale: 'en' | 'ar', p: Dictionary['employeeHub']['profile']): string | null {
  const [hy = 0, hm = 1, hd = 1] = hireDate.slice(0, 10).split('-').map(Number);
  const [ty = 0, tm = 1, td = 1] = today.split('-').map(Number);
  let months = (ty - hy) * 12 + (tm - hm) - (td < hd ? 1 : 0);
  if (months < 0) return null;
  if (months === 0) return p.lessThanMonth;
  const years = Math.floor(months / 12);
  months %= 12;
  const rules = new Intl.PluralRules(locale === 'ar' ? 'ar' : 'en');
  const word = (n: number, forms: Plural) => forms[rules.select(n) as keyof Plural].replace('{n}', formatNumber(n, locale));
  if (years && months) return fmt(p.join, { a: word(years, p.years), b: word(months, p.months) });
  return years ? word(years, p.years) : word(months, p.months);
}

/** Label / value pair; values wrap instead of being cut off. */
function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <h2 className="font-semibold">{title}</h2>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">{children}</dl>
      </CardContent>
    </Card>
  );
}

/** A tappable contact (mailto / tel) with a copy button. */
function Contact({ href, value, label, icon }: { href: string; value: string; label: string; icon: ReactNode }) {
  const { t } = useI18n();
  const p = t.employeeHub.profile;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(fmt(p.copied, { field: label }));
    } catch {
      toast.error(t.errors.UNKNOWN);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1">
      <a href={href} className="text-link inline-flex min-h-6 items-center gap-1.5 break-all underline-offset-4 hover:underline" dir="ltr">
        {icon}
        {value}
      </a>
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copy()} aria-label={fmt(p.copy, { field: label })}>
        <Copy aria-hidden />
      </Button>
    </span>
  );
}

/**
 * Profile & access tab: personal, employment, sign-in and roles, read-only. "Edit" opens the edit
 * dialog on this page (?edit=1) so the user stays here after saving.
 *
 * Without `onEdit` (people who may read but not manage employees, e.g. department managers) it shows
 * only the Personal and Employment cards, so they can still reach a team member's phone and email; the
 * Edit button and the Sign-in and Roles cards need EMPLOYEES_MANAGE.
 */
export function ProfileTab({ employee: e, manager, from, onEdit }: {
  employee: EmployeeDto;
  manager: EmployeeDto | null;
  from: string | null;
  /** Opens the edit dialog; omit for the read-only view. */
  onEdit?: () => void;
}) {
  const canManage = onEdit !== undefined;
  const { t, locale, units } = useI18n();
  const p = t.employeeHub.profile;
  const c = t.approvalChains.employee;
  const f = t.employees.fields;
  const departments = useApi<DepartmentDto[]>('/departments');
  const roleKeys = Array.from(new Set((e.user?.roles ?? []).map((r) => r.key)));
  const managed = (e.user?.roles ?? [])
    .filter((r) => r.key === SYSTEM_ROLES.DEPARTMENT_MANAGER && r.departmentId)
    .map((r) => departments.data?.find((d) => d.id === r.departmentId))
    .filter((d): d is DepartmentDto => !!d)
    .map((d) => localized(locale, d.name, d.nameAr));
  const tenure = e.hireDate ? tenureText(e.hireDate, todayInAmman(), locale, p) : null;
  const department = localized(locale, e.departmentName, e.departmentNameAr);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={onEdit}>
            <Pencil aria-hidden />
            {t.common.edit}
          </Button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={p.personal}>
          <Item label={p.nameEn}>
            <bdi>{e.fullName}</bdi>
          </Item>
          <Item label={p.nameAr}>{e.fullNameAr ? <bdi>{e.fullNameAr}</bdi> : '—'}</Item>
          <Item label={f.email}>
            {e.email ? <Contact href={`mailto:${e.email}`} value={e.email} label={f.email} icon={<Mail className="size-4 shrink-0" aria-hidden />} /> : '—'}
          </Item>
          <Item label={f.phone}>
            {e.phone ? <Contact href={`tel:${e.phone.replace(/\s+/g, '')}`} value={e.phone} label={f.phone} icon={<Phone className="size-4 shrink-0" aria-hidden />} /> : '—'}
          </Item>
        </Section>

        <Section title={p.employment}>
          <Item label={f.employeeCode}>
            <span dir="ltr">{e.employeeCode}</span>
          </Item>
          <Item label={f.department}>{department ? <bdi>{department}</bdi> : '—'}</Item>
          <Item label={f.jobTitle}>{e.jobTitle ? <bdi>{e.jobTitle}</bdi> : '—'}</Item>
          <Item label={f.manager}>
            {manager ? <EmployeeLink id={manager.id} name={manager.fullName} nameAr={manager.fullNameAr} from={from ?? undefined} /> : '—'}
          </Item>
          {managed.length > 0 && (
            <Item label={f.managedDepartments}>
              <span className="flex flex-wrap gap-1">
                {managed.map((d) => (
                  <Badge key={d} variant="outline">
                    <bdi>{d}</bdi>
                  </Badge>
                ))}
              </span>
            </Item>
          )}
          <Item label={c.supervisors}>
            {e.supervisors.length || e.directManagerSupervisor ? (
              <span className="flex flex-wrap gap-1">
                {e.directManagerSupervisor && (
                  <Badge variant="outline">
                    <bdi>{localized(locale, e.directManagerSupervisor.name, e.directManagerSupervisor.nameAr) || e.directManagerSupervisor.username}</bdi>
                    <span className="text-muted-foreground font-normal">({t.managerTeam.directManagerChip})</span>
                  </Badge>
                )}
                {e.supervisors.map((s) => (
                  <Badge key={s.userId} variant="outline">
                    <bdi>{localized(locale, s.name, s.nameAr) || s.username}</bdi>
                  </Badge>
                ))}
              </span>
            ) : (
              '—'
            )}
          </Item>
          {(e.dailyRequiredMinutes !== null || e.includedBreakMinutes !== null) && (
            <Item label={c.hours}>
              <span className="grid gap-0.5">
                {e.dailyRequiredMinutes !== null && <span>{c.dailyHours}: <bdi>{formatMinutes(e.dailyRequiredMinutes, units)}</bdi></span>}
                {e.includedBreakMinutes !== null && <span>{c.breakMinutes}: <bdi>{formatMinutes(e.includedBreakMinutes, units)}</bdi></span>}
              </span>
            </Item>
          )}
          <Item label={f.hireDate}>
            {e.hireDate ? (
              <>
                {formatWorkDate(e.hireDate, locale, 'long')}
                {tenure && <span className="text-muted-foreground block text-xs font-normal">{p.tenure}: {tenure}</span>}
              </>
            ) : (
              '—'
            )}
          </Item>
        </Section>

        {canManage && (
          <Section title={p.signIn}>
            <Item label={f.username}>{e.user ? <span dir="ltr">{e.user.username}</span> : t.employees.noAccount}</Item>
            <Item label={t.employees.cols.lastLogin}>{e.user?.lastLoginAt ? formatDateTime(e.user.lastLoginAt, locale) : t.employees.never}</Item>
            {e.user && (
              <Item label={p.account}>
                {e.user.isActive ? <ActiveBadge active /> : <span className="text-muted-foreground">{p.accountDisabled}</span>}
              </Item>
            )}
          </Section>
        )}

        {canManage && (
          <Card>
            <CardContent className="space-y-4">
              <h2 className="font-semibold">{p.roles}</h2>
              {roleKeys.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {roleKeys.map((k) => (
                    <li key={k}>
                      <Badge variant="outline">{t.approvalChains.roleNames[k] ?? t.employeeHub.roles[k] ?? k}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">{p.noRoles}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

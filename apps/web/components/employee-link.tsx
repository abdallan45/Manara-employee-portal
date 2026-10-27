'use client';

import Link from 'next/link';
import { PERMISSIONS } from '@workforce/shared';

import { useAuth } from '@/lib/auth';
import { localized } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

export type EmployeeTab = 'overview' | 'attendance' | 'leave' | 'overtime' | 'schedule' | 'team' | 'profile';

/** `from` must be a relative /admin/... URL (the URL contract); anything else is dropped. */
function safeFrom(from: string | undefined): string | undefined {
  if (!from) return undefined;
  return from === '/admin' || from.startsWith('/admin/') || from.startsWith('/admin?') ? from : undefined;
}

/** /admin/employees/view?id=..[&tab=..][&from=..] - the one way to address an employee profile. */
export function employeeHref(id: string, tab?: EmployeeTab | string, from?: string): string {
  const qs = new URLSearchParams({ id });
  if (tab) qs.set('tab', tab);
  const back = safeFrom(from);
  if (back) qs.set('from', back);
  return `/admin/employees/view?${qs.toString()}`;
}

/**
 * Employee name that links to the profile. The localized name sits in <bdi> (Arabic and Latin names
 * mix safely in either direction) and the employee code in dir=ltr. Users without EMPLOYEES_READ or
 * EMPLOYEES_MANAGE get plain text instead of a link to a page they cannot open.
 */
export function EmployeeLink({ id, name, nameAr, code, tab, from, className }: {
  id: string;
  name: string;
  nameAr?: string | null;
  code?: string | null;
  tab?: EmployeeTab | string;
  /** Relative /admin/... URL the profile's Back link returns to (usually the current list URL). */
  from?: string;
  className?: string;
}) {
  const { locale } = useI18n();
  const { can } = useAuth();
  const label = localized(locale, name, nameAr) || name;

  const content = (
    <>
      <bdi>{label}</bdi>
      {code && (
        <span dir="ltr" className="text-muted-foreground ms-1.5 text-xs font-normal">
          {code}
        </span>
      )}
    </>
  );

  if (!can(PERMISSIONS.EMPLOYEES_READ, PERMISSIONS.EMPLOYEES_MANAGE)) {
    return <span className={cn('font-medium', className)}>{content}</span>;
  }

  return (
    <Link
      href={employeeHref(id, tab, from)}
      className={cn(
        'text-foreground rounded-sm font-medium underline-offset-4 decoration-[color:var(--link)] hover:underline focus-visible:underline',
        className,
      )}
    >
      {content}
    </Link>
  );
}

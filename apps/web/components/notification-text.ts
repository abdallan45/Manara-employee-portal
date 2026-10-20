'use client';

import { AlarmClockOff, Bell, CircleCheck, CircleX, ClipboardCheck, Coffee, type LucideIcon } from 'lucide-react';
import { NOTIFICATION_TYPES, REQUEST_NOTIFICATION_TYPES, type NotificationDto, type RequestKind } from '@workforce/shared';

import { useAuth } from '@/lib/auth';
import { formatMinutes, formatNumber, formatWorkDate, localized } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { portalPageForPath, usePortal } from '@/lib/portal';

export interface NotificationText {
  title: string;
  body: string;
  icon: LucideIcon;
  color: string;
  /** Where opening the notification leads (the item it is about). Absent when there is nowhere useful to go. */
  href?: string;
  /** The reader is asked to do something (decide a request, fix a missing check-out). */
  action?: boolean;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const KINDS: readonly RequestKind[] = ['LEAVE', 'OVERTIME', 'CORRECTION'];

/** The employee's own page for a decided request of this kind. */
function ownRequestHref(kind: RequestKind | undefined, requestId: string | undefined): string | undefined {
  if (kind === 'LEAVE') return requestId ? `/me/leave?request=${encodeURIComponent(requestId)}` : '/me/leave';
  if (kind === 'OVERTIME') return '/me/overtime';
  if (kind === 'CORRECTION') return '/me/corrections';
  return undefined;
}

/**
 * Notifications are stored with English server text plus structured data; the UI renders them in the
 * viewer's language from the type and data. Unknown types fall back to the stored text.
 * Each one links to what it is about; links to "My work" pages HR turned off are dropped.
 */
export function useNotificationText(): (n: NotificationDto) => NotificationText {
  const { t, locale, units } = useI18n();
  const { user } = useAuth();
  const { isVisible } = usePortal();
  const types = t.notifications.types;

  /** Keeps a link only when its page is visible in the employee portal (admin pages are not portal pages). */
  const visible = (href: string | undefined): string | undefined => {
    if (!href) return undefined;
    const page = portalPageForPath(href.split('?')[0] ?? href);
    return page === null || isVisible(page) ? href : undefined;
  };

  return (n) => {
    const d = n.data;
    const name = localized(locale, str(d.employeeName), str(d.employeeNameAr));
    const requestId = str(d.requestId);
    if (n.type === NOTIFICATION_TYPES.MISSING_CHECKOUT) {
      const date = str(d.workDate) ? formatWorkDate(str(d.workDate)!, locale) : '';
      const aboutMe = !d.employeeId || d.employeeId === user.employee?.id;
      const x = aboutMe ? types.ATTENDANCE_MISSING_CHECKOUT : types.ATTENDANCE_MISSING_CHECKOUT_TEAM;
      const sessionId = str(d.sessionId);
      const employeeId = str(d.employeeId);
      const href = aboutMe
        ? sessionId
          ? `/me/corrections?new=1&session=${encodeURIComponent(sessionId)}`
          : '/me/corrections'
        : employeeId
          ? `/admin/employees/view?id=${encodeURIComponent(employeeId)}&tab=attendance`
          : '/admin/attendance';
      return {
        title: x.title,
        body: fmt(x.body, { date, name, code: str(d.employeeCode) ?? '' }),
        icon: AlarmClockOff,
        color: 'var(--status-missing)',
        href: visible(href),
        action: true,
      };
    }
    if (n.type === NOTIFICATION_TYPES.BREAK_OVERDUE) {
      const x = types.ATTENDANCE_BREAK_OVERDUE;
      const vars = {
        break: localized(locale, str(d.breakTypeName), str(d.breakTypeNameAr)),
        minutes: formatNumber(num(d.minutes) ?? 0, locale),
        limit: formatNumber(num(d.notifyAfterMinutes) ?? 0, locale),
      };
      return { title: x.title, body: fmt(x.body, vars), icon: Coffee, color: 'var(--status-break)', href: visible('/') };
    }
    const kind = typeof d.kind === 'string' && (KINDS as readonly string[]).includes(d.kind) ? (d.kind as RequestKind) : undefined;
    const vars = { kind: kind ? t.requests.kind[kind] : '', name };
    const comment = str(d.comment) ?? null;
    if (n.type === REQUEST_NOTIFICATION_TYPES.PENDING_APPROVAL) {
      const x = types.REQUEST_PENDING_APPROVAL;
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (requestId) params.set('id', requestId);
      const qs = params.toString();
      return {
        title: fmt(x.title, vars),
        body: fmt(x.body, vars),
        icon: ClipboardCheck,
        color: 'var(--brand-soft)',
        href: qs ? `/admin/approvals?${qs}` : '/admin/approvals',
        action: true,
      };
    }
    if (n.type === REQUEST_NOTIFICATION_TYPES.APPROVED && d.directOvertime === true) {
      const x = types.OVERTIME_DIRECT;
      const date = str(d.workDate) ? formatWorkDate(str(d.workDate)!, locale) : '';
      return {
        title: x.title,
        body: comment ?? fmt(x.body, { duration: formatMinutes(num(d.approvedMinutes) ?? 0, units), date }),
        icon: CircleCheck,
        color: 'var(--status-working)',
        href: visible('/me/overtime'),
      };
    }
    if (n.type === REQUEST_NOTIFICATION_TYPES.APPROVED && d.direct === true) {
      const x = types.ATTENDANCE_CORRECTED;
      return { title: x.title, body: comment ?? x.body, icon: CircleCheck, color: 'var(--status-working)', href: visible('/me/corrections') };
    }
    if (n.type === REQUEST_NOTIFICATION_TYPES.APPROVED || n.type === REQUEST_NOTIFICATION_TYPES.LEVEL_APPROVED) {
      const x = n.type === REQUEST_NOTIFICATION_TYPES.APPROVED ? types.REQUEST_APPROVED : types.REQUEST_LEVEL_APPROVED;
      return {
        title: fmt(x.title, vars),
        body: comment ?? fmt(x.body, vars),
        icon: CircleCheck,
        color: 'var(--status-working)',
        href: visible(ownRequestHref(kind, requestId)),
      };
    }
    if (n.type === REQUEST_NOTIFICATION_TYPES.REJECTED) {
      const x = types.REQUEST_REJECTED;
      return {
        title: fmt(x.title, vars),
        body: comment ?? fmt(x.body, vars),
        icon: CircleX,
        color: 'var(--status-absent)',
        href: visible(ownRequestHref(kind, requestId)),
      };
    }
    return { title: n.title, body: n.body, icon: Bell, color: 'var(--brand-soft)' };
  };
}

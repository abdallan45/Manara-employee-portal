'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { NotificationDto, Paginated } from '@workforce/shared';

import { Pagination } from '@/components/data-table';
import { useNotificationText, type NotificationText } from '@/components/notification-text';
import { NOTIFICATIONS_CHANGED_EVENT, markNotificationRead } from '@/components/notifications-bell';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const { t, locale, errorMessage } = useI18n();
  const s = t.employeeSelfService.notifications;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useApi<Paginated<NotificationDto>>('/notifications', { unread: unreadOnly ? 'true' : undefined, page, pageSize: PAGE_SIZE });

  const changed = () => {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
    void list.refetch();
  };

  const markRead = async (n: NotificationDto) => {
    setBusy(n.id);
    try {
      await apiPost<unknown>(`/notifications/${encodeURIComponent(n.id)}/read`);
      changed();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Opening a notification marks it read (in the background; the link navigates at once). */
  const opened = (n: NotificationDto) => {
    if (n.readAt) return;
    if (list.data) list.setData({ ...list.data, items: list.data.items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) });
    markNotificationRead(n.id);
  };

  const markAll = async () => {
    setBusy('all');
    try {
      await apiPost<unknown>('/notifications/read-all');
      toast.success(t.notifications.allReadToast);
      changed();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const present = useNotificationText();

  const items = list.data?.items;
  const hasUnread = items?.some((n) => !n.readAt) ?? false;
  const shown = (items ?? []).map((n) => ({ n, p: present(n) }));
  const needsAction = shown.filter(({ n, p }) => p.action && !n.readAt);
  const updates = shown.filter(({ n, p }) => !(p.action && !n.readAt));

  const row = ({ n, p }: { n: NotificationDto; p: NotificationText }) => {
    const Icon = p.icon;
    const content: ReactNode = (
      <>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ color: p.color, background: `color-mix(in srgb, ${p.color} 12%, transparent)` }}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn('font-medium', p.href && 'decoration-[color:var(--link)] underline-offset-4 group-hover:underline')}>{p.title}</span>
            {!n.readAt && (
              <span className="bg-brand-cta rounded-full px-2 py-0.5 text-xs font-bold text-white">
                {t.notifications.new}
                <span className="sr-only"> ({s.unread})</span>
              </span>
            )}
          </span>
          <span className="text-muted-foreground block text-sm" dir="auto">{p.body}</span>
          <span className="text-brand-subtle block text-xs">{formatDateTime(n.createdAt, locale)}</span>
        </span>
      </>
    );
    return (
      <li key={n.id} className={cn('flex items-start', !n.readAt && 'bg-tint/[0.02]')}>
        {p.href ? (
          <Link href={p.href} onClick={() => opened(n)} className="group flex min-w-0 flex-1 gap-3 p-4 hover:bg-tint/[0.03] focus-visible:-outline-offset-2">
            {content}
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 gap-3 p-4">{content}</div>
        )}
        {!n.readAt && (
          <Button variant="ghost" size="sm" className="m-3 shrink-0 max-md:size-10 max-md:p-0" onClick={() => void markRead(n)} disabled={busy !== null}>
            {busy === n.id ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCheck aria-hidden />}
            <span className="hidden md:inline">{t.notifications.markRead}</span>
            <span className="sr-only md:hidden">{t.notifications.markRead}</span>
          </Button>
        )}
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t.notifications.title}
        description={t.notifications.subtitle}
        actions={
          <Button variant="outline" onClick={() => void markAll()} disabled={busy !== null || (!hasUnread && !unreadOnly)}>
            {busy === 'all' ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCheck aria-hidden />}
            {t.notifications.markAllRead}
          </Button>
        }
      />

      <div className="flex items-center gap-2">
        <Switch
          id="unread-only"
          checked={unreadOnly}
          onCheckedChange={(c) => {
            setUnreadOnly(c);
            setPage(1);
          }}
        />
        <Label htmlFor="unread-only">{t.notifications.unreadOnly}</Label>
      </div>

      <Card className="gap-0 py-0">
        {list.error && !items ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !items ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <EmptyState icon={Bell} title={t.notifications.empty} />
        ) : (
          <div className={cn('transition-opacity', list.refreshing && 'opacity-60')}>
            {needsAction.length > 0 && (
              <section aria-labelledby="notif-action">
                <h2 id="notif-action" className="text-muted-foreground px-4 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase">{s.needsAction}</h2>
                <ul className="divide-y divide-tint/[0.05]">{needsAction.map(row)}</ul>
              </section>
            )}
            {updates.length > 0 && (
              <section aria-labelledby={needsAction.length > 0 ? 'notif-updates' : undefined} className={cn(needsAction.length > 0 && 'border-t border-tint/[0.05]')}>
                {needsAction.length > 0 && (
                  <h2 id="notif-updates" className="text-muted-foreground px-4 pt-4 pb-1 text-xs font-semibold tracking-wide uppercase">{s.updates}</h2>
                )}
                <ul className="divide-y divide-tint/[0.05]">{updates.map(row)}</ul>
              </section>
            )}
          </div>
        )}
        {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPageChange={setPage} className="border-t border-tint/[0.05]" />}
      </Card>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import type { NotificationDto, Paginated } from '@workforce/shared';

import { useNotificationText } from '@/components/notification-text';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiGet, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';

export const NOTIFICATIONS_CHANGED_EVENT = 'wf:notifications-changed';

/**
 * Marks one notification read in the background and tells the bell (and nav counts) to refresh.
 * Used when a notification is opened; failures are ignored (it simply stays unread).
 */
export function markNotificationRead(id: string): void {
  void apiPost<unknown>(`/notifications/${encodeURIComponent(id)}/read`)
    .then(() => window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT)))
    .catch(() => undefined);
}

const COUNT_OPTIONS = { refreshMs: 60_000, refetchOnFocus: true };

/**
 * Top-bar bell: unread count, latest items loaded when opened. Each item opens what it is about.
 *
 * `unreadCount`: the count the shell already polls (useNavCounts().notifications). Pass it so the bell does
 * not poll /notifications/unread-count a second time; without it the bell polls on its own (every 60 s,
 * on focus and on NOTIFICATIONS_CHANGED_EVENT, like useNavCounts).
 */
export function NotificationsBell({ unreadCount }: { unreadCount?: number } = {}) {
  const { t, locale } = useI18n();
  const present = useNotificationText();
  const ownCount = unreadCount === undefined;
  const own = useApi<{ count: number }>(ownCount ? '/notifications/unread-count' : null, undefined, COUNT_OPTIONS);
  const refetchOwn = own.refetch;
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Items opened here count as read at once; the adjustment ends as soon as the source count moves.
  const [readHere, setReadHere] = useState<{ base: number; n: number } | null>(null);

  useEffect(() => {
    if (!ownCount) return;
    const onChanged = () => void refetchOwn();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
  }, [ownCount, refetchOwn]);

  // A failed poll keeps the last known count (useApi keeps its data).
  const source = unreadCount ?? own.data?.count ?? 0;
  const count = readHere && readHere.base === source ? Math.max(0, source - readHere.n) : source;

  const onOpenChange = async (open: boolean) => {
    if (!open) return;
    setFailed(false);
    try {
      const res = await apiGet<Paginated<NotificationDto>>('/notifications', { page: 1 });
      setItems(res.items.slice(0, 5));
    } catch {
      setFailed(true);
    }
  };

  const open = (n: NotificationDto) => {
    if (n.readAt) return;
    setItems((list) => list?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? list);
    setReadHere((r) => (r && r.base === source ? { base: source, n: r.n + 1 } : { base: source, n: 1 }));
    markNotificationRead(n.id);
  };

  const label = count > 0 ? `${t.notifications.bell} - ${fmt(t.notifications.unreadCount, { n: count })}` : t.notifications.bell;

  return (
    <DropdownMenu onOpenChange={(o) => void onOpenChange(o)}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell aria-hidden />
          {count > 0 && (
            <span className="bg-brand-cta num absolute -top-0.5 -end-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-xs leading-none font-bold text-white" aria-hidden>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{t.notifications.title}</span>
          {count > 0 && <span className="text-muted-foreground text-xs font-normal">{fmt(t.notifications.unreadCount, { n: count })}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {failed && <p className="text-muted-foreground px-2.5 py-3 text-sm">{t.errors.UNKNOWN}</p>}
        {!failed && items === null && <p className="text-muted-foreground px-2.5 py-3 text-sm">{t.common.loading}</p>}
        {!failed && items?.length === 0 && <p className="text-muted-foreground px-2.5 py-3 text-sm">{t.notifications.empty}</p>}
        {items?.map((n) => {
          const p = present(n);
          return (
            <DropdownMenuItem key={n.id} asChild>
              <Link href={p.href ?? '/notifications'} onClick={() => open(n)} className="flex min-h-11 flex-col items-start gap-0.5">
                <span className="flex w-full items-center gap-2">
                  {!n.readAt && (
                    <>
                      <span className="bg-primary size-2 shrink-0 rounded-full" aria-hidden />
                      <span className="sr-only">{t.employeeSelfService.notifications.unread}: </span>
                    </>
                  )}
                  <span className="truncate font-medium">{p.title}</span>
                </span>
                <span className="text-muted-foreground line-clamp-2 text-xs">{p.body}</span>
                <span className="text-muted-foreground text-xs">{formatDateTime(n.createdAt, locale)}</span>
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/notifications" className="min-h-10 justify-center font-medium">
            {t.notifications.viewAll}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { EyeOff } from 'lucide-react';
import { PERMISSIONS } from '@workforce/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { homeFor } from '@/lib/nav';
import { portalLabel, portalPageForPath, usePortal, type PortalPageKey } from '@/lib/portal';

/**
 * Shows a friendly "turned off" card instead of a "My work" page that HR hid in Settings -> Employee
 * portal (opened from an old link or bookmark). No redirect and no 404; every other route renders as is.
 */
export function PortalRouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isVisible } = usePortal();
  const page = portalPageForPath(pathname ?? '/');
  if (page === null || isVisible(page)) return <>{children}</>;
  return <PageTurnedOff page={page} />;
}

function PageTurnedOff({ page }: { page: PortalPageKey }) {
  const { user, can } = useAuth();
  const { t } = useI18n();
  const s = t.portalVisibility;
  const [before, ...rest] = s.offBody.split('{page}');
  // My day shows the balances while My leave is hidden (they can never be hidden).
  const balancesNote = page === 'leave' && user.employee !== null && can(PERMISSIONS.LEAVE_SELF);

  useEffect(() => {
    document.title = `${s.offTitle} · ${t.common.appName}`;
  }, [s.offTitle, t.common.appName]);

  return (
    <div className="flex min-h-[60dvh] items-center justify-center py-8">
      <Card className="w-full max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-tint/[0.08] bg-tint/[0.04]">
            <EyeOff className="text-muted-foreground size-5" aria-hidden />
          </div>
          <div className="space-y-2">
            <h1 className="font-display text-xl font-bold">{s.offTitle}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {before}
              {rest.length > 0 && <bdi className="text-foreground font-medium">{portalLabel(t, page)}</bdi>}
              {rest.join('{page}')}
            </p>
            {balancesNote && <p className="text-muted-foreground text-sm leading-relaxed">{fmt(s.offLeaveBalances, { home: t.nav.home })}</p>}
          </div>
          <Button asChild>
            <Link href={homeFor(user)}>{s.goHome}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { BrandMark } from '@/components/brand';
import { Mascot } from '@/components/mascot/mascot';
import { PasswordChangeGuard } from '@/components/password-change-guard';
import { PortalRouteGuard } from '@/components/portal-route-guard';
import { ErrorState } from '@/components/states';
import { AuthProvider } from '@/lib/auth';

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">{children}</div>;
}

export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider
      fallback={
        <FullScreen>
          <BrandMark className="size-12 animate-pulse" />
        </FullScreen>
      }
      errorFallback={(error, retry) => (
        <FullScreen>
          <BrandMark className="size-12" />
          <ErrorState error={error} onRetry={retry} />
        </FullScreen>
      )}
    >
      <PasswordChangeGuard>
        <AppShell>
          <PortalRouteGuard>{children}</PortalRouteGuard>
        </AppShell>
        <Mascot />
      </PasswordChangeGuard>
    </AuthProvider>
  );
}

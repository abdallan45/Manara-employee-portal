'use client';

import { useEffect, type ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
// Side effect: adds the first popstate listener before Next.js adds its own (see the module).
import '@/lib/history-guard';
// Side effect: catches the browser's one-time install offer before the menu is on screen.
import '@/lib/install-prompt';
import { I18nProvider, useI18n } from '@/lib/i18n/context';
import { ThemeProvider, useTheme } from '@/lib/theme';

function DirectionalToaster() {
  const { dir } = useI18n();
  const { theme } = useTheme();
  return <Toaster theme={theme} position={dir === 'rtl' ? 'top-left' : 'top-right'} dir={dir} richColors closeButton />;
}

/** Registers the app-shell service worker in production builds only. */
function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <TooltipProvider>
          {children}
          <DirectionalToaster />
          <ServiceWorkerRegistration />
        </TooltipProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Employee Portal', template: '%s · Employee Portal' },
  description: 'Manara employee portal: attendance, leave, overtime and requests',
  applicationName: 'Employee Portal',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'Employee Portal', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  // Dark by default; lib/theme updates the theme colour when the user picks the light theme.
  themeColor: '#0a0a0f',
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Arabic/RTL and the dark theme are the defaults; I18nProvider and ThemeProvider switch them on the
    // client. locale-init.js and theme-init.js apply a saved choice before first paint (external files so a
    // strict `script-src 'self'` CSP still allows them).
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/locale-init.js" />
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
        <link rel="preload" href="/fonts/montserrat-latin-wght-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

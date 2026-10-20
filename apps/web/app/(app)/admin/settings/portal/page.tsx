'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { LoadingRows } from '@/components/states';
import { settingsHref } from '@/lib/nav';

/** Old address of Settings -> Employee pages, which is a settings section now (portal-tab.tsx). */
export default function EmployeePagesSettingsRedirect() {
  const router = useRouter();
  useEffect(() => router.replace(settingsHref('portal')), [router]);
  return <LoadingRows rows={6} />;
}

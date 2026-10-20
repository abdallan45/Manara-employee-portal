'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { LoadingRows } from '@/components/states';
import { settingsHref, type SettingsTab } from '@/lib/nav';

const SECTIONS: readonly SettingsTab[] = ['schedules', 'assignments', 'holidays'];

/**
 * Old address of Hours & holidays (/admin/schedules?tab=schedules|assignments|holidays). Schedules, who works
 * which schedule and public holidays are settings sections now; the tab components stay in this folder.
 */
export default function SchedulesRedirect() {
  const router = useRouter();
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    router.replace(settingsHref(SECTIONS.find((s) => s === tab) ?? 'schedules'));
  }, [router]);
  return <LoadingRows rows={6} />;
}

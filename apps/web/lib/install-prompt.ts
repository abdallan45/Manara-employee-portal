'use client';

import { useSyncExternalStore } from 'react';

/** Chrome / Edge / Samsung Internet event that lets the page show the browser's own install dialog. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';

interface InstallState {
  /** Running as the installed app (home-screen icon): nothing to offer. */
  installed: boolean;
  /** The browser's install dialog can be shown directly (Android Chrome, desktop Chrome/Edge). */
  canPrompt: boolean;
  platform: InstallPlatform;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function detectPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; touch points tell them apart.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function runningInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// The event fires once, early (often before the menu is on screen), so it is captured at module load.
// This module is imported by components/providers.tsx.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    notify();
  });
}

let snapshot: InstallState | null = null;
function getSnapshot(): InstallState {
  const next: InstallState = { installed: installedNow || runningInstalled(), canPrompt: deferred !== null, platform: detectPlatform() };
  if (!snapshot || snapshot.installed !== next.installed || snapshot.canPrompt !== next.canPrompt || snapshot.platform !== next.platform) {
    snapshot = next;
  }
  return snapshot;
}

const SERVER_STATE: InstallState = { installed: true, canPrompt: false, platform: 'desktop' };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows the browser's install dialog; false when it is not available (then show the manual steps). */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  notify();
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === 'accepted') {
    installedNow = true;
    notify();
  }
  return true;
}

/** Whether to offer "Install the app", and how (direct prompt or manual steps for this platform). */
export function useInstallState(): InstallState {
  // Hidden during the static export render; decided on the client.
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_STATE);
}

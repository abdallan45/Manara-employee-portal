'use client';

import { useEffect, useState } from 'react';
import type { MascotConfigDto } from '@workforce/shared';

import { apiGet } from '@/lib/api';

/**
 * Nouria's content (GET /mascot/config), shared by every component in the tab. Fetched once per session
 * (kept in memory and in sessionStorage with its `version`), refreshed on window focus at most every
 * five minutes, and right away after an admin changes it (invalidateMascotConfig).
 */
const STORAGE_KEY = 'wf_mascot_config';
const REFRESH_MS = 5 * 60 * 1000;

interface Cached { config: MascotConfigDto; fetchedAt: number }

let cache: Cached | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(config: MascotConfigDto) => void>();

function readStored(): Cached | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cached>;
    const c = parsed.config;
    if (!c || typeof c.version !== 'string' || typeof c.enabled !== 'boolean' || !Array.isArray(c.groups)) return null;
    return { config: c, fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0 };
  } catch {
    return null;
  }
}

function store(next: Cached): void {
  const changed = !cache || cache.config.version !== next.config.version || cache.config.enabled !== next.config.enabled;
  cache = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the in-memory copy still works */
  }
  if (changed) for (const fn of listeners) fn(next.config);
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = apiGet<MascotConfigDto>('/mascot/config')
    .then((config) => store({ config, fetchedAt: Date.now() }))
    .catch(() => {
      // Keep whatever we had; try again on the next focus. Without any config she simply stays quiet.
      if (cache) cache = { ...cache, fetchedAt: Date.now() };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cached copy and fetch again (after an admin edit, so the live mascot follows at once). */
export function invalidateMascotConfig(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  if (cache) cache = { ...cache, fetchedAt: 0 };
  if (listeners.size > 0) void refresh();
}

/** The mascot config, or null until it has loaded. `active = false` skips fetching (e.g. no employee profile). */
export function useMascotConfig(active = true): MascotConfigDto | null {
  const [config, setConfig] = useState<MascotConfigDto | null>(() => cache?.config ?? null);

  useEffect(() => {
    if (!active) return;
    if (!cache) cache = readStored();
    if (cache) setConfig(cache.config);
    listeners.add(setConfig);
    if (!cache || Date.now() - cache.fetchedAt > REFRESH_MS) void refresh();

    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (!cache || Date.now() - cache.fetchedAt > REFRESH_MS) void refresh();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      listeners.delete(setConfig);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [active]);

  return active ? config : null;
}

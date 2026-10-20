'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * The last write that the router has not committed yet, shared by every hook on the page. router.replace
 * updates the URL only after React commits, so without this a second write in the same tick (e.g. a tab
 * change plus a filter reset, from two different hooks) would start from the stale query and drop the first.
 * It applies only while the live query still equals the one the write started from, and it is dropped as
 * soon as the URL moves off that query (committed or superseded) or the page's last writer unmounts. Without
 * that, coming back to the same query later through a Link would resume from the old result, and a close
 * write such as `setUrl({ new: '' })` could compute "no change" and never navigate.
 */
let pendingWrite: { pathname: string; base: string; qs: string } | null = null;

/** Mounted query writers; when the last one unmounts (the user left the page) no write can still be waiting. */
let mountedWriters = 0;

/**
 * The committed query. Next updates window.location in the same commit as useSearchParams, so this equals
 * the render-time value, but it is also right for a setter called from a stale closure (after an await).
 */
function liveQuery(fallback: string): string {
  return typeof window === 'undefined' ? fallback : new URLSearchParams(window.location.search).toString();
}

/**
 * Builds the next query string from the current one (or a write still in flight) and navigates with
 * router.replace, so tabs, filters, sort and page survive reloads, links and Back without adding history.
 */
function useQueryWriter(): (mutate: (params: URLSearchParams) => void) => void {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const current = searchParams.toString();

  useEffect(() => {
    mountedWriters += 1;
    return () => {
      mountedWriters -= 1;
      if (mountedWriters === 0) pendingWrite = null;
    };
  }, []);

  // The URL left the query the pending write started from: it was committed (or another navigation won).
  // A hook that mounts while the write is still in flight sees current === base and keeps it.
  useEffect(() => {
    if (pendingWrite && (pendingWrite.pathname !== pathname || pendingWrite.base !== current)) pendingWrite = null;
  }, [current, pathname]);

  return useCallback(
    (mutate) => {
      const live = liveQuery(current);
      const start = pendingWrite && pendingWrite.pathname === pathname && pendingWrite.base === live ? pendingWrite.qs : live;
      const params = new URLSearchParams(start);
      mutate(params);
      const qs = params.toString();
      if (qs === start) return;
      pendingWrite = { pathname, base: live, qs };
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [current, pathname, router],
  );
}

/**
 * Query-string backed state for filters, sort and paging.
 *
 * - Reads every key of `defaults` from the URL; a missing key falls back to its default.
 * - The setter merges a patch and writes it with `router.replace(`${pathname}?${qs}`, { scroll: false })`.
 *   Values equal to their default (or `undefined`) are omitted, so the URL only carries what differs.
 *   Query keys that are not in `defaults` (e.g. `id` on a detail page) are preserved.
 * - Keep `defaults` stable in value (it is compared by JSON, so an inline literal is fine).
 *
 * IMPORTANT: this reads `useSearchParams()`, so the static export requires the calling page to render
 * its content inside `<Suspense>`.
 *
 * @example
 * const [filters, setFilters] = useUrlState({ q: '', status: '', page: '1' });
 * setFilters({ status: 'ABSENT', page: '1' });
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const searchParams = useSearchParams();
  const write = useQueryWriter();
  const defaultsKey = JSON.stringify(defaults);

  const state = useMemo(() => {
    const base = JSON.parse(defaultsKey) as T;
    const out: Record<string, string> = { ...base };
    for (const key of Object.keys(base)) {
      const value = searchParams.get(key);
      if (value !== null) out[key] = value;
    }
    return out as T;
  }, [searchParams, defaultsKey]);

  const setState = useCallback(
    (patch: Partial<T>) => {
      const base = JSON.parse(defaultsKey) as T;
      write((params) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === null || value === base[key]) params.delete(key);
          else params.set(key, String(value));
        }
      });
    },
    [defaultsKey, write],
  );

  return [state, setState];
}

/**
 * The active tab, kept in the query string (default param `tab`).
 *
 * Unknown values fall back to `fallback`; selecting `fallback` removes the param so the plain URL stays
 * canonical. Other query keys are preserved. Pass the result straight to Radix:
 * `<Tabs value={tab} onValueChange={setTab}>`.
 *
 * IMPORTANT: this reads `useSearchParams()`, so the static export requires the calling page to render
 * its content inside `<Suspense>`.
 */
export function useUrlTab(allowed: readonly string[], fallback: string, param = 'tab'): [string, (v: string) => void] {
  const searchParams = useSearchParams();
  const write = useQueryWriter();
  const raw = searchParams.get(param);
  const allowedKey = allowed.join('\u0000');
  const value = raw !== null && allowed.includes(raw) ? raw : fallback;

  const setValue = useCallback(
    (next: string) => {
      const ok = allowedKey.split('\u0000').includes(next);
      write((params) => {
        if (!ok || next === fallback) params.delete(param);
        else params.set(param, next);
      });
    },
    [allowedKey, fallback, param, write],
  );

  return [value, setValue];
}

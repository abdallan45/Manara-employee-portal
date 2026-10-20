'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, apiGet, type Query } from '@/lib/api';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** True while re-fetching with data already on screen after refetch() or a path/query change. Background polls never set it. */
  refreshing: boolean;
  refetch: () => Promise<void>;
  setData: (value: T) => void;
  /** When the data on screen was last fetched successfully. */
  lastUpdatedAt?: Date;
  /** A refresh failed while older data is still shown (render DataTable `stale` / a "Couldn't refresh" banner). */
  stale: boolean;
}

export interface UseApiOptions {
  /** Silent background poll interval (only while the tab is visible). */
  refreshMs?: number;
  /** Refetch silently when the tab becomes visible, the window regains focus or the device comes back online (at most once a second). */
  refetchOnFocus?: boolean;
}

type LoadMode = 'foreground' | 'background';

const FOCUS_DEBOUNCE_MS = 1000;

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('UNKNOWN', 0, err instanceof Error ? err.message : String(err));
}

/**
 * Minimal typed GET hook: loading / error / refetch, aborts stale requests.
 * Pass `path = null` to skip fetching (e.g. while a prerequisite is missing).
 *
 * Background work (refreshMs polls, refetchOnFocus) is silent: it never sets `loading` or `refreshing`,
 * so live tables do not dim; a failure keeps the old data and sets `stale` (and `error`).
 */
export function useApi<T>(path: string | null, query?: Query, options: UseApiOptions = {}): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const hasDataRef = useRef(false);
  const queryKey = JSON.stringify(query ?? {});

  const load = useCallback(
    async (mode: LoadMode = 'foreground') => {
      if (path === null) {
        setLoading(false);
        return;
      }
      // A background refresh never interrupts a request that is already running.
      if (mode === 'background' && inFlightRef.current) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      inFlightRef.current = true;
      if (!hasDataRef.current) setLoading(true);
      else if (mode === 'foreground') setRefreshing(true);
      try {
        const result = await apiGet<T>(path, JSON.parse(queryKey) as Query, controller.signal);
        if (controller.signal.aborted) return;
        hasDataRef.current = true;
        setData(result);
        setError(undefined);
        setStale(false);
        setLastUpdatedAt(new Date());
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(toApiError(err));
        setStale(hasDataRef.current);
      } finally {
        if (!controller.signal.aborted) {
          inFlightRef.current = false;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [path, queryKey],
  );

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load('foreground');
    return () => {
      controllerRef.current?.abort();
      inFlightRef.current = false;
    };
  }, [load]);

  const { refreshMs, refetchOnFocus } = options;

  useEffect(() => {
    if (!refreshMs || path === null) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRef.current('background');
    }, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, path]);

  useEffect(() => {
    if (!refetchOnFocus || path === null) return;
    let last = 0;
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      // visibilitychange + focus usually fire together; collapse them into one request.
      if (now - last < FOCUS_DEBOUNCE_MS) return;
      last = now;
      void loadRef.current('background');
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [refetchOnFocus, path]);

  const set = useCallback((value: T) => {
    hasDataRef.current = true;
    setData(value);
  }, []);

  const refetch = useCallback(() => load('foreground'), [load]);

  return { data, error, loading, refreshing, refetch, setData: set, lastUpdatedAt, stale };
}

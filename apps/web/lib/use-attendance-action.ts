'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttendanceStatusDto, DeviceLocation } from '@workforce/shared';

import { ApiError, apiPost } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/idempotency';
import { emitMascot } from '@/lib/mascot/events';

export type AttendanceActionPath = 'check-in' | 'check-out' | 'break/start' | 'break/end';

export type ActionOutcome =
  | { ok: true; status: AttendanceStatusDto }
  | { ok: false; error: ApiError; /** true when no response arrived and the same key will be reused on retry */ retryable: boolean };

/** How long the new primary button ignores taps after a successful action (slip guard against double taps). */
export const ACTION_GUARD_MS = 2000;

/**
 * Sends attendance actions with idempotency keys. A key is kept while the request fails without a
 * server response (so a retry cannot double-record), and discarded after any server response.
 * Check-in and check-out pass the device location; breaks carry none.
 *
 * `guarded` stays true for {@link ACTION_GUARD_MS} after a success: the button that took the place of the
 * one just tapped (Check in -> Check out) should ignore taps meanwhile (render it with aria-disabled).
 */
export function useAttendanceAction() {
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState<AttendanceActionPath | null>(null);
  const [guarded, setGuarded] = useState(false);
  const guardTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(guardTimer.current), []);

  const run = useCallback(async (action: AttendanceActionPath, breakTypeId?: string, location?: DeviceLocation): Promise<ActionOutcome> => {
    const slot = breakTypeId ? `${action}:${breakTypeId}` : action;
    let key = keys.current.get(slot);
    if (!key) {
      key = newIdempotencyKey();
      keys.current.set(slot, key);
    }
    setPending(action);
    try {
      const body = { idempotencyKey: key, ...(breakTypeId ? { breakTypeId } : {}), ...(location ? { location } : {}) };
      const status = await apiPost<AttendanceStatusDto>(`/attendance/me/${action}`, body);
      keys.current.delete(slot);
      window.clearTimeout(guardTimer.current);
      setGuarded(true);
      guardTimer.current = window.setTimeout(() => setGuarded(false), ACTION_GUARD_MS);
      emitMascot({ kind: 'action', action, status });
      return { ok: true, status };
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError('UNKNOWN', 0, String(err));
      const retryable = error.isNetworkError;
      if (!retryable) keys.current.delete(slot);
      emitMascot({ kind: 'error', action, code: error.code });
      return { ok: false, error, retryable };
    } finally {
      setPending(null);
    }
  }, []);

  return { run, pending, guarded };
}

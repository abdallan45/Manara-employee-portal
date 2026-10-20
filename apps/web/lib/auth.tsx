'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { SessionUser } from '@workforce/shared';

import { ApiError, PASSWORD_CHANGE_REQUIRED_EVENT, UNAUTHENTICATED_EVENT, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import type { Locale } from '@/lib/i18n/dictionaries';

interface AuthValue {
  user: SessionUser;
  can: (...anyOf: string[]) => boolean;
  logout: () => Promise<void>;
  /** POST /auth/logout-all: ends every session of this user (this one too), then goes to /login. Throws on failure. */
  logoutAll: () => Promise<void>;
  changeLocale: (locale: Locale) => void;
  /** Reloads the session user (roles, employee-portal visibility). A failure other than 401 keeps the current user. */
  refreshUser: () => Promise<void>;
  /** After POST /auth/me/password succeeded: clears mustChangePassword at once, then re-reads /auth/me. */
  markPasswordChanged: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

type AuthState = { status: 'loading' } | { status: 'ready'; user: SessionUser } | { status: 'error'; error: unknown };

/** Background refresh when the tab regains focus, at most this often. */
const FOCUS_REFRESH_MS = 60_000;

const sameUser = (a: SessionUser, b: SessionUser) => JSON.stringify(a) === JSON.stringify(b);

export function loginRedirect(pathname: string): string {
  return pathname && pathname !== '/' ? `/login?next=${encodeURIComponent(pathname)}` : '/login';
}

/** Loads the session for every authenticated page; redirects to /login on 401. */
export function AuthProvider({ children, fallback, errorFallback }: {
  children: ReactNode;
  fallback: ReactNode;
  errorFallback: (error: unknown, retry: () => void) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { setLocale, t } = useI18n();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  /** When /auth/me was last requested (focus refreshes are throttled on it). */
  const requestedAt = useRef(0);
  /** Id of the latest refresh; an older response that arrives late is dropped. */
  const refreshSeq = useRef(0);

  const load = useCallback(async () => {
    requestedAt.current = Date.now();
    try {
      const user = await api<SessionUser>('/auth/me', { silentAuth: true });
      setState({ status: 'ready', user });
      setLocale(user.locale);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace(loginRedirect(pathname));
        return;
      }
      setState({ status: 'error', error: err });
    }
    // pathname only matters for the initial redirect target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, setLocale]);

  /**
   * Re-reads /auth/me while the app is open (HR may have changed the employee portal or roles).
   * Keeps the current user on failures other than 401, and keeps the language chosen in this tab.
   * A 401 goes through the shared session-expired handler (toast, then sign-in).
   */
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++refreshSeq.current;
    requestedAt.current = Date.now();
    try {
      const fresh = await api<SessionUser>('/auth/me');
      if (id !== refreshSeq.current) return;
      setState((prev) => {
        if (prev.status !== 'ready') return prev;
        const next: SessionUser = { ...fresh, locale: prev.user.locale };
        return sameUser(prev.user, next) ? prev : { status: 'ready', user: next };
      });
    } catch {
      // 401: api() already broadcast UNAUTHENTICATED_EVENT. Anything else: keep the current user.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Any call answering 403 PASSWORD_CHANGE_REQUIRED: mark the session user so the route guard
  // (components/password-change-guard) keeps them on the change-password page.
  useEffect(() => {
    const onRequired = () =>
      setState((prev) => (prev.status === 'ready' && !prev.user.mustChangePassword ? { status: 'ready', user: { ...prev.user, mustChangePassword: true } } : prev));
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
  }, []);

  useEffect(() => {
    const onExpired = () => {
      toast.error(t.auth.sessionExpired, { id: 'session-expired' });
      router.replace(loginRedirect(window.location.pathname));
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onExpired);
  }, [router, t]);

  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - requestedAt.current < FOCUS_REFRESH_MS) return;
      void refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [ready, refresh]);

  const value = useMemo<AuthValue | null>(() => {
    if (state.status !== 'ready') return null;
    const { user } = state;
    return {
      user,
      can: (...anyOf: string[]) => anyOf.some((p) => user.permissions.includes(p)),
      logout: async () => {
        try {
          await api<unknown>('/auth/logout', { method: 'POST', body: {}, silentAuth: true });
        } catch {
          // the session is gone either way
        }
        router.replace('/login');
      },
      logoutAll: async () => {
        try {
          await api<unknown>('/auth/logout-all', { method: 'POST', silentAuth: true });
        } catch (err) {
          // 401: the session had already ended - nothing left to sign out here.
          if (!(err instanceof ApiError && err.status === 401)) throw err;
        }
        router.replace('/login');
      },
      changeLocale: (locale: Locale) => {
        setLocale(locale);
        setState({ status: 'ready', user: { ...user, locale } });
        void api<unknown>('/auth/me/locale', { method: 'PATCH', body: { locale } }).catch(() => undefined);
      },
      refreshUser: refresh,
      markPasswordChanged: () => {
        setState((prev) => (prev.status === 'ready' ? { status: 'ready', user: { ...prev.user, mustChangePassword: false } } : prev));
        void refresh();
      },
    };
  }, [state, router, setLocale, refresh]);

  if (state.status === 'error') return <>{errorFallback(state.error, () => { setState({ status: 'loading' }); void load(); })}</>;
  if (!value) return <>{fallback}</>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

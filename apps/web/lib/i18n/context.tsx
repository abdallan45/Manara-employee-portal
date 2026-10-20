'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PORTAL_DISABLED_REASON } from '@workforce/shared';

import { ApiError, type AnyErrorCode } from '@/lib/api';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, dictionaries, dirFor, type Dictionary, type Locale } from './dictionaries';

interface I18nValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Dictionary;
  setLocale: (locale: Locale) => void;
  /** Translated, user-facing message for any thrown value. */
  errorMessage: (err: unknown) => string;
  /** Duration units for formatMinutes. */
  units: { h: string; m: string };
}

const I18nContext = createContext<I18nValue | null>(null);

const isPortalDisabled = (details: unknown): boolean =>
  typeof details === 'object' && details !== null && (details as { reason?: unknown }).reason === PORTAL_DISABLED_REASON;

function readStoredLocale(): Locale | null {
  try {
    const v = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return v === 'en' || v === 'ar' ? v : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = readStoredLocale();
    if (stored) setLocaleState(stored);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.lang = locale;
    el.dir = dirFor(locale);
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // storage unavailable - the choice still applies for this page view
    }
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t = dictionaries[locale];
    const errorMessage = (err: unknown): string => {
      if (err instanceof ApiError) {
        // A page or section HR turned off in the employee portal: say so instead of "no permission".
        if (err.code === 'FORBIDDEN' && isPortalDisabled(err.details)) return t.portalVisibility.offError;
        const code: AnyErrorCode = err.code;
        return t.errors[code] ?? t.errors.UNKNOWN;
      }
      return t.errors.UNKNOWN;
    };
    return { locale, dir: dirFor(locale), t, setLocale, errorMessage, units: { h: t.common.h, m: t.common.m } };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** Dark is the default; light is opt-in and remembered on this device. */
export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'wf_theme';
/** Browser UI colour (address bar, PWA title bar) per theme: the page background. */
const THEME_COLOR: Record<Theme, string> = { dark: '#0a0a0f', light: '#f5f5f9' };

interface ThemeValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readStoredTheme(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

/** Applies the theme to <html>: data-theme (globals.css), the `dark` class, and the browser UI colour. */
function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === 'light') el.dataset.theme = 'light';
  else delete el.dataset.theme;
  el.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/**
 * Light / dark theme. public/theme-init.js applies a saved choice before first paint, so this provider
 * only takes it over (React state starts at the default, like the locale) and applies later switches.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const stored = readStoredTheme();
    if (stored) setThemeState(stored);
  }, []);

  useEffect(() => applyTheme(theme), [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage unavailable: the choice still applies for this page view
    }
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({ theme, setTheme, toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark') }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

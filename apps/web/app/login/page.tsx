'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Loader2, LogIn, Sparkles } from 'lucide-react';
import type { DemoAccountDto as DemoAccount, LoginResponse, SessionUser } from '@workforce/shared';

import { BrandMark, BrandWordmark } from '@/components/brand';
import { HelpTip } from '@/components/help-tip';
import { LanguageToggle } from '@/components/language-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { FieldError, FormErrorSummary, focusFirstError } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, api } from '@/lib/api';
import { formatTime } from '@/lib/format';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { CHANGE_PASSWORD_PATH, homeFor } from '@/lib/nav';
import { safeNext } from '@/lib/safe-redirect';

/** Ignore anything that does not match the contract (e.g. an older API answering this route). */
function isDemoAccount(a: unknown): a is DemoAccount {
  if (typeof a !== 'object' || a === null) return false;
  const r = a as Record<string, unknown>;
  return typeof r.username === 'string' && typeof r.displayName === 'string' && Array.isArray(r.roles);
}

function LoginForm() {
  const { t, locale, setLocale, errorMessage } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [demo, setDemo] = useState<DemoAccount[]>([]);
  const usernameRef = useRef<HTMLInputElement>(null);
  const s = t.employeeSelfService.login;

  useEffect(() => {
    document.title = `${t.auth.signIn} · ${t.common.appName}`;
  }, [t]);

  // Focus the username on larger screens only: on phones the keyboard would cover the page at once.
  useEffect(() => {
    try {
      if (window.matchMedia('(min-width: 768px)').matches) usernameRef.current?.focus({ preventScroll: true });
    } catch {
      // matchMedia unavailable: leave focus where it is
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Already signed in? Skip the form.
    api<SessionUser>('/auth/me', { silentAuth: true, signal: controller.signal })
      .then((user) => router.replace(user.mustChangePassword ? CHANGE_PASSWORD_PATH : (next ?? homeFor(user))))
      .catch(() => undefined);
    // Demo quick-login is only offered when the API answers 200 with a list.
    api<DemoAccount[]>('/auth/demo/accounts', { silentAuth: true, signal: controller.signal })
      .then((list) => setDemo(Array.isArray(list) ? list.filter(isDemoAccount) : []))
      .catch(() => setDemo([]));
    return () => controller.abort();
  }, [router, next]);

  const finish = (res: LoginResponse) => {
    setLocale(res.user.locale);
    // A password set by an administrator must be replaced first (the app keeps the user on that page).
    router.replace(res.user.mustChangePassword ? CHANGE_PASSWORD_PATH : (next ?? homeFor(res.user)));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Sign in stays enabled; empty fields get a specific message next to them and in the error summary
    // (announced), and focus moves to the first one.
    const missing = { username: username.trim() ? undefined : s.enterUsername, password: password ? undefined : s.enterPassword };
    setFieldErrors(missing);
    if (missing.username || missing.password) {
      setError(null);
      focusFirstError([missing.username && 'username', missing.password && 'password'].filter((x): x is string => !!x));
      return;
    }
    setBusy('form');
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password, client: 'WEB' },
        silentAuth: true,
      });
      finish(res);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('UNKNOWN', 0, String(err)));
      setBusy(null);
    }
  };

  const demoLogin = async (account: DemoAccount) => {
    setBusy(account.username);
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/demo/login', { method: 'POST', body: { username: account.username }, silentAuth: true });
      finish(res);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('UNKNOWN', 0, String(err)));
      setBusy(null);
    }
  };

  const lockedUntil = (error?.details as { lockedUntil?: unknown } | null | undefined)?.lockedUntil;
  const hint =
    error?.code === 'ACCOUNT_LOCKED'
      ? typeof lockedUntil === 'string'
        ? fmt(t.auth.lockedUntil, { time: formatTime(lockedUntil, locale) })
        : t.auth.lockedHint
      : error?.code === 'RATE_LIMITED'
        ? t.auth.rateLimitedHint
        : null;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <BrandMark className="size-9" />
          <BrandWordmark subtitle={t.common.appShort} />
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-10">
        <div className="w-full max-w-md">
          <div className="bg-card/80 relative overflow-hidden rounded-3xl border border-tint/[0.07] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
            <div className="bg-brand-gradient absolute inset-x-0 top-0 h-[3px]" aria-hidden />
            <div className="mb-6 flex items-center gap-1">
              <h1 className="font-display text-2xl font-bold" aria-describedby="login-subtitle">
                {t.auth.title}
              </h1>
              <HelpTip text={t.auth.subtitle} />
              <p id="login-subtitle" className="sr-only">
                {t.auth.subtitle}
              </p>
            </div>

            {error && (
              <div role="alert" className="mb-5 flex gap-3 rounded-2xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3.5 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                <div className="space-y-1">
                  <p className="font-medium">{errorMessage(error)}</p>
                  {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
                </div>
              </div>
            )}

            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <FormErrorSummary
                errors={[
                  fieldErrors.username && { id: 'username', message: fieldErrors.username },
                  fieldErrors.password && { id: 'password', message: fieldErrors.password },
                ].filter((x): x is { id: string; message: string } => !!x)}
              />
              <div className="space-y-2">
                <Label htmlFor="username">{t.auth.username}</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  dir="ltr"
                  required
                  ref={usernameRef}
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (fieldErrors.username) setFieldErrors((f) => ({ ...f, username: undefined }));
                  }}
                  className="h-12"
                  aria-invalid={error?.code === 'INVALID_CREDENTIALS' || !!fieldErrors.username || undefined}
                  aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                />
                <FieldError id="username-error" message={fieldErrors.username} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t.auth.password}</Label>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    dir="ltr"
                    required
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }));
                    }}
                    className="h-12 pe-12"
                    aria-invalid={error?.code === 'INVALID_CREDENTIALS' || !!fieldErrors.password || undefined}
                    aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute end-2 top-1/2 -translate-y-1/2"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </Button>
                </div>
                <FieldError id="password-error" message={fieldErrors.password} />
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={busy !== null}>
                {busy === 'form' ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn className="rtl:-scale-x-100" aria-hidden />}
                {busy === 'form' ? t.auth.signingIn : t.auth.signIn}
              </Button>
              <p className="text-muted-foreground text-center text-sm">{s.forgot}</p>
            </form>

            {demo.length > 0 && (
              <section className="mt-7 space-y-3 border-t border-tint/[0.06] pt-6" aria-labelledby="demo-title">
                <div className="flex items-center gap-2">
                  <Sparkles className="text-primary size-4" aria-hidden />
                  <h2 id="demo-title" className="text-sm font-semibold" aria-describedby="demo-hint">
                    {t.auth.demoTitle}
                  </h2>
                  <HelpTip text={t.auth.demoHint} />
                  <p id="demo-hint" className="sr-only">
                    {t.auth.demoHint}
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {demo.map((a) => (
                    <Button
                      key={a.username}
                      type="button"
                      variant="outline"
                      className="h-auto justify-start rounded-2xl px-3.5 py-2.5 text-start whitespace-normal"
                      disabled={busy !== null}
                      onClick={() => void demoLogin(a)}
                    >
                      {busy === a.username && <Loader2 className="animate-spin" aria-hidden />}
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">{(locale === 'ar' && a.displayNameAr) || a.displayName}</span>
                        <span className="text-muted-foreground truncate text-xs font-normal" dir="ltr">
                          {a.username} · {a.roles.join(', ')}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}
          </div>
          <p className="text-brand-subtle mt-6 text-center text-xs">{t.auth.footer}</p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

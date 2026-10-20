'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, LogOut, ShieldAlert } from 'lucide-react';

import { BrandMark, BrandWordmark } from '@/components/brand';
import { ChangePasswordForm } from '@/components/change-password-form';
import { LanguageToggle } from '@/components/language-toggle';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n/context';
import { CHANGE_PASSWORD_PATH, homeFor } from '@/lib/nav';

const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/';

/**
 * Route guard for a session that must set its own password (user.mustChangePassword from /auth/me, or any
 * call that answered 403 PASSWORD_CHANGE_REQUIRED). Every route is sent to /me/password, which renders
 * here without the app shell (its menus and counters would only get 403s) until the change succeeds;
 * then the session user is refreshed and the user goes home.
 */
export function PasswordChangeGuard({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = trimSlash(usePathname() ?? '/');
  const router = useRouter();
  const forced = user.mustChangePassword === true;
  const onPage = pathname === CHANGE_PASSWORD_PATH;

  useEffect(() => {
    if (forced && !onPage) router.replace(CHANGE_PASSWORD_PATH);
  }, [forced, onPage, router]);

  if (!forced) return <>{children}</>;
  if (!onPage) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <BrandMark className="size-12 animate-pulse" />
      </div>
    );
  }
  return <ForcedPasswordChange />;
}

function ForcedPasswordChange() {
  const { user, logout, changeLocale, markPasswordChanged } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const s = t.accountSecurity;
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    document.title = `${s.forcedTitle} · ${t.common.appName}`;
  }, [s.forcedTitle, t.common.appName]);

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-3 p-4 sm:p-6">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="size-9" />
          <BrandWordmark subtitle={t.common.appShort} className="hidden min-[360px]:flex" />
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LanguageToggle onChange={changeLocale} />
        </div>
      </header>

      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-10 sm:items-center">
        <div className="w-full max-w-md">
          <div className="bg-card/80 relative overflow-hidden rounded-3xl border border-tint/[0.07] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
            <div className="bg-brand-gradient absolute inset-x-0 top-0 h-[3px]" aria-hidden />
            <h1 className="font-display mb-3 text-2xl font-bold">{s.forcedTitle}</h1>
            <div className="mb-6 flex gap-3 rounded-2xl border border-[color:var(--status-late)]/30 bg-[color:var(--status-late)]/10 p-3.5 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--status-late)]" aria-hidden />
              <p>{s.forcedBody}</p>
            </div>
            <ChangePasswordForm
              onChanged={() => {
                markPasswordChanged();
                router.replace(homeFor(user));
              }}
            />
            <div className="mt-6 border-t border-tint/[0.06] pt-4 text-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={leaving}
                onClick={() => {
                  setLeaving(true);
                  void logout();
                }}
              >
                {leaving ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut className="rtl:-scale-x-100" aria-hidden />}
                {s.forcedSignOut}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

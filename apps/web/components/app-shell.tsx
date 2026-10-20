'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, KeyRound, Languages, LogOut, Menu, MonitorSmartphone, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { toast } from 'sonner';

import { BrandMark, BrandWordmark } from '@/components/brand';
import { CommandPalette } from '@/components/command-palette';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InstallAppButton } from '@/components/install-app-button';
import { LanguageToggle } from '@/components/language-toggle';
import { NotificationsBell } from '@/components/notifications-bell';
import { ThemeToggle, useThemeSwitch } from '@/components/theme-toggle';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth';
import { setPopStateGuard } from '@/lib/history-guard';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import {
  CHANGE_PASSWORD_PATH,
  defaultCollapsedGroups,
  homeFor,
  isActivePath,
  mobileNavFor,
  navGroupLabel,
  navGroupsFor,
  visibleNav,
  type NavGroup,
  type NavItem,
} from '@/lib/nav';
import { localized } from '@/lib/format';
import { useNavCounts, type NavCounts } from '@/lib/use-nav-counts';
import { cn } from '@/lib/utils';

// ───────────────────────────── Leave guard ─────────────────────────────

/** An open dialog with typed input (`<DialogContent dirty>`, components/ui/dialog). */
const DIRTY_DIALOG = '[data-slot="dialog-content"][data-state="open"][data-dirty]';

/**
 * True while the page holds unsaved edits: a mounted useDirtyGuard(true) (lib/use-dirty-guard), which would
 * make the browser ask before unloading, or an open dirty dialog. It asks the beforeunload listeners with a
 * synthetic event, which never shows the browser's own prompt.
 */
export function hasUnsavedChanges(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.querySelector(DIRTY_DIALOG)) return true;
  const probe = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(probe);
  return probe.defaultPrevented;
}

/**
 * Runs `proceed` (an in-app navigation) right away or, while the page has unsaved edits, after the user
 * confirms "Discard changes?". "Keep editing" returns focus to `returnFocus` (default: the focused element).
 */
export type LeaveGuard = (proceed: () => void, returnFocus?: HTMLElement | null) => void;

const LeaveGuardContext = createContext<LeaveGuard>((proceed) => proceed());

/** The app shell's leave guard, for navigation that is not a link click (link clicks are guarded already). */
export function useLeaveGuard(): LeaveGuard {
  return useContext(LeaveGuardContext);
}

const trimSlash = (path: string) => path.replace(/\/+$/, '') || '/';

/** The page part of the current URL (no #hash): a move between two entries with the same page unmounts nothing. */
const currentPage = () => `${trimSlash(window.location.pathname)}${window.location.search}`;

/** history.state key with the entry's position in this tab's history, which tells how far Back / Forward moved. */
const HISTORY_INDEX = '__wfIdx';

function historyIndexOf(state: unknown): number | undefined {
  const value = state !== null && typeof state === 'object' ? (state as Record<string, unknown>)[HISTORY_INDEX] : undefined;
  return typeof value === 'number' ? value : undefined;
}

const withHistoryIndex = (data: unknown, index: number) => ({ ...(data !== null && typeof data === 'object' ? data : {}), [HISTORY_INDEX]: index });

/** An unmodified primary click on a same-origin link to another page or query: where it goes, else null. */
function inAppTarget(e: MouseEvent): { href: string; anchor: HTMLAnchorElement } | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  // The same page (or an in-page #anchor such as the skip link) unmounts nothing.
  if (trimSlash(url.pathname) === trimSlash(window.location.pathname) && url.search === window.location.search) return null;
  return { href: `${url.pathname}${url.search}${url.hash}`, anchor };
}

const SIDEBAR_KEY = 'wf_sidebar_collapsed';
const GROUPS_KEY = 'wf_nav_groups';

type GroupState = Partial<Record<NavGroup, boolean>>;

function readStorage<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice still applies for this page view
  }
}

function displayName(user: ReturnType<typeof useAuth>['user'], locale: 'en' | 'ar'): string {
  if (!user.employee) return user.username;
  return (locale === 'ar' && user.employee.fullNameAr) || user.employee.fullName;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '')).toUpperCase();
}

/** The nav item for the current page (longest matching href), e.g. /admin/employees for /admin/employees/view. */
function activeItem(items: NavItem[], pathname: string): NavItem | undefined {
  return items.filter((i) => isActivePath(pathname, i.href)).sort((a, b) => b.href.length - a.href.length)[0];
}

const countOf = (item: NavItem, counts: NavCounts) =>
  item.badge === 'approvals' ? counts.approvals : item.badge === 'notifications' ? counts.notifications : 0;

const capped = (n: number) => (n > 99 ? '99+' : String(n));

/** Screen-reader text for an item's count: "{n} waiting" for approvals, "{n} unread" for notifications. */
function useCountText() {
  const { t } = useI18n();
  return (item: NavItem, n: number) =>
    item.badge === 'notifications' ? fmt(t.notifications.unreadCount, { n }) : fmt(t.navFindability.waiting, { n });
}

function NavLinks({ rail, onNavigate, counts, collapsedGroups, onToggleGroup, idPrefix }: {
  /** The 72px icon rail: dividers instead of headings, dots instead of counts. */
  rail: boolean;
  onNavigate?: () => void;
  counts: NavCounts;
  collapsedGroups: GroupState;
  onToggleGroup: (group: NavGroup) => void;
  idPrefix: string;
}) {
  const { t, dir, locale } = useI18n();
  const { user } = useAuth();
  const pathname = usePathname() ?? '/';
  const countText = useCountText();
  const items = visibleNav(user).filter((i) => i.inSidebar !== false);
  const current = activeItem(items, pathname);
  const groups = navGroupsFor(user)
    .map((group) => ({ group, list: items.filter((i) => i.group === group) }))
    .filter((g) => g.list.length > 0);

  const renderItem = (item: NavItem) => {
    const active = item === current;
    const Icon = item.icon;
    const label = item.label(t);
    const count = countOf(item, counts);
    const link = (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative flex min-h-10 items-center gap-3 rounded-xl px-3 text-sm transition-colors focus-visible:outline-offset-[-2px]',
          active ? 'bg-sidebar-accent font-semibold text-tint' : 'text-sidebar-foreground font-medium hover:bg-tint/[0.04] hover:text-tint',
          rail && 'justify-center px-0',
        )}
      >
        {active && <span className="bg-brand-gradient absolute inset-y-2 start-0 w-[3px] rounded-full" aria-hidden />}
        <span className="relative shrink-0">
          <Icon className={cn('size-[18px]', active ? 'text-tint' : 'text-muted-foreground group-hover:text-tint')} aria-hidden />
          {rail && count > 0 && <span className="bg-brand-pink ring-sidebar absolute -end-1 -top-1 size-2 rounded-full ring-2" aria-hidden />}
        </span>
        {rail ? (
          <span className="sr-only">
            {label}
            {count > 0 && `, ${countText(item, count)}`}
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count > 0 && (
              <span className="bg-brand-cta num flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-bold text-white">
                <span aria-hidden>{capped(count)}</span>
                <span className="sr-only">{countText(item, count)}</span>
              </span>
            )}
          </>
        )}
      </Link>
    );
    return (
      <li key={item.href}>
        {rail ? (
          <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent side={dir === 'rtl' ? 'left' : 'right'}>{label}</TooltipContent>
          </Tooltip>
        ) : (
          link
        )}
      </li>
    );
  };

  if (rail) {
    return (
      <nav aria-label={t.nav.menu}>
        {groups.map(({ group, list }, i) => (
          <div key={group}>
            {i > 0 && <div className="bg-sidebar-border mx-2 my-2 h-px" aria-hidden />}
            <ul className="flex flex-col gap-0.5" aria-label={navGroupLabel(t, group)}>
              {list.map(renderItem)}
            </ul>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label={t.nav.menu} className="flex flex-col gap-2">
      {groups.map(({ group, list }) => {
        const isCollapsed = collapsedGroups[group] === true;
        const listId = `${idPrefix}-nav-${group}`;
        const label = navGroupLabel(t, group);
        // A collapsed group still shows the page you are on, so the menu never hides your location.
        const shown = isCollapsed ? list.filter((i) => i === current) : list;
        return (
          <div key={group} className="flex flex-col gap-0.5">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              onClick={() => onToggleGroup(group)}
              className="text-muted-foreground hover:text-foreground flex h-7 w-full items-center justify-between gap-2 rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-offset-[-2px]"
            >
              <span className={cn(locale === 'en' && 'tracking-wider uppercase')}>{label}</span>
              <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90 rtl:rotate-90')} aria-hidden />
            </button>
            <ul id={listId} className="flex flex-col gap-0.5" aria-label={label}>
              {shown.map(renderItem)}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserMenu() {
  const { user, logout, logoutAll, changeLocale } = useAuth();
  const { t, locale, errorMessage } = useI18n();
  const router = useRouter();
  const leaveGuard = useLeaveGuard();
  const themeSwitch = useThemeSwitch();
  const name = displayName(user, locale);
  const s = t.accountSecurity;
  const [confirmAll, setConfirmAll] = useState(false);
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-full p-0.5" aria-label={`${t.nav.account}: ${name}`}>
          <span className="bg-brand-gradient flex size-9 items-center justify-center rounded-full text-xs font-bold text-white">{initials(name)}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate">
            <bdi>{name}</bdi>
          </span>
          <span className="text-muted-foreground truncate text-xs font-normal" dir="ltr">
            {user.username}
            {user.employee ? ` · ${user.employee.employeeCode}` : ''}
          </span>
          {user.employee?.departmentName && (
            <span className="text-muted-foreground truncate text-xs font-normal">
              {localized(locale, user.employee.departmentName, user.employee.departmentNameAr)}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => changeLocale(locale === 'ar' ? 'en' : 'ar')}>
          <Languages aria-hidden />
          <span lang={locale === 'ar' ? 'en' : 'ar'}>{t.common.switchLanguage}</span>
        </DropdownMenuItem>
        {/* Keeps the menu open, so the new theme shows behind it and a second click switches back. */}
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); themeSwitch.toggle(); }}>
          <themeSwitch.Icon aria-hidden />
          {themeSwitch.label}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => leaveGuard(() => router.push(CHANGE_PASSWORD_PATH))}>
          <KeyRound aria-hidden />
          {s.changePasswordMenu}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setConfirmAll(true)}>
          <MonitorSmartphone aria-hidden />
          {s.logoutAllMenu}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
          <LogOut aria-hidden />
          {t.auth.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <ConfirmDialog
      open={confirmAll}
      onOpenChange={setConfirmAll}
      title={s.logoutAllTitle}
      description={s.logoutAllBody}
      confirmLabel={s.logoutAllConfirm}
      cancelLabel={s.logoutAllCancel}
      destructive
      onConfirm={async () => {
        try {
          await logoutAll();
          toast.success(s.logoutAllDone);
          return true;
        } catch (err) {
          toast.error(errorMessage(err));
          return false;
        }
      }}
    />
    </>
  );
}

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, changeLocale } = useAuth();
  const { t, dir, locale } = useI18n();
  const nf = t.navFindability;
  const uf = t.uiFoundation;
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const items = visibleNav(user);
  const counts = useNavCounts();
  const countText = useCountText();

  // The shell renders only after /auth/me (never during prerender), so storage can be read on first render.
  const [collapsed, setCollapsed] = useState(() => readStorage(SIDEBAR_KEY, (raw) => raw === '1', false));
  const [savedGroups, setSavedGroups] = useState<GroupState>(() =>
    readStorage<GroupState>(GROUPS_KEY, (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as GroupState) : {};
    }, {}),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mac] = useState(isMacLike);
  const paletteOpenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // ── Leave guard: in-app navigation never drops a dirty form (useDirtyGuard) without asking. ──
  const [leavePrompt, setLeavePrompt] = useState<(() => void) | null>(null);
  const leaveReturnRef = useRef<HTMLElement | null>(null);

  const leaveGuard = useCallback<LeaveGuard>((proceed, returnFocus) => {
    if (!hasUnsavedChanges()) {
      proceed();
      return;
    }
    const active = document.activeElement;
    leaveReturnRef.current = returnFocus ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    setLeavePrompt(() => proceed);
  }, []);

  // Every link (sidebar, bottom bar, breadcrumbs, settings sections, cards...). Capture phase, so this runs
  // before next/link, which skips its navigation when the click was already prevented.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = inAppTarget(e);
      if (!target || !hasUnsavedChanges()) return;
      e.preventDefault();
      const { href, anchor } = target;
      // data-nav-replace marks links rendered with <Link replace> (the settings section list).
      const replace = anchor.dataset.navReplace !== undefined;
      leaveReturnRef.current = anchor;
      setLeavePrompt(() => () => (replace ? router.replace(href, { scroll: false }) : router.push(href)));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [router]);

  // Browser Back / Forward: by the time popstate fires the address bar has moved, but the page has not
  // (Next.js renders the other page from its own popstate listener). With unsaved edits, this guard runs
  // first (lib/history-guard), keeps Next.js from seeing the move, steps the browser back to the entry with
  // the edits and asks "Discard changes?"; Discard replays the move. Every entry carries its position
  // (HISTORY_INDEX, written by wrapping pushState / replaceState), which tells how far and which way to step.
  useEffect(() => {
    const { history } = window;
    const push = history.pushState;
    const replace = history.replaceState;
    // Entries from before the shell mounted (sign-in) have no position: count from the end of the stack.
    let index = historyIndexOf(history.state) ?? history.length - 1;
    let page = currentPage();
    history.pushState = function pushState(data, unused, url) {
      index += 1;
      push.call(history, withHistoryIndex(data, index), unused, url);
      page = currentPage();
    };
    history.replaceState = function replaceState(data, unused, url) {
      replace.call(history, withHistoryIndex(data, index), unused, url);
      page = currentPage();
    };
    // Next.js has written its state by now; never replace an entry that has none (popstate would reload).
    if (history.state !== null && typeof history.state === 'object') history.replaceState(history.state, '');

    // Moves this listener started itself: 'undo' (back to the edits) and 'replay' (after Discard).
    let expected: { step: 'undo' | 'replay'; at: number }[] = [];
    const onPopState = (e: PopStateEvent) => {
      const to = historyIndexOf(e.state);
      // A move that never arrived (no entry that far) must not swallow a later one.
      expected = expected.filter((x) => Date.now() - x.at < 1000);
      const step = expected.shift()?.step;
      if (step === 'undo') {
        e.stopImmediatePropagation();
        return;
      }
      // An in-page #anchor entry unmounts nothing.
      if (step !== 'replay' && currentPage() !== page && hasUnsavedChanges()) {
        e.stopImmediatePropagation();
        // An entry without a position comes from before the shell mounted, so it is behind this one.
        const delta = to === undefined || to === index ? -1 : to - index;
        expected.push({ step: 'undo', at: Date.now() });
        history.go(-delta);
        leaveGuard(() => {
          expected.push({ step: 'replay', at: Date.now() });
          history.go(delta);
        });
        return;
      }
      index = to ?? index - 1;
      page = currentPage();
    };
    setPopStateGuard(onPopState);
    return () => {
      setPopStateGuard(null);
      history.pushState = push;
      history.replaceState = replace;
    };
  }, [leaveGuard]);

  const collapsedGroups: GroupState = { ...Object.fromEntries(defaultCollapsedGroups(user).map((g) => [g, true])), ...savedGroups };

  const toggleGroup = (group: NavGroup) => {
    const next = { ...savedGroups, [group]: !(collapsedGroups[group] === true) };
    setSavedGroups(next);
    writeStorage(GROUPS_KEY, JSON.stringify(next));
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeStorage(SIDEBAR_KEY, next ? '1' : '0');
  };

  const openPalette = useCallback((from: HTMLElement | null) => {
    returnFocusRef.current = from;
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  // Ctrl/⌘+K anywhere (e.code also matches Arabic keyboard layouts). Ignored while another dialog is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyK' && (e.key ?? '').toLowerCase() !== 'k') return;
      if (paletteOpenRef.current) {
        e.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (document.querySelector(OPEN_DIALOG)) return;
      e.preventDefault();
      openPalette(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  // Fallback browser-tab title from the menu. It runs in the layout phase, so a page's PageHeader
  // (a passive effect, which runs later) overrides it with the specific title.
  const current = activeItem(items, pathname);
  const fallbackTitle = current ? current.label(t) : '';
  useLayoutEffect(() => {
    document.title = fallbackTitle ? `${fallbackTitle} · ${t.common.appName}` : t.common.appName;
  }, [pathname, locale, fallbackTitle, t.common.appName]);

  const bottomItems = mobileNavFor(user);
  const moreActive = !!current && !bottomItems.includes(current);
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const shortcut = mac ? '⌘K' : 'Ctrl K';

  return (
    <LeaveGuardContext.Provider value={leaveGuard}>
      <div className="flex min-h-dvh">
        <a href="#main" className="bg-primary sr-only z-[60] rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:start-3 focus:top-3">
          {t.common.skipToContent}
        </a>

        {/* Desktop sidebar */}
        <aside
          className={cn(
            'bg-sidebar/80 border-sidebar-border sticky top-0 hidden h-dvh shrink-0 flex-col border-e backdrop-blur transition-[width] duration-200 md:flex print:hidden',
            collapsed ? 'w-[72px]' : 'w-64',
          )}
        >
          <div className={cn('flex h-16 shrink-0 items-center gap-3 ps-4 pe-2', collapsed && 'justify-center px-0')}>
            {!collapsed && (
              <>
                <BrandMark />
                <BrandWordmark subtitle={t.common.appShort} className="flex-1" />
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground shrink-0"
                  onClick={toggleCollapsed}
                  aria-label={collapsed ? t.nav.expand : t.nav.collapse}
                  aria-expanded={!collapsed}
                >
                  <CollapseIcon className="rtl:-scale-x-100" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={dir === 'rtl' ? 'left' : 'right'}>{collapsed ? t.nav.expand : t.nav.collapse}</TooltipContent>
            </Tooltip>
          </div>
          <div className="bg-brand-gradient mx-4 h-px shrink-0 opacity-40" aria-hidden />
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <NavLinks rail={collapsed} counts={counts} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} idPrefix="side" />
          </div>
          <div className={cn('shrink-0 border-t border-tint/[0.06] p-3', collapsed && 'flex justify-center')}>
            <InstallAppButton rail={collapsed} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="bg-background/70 sticky top-0 z-30 border-b border-tint/[0.05] backdrop-blur-xl print:hidden">
            <div className="flex h-16 items-center gap-2 px-4 sm:gap-3 sm:px-6">
              <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setDrawerOpen(true)} aria-label={t.nav.openMenu}>
                <Menu aria-hidden />
              </Button>
              <Link href={homeFor(user)} className="flex items-center gap-2 rounded-md md:hidden" aria-label={t.common.appName}>
                <BrandMark className="size-7" />
                <BrandWordmark className="hidden min-[360px]:flex" />
              </Link>
              <div className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={(e) => openPalette(e.currentTarget)}
                  aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
                  aria-haspopup="dialog"
                  className="text-muted-foreground hover:text-foreground hidden h-10 w-full max-w-md items-center gap-2 rounded-full border border-tint/15 bg-tint/[0.03] ps-4 pe-2 text-sm transition-colors hover:bg-tint/[0.06] sm:flex"
                >
                  <Search className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-start">{nf.searchPlaceholder}</span>
                  <kbd dir="ltr" lang="en" className="text-muted-foreground shrink-0 rounded-md border border-tint/15 bg-tint/[0.04] px-1.5 py-0.5 font-sans text-xs">
                    {shortcut}
                  </kbd>
                </button>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="sm:hidden"
                onClick={(e) => openPalette(e.currentTarget)}
                aria-label={nf.search}
                aria-haspopup="dialog"
              >
                <Search aria-hidden />
              </Button>
              <LanguageToggle onChange={changeLocale} className="hidden sm:inline-flex" />
              <ThemeToggle className="hidden sm:inline-flex" />
              <NotificationsBell unreadCount={counts.notifications} />
              <UserMenu />
            </div>
            <div className="bg-brand-gradient h-px opacity-30" aria-hidden />
          </header>

          <main id="main" className="mx-auto w-full max-w-[1400px] min-w-0 flex-1 px-4 pt-6 pb-28 sm:px-6 md:pb-10">
            {children}
          </main>
        </div>

        {/* Mobile bottom navigation: role-aware slots + More */}
        <nav
          className="bg-background/85 pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-tint/[0.06] backdrop-blur-xl md:hidden print:hidden"
          aria-label={t.nav.menu}
        >
          <ul className="grid" style={{ gridTemplateColumns: `repeat(${bottomItems.length + 1}, minmax(0, 1fr))` }}>
            {bottomItems.map((item) => {
              const active = item === current;
              const Icon = item.icon;
              const count = countOf(item, counts);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex h-16 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-offset-[-2px]',
                      active ? 'font-semibold text-tint' : 'text-muted-foreground font-medium',
                    )}
                  >
                    {active && <span className="bg-brand-gradient absolute inset-x-4 top-0 h-0.5 rounded-full" aria-hidden />}
                    <span className="relative">
                      <Icon className={cn('size-5', active && 'text-primary')} aria-hidden />
                      {count > 0 && (
                        <span
                          className="bg-brand-cta num absolute -end-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.75rem] leading-none font-bold text-white"
                          aria-hidden
                        >
                          {capped(count)}
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 max-w-full px-0.5 text-center leading-tight">{(item.shortLabel ?? item.label)(t)}</span>
                    {count > 0 && <span className="sr-only">{countText(item, count)}</span>}
                  </Link>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                className={cn(
                  'relative flex h-16 w-full flex-col items-center justify-center gap-1 text-xs focus-visible:outline-offset-[-2px]',
                  moreActive ? 'font-semibold text-tint' : 'text-muted-foreground font-medium',
                )}
              >
                {moreActive && <span className="bg-brand-gradient absolute inset-x-4 top-0 h-0.5 rounded-full" aria-hidden />}
                <Menu className={cn('size-5', moreActive && 'text-primary')} aria-hidden />
                {t.nav.more}
              </button>
            </li>
          </ul>
        </nav>

        {/* Mobile drawer: the same grouped menu */}
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side={dir === 'rtl' ? 'right' : 'left'} className="w-[85%] max-w-xs p-0">
            <SheetHeader className="flex-row items-center gap-3">
              <BrandMark />
              <div>
                <SheetTitle>
                  <BrandWordmark subtitle={t.common.appShort} />
                </SheetTitle>
                <SheetDescription className="sr-only">{t.nav.menu}</SheetDescription>
              </div>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-3">
              <NavLinks
                rail={false}
                onNavigate={() => setDrawerOpen(false)}
                counts={counts}
                collapsedGroups={collapsedGroups}
                onToggleGroup={toggleGroup}
                idPrefix="drawer"
              />
            </div>
            <div className="space-y-2 border-t border-tint/[0.06] p-4">
              <InstallAppButton onDone={() => setDrawerOpen(false)} />
              <div className="flex gap-2">
                <LanguageToggle onChange={changeLocale} className="flex-1" />
                <ThemeToggle withLabel className="flex-1" />
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} returnFocusRef={returnFocusRef} guard={leaveGuard} />

        <AlertDialog open={leavePrompt !== null} onOpenChange={(open) => !open && setLeavePrompt(null)}>
          <AlertDialogContent
            onCloseAutoFocus={(e) => {
              // Keep editing: back to the link or control that tried to leave (cleared by Discard).
              const target = leaveReturnRef.current;
              leaveReturnRef.current = null;
              if (target?.isConnected) {
                e.preventDefault();
                target.focus();
              }
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{uf.discardTitle}</AlertDialogTitle>
              <AlertDialogDescription>{uf.discardBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* Radix focuses Cancel first, so Enter keeps the edits. */}
              <AlertDialogCancel>{uf.keepEditing}</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => {
                  leaveReturnRef.current = null;
                  leavePrompt?.();
                  setLeavePrompt(null);
                }}
              >
                {uf.discardConfirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </LeaveGuardContext.Provider>
  );
}

'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarClock, ChevronRight, FilePen, Loader2, Scale, Search, UserRound, type LucideIcon } from 'lucide-react';
import { PERMISSIONS, type EmployeeDto, type Paginated } from '@workforce/shared';

import { employeeHref } from '@/components/employee-link';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiGet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { localized } from '@/lib/format';
import { dictionaries, fmt, type Dictionary } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { NAV_ACTIONS, SETTING_LINKS, canAdjustLeave, canCorrectAttendanceOf, employeeTabAllowed, visibleNav, type EmployeeHubTab } from '@/lib/nav';
import { score } from '@/lib/search-normalize';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';

type GroupKey = 'thisEmployee' | 'pages' | 'employees' | 'settings' | 'actions';

const GROUP_ORDER: GroupKey[] = ['thisEmployee', 'pages', 'employees', 'settings', 'actions'];
const EMPLOYEE_PAGE = '/admin/employees/view';
const MIN_EMPLOYEE_QUERY = 2;
const EMPLOYEE_LIMIT = 6;

interface Entry {
  key: string;
  group: GroupKey;
  href: string;
  icon: LucideIcon;
  content: ReactNode;
  hint?: ReactNode;
  /** An employee's "Name > Leave & entitlements" style sub-option, indented under the employee. */
  sub?: boolean;
  score: number;
}

type ShortcutKey = 'adjustLeave' | 'assignSchedule' | 'correctAttendance';

/** Both languages, so an English word finds an Arabic label and the other way round. */
const bothLabels = (label: (t: Dictionary) => string) => [label(dictionaries.en), label(dictionaries.ar)];

/**
 * Ctrl/⌘+K command palette: pages, settings, actions and (with employees.read) employees, filtered by
 * the same role and employee-portal checks as the navigation. A combobox over a grouped listbox, built
 * on ui/dialog (no cmdk). Focus returns to `returnFocusRef` (the trigger) when it closes.
 */
export function CommandPalette({ open, onOpenChange, returnFocusRef, guard }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Runs the navigation, first asking "Discard changes?" when the page has unsaved edits (AppShell's leave guard). */
  guard?: (proceed: () => void, returnFocus?: HTMLElement | null) => void;
}) {
  const { t, locale } = useI18n();
  const nf = t.navFindability;
  const { user, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | null>(null);

  // Every opening starts fresh; on an employee page the "This employee" shortcuts target that person.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const onEmployeePage = (pathname ?? '').replace(/\/+$/, '') === EMPLOYEE_PAGE;
    setCurrentEmployeeId(onEmployeePage ? new URLSearchParams(window.location.search).get('id') : null);
  }, [open, pathname]);

  // ── Employee search (server side, debounced) ──
  const canSearchPeople = can(PERMISSIONS.EMPLOYEES_READ);
  const trimmed = query.trim();
  const debouncedQuery = useDebounced(trimmed, 200);
  const employeeQuery = canSearchPeople && debouncedQuery.length >= MIN_EMPLOYEE_QUERY ? debouncedQuery : '';
  const [people, setPeople] = useState<{ q: string; items: EmployeeDto[] } | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);

  useEffect(() => {
    if (!open || !employeeQuery) {
      setPeopleLoading(false);
      return;
    }
    const controller = new AbortController();
    setPeopleLoading(true);
    apiGet<Paginated<EmployeeDto>>('/employees', { search: employeeQuery, pageSize: EMPLOYEE_LIMIT }, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setPeople({ q: employeeQuery, items: res.items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPeople({ q: employeeQuery, items: [] });
      })
      .finally(() => {
        if (!controller.signal.aborted) setPeopleLoading(false);
      });
    return () => controller.abort();
  }, [open, employeeQuery]);

  const waitingForPeople = canSearchPeople && trimmed.length >= MIN_EMPLOYEE_QUERY && (peopleLoading || debouncedQuery !== trimmed);
  const peopleItems = useMemo(() => (employeeQuery && people?.q === employeeQuery ? people.items : []), [employeeQuery, people]);

  // ── Entries ──
  const entries = useMemo<Entry[]>(() => {
    const q = trimmed;
    const out: Entry[] = [];
    const add = (entry: Omit<Entry, 'score'>, primary: string[], secondary: string[] = []) => {
      const s = q ? score(q, primary, secondary) : 1;
      if (s > 0) out.push({ ...entry, score: s });
    };

    if (currentEmployeeId) {
      // The same rules as the employee hub, so each shortcut lands on a tab that has the control it names.
      const shortcuts: { key: ShortcutKey; href: string; icon: LucideIcon; allowed: boolean }[] = [
        // &adjust=1 opens the hub's Adjust balance dialog.
        { key: 'adjustLeave', href: `${employeeHref(currentEmployeeId, 'leave')}&adjust=1`, icon: Scale, allowed: canAdjustLeave(user) },
        { key: 'assignSchedule', href: employeeHref(currentEmployeeId, 'schedule'), icon: CalendarClock, allowed: employeeTabAllowed(user, 'schedule') },
        {
          key: 'correctAttendance',
          href: employeeHref(currentEmployeeId, 'attendance'),
          icon: FilePen,
          allowed: employeeTabAllowed(user, 'attendance') && canCorrectAttendanceOf(user, currentEmployeeId),
        },
      ];
      for (const s of shortcuts) {
        if (!s.allowed) continue;
        add(
          { key: `this-${s.key}`, group: 'thisEmployee', href: s.href, icon: s.icon, content: nf.actions[s.key] },
          [dictionaries.en.navFindability.actions[s.key], dictionaries.ar.navFindability.actions[s.key]],
        );
      }
    }

    for (const item of visibleNav(user)) {
      add({ key: `page-${item.href}`, group: 'pages', href: item.href, icon: item.icon, content: item.label(t) }, bothLabels(item.label), item.keywords);
    }

    for (const link of SETTING_LINKS) {
      if (!link.allowed(user)) continue;
      add(
        { key: `setting-${link.id}`, group: 'settings', href: link.href, icon: link.icon, content: link.label(t) },
        bothLabels(link.label),
        [...bothLabels(link.description), ...(link.keywords ?? [])],
      );
    }

    for (const action of NAV_ACTIONS) {
      if (!action.visible(user)) continue;
      add(
        { key: `action-${action.id}`, group: 'actions', href: action.href, icon: action.icon, content: nf.actions[action.id] },
        [dictionaries.en.navFindability.actions[action.id], dictionaries.ar.navFindability.actions[action.id]],
        action.keywords,
      );
    }

    if (q && peopleItems.length > 0) {
      const withSubOptions = peopleItems.length <= 2;
      for (const e of peopleItems) {
        const name = localized(locale, e.fullName, e.fullNameAr) || e.fullName;
        // The server already matched (also on username); keep its matches, ranked by how well the name fits.
        const s = Math.max(score(q, [e.fullName, e.fullNameAr ?? '', e.employeeCode]), 35);
        const dept = localized(locale, e.departmentName, e.departmentNameAr);
        out.push({
          key: `emp-${e.id}`,
          group: 'employees',
          href: employeeHref(e.id, 'overview'),
          icon: UserRound,
          score: s,
          content: (
            <span className="flex min-w-0 items-baseline gap-2">
              <bdi className="truncate">{name}</bdi>
              <span dir="ltr" className="text-muted-foreground shrink-0 text-xs">
                {e.employeeCode}
              </span>
            </span>
          ),
          hint: dept ? <bdi>{dept}</bdi> : undefined,
        });
        if (!withSubOptions) continue;
        const subs: { tab: EmployeeHubTab; label: string }[] = [
          { tab: 'leave', label: nf.employeeSub.leave },
          { tab: 'attendance', label: nf.employeeSub.attendance },
          { tab: 'schedule', label: nf.employeeSub.schedule },
        ];
        for (const sub of subs) {
          if (!employeeTabAllowed(user, sub.tab)) continue;
          out.push({
            key: `emp-${e.id}-${sub.tab}`,
            group: 'employees',
            href: employeeHref(e.id, sub.tab),
            icon: ChevronRight,
            sub: true,
            score: s - 1,
            content: (
              <span className="flex min-w-0 items-center gap-1.5">
                <bdi className="truncate">{name}</bdi>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden />
                <span className="sr-only">, </span>
                <span className="shrink-0">{sub.label}</span>
              </span>
            ),
          });
        }
      }
    }
    return out;
  }, [trimmed, currentEmployeeId, user, t, nf, locale, peopleItems]);

  // Groups in default order when browsing; ranked by their best match while searching.
  const groups = useMemo(() => {
    const byGroup = new Map<GroupKey, Entry[]>();
    for (const e of entries) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e]);
    const list = GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
      const items = byGroup.get(g)!;
      // Sub-options stay right under their employee, so only the other groups are re-sorted.
      const sorted = trimmed && g !== 'employees' ? [...items].sort((a, b) => b.score - a.score) : items;
      return { key: g, items: sorted, best: Math.max(...items.map((i) => i.score)) };
    });
    if (trimmed) list.sort((a, b) => (a.key === 'thisEmployee' ? -1 : b.key === 'thisEmployee' ? 1 : b.best - a.best));
    return list;
  }, [entries, trimmed]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  useEffect(() => {
    setActive(0);
  }, [trimmed]);

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${baseId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, baseId]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    const navigate = () => {
      onOpenChange(false);
      router.push(entry.href);
    };
    // With unsaved edits on the page, the "Discard changes?" prompt opens over the palette; Keep editing returns here.
    if (guard) guard(navigate, inputRef.current);
    else navigate();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = flat.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (n) setActive((activeIndex + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n) setActive((activeIndex - 1 + n) % n);
        break;
      case 'Home':
        if (!n) break;
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        if (!n) break;
        e.preventDefault();
        setActive(n - 1);
        break;
      case 'Enter':
        e.preventDefault();
        go(flat[activeIndex]);
        break;
    }
  };

  // Spoken summary, debounced so typing does not flood the screen reader.
  const status = waitingForPeople
    ? nf.searching
    : trimmed && flat.length === 0
      ? fmt(nf.noMatches, { q: trimmed })
      : trimmed
        ? flat.length === 1
          ? nf.resultsOne
          : fmt(nf.resultsMany, { n: flat.length })
        : '';
  const spoken = useDebounced(open ? status : '', 400);
  const [noMatchBefore, noMatchAfter = ''] = nf.noMatches.split('{q}');

  let index = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 pt-0 sm:top-[12vh] sm:max-h-[min(36rem,80dvh)] sm:max-w-xl sm:translate-y-0 sm:pt-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocusRef?.current;
          if (target && target.isConnected && target.offsetParent !== null) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogTitle className="sr-only">{nf.paletteTitle}</DialogTitle>
        <DialogDescription className="sr-only">{nf.footerHint}</DialogDescription>

        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-tint/10 ps-4 pe-14">
          {waitingForPeople ? (
            <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" aria-hidden />
          ) : (
            <Search className="text-muted-foreground size-5 shrink-0" aria-hidden />
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={nf.search}
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            dir="auto"
            enterKeyHint="go"
            placeholder={nf.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          <div role="listbox" id={listboxId} aria-label={nf.paletteTitle}>
            {groups.map((group) => {
              const headingId = `${baseId}-group-${group.key}`;
              return (
                <div key={group.key} role="group" aria-labelledby={headingId} className="pb-2">
                  <div id={headingId} aria-hidden className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-semibold">
                    {nf.paletteGroups[group.key]}
                  </div>
                  {group.items.map((entry) => {
                    index += 1;
                    const i = index;
                    const selected = i === activeIndex;
                    const Icon = entry.icon;
                    const sub = entry.sub === true;
                    return (
                      <div
                        key={entry.key}
                        id={optionId(i)}
                        role="option"
                        aria-selected={selected}
                        onMouseMove={() => {
                          if (!selected) setActive(i);
                        }}
                        onClick={() => go(entry)}
                        className={cn(
                          'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm',
                          selected ? 'bg-tint/[0.08] text-tint' : 'text-foreground',
                          sub && 'ps-9',
                        )}
                      >
                        {!sub && (
                          <Icon className={cn('size-4 shrink-0', selected ? 'text-tint' : 'text-muted-foreground')} aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate">{entry.content}</span>
                        {entry.hint && <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs">{entry.hint}</span>}
                        {selected && <ChevronRight className="text-muted-foreground size-4 shrink-0 rtl:-scale-x-100" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {trimmed && flat.length === 0 && !waitingForPeople && (
            <div className="px-4 py-10 text-center">
              <p className="font-medium">
                {noMatchBefore}
                <bdi>{trimmed}</bdi>
                {noMatchAfter}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">{nf.noMatchesHint}</p>
            </div>
          )}
          {waitingForPeople && flat.length === 0 && <p className="text-muted-foreground px-4 py-10 text-center text-sm">{nf.searching}</p>}
        </div>

        <div className="text-muted-foreground hidden shrink-0 border-t border-tint/10 px-4 py-2.5 text-xs sm:block">{nf.footerHint}</div>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {spoken}
        </div>
      </DialogContent>
    </Dialog>
  );
}

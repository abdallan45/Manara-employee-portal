'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Search, SearchX } from 'lucide-react';
import {
  PERMISSIONS,
  PORTAL_KEYS,
  SETTING_DEFAULTS,
  isPortalVisible,
  portalPageOf,
  type AttendanceStatusDto,
  type BreakTypeDto,
  type HolidayDto,
  type LeaveTypeDto,
  type OfficeLocationDto,
  type OvertimePolicyDto,
  type ScheduleDto,
  type SettingDto,
} from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { EmptyState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { formatNumber, todayInAmman } from '@/lib/format';
import { dictionaries, fmt, type Dictionary } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { SETTING_GROUPS, SETTING_LINKS, type SettingLink, type SettingLinkId } from '@/lib/nav';
import { score } from '@/lib/search-normalize';
import { useApi, type ApiState } from '@/lib/use-api';
import { cn } from '@/lib/utils';

/** undefined = still loading ("…"), null = unknown or failed (no status line). */
type Status = string | null | undefined;

const both = (label: (t: Dictionary) => string) => [label(dictionaries.en), label(dictionaries.ar)];

/** Status from one GET: "…" while loading, nothing on error. */
function statusOf<T>(state: ApiState<T>, enabled: boolean, render: (data: T) => string | null): Status {
  if (!enabled) return null;
  if (state.data !== undefined) return render(state.data);
  if (state.error) return null;
  return undefined;
}

/** Live one-line status per settings card, from the existing GET endpoints (only for cards the user can open). */
function useSettingStatuses(allowed: ReadonlySet<SettingLinkId>): Partial<Record<SettingLinkId, Status>> {
  const { t, locale } = useI18n();
  const { user, can } = useAuth();
  const s = t.navFindability.status;
  const n = (v: number) => formatNumber(v, locale);
  const year = todayInAmman().slice(0, 4);

  const on = (id: SettingLinkId) => allowed.has(id);
  const offices = useApi<OfficeLocationDto[]>(on('offices') ? '/offices' : null);
  // The enforcement mode: from the settings when this user manages them, else from their own attendance status.
  const canSettings = can(PERMISSIONS.SETTINGS_MANAGE);
  const ownStatus = useApi<AttendanceStatusDto>(
    on('offices') && !canSettings && user.employee && can(PERMISSIONS.ATTENDANCE_SELF) ? '/attendance/me/status' : null,
  );
  const breakTypes = useApi<BreakTypeDto[]>(on('break-types') ? '/break-types' : null);
  const schedules = useApi<ScheduleDto[]>(on('schedules') ? '/schedules' : null);
  const holidays = useApi<HolidayDto[]>(on('holidays') ? '/holidays' : null, { year });
  const leaveTypes = useApi<LeaveTypeDto[]>(on('leave-types') ? '/leave/types' : null);
  const policy = useApi<OvertimePolicyDto>(on('overtime') ? '/overtime/policy' : null);
  const settings = useApi<SettingDto[]>(on('general') || (on('offices') && canSettings) ? '/settings' : null);

  const officeStatus: Status = (() => {
    if (!on('offices')) return null;
    if (offices.error) return null;
    const source = canSettings ? settings : ownStatus;
    if (!offices.data || (source.loading && !source.data)) return undefined;
    const stored = canSettings ? settings.data?.find((x) => x.key === 'attendance.locationEnforcement')?.value : ownStatus.data?.location.enforcement;
    // Never saved: the default applies. Unknown (no access, or failed): the office count alone.
    const enforcement = stored ?? (canSettings && settings.data ? SETTING_DEFAULTS['attendance.locationEnforcement'] : undefined);
    const active = offices.data.filter((x) => x.isActive && x.latitude !== null && x.longitude !== null).length;
    if (enforcement === undefined) return active === 0 ? s.officesNoneShort : fmt(s.officesCount, { n: n(active) });
    const mode = enforcement === 'ENFORCE' ? s.blockingOn : s.flagOnly;
    if (active === 0) return fmt(s.officesNone, { mode });
    return active === 1 ? fmt(s.officesOne, { mode }) : fmt(s.officesMany, { n: n(active), mode });
  })();

  // No policy configured answers 409 CONFLICT: overtime is off.
  const overtimeStatus: Status =
    on('overtime') && policy.error?.code === 'CONFLICT'
      ? s.overtimeOff
      : statusOf(policy, on('overtime'), (p) => fmt(s.overtimeOn, { multiplier: formatNumber(Number(p.regularMultiplier), locale, { maximumFractionDigits: 2 }) }));

  // Hidden pages, plus sections hidden under a page that is still shown. A hidden page's sections go with
  // it and are not counted again (as on the Employee pages section).
  const hiddenPortal = PORTAL_KEYS.filter((k) => {
    const page = portalPageOf(k);
    return !isPortalVisible(user.portal, k) && (page === k || isPortalVisible(user.portal, page));
  }).length;

  return {
    offices: officeStatus,
    'break-types': statusOf(breakTypes, on('break-types'), (list) => fmt(s.active, { n: n(list.filter((b) => b.isActive).length) })),
    schedules: statusOf(schedules, on('schedules'), (list) => {
      const def = list.find((x) => x.isDefault);
      return def ? fmt(s.schedules, { n: n(list.length), name: def.name }) : fmt(s.schedulesNoDefault, { n: n(list.length) });
    }),
    holidays: statusOf(holidays, on('holidays'), (list) => (list.length === 1 ? fmt(s.holidaysOne, { year }) : fmt(s.holidays, { n: n(list.length), year }))),
    'leave-types': statusOf(leaveTypes, on('leave-types'), (list) => fmt(s.active, { n: n(list.filter((l) => l.isActive).length) })),
    entitlements: on('entitlements') ? s.entitlements : null,
    overtime: overtimeStatus,
    portal: on('portal') ? (hiddenPortal === 0 ? s.portalAll : fmt(s.portalHidden, { n: n(hiddenPortal) })) : null,
    general: statusOf(settings, on('general'), (list) => {
      const hours = list.find((x) => x.key === 'auth.sessionHours')?.value;
      return typeof hours === 'number' ? fmt(s.session, { h: n(hours) }) : null;
    }),
  };
}

function SettingRow({ link, status }: { link: SettingLink; status: Status }) {
  const { t } = useI18n();
  const Icon = link.icon;
  return (
    <Link href={link.href} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-tint/[0.04] focus-visible:-outline-offset-2">
      <span className="text-brand-soft flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint/[0.05]">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1">
          <span className="font-semibold">{link.label(t)}</span>
          {/* Inside the link: HelpTip prevents the click so tapping "?" doesn't navigate. */}
          <HelpTip text={link.description(t)} />
        </span>
        <span className="sr-only">{link.description(t)}</span>
        {status !== null && (
          <span className={cn('text-foreground/85 mt-0.5 text-xs font-medium', status === undefined && 'text-muted-foreground')} aria-busy={status === undefined || undefined}>
            {status === undefined ? t.navFindability.status.loading : status}
          </span>
        )}
      </span>
      <ChevronRight className="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors rtl:-scale-x-100" aria-hidden />
    </Link>
  );
}

/** /admin/settings without ?tab: every setting, one under another in its category, searchable, with a live status line each. */
export function SettingsOverview() {
  const { user } = useAuth();
  const { t } = useI18n();
  const nf = t.navFindability;
  const [query, setQuery] = useState('');

  const links = useMemo(() => SETTING_LINKS.filter((l) => l.allowed(user)), [user]);
  const allowedIds = useMemo(() => new Set(links.map((l) => l.id)), [links]);
  const statuses = useSettingStatuses(allowedIds);

  const q = query.trim();
  const matches = q
    ? links.filter((l) => {
        const status = statuses[l.id];
        return score(q, both(l.label), [...both(l.description), ...(l.keywords ?? []), ...(typeof status === 'string' ? [status] : [])]) > 0;
      })
    : links;
  const groups = SETTING_GROUPS.map((g) => ({ group: g, items: matches.filter((l) => l.group === g) })).filter((g) => g.items.length > 0);
  const [noneBefore, noneAfter = ''] = nf.noSettingMatches.split('{q}');

  return (
    <div className="space-y-6">
      <div className="max-w-md space-y-2">
        <Label htmlFor="settings-find">{nf.findSetting}</Label>
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" aria-hidden />
          <Input
            id="settings-find"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={nf.findSettingPlaceholder}
            autoComplete="off"
            dir="auto"
            className="ps-9"
            aria-describedby="settings-find-count"
          />
        </div>
        <p id="settings-find-count" className="sr-only" aria-live="polite">
          {q ? (matches.length === 1 ? nf.resultsOne : fmt(nf.resultsMany, { n: matches.length })) : ''}
        </p>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={SearchX} title={`${noneBefore}${q}${noneAfter}`} />
      ) : (
        <div className="max-w-3xl space-y-6">
          {groups.map(({ group, items }) => (
            <section key={group} aria-labelledby={`settings-group-${group}`} className="space-y-2">
              <h2 id={`settings-group-${group}`} className="text-muted-foreground px-1 text-sm font-semibold">
                {nf.settingGroups[group]}
              </h2>
              <ul className="bg-card/80 divide-y divide-tint/[0.06] overflow-hidden rounded-2xl border border-tint/[0.06]">
                {items.map((link) => (
                  <li key={link.id}>
                    <SettingRow link={link} status={statuses[link.id] ?? null} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

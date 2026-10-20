'use client';

import { Fragment, Suspense, useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { LayoutGrid } from 'lucide-react';
import type { ScheduleDto } from '@workforce/shared';

import { useLeaveGuard } from '@/components/app-shell';
import { LeaveEntitlements } from '@/components/leave-entitlements';
import { PageHeader } from '@/components/page-header';
import { ForbiddenState, LoadingRows } from '@/components/states';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import type { Dictionary } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { NAV_ITEMS, SETTING_GROUPS, SETTING_LINKS, allowedSettingsTabs, homeFor, settingsHref, settingsTabLabel, type SettingsTab } from '@/lib/nav';
import { useApi } from '@/lib/use-api';
import { useUrlTab } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { AssignmentsTab } from '../schedules/assignments-tab';
import { HolidaysTab } from '../schedules/holidays-tab';
import { SchedulesTab } from '../schedules/schedules-tab';
import { BreakTypesTab } from './break-types-tab';
import { GeneralTab } from './general-tab';
import { LeaveTypesTab } from './leave-types-tab';
import { OfficesTab } from './offices-tab';
import { OvertimeTab } from './overtime-tab';
import { PortalTab } from './portal-tab';
import { SettingsOverview } from './settings-overview';

const OVERVIEW = 'overview';
const SECTION_SELECT_ID = 'settings-section';

/** Schedules and "Who works what" share the schedule list (the assignment form picks from it). */
function SchedulesSection({ assignments = false }: { assignments?: boolean }) {
  const schedules = useApi<ScheduleDto[]>('/schedules');
  return assignments ? <AssignmentsTab schedules={schedules} /> : <SchedulesTab schedules={schedules} />;
}

/** Standing guidance for a section, added to its "?" next to the title (the sections show no intro paragraph). */
const SECTION_HELP: Partial<Record<SettingsTab, (t: Dictionary) => string>> = {
  schedules: (t) => t.schedules.typeHint,
  assignments: (t) => t.schedules.assignHint,
  holidays: (t) => t.schedules.holidays.clickHint,
  'leave-types': (t) => t.settings.leaveTypes.changeNote,
  entitlements: (t) => t.employeeHub.entitlements.intro,
};

const CONTENT: Record<SettingsTab, () => ReactNode> = {
  offices: () => <OfficesTab />,
  'break-types': () => <BreakTypesTab />,
  schedules: () => <SchedulesSection />,
  assignments: () => <SchedulesSection assignments />,
  holidays: () => <HolidaysTab />,
  'leave-types': () => <LeaveTypesTab />,
  entitlements: () => <LeaveEntitlements />,
  overtime: () => <OvertimeTab />,
  general: () => <GeneralTab />,
  portal: () => <PortalTab />,
};

/**
 * /admin/settings: every company setting, grouped by category. Without ?tab it lists them all (the
 * overview); with ?tab=<section> it opens one, next to the same grouped list (a select on phones).
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <Settings />
    </Suspense>
  );
}

function Settings() {
  const { user } = useAuth();
  const { t } = useI18n();
  const nf = t.navFindability;
  const tabs = allowedSettingsTabs(user);
  const [tab, setTab] = useUrlTab([...tabs, OVERVIEW], OVERVIEW);
  const leaveGuard = useLeaveGuard();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Switching between the overview and a section unmounts the control that had focus (the section select,
  // "All settings", a list row). Start again from the new page title instead of <body>; not on first load.
  const previousTab = useRef(tab);
  useEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    const rescue = () => {
      const active = document.activeElement;
      if (!active || active === document.body) titleRef.current?.focus({ preventScroll: true });
    };
    rescue();
    // A closing select or "Discard changes?" prompt gives focus back a moment later.
    const id = window.setTimeout(rescue, 300);
    return () => window.clearTimeout(id);
  }, [tab]);

  if (tabs.length === 0) {
    const home = homeFor(user);
    return <ForbiddenState homeHref={home} homeLabel={NAV_ITEMS.find((i) => i.href === home)?.label(t)} />;
  }

  if (tab === OVERVIEW) {
    return (
      <div className="space-y-6">
        <PageHeader title={t.settings.title} description={nf.settingsSubtitle} titleRef={titleRef} />
        <SettingsOverview />
      </div>
    );
  }

  const section = tab as SettingsTab;
  const label = settingsTabLabel(t, section);
  const description =
    [SETTING_LINKS.find((l) => l.id === section)?.description(t), SECTION_HELP[section]?.(t)].filter(Boolean).join('\n') || undefined;
  const groups = SETTING_GROUPS.map((group) => ({ group, links: SETTING_LINKS.filter((l) => l.group === group && l.allowed(user)) })).filter(
    (g) => g.links.length > 0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={label}
        description={description}
        breadcrumbs={[{ label: t.settings.title, href: '/admin/settings' }, { label }]}
        documentTitle={`${label} · ${t.settings.title}`}
        titleRef={titleRef}
      />

      {/* Below md: one select with the same grouped list. */}
      <div className="max-w-sm space-y-2 md:hidden">
        <Label htmlFor={SECTION_SELECT_ID}>{nf.section}</Label>
        {/* Links are guarded by the app shell; the select asks the same "Discard changes?" itself. */}
        <Select value={section} onValueChange={(value) => leaveGuard(() => setTab(value), document.getElementById(SECTION_SELECT_ID))}>
          <SelectTrigger id={SECTION_SELECT_ID} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OVERVIEW}>{nf.allSettings}</SelectItem>
            {groups.map(({ group, links }) => (
              <Fragment key={group}>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{nf.settingGroups[group]}</SelectLabel>
                  {links.map((link) => (
                    <SelectItem key={link.id} value={link.id}>
                      {link.label(t)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </Fragment>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:items-start md:gap-6">
        {/* From md: every setting on the start side, grouped like the overview. */}
        <nav aria-label={t.settings.title} className="hidden md:sticky md:top-20 md:block md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto md:pb-2">
          <Link
            href="/admin/settings"
            className="text-muted-foreground hover:text-foreground flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-medium transition-colors hover:bg-tint/[0.04]"
          >
            <LayoutGrid className="size-4 shrink-0" aria-hidden />
            {nf.allSettings}
          </Link>
          {groups.map(({ group, links }) => (
            <div key={group} className="mt-3">
              <p id={`settings-nav-${group}`} className="text-muted-foreground px-3 pb-1 text-xs font-semibold">
                {nf.settingGroups[group]}
              </p>
              <ul aria-labelledby={`settings-nav-${group}`} className="flex flex-col gap-0.5">
                {links.map((link) => {
                  const active = link.id === section;
                  const Icon = link.icon;
                  return (
                    <li key={link.id}>
                      <Link
                        href={settingsHref(link.id)}
                        replace
                        data-nav-replace
                        scroll={false}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors',
                          active ? 'bg-tint/[0.07] font-semibold text-tint' : 'text-sidebar-foreground font-medium hover:bg-tint/[0.04] hover:text-tint',
                        )}
                      >
                        {active && <span className="bg-brand-gradient absolute inset-y-2 start-0 w-[3px] rounded-full" aria-hidden />}
                        <Icon className={cn('size-4 shrink-0', active ? 'text-tint' : 'text-muted-foreground')} aria-hidden />
                        <span className="min-w-0">{link.label(t)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-w-0">{CONTENT[section]()}</div>
      </div>
    </div>
  );
}

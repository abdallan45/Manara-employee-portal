'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Circle, Loader2, Lock, Menu, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES, type SessionUser, type SettingDto } from '@workforce/shared';

import { HelpTip } from '@/components/help-tip';
import { ErrorState, LoadingRows } from '@/components/states';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { NAV_ITEMS, mobileNavFor, navGroupLabel, visibleNav } from '@/lib/nav';
import {
  DEFAULT_PORTAL_VISIBILITY,
  PORTAL_KEYS,
  PORTAL_PAGES,
  isPortalVisible,
  normalizePortalVisibility,
  portalLabel,
  type PortalKey,
  type PortalPage,
  type PortalSectionKey,
} from '@/lib/portal';
import { useApi } from '@/lib/use-api';
import { useDirtyGuard } from '@/lib/use-dirty-guard';
import { cn } from '@/lib/utils';

type Draft = Record<PortalKey, boolean>;
type CheckedState = boolean | 'indeterminate';

const SETTING_KEY = 'portal.visibility';

/** Same icons as the navigation; a neutral dot if a page is not in the menu. */
function iconFor(path: string): LucideIcon {
  return NAV_ITEMS.find((item) => item.href === path)?.icon ?? Circle;
}

const sameDraft = (a: Draft, b: Draft) => PORTAL_KEYS.every((k) => a[k] === b[k]);

/** Items that employees see now and would no longer see; sections of a newly hidden page are implied. */
function newlyHidden(saved: Draft, draft: Draft): PortalKey[] {
  const out: PortalKey[] = [];
  for (const page of PORTAL_PAGES) {
    if (isPortalVisible(saved, page.key) && !isPortalVisible(draft, page.key)) {
      out.push(page.key);
      continue;
    }
    for (const section of page.sections) {
      if (isPortalVisible(saved, section) && !isPortalVisible(draft, section)) out.push(section);
    }
  }
  return out;
}

/** Settings -> Employee pages (?tab=portal): which "My work" pages and sections employees see. */
export function PortalTab() {
  const { t, errorMessage } = useI18n();
  const { refreshUser } = useAuth();
  const s = t.portalVisibility;
  const settings = useApi<SettingDto[]>('/settings');
  // null = no edits yet (the draft equals what is saved).
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<PortalKey[] | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const saved: Draft | null = settings.data ? normalizePortalVisibility(settings.data.find((x) => x.key === SETTING_KEY)?.value) : null;
  const draft = edits ?? saved;
  const changed = saved && draft ? PORTAL_KEYS.filter((k) => draft[k] !== saved[k]).length : 0;
  const dirty = changed > 0;
  useDirtyGuard(dirty);

  // Reset and Save disable themselves while focused (Reset: the draft is now the defaults; Save: while
  // saving). After that render, put focus back on Save (or the tree when the bar is gone) if it was lost.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || saving) return;
    refocus.current = false;
    const el = document.activeElement;
    const lost = !el || el === document.body || (el instanceof HTMLButtonElement && el.disabled);
    if (lost) (saveRef.current ?? treeRef.current)?.focus();
  });

  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;

  const update = (patch: Partial<Draft>) => {
    setError(undefined);
    setEdits((prev) => ({ ...(prev ?? saved ?? DEFAULT_PORTAL_VISIBILITY), ...patch }));
  };

  const setPage = (page: PortalPage, checked: CheckedState) => {
    if (checked === true) {
      // Checking the page turns all of its sections on.
      update({ [page.key]: true, ...Object.fromEntries(page.sections.map((sec) => [sec, true])) });
    } else {
      // Unchecking keeps the section choices; they only become unavailable.
      update({ [page.key]: false });
    }
  };

  /** Saves the draft. Focus moves to the tree when the bar disappears (the dialog handles its own focus). */
  const persist = async (value: Draft, fromDialog = false): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const res = await api<SettingDto>(`/settings/${encodeURIComponent(SETTING_KEY)}`, { method: 'PATCH', body: { value } });
      const list = settings.data ?? [];
      settings.setData(list.some((x) => x.key === SETTING_KEY) ? list.map((x) => (x.key === SETTING_KEY ? res : x)) : [...list, res]);
      setEdits(null);
      toast.success(s.savedToast);
      if (!fromDialog) treeRef.current?.focus();
      void refreshUser();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      // The bar stays; its Save button was disabled during the request (the dialog restores its own focus).
      if (!fromDialog) refocus.current = true;
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    if (!saved || !draft) return;
    const hidden = newlyHidden(saved, draft);
    if (hidden.length > 0) setConfirm(hidden);
    else void persist(draft);
  };

  const onDiscard = () => {
    setEdits(null);
    setError(undefined);
    treeRef.current?.focus();
  };

  const isDefault = draft ? sameDraft(draft, { ...DEFAULT_PORTAL_VISIBILITY }) : true;

  return (
    <div className="space-y-6">
      {draft && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              refocus.current = true;
              update({ ...DEFAULT_PORTAL_VISIBILITY });
            }}
            disabled={isDefault || saving}
          >
            <RotateCcw aria-hidden />
            {s.resetDefaults}
          </Button>
        </div>
      )}

      {!draft ? (
        <LoadingRows rows={6} />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div ref={treeRef} tabIndex={-1} className="grid gap-4 outline-none">
            {PORTAL_PAGES.map((page) => (
              <PageCard
                key={page.key}
                page={page}
                draft={draft}
                onPage={(c) => setPage(page, c)}
                onSection={(sec, on) => update({ [sec]: on })}
              />
            ))}
          </div>
          <PortalPreview draft={draft} />
        </div>
      )}

      {/* Announced once when the first change is made; the bar itself is not a live region. */}
      <span className="sr-only" aria-live="polite">
        {dirty ? s.unsavedRegion : ''}
      </span>
      {dirty && (
        <div
          role="region"
          aria-label={s.unsavedRegion}
          className="bg-popover/95 sticky bottom-20 z-20 mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-tint/15 px-4 py-3 shadow-2xl backdrop-blur md:bottom-4 print:hidden"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{changed === 1 ? s.unsavedOne : fmt(s.unsavedMany, { n: changed })}</p>
            {error && (
              <p role="alert" className="text-xs text-[color:var(--status-absent)]">
                {error}
              </p>
            )}
          </div>
          <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving} className="min-h-10">
            {s.discard}
          </Button>
          <Button ref={saveRef} type="button" onClick={onSave} disabled={saving} className="min-h-10">
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            {s.saveChanges}
          </Button>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !saving && !open && setConfirm(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Back to Save when the bar is still there (kept editing or the save failed), else to the tree.
            e.preventDefault();
            (saveRef.current ?? treeRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.length === 1 ? s.confirmTitleOne : fmt(s.confirmTitleMany, { n: confirm?.length ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>{s.confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm && confirm.length > 0 && (
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {confirm.map((key) => (
                <li key={key}>
                  <HiddenItemName itemKey={key} />
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            {/* Radix focuses Cancel first, so "Keep editing" is the default. */}
            <AlertDialogCancel disabled={saving}>{s.keepEditing}</AlertDialogCancel>
            <Button
              type="button"
              disabled={saving}
              onClick={async () => {
                if (!draft) return;
                await persist(draft, true);
                setConfirm(null);
              }}
            >
              {saving && <Loader2 className="animate-spin" aria-hidden />}
              {s.hideAndSave}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HiddenItemName({ itemKey }: { itemKey: PortalKey }) {
  const { t } = useI18n();
  const page = PORTAL_PAGES.find((p) => p.key === itemKey || (p.sections as readonly string[]).includes(itemKey));
  if (!page || page.key === itemKey) return <bdi>{portalLabel(t, itemKey)}</bdi>;
  return (
    <>
      <bdi>{portalLabel(t, itemKey)}</bdi> <span className="text-muted-foreground">(<bdi>{portalLabel(t, page.key)}</bdi>)</span>
    </>
  );
}

function PageCard({ page, draft, onPage, onSection }: {
  page: PortalPage;
  draft: Draft;
  onPage: (checked: CheckedState) => void;
  onSection: (section: PortalSectionKey, on: boolean) => void;
}) {
  const { t } = useI18n();
  const s = t.portalVisibility;
  const label = portalLabel(t, page.key);
  const Icon = iconFor(page.path);
  const base = `pv-${page.key}`;
  const pageOn = isPortalVisible(draft, page.key);
  const sections: readonly PortalSectionKey[] = page.sections;
  const partial = sections.some((sec) => !draft[sec]);
  const parent: CheckedState = !pageOn ? false : partial ? 'indeterminate' : true;
  const lockedNote = page.locked ? (page.key === 'notifications' ? s.lockedNotifications : s.lockedAttendance) : undefined;
  const hasChildren = sections.length > 0 || page.key === 'leave';
  const hintId = `${base}-hint`;

  return (
    <Card role="group" aria-labelledby={`${base}-title`} className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>
          <h2 id={`${base}-title`} className="flex items-center gap-2 text-base font-semibold">
            <Icon className="text-muted-foreground size-[18px] shrink-0" aria-hidden />
            {label}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 px-2">
        <TreeRow
          id={base}
          checked={parent}
          disabled={page.locked}
          onCheckedChange={onPage}
          label={fmt(s.showPage, { page: label })}
          description={s.pageDescriptions[page.key]}
          note={lockedNote}
        />
        {hasChildren && (
          <div className="space-y-1 ps-8">
            {!pageOn && (
              <p id={hintId} className="text-muted-foreground px-3 pt-1 text-xs">
                {s.sectionsDisabledHint}
              </p>
            )}
            {page.key === 'leave' && (
              <TreeRow
                id={`${base}-balances`}
                checked
                disabled
                label={s.leaveBalancesAlways}
                description={fmt(s.leaveBalancesHelp, { leave: t.nav.myLeave, home: t.nav.home })}
              />
            )}
            {sections.map((sec) => (
              <TreeRow
                key={sec}
                id={`pv-${sec.replace('.', '-')}`}
                checked={draft[sec]}
                disabled={!pageOn}
                describedBy={!pageOn ? hintId : undefined}
                onCheckedChange={(c) => onSection(sec, c === true)}
                label={s.sections[sec]}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One checkbox row; the whole row is the click target. */
function TreeRow({ id, checked, disabled, onCheckedChange, label, description, note, describedBy }: {
  id: string;
  checked: CheckedState;
  disabled?: boolean;
  onCheckedChange?: (checked: CheckedState) => void;
  label: string;
  description?: string;
  note?: string;
  describedBy?: string;
}) {
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  const noteId = note ? `${id}-note` : undefined;
  const ariaDescribedBy = [descId, noteId, describedBy].filter(Boolean).join(' ') || undefined;
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-h-10 items-start gap-3 rounded-xl px-3 py-2.5 transition-colors',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-tint/[0.04]',
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        aria-describedby={ariaDescribedBy}
        className="mt-0.5"
      />
      <span className="flex min-w-0 items-start gap-1">
        <span id={labelId} className={cn('text-sm leading-snug font-medium', disabled && !note && checked !== true && 'text-muted-foreground')}>
          {label}
        </span>
        {note && <Lock className="text-muted-foreground mt-1 size-3 shrink-0" aria-hidden />}
        {(description || note) && <HelpTip text={[description, note].filter(Boolean).join('\n')} className="-mt-0.5" />}
        {description && (
          <span id={descId} className="sr-only">
            {description}
          </span>
        )}
        {note && (
          <span id={noteId} className="sr-only">
            {note}
          </span>
        )}
      </span>
    </label>
  );
}

/** Stand-in profile so the preview also works for an admin account without an employee record. */
const PREVIEW_EMPLOYEE: NonNullable<SessionUser['employee']> = {
  id: 'preview',
  employeeCode: '',
  fullName: '',
  fullNameAr: null,
  departmentName: null,
  departmentNameAr: null,
};

/** A plain employee (default Employee role) seeing the draft, for the real navigation helpers. */
function previewUser(user: SessionUser, draft: Draft): SessionUser {
  return {
    ...user,
    roles: [SYSTEM_ROLES.EMPLOYEE],
    permissions: [...DEFAULT_ROLE_PERMISSIONS.EMPLOYEE],
    employee: user.employee ?? PREVIEW_EMPLOYEE,
    portal: draft,
  };
}

/**
 * Mock sidebar and phone bar built from the draft with the same helpers as the app shell
 * (visibleNav / mobileNavFor), so it matches what an employee sees; updates on every change.
 */
function PortalPreview({ draft }: { draft: Draft }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const s = t.portalVisibility;
  const mock = useMemo(() => previewUser(user, draft), [user, draft]);
  const sidebar = visibleNav(mock).filter((item) => item.group === 'me' && item.inSidebar !== false);
  const bottom = mobileNavFor(mock);

  return (
    <Card className="gap-4 py-4 lg:sticky lg:top-20">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-1">
          <h2 className="text-base font-semibold" aria-describedby="portal-preview-caption">
            {s.previewTitle}
          </h2>
          <HelpTip text={s.previewCaption} />
        </CardTitle>
        <p id="portal-preview-caption" className="sr-only">
          {s.previewCaption}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium">{s.previewSidebar}</h3>
          <div className="bg-sidebar/80 border-sidebar-border rounded-xl border p-2">
            <p className="text-brand-subtle px-2 pb-1 text-xs font-semibold tracking-wider uppercase">{navGroupLabel(t, 'me')}</p>
            <ul className="space-y-0.5">
              {sidebar.map((item) => {
                const Icon = item.icon;
                const page = PORTAL_PAGES.find((p) => p.key === item.portalKey);
                const sections: readonly PortalSectionKey[] = page?.sections ?? [];
                const hidden = sections.filter((sec) => !isPortalVisible(draft, sec));
                return (
                  <li key={item.href} className="text-sidebar-foreground flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm">
                    <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{item.label(t)}</span>
                      {hidden.length > 0 && (
                        <span className="text-muted-foreground text-xs">
                          {fmt(s.previewHidden, { list: hidden.map((sec) => portalLabel(t, sec)).join(s.listSeparator) })}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium">{s.previewBottomBar}</h3>
          <ul
            className="bg-background/85 grid overflow-hidden rounded-xl border border-tint/[0.08]"
            style={{ gridTemplateColumns: `repeat(${bottom.length + 1}, minmax(0, 1fr))` }}
          >
            {bottom.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href} className="text-muted-foreground flex h-14 flex-col items-center justify-center gap-1 px-1 text-xs">
                  <Icon className="size-4" aria-hidden />
                  <span className="max-w-full truncate">{(item.shortLabel ?? item.label)(t)}</span>
                </li>
              );
            })}
            <li className="text-muted-foreground flex h-14 flex-col items-center justify-center gap-1 px-1 text-xs">
              <Menu className="size-4" aria-hidden />
              <span className="max-w-full truncate">{t.nav.more}</span>
            </li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

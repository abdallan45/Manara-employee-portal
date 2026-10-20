'use client';

import { useState, type ComponentProps, type FormEvent } from 'react';
import { ExternalLink, Loader2, LocateFixed, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  OFFICE_RADIUS_RANGE, PERMISSIONS, SETTING_DEFAULTS, SETTING_RANGES,
  type AttendanceStatusDto, type OfficeLocationDto, type RangedSettingKey, type SettingDto,
} from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table';
import { CheckRow, FormField } from '@/components/form-field';
import { HelpTip } from '@/components/help-tip';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, api, apiDelete, fieldErrorsFrom } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatWorkDate, parseLocaleNumber, todayInAmman } from '@/lib/format';
import {
  formatCoordinates, formatDistance, getDeviceLocation, isValidLatitude, isValidLongitude, mapsUrl, parseCoordinatePair,
} from '@/lib/geolocation';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';
import { useApi } from '@/lib/use-api';
import { useDirtyGuard } from '@/lib/use-dirty-guard';
import { cn } from '@/lib/utils';

const ENFORCEMENT_KEY = 'attendance.locationEnforcement';
const MAX_OPEN_KEY = 'attendance.maxOpenSessionHours';
const ACCURACY_KEY = 'attendance.maxLocationAccuracyMeters';
const DEFAULT_RADIUS = 150;
type Mode = 'ENFORCE' | 'FLAG';

const isNeverChanged = (s: SettingDto | undefined) => !s || new Date(s.updatedAt).getTime() === 0;

/** An office counts for the location rule only when it is active and has coordinates. */
const isGeofence = (o: OfficeLocationDto) => o.isActive && o.latitude !== null && o.longitude !== null;

function MapLink({ latitude, longitude, label, className }: { latitude: number; longitude: number; label: string; className?: string }) {
  return (
    <a
      href={mapsUrl(latitude, longitude)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-link inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline', className)}
    >
      {label}
      <ExternalLink className="size-3 rtl:-scale-x-100" aria-hidden />
    </a>
  );
}

export function OfficesTab() {
  const { t, locale, errorMessage } = useI18n();
  const { user, can } = useAuth();
  const w = t.adminWorkflows.offices;
  const canSettings = can(PERMISSIONS.SETTINGS_MANAGE);
  const list = useApi<OfficeLocationDto[]>('/offices');
  const settings = useApi<SettingDto[]>(canSettings ? '/settings' : null);
  // Without settings access the mode is read (not changed) from this user's own attendance status.
  const ownStatus = useApi<AttendanceStatusDto>(!canSettings && user.employee && can(PERMISSIONS.ATTENDANCE_SELF) ? '/attendance/me/status' : null);
  const [editing, setEditing] = useState<OfficeLocationDto | 'new' | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [deleting, setDeleting] = useState<OfficeLocationDto | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<'delete' | 'deactivate' | null>(null);
  const [deleteInUse, setDeleteInUse] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<OfficeLocationDto | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const byKey = new Map((settings.data ?? []).map((s) => [s.key, s]));
  const stored = byKey.get(ENFORCEMENT_KEY)?.value;
  const mode: Mode | undefined =
    stored === 'ENFORCE' || stored === 'FLAG' ? stored : canSettings && settings.data ? SETTING_DEFAULTS[ENFORCEMENT_KEY] : ownStatus.data?.location.enforcement;
  const activeCount = (list.data ?? []).filter(isGeofence).length;
  // Until the list has loaded (or when it failed) the count is unknown, not 0: Block stays unavailable.
  const listKnown = list.data !== undefined;
  const blockDisabled = !listKnown || activeCount === 0;
  const blockReason = listKnown ? (activeCount === 0 ? w.blockDisabled : null) : list.error ? w.blockUnknown : null;
  const meters = (m: number) => formatDistance(m, locale);

  const onSettingSaved = (s: SettingDto) => {
    const rest = (settings.data ?? []).filter((x) => x.key !== s.key);
    settings.setData([...rest, s]);
  };

  const saveMode = async (next: Mode) => {
    setModeSaving(true);
    setModeError(null);
    try {
      const s = await api<SettingDto>(`/settings/${encodeURIComponent(ENFORCEMENT_KEY)}`, { method: 'PATCH', body: { value: next } });
      onSettingSaved(s);
      toast.success(next === 'ENFORCE' ? w.savedBlock : w.savedFlag);
      return true;
    } catch (err) {
      setModeError(errorMessage(err));
      return false;
    } finally {
      setModeSaving(false);
    }
  };

  const closeDelete = () => {
    setDeleting(null);
    setDeleteInUse(false);
  };

  const remove = async (office: OfficeLocationDto) => {
    setDeleteBusy('delete');
    setDeleteInUse(false);
    try {
      await apiDelete<void>(`/offices/${encodeURIComponent(office.id)}`);
      toast.success(t.common.deletedToast);
      closeDelete();
      void list.refetch();
    } catch (err) {
      // In use (employees, holidays or past check-ins point at it): offer Deactivate in the same dialog.
      if (err instanceof ApiError && err.code === 'CONFLICT') setDeleteInUse(true);
      else toast.error(errorMessage(err));
    } finally {
      setDeleteBusy(null);
    }
  };

  const setActive = async (office: OfficeLocationDto, isActive: boolean): Promise<boolean> => {
    try {
      await api<OfficeLocationDto>(`/offices/${encodeURIComponent(office.id)}`, { method: 'PATCH', body: { isActive } });
      toast.success(isActive ? t.common.savedToast : w.deactivatedToast);
      void list.refetch();
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? w.activeNeedsCoordinates : errorMessage(err));
      return false;
    }
  };

  const deactivate = async (office: OfficeLocationDto) => {
    setDeleteBusy('deactivate');
    if (await setActive(office, false)) closeDelete();
    setDeleteBusy(null);
  };

  const toggle = async (office: OfficeLocationDto, next: boolean) => {
    // Turning off the last office under Block mode would stop everyone checking in: confirm first.
    if (!next && isGeofence(office) && activeCount === 1 && mode === 'ENFORCE') {
      setConfirmOff(office);
      return;
    }
    setToggling(office.id);
    await setActive(office, next);
    setToggling(null);
  };

  const activeSwitch = (r: OfficeLocationDto) => (
    <span className="inline-flex items-center">
      <Switch
        checked={r.isActive}
        disabled={toggling === r.id || (!r.isActive && (r.latitude === null || r.longitude === null))}
        onCheckedChange={(v) => void toggle(r, v)}
        aria-label={`${w.active}: ${r.name}`}
      />
    </span>
  );

  const coordinates = (r: OfficeLocationDto) =>
    r.latitude !== null && r.longitude !== null ? (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <code className="tabular rounded-md bg-tint/[0.05] px-1.5 py-0.5 text-xs" dir="ltr">
          {formatCoordinates(r.latitude, r.longitude)}
        </code>
        <MapLink latitude={r.latitude} longitude={r.longitude} label={t.events.map} />
      </span>
    ) : (
      <span className="text-xs text-[color:var(--status-missing)]">{w.noCoordinates}</span>
    );

  const columns: Column<OfficeLocationDto>[] = [
    {
      id: 'name',
      header: w.name,
      cell: (r) => (
        <span className="grid">
          <span className="font-medium">
            <bdi>{r.name}</bdi>
          </span>
          {r.address && (
            <span className="text-muted-foreground text-xs">
              <bdi>{r.address}</bdi>
            </span>
          )}
        </span>
      ),
    },
    { id: 'coords', header: w.coordinates, cell: coordinates },
    { id: 'radius', header: w.radius, cell: (r) => <span className="tabular">{meters(r.radiusMeters)}</span> },
    { id: 'active', header: t.common.status, cell: activeSwitch },
    { id: 'created', header: w.createdAt, cell: (r) => <span className="text-muted-foreground tabular">{formatDateTime(r.createdAt, locale)}</span> },
    {
      id: 'actions',
      header: t.common.actions,
      srOnlyHeader: true,
      className: 'w-24 text-end',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(r)} aria-label={`${t.common.edit}: ${r.name}`}>
            <Pencil aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(r)} aria-label={`${t.common.delete}: ${r.name}`}>
            <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  const deleteWarnings: string[] = [];
  if (deleting && isGeofence(deleting) && activeCount === 1) deleteWarnings.push(mode === 'ENFORCE' ? `${w.deleteLast} ${w.deleteLastBlocking}` : w.deleteLast);

  const modeOptions: { value: Mode; label: string; hint: string }[] = [
    { value: 'ENFORCE', label: w.modeBlock, hint: w.modeBlockHint },
    { value: 'FLAG', label: w.modeFlag, hint: w.modeFlagHint },
  ];

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent>
          <fieldset className="grid gap-3" aria-describedby={!canSettings ? 'mode-readonly' : undefined}>
            <legend className="mb-3 flex items-center gap-2 text-sm font-semibold">
              {w.modeTitle}
              {modeSaving && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />}
            </legend>
            <div className="grid gap-3 md:grid-cols-2">
              {modeOptions.map((opt) => {
                const checked = mode === opt.value;
                const disabled = !canSettings || modeSaving || (opt.value === 'ENFORCE' && blockDisabled && !checked);
                const hintId = `mode-${opt.value}-hint`;
                const reasonId = `mode-${opt.value}-reason`;
                const showReason = opt.value === 'ENFORCE' && blockReason !== null;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors',
                      checked ? 'border-[color:var(--brand-soft)]/60 bg-tint/[0.06]' : 'border-tint/[0.1] bg-tint/[0.02] hover:bg-tint/[0.04]',
                      disabled && !checked && 'cursor-not-allowed opacity-70 hover:bg-tint/[0.02]',
                    )}
                  >
                    <input
                      type="radio"
                      name="location-enforcement"
                      value={opt.value}
                      checked={checked}
                      disabled={disabled}
                      onChange={() => {
                        if (opt.value === 'ENFORCE') setConfirmBlock(true);
                        else void saveMode('FLAG');
                      }}
                      aria-describedby={showReason ? `${hintId} ${reasonId}` : hintId}
                      className="mt-0.5 size-5 shrink-0 accent-[color:var(--brand-soft)]"
                    />
                    <span className="grid gap-1">
                      <span className="flex items-center gap-1">
                        <span className="text-sm font-medium">{opt.label}</span>
                        <HelpTip text={opt.hint} />
                      </span>
                      <span id={hintId} className="sr-only">
                        {opt.hint}
                      </span>
                      {showReason && (
                        <span id={reasonId} className="flex items-start gap-1.5 text-xs text-[color:var(--status-missing)]">
                          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                          {blockReason}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            {!canSettings && (
              <p id="mode-readonly" className="text-muted-foreground text-xs">
                {w.readOnly}
              </p>
            )}
            {modeError && (
              <p role="alert" className="text-sm text-[color:var(--status-absent)]">
                {modeError}
              </p>
            )}
          </fieldset>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{listKnown && fmt(w.activeCount, { n: activeCount })}</p>
        <Button onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {w.add}
        </Button>
      </div>

      <Card className="gap-0 py-0">
        <DataTable
          rows={list.data}
          columns={columns}
          rowKey={(r) => r.id}
          loading={list.loading || list.refreshing}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle={w.empty}
          mobileCard={(r) => (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate font-medium">
                  <bdi>{r.name}</bdi>
                </p>
                {activeSwitch(r)}
              </div>
              {coordinates(r)}
              <p className="text-muted-foreground text-xs">
                {w.radius}: <span className="tabular">{meters(r.radiusMeters)}</span>
              </p>
            </div>
          )}
          mobileActions={(r) => (
            <>
              <Button variant="ghost" size="icon" onClick={() => setEditing(r)} aria-label={`${t.common.edit}: ${r.name}`}>
                <Pencil aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setDeleting(r)} aria-label={`${t.common.delete}: ${r.name}`}>
                <Trash2 className="text-[color:var(--status-absent)]" aria-hidden />
              </Button>
            </>
          )}
        />
      </Card>

      {canSettings && settings.data && (
        <>
          <NumberSetting
            key={`acc-${byKey.get(ACCURACY_KEY)?.updatedAt ?? 'default'}`}
            settingKey={ACCURACY_KEY}
            inputId="set-max-accuracy"
            title={w.maxAccuracy}
            hint={w.maxAccuracyHint}
            unit={w.meters}
            setting={byKey.get(ACCURACY_KEY)}
            onSaved={onSettingSaved}
          />
          <NumberSetting
            key={`open-${byKey.get(MAX_OPEN_KEY)?.updatedAt ?? 'default'}`}
            settingKey={MAX_OPEN_KEY}
            inputId="set-max-open"
            title={w.maxOpen}
            hint={w.maxOpenHint}
            unit={t.adminWorkflows.units.hours}
            setting={byKey.get(MAX_OPEN_KEY)}
            onSaved={onSettingSaved}
          />
        </>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setFormDirty(false);
          }
        }}
      >
        <DialogContent dirty={formDirty}>
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? w.createTitle : w.editTitle}</DialogTitle>
            {/* The same text is the Latitude field's "?" hint; kept here for screen readers only. */}
            <DialogDescription className="sr-only">{w.coordinatesHint}</DialogDescription>
          </DialogHeader>
          {editing !== null && (
            <OfficeForm
              key={editing === 'new' ? 'new' : editing.id}
              existing={editing === 'new' ? null : editing}
              activeCount={activeCount}
              mode={mode}
              onDirtyChange={setFormDirty}
              onCancel={() => {
                setEditing(null);
                setFormDirty(false);
              }}
              onSaved={() => {
                setEditing(null);
                setFormDirty(false);
                void list.refetch();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && deleteBusy === null && closeDelete()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleting ? fmt(w.deleteTitle, { name: deleting.name }) : ''}</AlertDialogTitle>
            <AlertDialogDescription>{w.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          {(deleteWarnings.length > 0 || deleteInUse) && (
            <ul role={deleteInUse ? 'alert' : undefined} className="space-y-1.5 rounded-xl border border-[color:var(--status-absent)]/40 bg-[color:var(--status-absent)]/10 p-3 text-sm">
              {[...(deleteInUse ? [w.deleteInUse] : []), ...deleteWarnings].map((text) => (
                <li key={text} className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                  {text}
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter className="sm:flex-wrap">
            {/* The safe choice keeps initial focus. */}
            <AlertDialogCancel disabled={deleteBusy !== null}>{w.keepOffice}</AlertDialogCancel>
            {deleting?.isActive && (
              <Button variant="outline" onClick={() => deleting && void deactivate(deleting)} disabled={deleteBusy !== null}>
                {deleteBusy === 'deactivate' && <Loader2 className="animate-spin" aria-hidden />}
                {w.deactivateInstead}
              </Button>
            )}
            {!deleteInUse && (
              <Button variant="destructive" onClick={() => deleting && void remove(deleting)} disabled={deleteBusy !== null}>
                {deleteBusy === 'delete' && <Loader2 className="animate-spin" aria-hidden />}
                {w.deleteOffice}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDialog
        open={confirmOff !== null}
        onOpenChange={(o) => !o && setConfirmOff(null)}
        destructive
        title={w.deactivateLastTitle}
        description={w.deleteLastBlocking}
        confirmLabel={w.deactivateOffice}
        cancelLabel={w.keepActive}
        onConfirm={async () => {
          if (confirmOff) await setActive(confirmOff, false);
          return true;
        }}
      />

      <ConfirmDialog
        open={confirmBlock}
        onOpenChange={setConfirmBlock}
        title={w.confirmBlockTitle}
        description={`${fmt(w.activeCount, { n: activeCount })} · ${w.confirmBlockBody}`}
        confirmLabel={w.turnOnBlocking}
        cancelLabel={w.keepFlagOnly}
        onConfirm={async () => {
          // The list may have changed (or failed to reload) while the dialog was open: never block with no office.
          if (!listKnown || activeCount === 0) return true;
          // Close either way: a failure is reported next to the options, not behind the dialog.
          await saveMode('ENFORCE');
          return true;
        }}
      />
    </div>
  );
}

/** Text input with its unit inside the field (end side); digits in any script are parsed with parseLocaleNumber. */
function UnitInput({ unit, wrapperClassName, className, ...props }: ComponentProps<typeof Input> & { unit: string; wrapperClassName?: string }) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input type="text" autoComplete="off" className={cn('tabular pe-12', className)} {...props} />
      <span aria-hidden className="text-muted-foreground pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm">
        {unit}
      </span>
    </div>
  );
}

/** One whole-number setting with its allowed range: explicit save with an inline unsaved-changes row. */
function NumberSetting({ settingKey, inputId, title, hint, unit, setting, onSaved }: {
  settingKey: typeof MAX_OPEN_KEY | typeof ACCURACY_KEY;
  inputId: string;
  title: string;
  hint: string;
  unit: string;
  setting: SettingDto | undefined;
  onSaved: (s: SettingDto) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const w = t.adminWorkflows;
  const { min, max } = SETTING_RANGES[settingKey satisfies RangedSettingKey];
  const fallback: number = SETTING_DEFAULTS[settingKey];
  const loaded = typeof setting?.value === 'number' ? setting.value : fallback;
  const [value, setValue] = useState(String(loaded));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const parsed = parseLocaleNumber(value);
  const dirty = parsed !== loaded;
  useDirtyGuard(dirty);

  const validate = (): number | null => {
    if (parsed === null || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(fmt(w.wholeNumberRange, { min, max }));
      return null;
    }
    setError(undefined);
    return parsed;
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = validate();
    if (n === null) {
      document.getElementById(inputId)?.focus();
      return;
    }
    setSaving(true);
    try {
      const s = await api<SettingDto>(`/settings/${encodeURIComponent(settingKey)}`, { method: 'PATCH', body: { value: n } });
      onSaved(s);
      toast.success(t.common.savedToast);
    } catch (err) {
      // Never show the server's English text: a validation failure gets the localized range message.
      setError(err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? fmt(w.wholeNumberRange, { min, max }) : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-1.5 text-base">
          {title}
          <HelpTip text={hint} />
          {isNeverChanged(setting) && <Badge variant="outline">{w.defaultBadge}</Badge>}
        </CardTitle>
        <p id={`${inputId}-desc`} className="sr-only">
          {hint}
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} noValidate className="grid gap-3">
          <FormField id={inputId} label={title} hint={fmt(w.rangeHint, { min, max, default: fallback })} error={error}>
            {({ id, describedBy, invalid }) => (
              <UnitInput
                id={id}
                unit={unit}
                inputMode="numeric"
                wrapperClassName="w-36"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => value.trim() && validate()}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          {!isNeverChanged(setting) && setting && (
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {/* updatedAt is UTC; the date shown is the Amman calendar day. */}
              <span>{fmt(w.changedOn, { date: formatWorkDate(todayInAmman(Date.parse(setting.updatedAt)), locale) })}</span>
              {loaded !== fallback && (
                <Button type="button" variant="link" size="sm" className="h-6 px-0 text-xs" onClick={() => setValue(String(fallback))}>
                  {w.resetToDefault}
                </Button>
              )}
            </p>
          )}
          {dirty && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-tint/15 bg-tint/[0.04] px-3 py-2" role="region" aria-label={w.unsavedChanges}>
              <span className="text-sm font-medium">{w.unsavedChanges}</span>
              <div className="ms-auto flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setValue(String(loaded));
                    setError(undefined);
                  }}
                  disabled={saving}
                >
                  {w.discard}
                </Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving && <Loader2 className="animate-spin" aria-hidden />}
                  {w.saveChanges}
                </Button>
              </div>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function OfficeForm({ existing, activeCount, mode, onCancel, onSaved, onDirtyChange }: {
  existing: OfficeLocationDto | null;
  /** Active offices with coordinates now, for the same warning as the delete dialog when Active is unticked. */
  activeCount: number;
  mode: Mode | undefined;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, locale, errorMessage } = useI18n();
  const w = t.adminWorkflows.offices;
  const geo = t.employeeSelfService.home;
  const { min: rMin, max: rMax } = OFFICE_RADIUS_RANGE;
  const initial = {
    name: existing?.name ?? '',
    address: existing?.address ?? '',
    latitude: existing?.latitude != null ? String(existing.latitude) : '',
    longitude: existing?.longitude != null ? String(existing.longitude) : '',
    radius: String(existing?.radiusMeters ?? DEFAULT_RADIUS),
    isActive: existing?.isActive ?? true,
  };
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  /** Polite announcement under the coordinates: device position used, a pasted pair split, or why no position. */
  const [coordNote, setCoordNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirmLockout, setConfirmLockout] = useState(false);

  const lat = parseLocaleNumber(f.latitude);
  const lng = parseLocaleNumber(f.longitude);
  const coordsValid = isValidLatitude(lat) && isValidLongitude(lng);
  const noCoords = !f.latitude.trim() && !f.longitude.trim();

  // Unticking Active does what "Deactivate instead" does in the delete dialog: same warning, and under
  // Block mode the last active office needs a confirmation, because nobody could check in afterwards.
  const deactivating = existing !== null && isGeofence(existing) && !f.isActive;
  const lastActive = deactivating && activeCount === 1;
  const warnings = lastActive ? [mode === 'ENFORCE' ? `${w.deleteLast} ${w.deleteLastBlocking}` : w.deleteLast] : [];
  const lockout = lastActive && mode === 'ENFORCE';

  const change = (patch: Partial<typeof initial>) => {
    const next = { ...f, ...patch };
    setF(next);
    onDirtyChange((Object.keys(initial) as (keyof typeof initial)[]).some((k) => next[k] !== initial[k]));
  };

  // "31.95, 35.91" pasted (or typed) into Latitude fills both fields.
  const onLatitude = (value: string) => {
    const pair = value.includes(',') || value.includes('،') || /\d\s+[-+]?\d/.test(value.trim()) ? parseCoordinatePair(value) : null;
    if (pair) {
      change({ latitude: String(pair.latitude), longitude: String(pair.longitude) });
      setErrors((er) => ({ ...er, latitude: '', longitude: '' }));
      setCoordNote({ text: w.pasted });
    } else change({ latitude: value });
  };

  const fillFromDevice = async () => {
    if (locating) return;
    setLocating(true);
    setCoordNote(null);
    const r = await getDeviceLocation();
    setLocating(false);
    if (r.ok) {
      change({ latitude: r.location.latitude.toFixed(6), longitude: r.location.longitude.toFixed(6) });
      setErrors((er) => ({ ...er, latitude: '', longitude: '' }));
      setCoordNote({ text: fmt(w.gotPosition, { accuracy: formatDistance(r.location.accuracy, locale) }) });
    } else {
      setCoordNote({ text: `${geo.geo[r.reason]} ${geo.geoHelp[r.reason]}`, error: true });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const radius = parseLocaleNumber(f.radius);
    const v: Record<string, string> = {};
    if (!f.name.trim()) v.name = t.employees.required;
    // Only an existing office left inactive may stay without coordinates.
    const coordsOptional = existing !== null && !f.isActive && noCoords;
    if (!coordsOptional) {
      if (!isValidLatitude(lat)) v.latitude = f.isActive && noCoords && existing ? w.activeNeedsCoordinates : w.latitudeInvalid;
      if (!isValidLongitude(lng)) v.longitude = w.longitudeInvalid;
    }
    if (radius === null || !Number.isInteger(radius) || radius < rMin || radius > rMax) v.radius = fmt(w.radiusInvalid, { min: rMin, max: rMax });
    setErrors(v);
    setFormError(null);
    const first = ['name', 'latitude', 'longitude', 'radius'].find((k) => v[k]);
    if (first) {
      document.getElementById(`office-${first}`)?.focus();
      return;
    }
    if (lockout) {
      setConfirmLockout(true);
      return;
    }
    await save();
  };

  const save = async () => {
    setSaving(true);
    const radiusMeters = parseLocaleNumber(f.radius) ?? DEFAULT_RADIUS;
    const coords = coordsValid ? { latitude: lat, longitude: lng } : {};
    const address = f.address.trim();
    try {
      if (existing) {
        const body = { name: f.name.trim(), address: address || null, radiusMeters, isActive: f.isActive, ...coords };
        await api<OfficeLocationDto>(`/offices/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body });
      } else {
        const body = { name: f.name.trim(), ...(address ? { address } : {}), radiusMeters, isActive: f.isActive, ...coords };
        await api<OfficeLocationDto>('/offices', { method: 'POST', body });
      }
      toast.success(existing ? t.common.savedToast : t.common.createdToast);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        const fe = fieldErrorsFrom(err.details);
        // Localized messages only; the API's English field text is not shown.
        setErrors({
          ...(fe.name ? { name: t.errors.VALIDATION_FAILED } : {}),
          ...(fe.latitude ? { latitude: noCoords ? w.activeNeedsCoordinates : w.latitudeInvalid } : {}),
          ...(fe.longitude ? { longitude: w.longitudeInvalid } : {}),
          ...(fe.radiusMeters ? { radius: fmt(w.radiusInvalid, { min: rMin, max: rMax }) } : {}),
        });
      }
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormField id="office-name" label={w.name} error={errors.name}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={f.name} onChange={(e) => change({ name: e.target.value })} aria-describedby={describedBy} aria-invalid={invalid} maxLength={120} dir="auto" />
        )}
      </FormField>
      <FormField id="office-address" label={w.address} hint={w.addressHint} optional>
        {({ id, describedBy }) => (
          <Input id={id} value={f.address} onChange={(e) => change({ address: e.target.value })} aria-describedby={describedBy} maxLength={300} dir="auto" />
        )}
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="office-latitude" label={w.latitude} hint={w.coordinatesHint} error={errors.latitude}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              dir="ltr"
              inputMode="decimal"
              className="tabular"
              value={f.latitude}
              onChange={(e) => onLatitude(e.target.value)}
              onBlur={() => f.latitude.trim() && setErrors((er) => ({ ...er, latitude: isValidLatitude(lat) ? '' : w.latitudeInvalid }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="31.95392"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <FormField id="office-longitude" label={w.longitude} error={errors.longitude}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              dir="ltr"
              inputMode="decimal"
              className="tabular"
              value={f.longitude}
              onChange={(e) => change({ longitude: e.target.value })}
              onBlur={() => f.longitude.trim() && setErrors((er) => ({ ...er, longitude: isValidLongitude(lng) ? '' : w.longitudeInvalid }))}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="35.91061"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
      </div>
      <div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="outline" size="sm" className="max-md:min-h-10" onClick={() => void fillFromDevice()} aria-disabled={locating || undefined}>
          {locating ? <Loader2 className="animate-spin" aria-hidden /> : <LocateFixed aria-hidden />}
          {locating ? w.locating : w.useDevice}
        </Button>
        {coordsValid && <MapLink latitude={lat} longitude={lng} label={w.openMap} />}
      </div>
      {/* Always mounted, so a filled-in position or a location error is announced when it appears. */}
      <p aria-live="polite" className={cn('-mt-2 text-xs', coordNote?.error ? 'text-[color:var(--status-absent)]' : 'text-muted-foreground', !coordNote && 'sr-only')}>
        {coordNote?.text}
      </p>

      <FormField id="office-radius" label={w.radius} hint={w.radiusHint} error={errors.radius}>
        {({ id, describedBy, invalid }) => (
          <UnitInput
            id={id}
            unit={w.meters}
            inputMode="numeric"
            wrapperClassName="w-36"
            value={f.radius}
            onChange={(e) => change({ radius: e.target.value })}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </FormField>

      <CheckRow id="office-active" checked={f.isActive} onCheckedChange={(v) => change({ isActive: v })} label={w.active} />
      {/* Always mounted, so the warning is announced when unticking Active makes it appear. */}
      <div aria-live="polite" className={cn(warnings.length === 0 && 'sr-only')}>
        {warnings.length > 0 && (
          <ul className="space-y-1.5 rounded-xl border border-[color:var(--status-absent)]/40 bg-[color:var(--status-absent)]/10 p-3 text-sm">
            {warnings.map((text) => (
              <li key={text} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color:var(--status-absent)]" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        )}
      </div>
      {formError && (
        <p role="alert" className="rounded-xl border border-[color:var(--status-absent)]/30 bg-[color:var(--status-absent)]/10 p-3 text-sm">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t.common.cancel}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {saving ? t.common.saving : existing ? t.common.save : t.common.create}
        </Button>
      </DialogFooter>
      <ConfirmDialog
        open={confirmLockout}
        onOpenChange={setConfirmLockout}
        destructive
        title={w.deactivateLastTitle}
        description={w.deleteLastBlocking}
        confirmLabel={w.deactivateOffice}
        cancelLabel={w.keepActive}
        onConfirm={async () => {
          // Close either way: a failure is shown in the form.
          await save();
          return true;
        }}
      />
    </form>
  );
}

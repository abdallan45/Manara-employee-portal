'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { BreakTypeDto, MascotConfigDto, MascotGroupDto } from '@workforce/shared';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { api, apiDelete } from '@/lib/api';
import { fmt } from '@/lib/i18n/dictionaries';
import { useI18n } from '@/lib/i18n/context';

import { patchGroup, withGroup, withoutGroup } from './mascot-helpers';

/** Shared by the list, the group page and the editor: the admin copy of the config plus local updates. */
export interface MascotStore {
  config: MascotConfigDto;
  breakTypes: BreakTypeDto[] | undefined;
  /** Applies a change locally (mutation answers, optimistic toggles) and lets the live mascot refetch. */
  update: (fn: (cfg: MascotConfigDto) => MascotConfigDto) => void;
  refetch: () => Promise<void>;
}

/** Active switch of a group (optimistic; reverts on failure). */
export function GroupActiveSwitch({ group, store }: { group: MascotGroupDto; store: MascotStore }) {
  const { t, errorMessage } = useI18n();
  const g = t.mascotAdmin.groups;
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    store.update((c) => patchGroup(c, group.id, { isActive: next }));
    try {
      const saved = await api<MascotGroupDto>(`/mascot/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: { isActive: next } });
      store.update((c) => withGroup(c, saved));
      toast.success(next ? g.activated : g.deactivated);
    } catch (err) {
      store.update((c) => patchGroup(c, group.id, { isActive: !next }));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return <Switch checked={group.isActive} disabled={busy} onCheckedChange={(v) => void toggle(v)} aria-label={fmt(g.activeToggle, { name: group.name })} />;
}

/** Deletes a group after confirmation; `onDeleted` runs after success. */
export function useDeleteGroup(store: MascotStore, onDeleted?: () => void) {
  const { t, errorMessage } = useI18n();
  const g = t.mascotAdmin.groups;
  const [deleting, setDeleting] = useState<MascotGroupDto | null>(null);
  const dialog = (
    <ConfirmDialog
      open={deleting !== null}
      onOpenChange={(o) => !o && setDeleting(null)}
      destructive
      title={deleting ? fmt(g.deleteTitle, { name: deleting.name }) : ''}
      description={g.deleteBody}
      confirmLabel={t.common.delete}
      onConfirm={async () => {
        if (!deleting) return false;
        try {
          await apiDelete<void>(`/mascot/groups/${encodeURIComponent(deleting.id)}`);
          store.update((c) => withoutGroup(c, deleting.id));
          toast.success(t.common.deletedToast);
          onDeleted?.();
          return true;
        } catch (err) {
          toast.error(errorMessage(err));
          return false;
        }
      }}
    />
  );
  return { ask: setDeleting, dialog };
}


import { useMemo } from 'react';
import {
  DEFAULT_PORTAL_VISIBILITY,
  isPortalVisible,
  type PortalKey,
  type PortalPageKey,
  type PortalSectionKey,
  type PortalVisibility,
} from '@workforce/shared';

import { useAuth } from '@/lib/auth';
import type { Dictionary } from '@/lib/i18n/dictionaries';

export {
  DEFAULT_PORTAL_VISIBILITY,
  LOCKED_PORTAL_KEYS,
  PORTAL_KEYS,
  PORTAL_PAGES,
  isPortalVisible,
  normalizePortalVisibility,
  portalPageForPath,
  portalPageOf,
} from '@workforce/shared';
export type { PortalKey, PortalPage, PortalPageKey, PortalSectionKey, PortalVisibility } from '@workforce/shared';

export interface PortalValue {
  /** Company-wide employee-portal visibility from /auth/me (all visible when the API did not send it). */
  config: PortalVisibility;
  /** Effective visibility of a "My work" page or section (a section also needs its page). */
  isVisible: (key: PortalKey) => boolean;
}

/**
 * Employee-portal visibility for the signed-in user. Navigation, My day widgets and notification links
 * use it to hide what HR turned off in Settings -> Employee portal. Must be used inside <AuthProvider>.
 */
export function usePortal(): PortalValue {
  const { user } = useAuth();
  const portal = user.portal;
  return useMemo(() => {
    const config: PortalVisibility = portal ?? DEFAULT_PORTAL_VISIBILITY;
    return { config, isVisible: (key: PortalKey) => isPortalVisible(config, key) };
  }, [portal]);
}

const PAGE_LABELS: Record<PortalPageKey, (t: Dictionary) => string> = {
  home: (t) => t.nav.home,
  attendance: (t) => t.nav.myAttendance,
  leave: (t) => t.nav.myLeave,
  overtime: (t) => t.nav.myOvertime,
  corrections: (t) => t.nav.corrections,
  notifications: (t) => t.nav.notifications,
};

/** Localized name of a portal page (the same words as the navigation) or section. */
export function portalLabel(t: Dictionary, key: PortalKey): string {
  if (key in PAGE_LABELS) return PAGE_LABELS[key as PortalPageKey](t);
  return t.portalVisibility.sections[key as PortalSectionKey];
}

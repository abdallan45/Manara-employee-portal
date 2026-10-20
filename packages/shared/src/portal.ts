// Employee-portal visibility: which "My work" pages and sections employees see. One company-wide
// setting (system setting 'portal.visibility'), exposed on /auth/me as SessionUser.portal and
// enforced by the API for request creation. Administration pages follow roles, not this setting.

/** "My work" pages in navigation order, with the sections an admin can hide inside each page. */
export const PORTAL_PAGES = [
  { key: 'home', path: '/', locked: true, sections: ['home.breaks', 'home.summary', 'home.activity'] },
  { key: 'attendance', path: '/me/attendance', locked: true, sections: ['attendance.events'] },
  { key: 'leave', path: '/me/leave', locked: false, sections: ['leave.requests', 'leave.documents'] },
  { key: 'overtime', path: '/me/overtime', locked: false, sections: ['overtime.recorded', 'overtime.requests'] },
  { key: 'corrections', path: '/me/corrections', locked: false, sections: [] },
  { key: 'notifications', path: '/notifications', locked: true, sections: [] },
] as const;

export type PortalPage = (typeof PORTAL_PAGES)[number];
export type PortalPageKey = PortalPage['key'];
export type PortalSectionKey = PortalPage['sections'][number];
export type PortalKey = PortalPageKey | PortalSectionKey;
/** Stored / transported visibility. A missing key means visible; locked pages are always visible. */
export type PortalVisibility = Partial<Record<PortalKey, boolean>>;

/** `details.reason` of the 403 FORBIDDEN the API returns for a request to a page or section HR turned off. */
export const PORTAL_DISABLED_REASON = 'PORTAL_DISABLED' as const;

/** Every key, each page followed by its sections (14 in total). */
export const PORTAL_KEYS: readonly PortalKey[] = PORTAL_PAGES.flatMap((p): PortalKey[] => [p.key, ...p.sections]);

/** Pages that can never be hidden: own attendance, its record and notifications (transparency). */
export const LOCKED_PORTAL_KEYS: readonly PortalPageKey[] = PORTAL_PAGES.filter((p) => p.locked).map((p) => p.key);

/** Everything visible. */
export const DEFAULT_PORTAL_VISIBILITY: Readonly<Record<PortalKey, boolean>> = Object.freeze(
  Object.fromEntries(PORTAL_KEYS.map((k) => [k, true])) as Record<PortalKey, boolean>,
);

const PAGE_BY_KEY = new Map<string, PortalPage>(PORTAL_PAGES.map((p) => [p.key, p]));
const PAGE_OF_SECTION = new Map<string, PortalPageKey>(PORTAL_PAGES.flatMap((p) => p.sections.map((s): [string, PortalPageKey] => [s, p.key])));
const KNOWN_KEYS = new Set<string>(PORTAL_KEYS);

export const isPortalKey = (key: string): key is PortalKey => KNOWN_KEYS.has(key);

/** The page a section belongs to, or the key itself for a page. */
export function portalPageOf(key: PortalKey): PortalPageKey {
  return PAGE_OF_SECTION.get(key) ?? (key as PortalPageKey);
}

export function isLockedPortalKey(key: string): boolean {
  return PAGE_BY_KEY.get(key)?.locked === true;
}

/**
 * Effective visibility of a page or section. A section also requires its page; a missing key (or a
 * missing config) means visible; locked pages are always visible.
 */
export function isPortalVisible(config: PortalVisibility | null | undefined, key: PortalKey): boolean {
  const page = PAGE_OF_SECTION.get(key);
  if (page !== undefined) return isPortalVisible(config, page) && config?.[key] !== false;
  if (isLockedPortalKey(key)) return true;
  return config?.[key] !== false;
}

/** The "My work" page a pathname belongs to (trailing slashes, sub-paths, query and hash tolerated), or null. */
export function portalPageForPath(pathname: string): PortalPageKey | null {
  const p = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  for (const page of PORTAL_PAGES) {
    if (page.path === '/') {
      if (p === '/') return page.key;
    } else if (p === page.path || p.startsWith(`${page.path}/`)) {
      return page.key;
    }
  }
  return null;
}

/**
 * A full object with every key present and locked pages forced on. Lenient: unknown keys and
 * non-boolean values are ignored (treated as visible), so it is safe on stored or legacy values.
 */
export function normalizePortalVisibility(value: unknown): Record<PortalKey, boolean> {
  const src = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out = { ...DEFAULT_PORTAL_VISIBILITY };
  for (const key of PORTAL_KEYS) {
    if (isLockedPortalKey(key)) continue;
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
  }
  return out;
}

/** Validation for PATCH /settings/portal.visibility. Returns a problem phrase or null when valid. */
export function validatePortalVisibility(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object that maps page and section keys to true or false';
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isPortalKey(key)) return `has an unknown key "${key}"; allowed keys: ${PORTAL_KEYS.join(', ')}`;
    if (typeof v !== 'boolean') return `"${key}" must be true or false`;
    if (v === false && isLockedPortalKey(key)) return `"${key}" is always shown and cannot be turned off`;
  }
  return null;
}

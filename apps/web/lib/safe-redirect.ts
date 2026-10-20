/**
 * Turns a user-supplied redirect target (`?next=`, `?from=` …) into a same-origin
 * `pathname + search + hash`, or null when it could leave the site or is not a plain path.
 *
 * Rejected: empty values, anything not starting with a single `/`, any backslash (browsers treat
 * `/\evil.com` like `//evil.com`), and any control character (tab/CR/LF are stripped by the URL
 * parser, so `/\t/evil.com` would become `//evil.com`). What is left is parsed against `origin` and
 * must resolve to that same origin.
 */
export function safeRedirect(value: string | null | undefined, origin?: string): string | null {
  if (!value || value.length > 2048) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  const result = `${url.pathname}${url.search}${url.hash}`;
  return result.startsWith('/') && !result.startsWith('//') ? result : null;
}

/** True when `path` (a safeRedirect result) is `prefix` itself or below it (`prefix/…`, `prefix?…`, `prefix#…`). */
export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}#`);
}

/** `?next=` of the sign-in page: a safe same-origin path that is not the sign-in page itself. */
export function safeNext(value: string | null | undefined, origin?: string): string | null {
  const path = safeRedirect(value, origin);
  if (!path || isUnder(path, '/login')) return null;
  return path;
}

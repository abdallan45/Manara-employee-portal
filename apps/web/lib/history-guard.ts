// The first popstate listener of the page, so browser Back / Forward can be checked before Next.js acts.
// Next.js renders the other page from its own popstate listener (app-router effect), and React 19 renders
// a popstate navigation synchronously inside it; listeners on window run in the order they were added,
// so a guard added later (e.g. in the app shell's effect) would only see the new page. components/providers
// imports this module, which runs before any effect, also on pages outside the app shell (sign-in).

/** Called for every Back / Forward move; it may stopImmediatePropagation() to keep Next.js from seeing it. */
export type PopStateGuard = (event: PopStateEvent) => void;

interface GuardSlot {
  guard: PopStateGuard | null;
}

const KEY = '__wfPopStateGuard';

function slot(): GuardSlot | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, GuardSlot | undefined>;
  // One listener per page, also when development hot reload evaluates this module again.
  if (!w[KEY]) {
    const created: GuardSlot = { guard: null };
    w[KEY] = created;
    window.addEventListener('popstate', (event) => created.guard?.(event));
  }
  return w[KEY]!;
}

slot();

/** Installs the Back / Forward guard (the app shell's unsaved-changes check); null removes it. */
export function setPopStateGuard(guard: PopStateGuard | null): void {
  const s = slot();
  if (s) s.guard = guard;
}

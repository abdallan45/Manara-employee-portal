// Where focus goes when the control that opened a dialog, sheet or alert dialog is no longer on the page
// when it closes, or leaves it soon after (a deleted row once the list reloads, a bulk-action bar that
// closed with the selection). Without this, focus falls to <body> and the next Tab starts from the top.

/**
 * Marks a script-focusable (tabIndex -1) element that holds a place in the page, such as the live region
 * of a DataTable or of a BulkActionBar. It is the fallback for controls that sat beside it.
 */
const FOCUS_ANCHOR = 'data-focus-anchor';

const CANDIDATES = 'a[href], button, input, select, textarea, [tabindex]';

/** Controls Tab reaches inside `root`, in order. */
function tabbables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES)).filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0,
  );
}

/** The page title, made script-focusable when it is not already. */
function pageTitle(): HTMLElement | null {
  const title = document.querySelector<HTMLElement>('#main h1');
  if (title && !title.hasAttribute('tabindex')) {
    title.setAttribute('tabindex', '-1');
    title.classList.add('outline-none');
  }
  return title;
}

/**
 * Notes where `opener` sits while it is still on the page and returns a function that later picks its
 * replacement: the control in the same place in the row that now has its row's position (the next row,
 * or the previous one when it was the last), else the nearest place anchor ([data-focus-anchor]) around
 * it, else the page title.
 */
export function focusFallbackFor(opener: HTMLElement): () => HTMLElement | null {
  const row = opener.closest('tr, li');
  const list = row?.parentElement ?? null;
  const rowIndex = row && list ? Array.from(list.children).indexOf(row) : -1;
  const slot = row ? tabbables(row).indexOf(opener) : -1;
  const anchors: HTMLElement[] = [];
  for (let el = opener.parentElement; el; el = el.parentElement) {
    for (const child of Array.from(el.children)) {
      if (child instanceof HTMLElement && child.hasAttribute(FOCUS_ANCHOR)) anchors.push(child);
    }
  }

  return () => {
    if (row && list?.isConnected) {
      const rows = Array.from(list.children).filter((el) => el.tagName === row.tagName);
      const target = row.isConnected ? row : rows[Math.min(rowIndex, rows.length - 1)];
      const controls = target ? tabbables(target) : [];
      const control = controls[slot] ?? controls[0];
      if (control) return control;
    }
    return anchors.find((a) => a.isConnected) ?? pageTitle();
  };
}

/**
 * For a few seconds after focus returned to `el`: if `el` leaves the page while it still has focus (the
 * list reloads without its row), focus `fallback()` instead of letting focus fall to <body>. Stops as soon
 * as focus is elsewhere.
 */
export function keepFocusOnPage(el: HTMLElement, fallback: () => HTMLElement | null, ms = 10_000): void {
  const observer = new MutationObserver(() => {
    if (el.isConnected) {
      if (document.activeElement !== el) stop();
      return;
    }
    stop();
    const active = document.activeElement;
    if (active && active !== document.body) return;
    fallback()?.focus({ preventScroll: true });
  });
  const timer = window.setTimeout(stop, ms);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(document.body, { childList: true, subtree: true });
}

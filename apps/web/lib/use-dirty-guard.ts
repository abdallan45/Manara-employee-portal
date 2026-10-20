'use client';

import { useEffect } from 'react';

/**
 * While `dirty` is true, closing the tab, reloading or leaving the site asks the browser's
 * "Leave site? Changes you made may not be saved." prompt, and the app shell (components/app-shell) asks
 * "Discard changes?" before an in-app link, browser Back / Forward or useLeaveGuard() navigation drops the
 * edits. Pair it with a sticky "Unsaved changes · Discard · Save" bar on the page; dialogs use
 * `<DialogContent dirty>` instead, which the app shell guards the same way.
 */
export function useDirtyGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older Chromium/Safari only show the prompt when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

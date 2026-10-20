'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

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
import { useI18n } from '@/lib/i18n/context';

/**
 * Confirmation for irreversible / disruptive actions. `onConfirm` may be async; the dialog stays open until
 * it settles. Name the outcome on both buttons (confirmLabel / cancelLabel, e.g. "Deactivate" / "Keep
 * active"). The safe (cancel) button has initial focus, so Enter never triggers a destructive action.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, destructive = false, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Label of the safe button; defaults to t.common.cancel. */
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const run = async () => {
    setBusy(true);
    try {
      const result = await onConfirm();
      if (result !== false) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          // Radix focuses Cancel by default; keep it explicit so the safe choice is always the default.
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={busy}>
            {cancelLabel ?? t.common.cancel}
          </AlertDialogCancel>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={() => void run()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {confirmLabel ?? t.common.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

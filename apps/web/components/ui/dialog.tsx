'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  useFocusReturn,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
        className,
      )}
      {...props}
    />
  );
}

/** 40×40 hit area; sits in the top-end corner above the content. */
const closeButtonClass =
  "absolute top-2 end-2 z-10 flex size-10 items-center justify-center rounded-full opacity-80 transition-opacity hover:bg-tint/[0.06] hover:opacity-100 disabled:pointer-events-none sm:top-3 sm:end-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/**
 * Below `sm` the dialog is full screen; from `sm` up it is centred. The content scrolls, and a
 * DialogFooter placed at the end (directly or as the last child of a <form>) stays pinned to the bottom.
 *
 * `dirty`: while true, Esc, a click outside and the close button ask "Discard changes?" first, so typed
 * input is never lost silently. A clean dialog closes without asking. `discardTitle`, `discardBody` and
 * `discardConfirmLabel` reword that prompt (e.g. "Discard this request?"); they default to the generic text.
 * "Keep editing" returns focus to the control that had it when the prompt opened. Closing the dialog returns
 * focus to the control that opened it, also when it is opened from state rather than a DialogTrigger.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel,
  dirty = false,
  discardTitle,
  discardBody,
  discardConfirmLabel,
  onEscapeKeyDown,
  onInteractOutside,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  /** Accessible name of the close button; defaults to t.common.close. */
  closeLabel?: string;
  /** Unsaved input: confirm before Esc / outside click / the close button dismisses the dialog. */
  dirty?: boolean;
  /** Title of the discard prompt; defaults to t.uiFoundation.discardTitle ("Discard changes?"). */
  discardTitle?: string;
  /** Body of the discard prompt; defaults to t.uiFoundation.discardBody. */
  discardBody?: string;
  /** Label of the destructive confirm button; defaults to t.uiFoundation.discardConfirm. */
  discardConfirmLabel?: string;
}) {
  const { t } = useI18n();
  const u = t.uiFoundation;
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  /** Focused control when the prompt opened; "Keep editing" puts focus back there. */
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  /** Set while discarding: the dialog itself closes and Radix restores focus to its trigger. */
  const discardingRef = React.useRef(false);
  const label = closeLabel ?? t.common.close;
  const focusReturn = useFocusReturn(onOpenAutoFocus, onCloseAutoFocus);

  const askDiscard = () => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setConfirmOpen(true);
  };

  const discard = () => {
    discardingRef.current = true;
    setConfirmOpen(false);
    closeRef.current?.click();
  };

  // The nested prompt has no Trigger, so Radix would leave focus on <body> when it closes.
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (discardingRef.current) {
      discardingRef.current = false;
      return;
    }
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    // The hidden Close button is a direct child of the dialog content, which Radix makes focusable.
    const content = closeRef.current?.parentElement;
    if (target?.isConnected && content?.contains(target)) target.focus();
    else content?.focus();
  };

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-dirty={dirty || undefined}
        className={cn(
          'bg-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed inset-0 z-50 grid h-dvh w-full content-start gap-4 overflow-y-auto overscroll-contain rounded-none border-tint/10 p-6 pt-14 shadow-2xl duration-200',
          'sm:top-[50%] sm:right-auto sm:bottom-auto sm:left-[50%] sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-2xl sm:border sm:pt-6',
          className,
        )}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (event.defaultPrevented || !dirty) return;
          event.preventDefault();
          askDiscard();
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (event.defaultPrevented || !dirty) return;
          event.preventDefault();
          askDiscard();
        }}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      >
        {children}
        {/* Programmatic close used by "Discard changes", so the caller's onOpenChange stays the only close path. */}
        <DialogPrimitive.Close ref={closeRef} className="hidden" tabIndex={-1} aria-hidden />
        {showCloseButton &&
          (dirty ? (
            <button type="button" data-slot="dialog-close" className={closeButtonClass} onClick={askDiscard}>
              <XIcon aria-hidden />
              <span className="sr-only">{label}</span>
            </button>
          ) : (
            <DialogPrimitive.Close data-slot="dialog-close" className={closeButtonClass}>
              <XIcon aria-hidden />
              <span className="sr-only">{label}</span>
            </DialogPrimitive.Close>
          ))}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent onCloseAutoFocus={restoreFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>{discardTitle ?? u.discardTitle}</AlertDialogTitle>
              <AlertDialogDescription>{discardBody ?? u.discardBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* Cancel ("Keep editing") receives initial focus; the destructive choice is never the default. */}
              <AlertDialogCancel>{u.keepEditing}</AlertDialogCancel>
              <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={discard}>
                {discardConfirmLabel ?? u.discardConfirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2 pe-8 text-start', className)} {...props} />;
}

/**
 * Pinned to the bottom edge of the scrolling dialog. It bleeds over the content padding (negative
 * margins, `-bottom-6`), so it works as a direct child of DialogContent or as the last child of a <form>.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'bg-popover sticky -bottom-6 z-[1] -mx-6 -mb-6 flex flex-col-reverse gap-2 border-t border-tint/10 px-6 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-lg leading-snug font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('text-muted-foreground text-sm', className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger };

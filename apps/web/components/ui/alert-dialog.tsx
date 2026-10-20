'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';

import { focusFallbackFor, keepFocusOnPage } from '@/lib/focus-fallback';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

/**
 * Returns focus to the control that opened a dialog, sheet or alert dialog when it closes. Radix only
 * returns focus to its own <…Trigger>, and this app opens most of them from state (`open={…}`), so focus
 * used to fall to <body>. The caller's handlers run first; `event.preventDefault()` in the caller's
 * onCloseAutoFocus opts out. Focus already moved elsewhere (not <body>) is left alone. When the opener is
 * gone (its row was deleted, a bulk-action bar closed with the selection), or leaves the page soon after
 * (the list reloads without its row), focus goes to its replacement (lib/focus-fallback): the same control
 * in the next row, the list's place anchor, or the page title.
 */
function useFocusReturn(onOpenAutoFocus?: (event: Event) => void, onCloseAutoFocus?: (event: Event) => void) {
  const openerRef = React.useRef<{ el: HTMLElement; fallback: () => HTMLElement | null } | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      // Dispatched before Radix moves focus inside, so this is still the opener.
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? { el: active, fallback: focusFallbackFor(active) } : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const opener = openerRef.current;
      openerRef.current = null;
      if (event.defaultPrevented || !opener) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      if (opener.el.isConnected) {
        event.preventDefault();
        opener.el.focus();
        keepFocusOnPage(opener.el, opener.fallback);
        return;
      }
      const target = opener.fallback();
      if (!target) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    },
  };
}

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({ className, onOpenAutoFocus, onCloseAutoFocus, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  const focusReturn = useFocusReturn(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'bg-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border border-tint/10 p-6 shadow-2xl duration-200 sm:max-w-md',
          className,
        )}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-header" className={cn('flex flex-col gap-2 text-center sm:text-start', className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-dialog-footer" className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn('text-lg leading-snug font-semibold', className)} {...props} />;
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn('text-muted-foreground text-sm', className)} {...props} />;
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />;
}

/** The safe choice. Radix gives it initial focus when the dialog opens, so Enter never confirms by accident. */
function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: 'outline' }), className)} {...props} />;
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
  useFocusReturn,
};

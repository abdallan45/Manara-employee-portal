'use client';

import { CircleHelp } from 'lucide-react';
import { useState, type MouseEvent, type PointerEvent } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/**
 * A small "?" next to a label that shows an explanation on hover (mouse) or tap (touch).
 * Keep the same text in the page for screen readers (`sr-only` element referenced by the control's
 * aria-describedby); this button only says "More info".
 *
 * Safe inside a <label>: the click is stopped so it doesn't toggle the checkbox or switch.
 */
export function HelpTip({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((o) => !o);
  };
  // Radix opens on hover itself; for touch, hover never happens, so a tap toggles instead.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') e.stopPropagation();
  };

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          onPointerDown={onPointerDown}
          aria-label={t.uiFoundation.moreInfo}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 inline-grid size-5 shrink-0 place-items-center rounded-full align-middle transition-colors focus-visible:ring-2 focus-visible:outline-none',
            className,
          )}
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent dir="auto" className="max-w-72 text-start leading-relaxed whitespace-pre-line" onPointerDownOutside={() => setOpen(false)}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

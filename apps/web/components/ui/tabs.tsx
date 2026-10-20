'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { useI18n } from '@/lib/i18n/context';
import { cn } from '@/lib/utils';

/** `dir` defaults to the UI direction, so in Arabic the first tab sits at the right and arrow keys follow RTL. */
function Tabs({ className, dir, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const { dir: uiDir } = useI18n();
  return <TabsPrimitive.Root data-slot="tabs" dir={dir ?? uiDir} className={cn('flex flex-col gap-4', className)} {...props} />;
}

const FADE_PX = 24;

/** Edge fade on the side(s) that can still scroll, in physical terms (works for RTL scrollLeft ≤ 0). */
function fadeMask(el: HTMLElement): string | undefined {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 1) return undefined;
  const rtl = getComputedStyle(el).direction === 'rtl';
  const pos = Math.abs(el.scrollLeft);
  const atStart = pos <= 1;
  const atEnd = pos >= max - 1;
  const left = rtl ? !atEnd : !atStart;
  const right = rtl ? !atStart : !atEnd;
  if (!left && !right) return undefined;
  const from = left ? `transparent 0, #000 ${FADE_PX}px` : '#000 0';
  const to = right ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : '#000 100%';
  return `linear-gradient(to right, ${from}, ${to})`;
}

/** Scrolls the list (never the page) so the active trigger is fully visible. */
function revealActive(list: HTMLElement, smooth: boolean) {
  const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  if (!active) return;
  const l = list.getBoundingClientRect();
  const a = active.getBoundingClientRect();
  let delta = 0;
  if (a.left < l.left + FADE_PX) delta = a.left - l.left - FADE_PX;
  else if (a.right > l.right - FADE_PX) delta = a.right - l.right + FADE_PX;
  if (Math.abs(delta) < 1) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  list.scrollBy({ left: delta, behavior: smooth && !reduce ? 'smooth' : 'auto' });
}

/**
 * One row that scrolls horizontally on narrow screens (scroll-snap, hidden scrollbar, edge fades only
 * while it can scroll); the active tab is scrolled into view whenever it changes. A legacy
 * `className="flex-wrap"` from callers is ignored so tabs never wrap or clip.
 */
function TabsList({ className, style, ref, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const [mask, setMask] = React.useState<string | undefined>(undefined);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const update = () => setMask(fadeMask(el));
    update();
    revealActive(el, false);
    el.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(() => {
      update();
      revealActive(el, false);
    });
    resize.observe(el);
    // Radix flips data-state on the triggers when the value changes (click, keyboard or URL).
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => r.attributeName === 'data-state' && (r.target as HTMLElement).getAttribute('data-state') === 'active')) {
        revealActive(el, true);
      }
      update();
    });
    mutations.observe(el, { subtree: true, attributes: true, attributeFilter: ['data-state'], childList: true });
    return () => {
      el.removeEventListener('scroll', update);
      resize.disconnect();
      mutations.disconnect();
    };
  }, []);

  const cleaned = typeof className === 'string' ? className.replace(/(^|\s)flex-wrap(?=\s|$)/g, ' ') : className;

  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-slot="tabs-list"
      className={cn(
        'text-muted-foreground flex min-h-10 w-fit max-w-full flex-nowrap items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden rounded-full border border-tint/[0.06] bg-tint/[0.04] p-1 [scrollbar-width:none] snap-x snap-proximity [&::-webkit-scrollbar]:hidden',
        cleaned,
        'flex-nowrap',
      )}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      {...props}
    />
  );
}

/** Active tab: filled pill + semibold (two cues). Inactive tabs keep ≥4.5:1 text. */
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "data-[state=active]:bg-tint/[0.14] data-[state=active]:text-foreground data-[state=active]:font-semibold text-muted-foreground hover:text-foreground inline-flex min-h-8 flex-1 shrink-0 snap-start items-center justify-center gap-1.5 rounded-full border border-transparent px-3.5 py-1 text-sm font-medium whitespace-nowrap transition-[color,background-color] focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-tint/10 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn('flex-1 rounded-xl', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };

'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';

/** 40×24 switch; the unchecked track has a 3:1 border so its edge is visible on dark surfaces. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=unchecked]:border-input inline-flex h-6 w-10 shrink-0 items-center rounded-full border-2 shadow-xs transition-all disabled:cursor-not-allowed disabled:opacity-50 data-[state=unchecked]:bg-tint/[0.06]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-white ring-0 transition-transform data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5 rtl:data-[state=checked]:-translate-x-[18px] rtl:data-[state=unchecked]:-translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

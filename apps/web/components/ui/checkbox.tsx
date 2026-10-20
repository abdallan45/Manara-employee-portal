'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { CheckIcon, MinusIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/** 20px box with a 3:1 border; `checked="indeterminate"` shows a minus (mixed state for "select all"). */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox border-input data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:border-primary aria-invalid:border-destructive aria-invalid:ring-destructive/30 aria-invalid:ring-[3px] size-5 shrink-0 rounded-[5px] border bg-tint/[0.03] shadow-xs transition-shadow disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current transition-none">
        <CheckIcon className="size-4 group-data-[state=indeterminate]/checkbox:hidden" aria-hidden />
        <MinusIcon className="hidden size-4 group-data-[state=indeterminate]/checkbox:block" aria-hidden />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

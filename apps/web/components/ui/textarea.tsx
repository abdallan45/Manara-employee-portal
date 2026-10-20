import * as React from 'react';

import { cn } from '@/lib/utils';

/** Free text: direction follows what is typed (dir="auto") and the box grows with its content (field-sizing). */
function Textarea({ className, dir = 'auto', ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      dir={dir}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-[color:var(--focus)] aria-invalid:border-destructive aria-invalid:ring-destructive/30 aria-invalid:ring-[3px] flex field-sizing-content min-h-16 max-h-[50vh] w-full rounded-xl border bg-tint/[0.03] px-3.5 py-2 text-base shadow-xs transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };

import * as React from 'react';

import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('bg-tint/[0.06] animate-pulse rounded-md', className)} {...props} />;
}

export { Skeleton };

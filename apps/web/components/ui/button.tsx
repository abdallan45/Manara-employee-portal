import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 aria-invalid:ring-destructive/40 aria-invalid:ring-[3px] aria-invalid:border-destructive active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: 'bg-brand-cta text-primary-foreground shadow-[0_8px_30px_-12px_rgba(206,18,137,0.7)] hover:brightness-110',
        destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90',
        outline: 'border border-tint/25 bg-tint/[0.03] shadow-xs hover:bg-tint/[0.07] hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-link underline-offset-4 hover:underline',
        blue: 'bg-[linear-gradient(90deg,#4373b9_0%,#6c65ad_100%)] text-white shadow-[0_8px_30px_-12px_rgba(67,115,185,0.7)] hover:brightness-110',
      },
      size: {
        default: 'h-10 px-5 py-2 has-[>svg]:px-4',
        sm: 'h-8 gap-1.5 px-3.5 has-[>svg]:px-3 text-xs',
        lg: 'h-12 px-7 has-[>svg]:px-5 text-base',
        xl: 'h-14 px-8 text-base',
        icon: 'size-10',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };

'use client';

import * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** shadcn Sonner wrapper. The theme comes from the caller (lib/theme via components/providers), not next-themes. */
const Toaster = ({ theme = 'dark', ...props }: ToasterProps) => {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

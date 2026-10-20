import { cn } from '@/lib/utils';

/** Manara mark (same artwork as the PWA icon) + wordmark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id="wf-brand-g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e82064" />
          <stop offset=".52" stopColor="#6c65ad" />
          <stop offset="1" stopColor="#4373b9" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="#12121a" />
      <circle cx="256" cy="256" r="150" fill="none" stroke="url(#wf-brand-g)" strokeWidth="36" />
      <path d="M256 160v104l64 40" fill="none" stroke="#fff" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BrandWordmark({ className, subtitle }: { className?: string; subtitle?: string }) {
  return (
    <span className={cn('flex min-w-0 flex-col leading-none', className)}>
      <span className="font-display text-[15px] font-extrabold tracking-[0.18em] text-tint italic" dir="ltr">
        MANARA
      </span>
      {subtitle && <span className="text-muted-foreground mt-1 truncate text-xs font-medium">{subtitle}</span>}
    </span>
  );
}

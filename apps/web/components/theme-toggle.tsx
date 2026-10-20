'use client';

import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n/context';
import { useTheme } from '@/lib/theme';

/** The theme switch's name and icon: what pressing it does ("Switch to light mode", a sun). */
export function useThemeSwitch() {
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const toLight = theme === 'dark';
  return {
    label: toLight ? t.common.switchToLight : t.common.switchToDark,
    short: toLight ? t.common.themeLight : t.common.themeDark,
    Icon: toLight ? Sun : Moon,
    toggle: toggleTheme,
  };
}

/** Icon button that switches between the dark and light themes; `withLabel` also shows "Light mode". */
export function ThemeToggle({ className, withLabel = false }: { className?: string; withLabel?: boolean }) {
  const { label, short, Icon, toggle } = useThemeSwitch();
  if (withLabel) {
    return (
      <Button variant="outline" size="sm" className={className} onClick={toggle} aria-label={label}>
        <Icon aria-hidden />
        {short}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={className} onClick={toggle} aria-label={label}>
          <Icon aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

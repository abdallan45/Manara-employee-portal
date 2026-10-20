'use client';

import { Languages } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/context';
import type { Locale } from '@/lib/i18n/dictionaries';

/** Switches EN/AR. `onChange` lets signed-in pages also persist the choice server-side. */
export function LanguageToggle({ onChange, className }: { onChange?: (locale: Locale) => void; className?: string }) {
  const { t, locale, setLocale } = useI18n();
  const next: Locale = locale === 'ar' ? 'en' : 'ar';
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={() => (onChange ? onChange(next) : setLocale(next))}
      aria-label={t.common.switchLanguageLabel}
      lang={next}
    >
      <Languages aria-hidden />
      {t.common.switchLanguage}
    </Button>
  );
}

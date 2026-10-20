import { ar } from './ar';
import { en, type Dictionary } from './en';

export type Locale = 'en' | 'ar';
export type { Dictionary };

export const dictionaries: Record<Locale, Dictionary> = { en, ar };
export const DEFAULT_LOCALE: Locale = 'ar';
export const LOCALE_STORAGE_KEY = 'wf_locale';

export const dirFor = (locale: Locale): 'rtl' | 'ltr' => (locale === 'ar' ? 'rtl' : 'ltr');

/** "Hello {name}" + { name: 'Sara' } -> "Hello Sara". */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

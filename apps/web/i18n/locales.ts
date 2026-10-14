// Console UI languages. The choice lives in a cookie (no locale prefix in URLs), default English.
export const LOCALES = ['en', 'zh-TW', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** Each language's own name, for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', 'zh-TW': '繁體中文', ja: '日本語' };

export function toLocale(value: string | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? '') ? (value as Locale) : DEFAULT_LOCALE;
}

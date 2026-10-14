import type en from './messages/en.json';
import type { Locale } from './i18n/locales';

// Typed message keys: every t('…') call is checked against the English catalog.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof en;
  }
}

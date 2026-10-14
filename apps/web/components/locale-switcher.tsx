'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setLocaleAction } from '../i18n/actions';
import { LOCALE_NAMES, LOCALES } from '../i18n/locales';
import { Icon } from './icons';

/** Language picker; the server action sets the cookie and Next re-renders the current route. */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations('common');
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  return (
    <div className={`select-wrap ${className ?? ''}`}>
      <select
        className="input input-sm select"
        aria-label={t('language')}
        value={locale}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => setLocaleAction(next));
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
      <span className="select-chevron">
        <Icon name="chevron-down" size={16} />
      </span>
    </div>
  );
}

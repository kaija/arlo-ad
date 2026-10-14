'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, toLocale } from './locales';

export async function setLocaleAction(locale: string): Promise<void> {
  (await cookies()).set(LOCALE_COOKIE, toLocale(locale), { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
}

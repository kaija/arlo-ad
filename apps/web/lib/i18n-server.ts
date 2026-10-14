import { getTranslations } from 'next-intl/server';
import type { Msg } from './msg';

/** Translates a lib message in the request's locale. */
export async function translateMsg(m: Msg): Promise<string> {
  const t = await getTranslations('errors');
  return typeof m === 'string' ? t(m) : t(m.key, m.values);
}

/** Translates a field → message map, e.g. form validation errors. */
export async function translateErrors<K extends string>(errors: Partial<Record<K, Msg>>): Promise<Partial<Record<K, string>>> {
  const out: Partial<Record<K, string>> = {};
  for (const [k, m] of Object.entries(errors) as [K, Msg | undefined][]) if (m) out[k] = await translateMsg(m);
  return out;
}

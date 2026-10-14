import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import ja from '../messages/ja.json';
import zhTW from '../messages/zh-TW.json';
import { LOCALES, toLocale } from './locales';

type Tree = { [key: string]: string | Tree };

/** Every leaf as [dotted.key, message]. */
function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
}

/** ICU argument names, e.g. {count, plural, …} → count; rich-text tags, e.g. <b> → <b>. */
function args(message: string): string[] {
  const names = [...message.matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/g)].map((m) => m[1]!);
  const tags = [...message.matchAll(/<(\w+)>/g)].map((m) => `<${m[1]}>`);
  return [...new Set([...names, ...tags])].sort();
}

const catalogs = { 'zh-TW': zhTW, ja } as Record<string, Tree>;
const english = new Map(leaves(en as Tree));

describe('message catalogs', () => {
  it.each(Object.keys(catalogs))('%s has exactly the English keys', (locale) => {
    expect(leaves(catalogs[locale]!).map(([k]) => k).sort()).toEqual([...english.keys()].sort());
  });

  it.each(Object.keys(catalogs))('%s uses the same arguments as English', (locale) => {
    const mismatched = leaves(catalogs[locale]!).filter(([k, v]) => JSON.stringify(args(v)) !== JSON.stringify(args(english.get(k) ?? '')));
    expect(mismatched.map(([k]) => k)).toEqual([]);
  });

  it('has no empty messages', () => {
    for (const tree of [en, zhTW, ja] as Tree[]) expect(leaves(tree).filter(([, v]) => !v.trim())).toEqual([]);
  });
});

describe('toLocale', () => {
  it('accepts supported locales and falls back to English', () => {
    for (const l of LOCALES) expect(toLocale(l)).toBe(l);
    expect(toLocale(undefined)).toBe('en');
    expect(toLocale('fr')).toBe('en');
  });
});

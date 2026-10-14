// User-facing messages from lib/ are keys into the `errors` catalog (messages/*.json), with values
// when the text needs them. Server actions translate them with `translateMsg` / `translateErrors`.
import en from '../messages/en.json';

export type ErrorKey = keyof (typeof en)['errors'];
export type Msg = ErrorKey | { key: ErrorKey; values: Record<string, string | number> };

export const msg = (key: ErrorKey, values: Record<string, string | number>): Msg => ({ key, values });

export const isErrorKey = (s: string): s is ErrorKey => Object.hasOwn(en.errors, s);

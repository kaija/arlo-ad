// Search terms page (Requirement 18.6): spend, classifier labels against the current Business
// Profile, and the negative keyword history built from ChangeSets.
import { addDays, dateInTimeZone, normalizeSearchTerm, type ChangeSetStatus, type SearchTermLabel } from '@arlo/core';
import { getBusinessProfile, getSearchTermLabels, listChangeSets, searchTermStats, type AdAccount, type DbOrTx } from '@arlo/db';

export const LABEL_FILTERS = ['all', 'irrelevant', 'relevant', 'unlabelled', 'negated'] as const;
export type LabelFilter = (typeof LABEL_FILTERS)[number];

/** Classifier intents with a translated label (`searchTerms.intent.*`); others show their raw value. */
export const INTENTS = ['purchase', 'research', 'support', 'navigational', 'competitor', 'jobs', 'free_or_diy', 'unrelated'] as const;
export const isIntent = (v: string): v is (typeof INTENTS)[number] => (INTENTS as readonly string[]).includes(v);

export interface TermFilter {
  days: 7 | 30 | 90;
  label: LabelFilter;
  q: string;
}

export function parseTermFilter(params: Record<string, string | string[] | undefined>): TermFilter {
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '');
  const days = Number(one('days'));
  const label = one('label') as LabelFilter;
  return {
    days: days === 7 || days === 90 ? days : 30,
    label: (LABEL_FILTERS as readonly string[]).includes(label) ? label : 'all',
    q: one('q').trim().slice(0, 100),
  };
}

export interface NegativeHistoryItem {
  term: string;
  matchType: string;
  changesetId: string;
  status: ChangeSetStatus;
  excluded: boolean;
  createdAt: Date;
  auto: boolean;
}

export interface TermRow {
  term: string;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions90d: number;
  label: SearchTermLabel | null;
  negative: NegativeHistoryItem | null;
}

/** Negative keyword ops from the account's recent ChangeSets, newest first. */
export async function negativeHistory(db: DbOrTx, accountId: string, limit = 200): Promise<NegativeHistoryItem[]> {
  const sets = await listChangeSets(db, { accountIds: [accountId], limit });
  return sets.flatMap((cs) =>
    cs.ops.flatMap((op, i) => {
      if (op.kind !== 'google.add_negative_keyword') return [];
      const after = op.after as { text?: string; matchType?: string };
      if (!after?.text) return [];
      return [{ term: normalizeSearchTerm(after.text), matchType: after.matchType ?? 'EXACT', changesetId: cs.id, status: cs.status, excluded: cs.excludedOps?.includes(i) ?? false, createdAt: cs.createdAt, auto: cs.feature === 'negative_kw_auto' }];
    }),
  );
}

export async function loadSearchTerms(db: DbOrTx, account: AdAccount, filter: TermFilter, now: Date): Promise<{ rows: TermRow[]; profileVersion: number | null; history: NegativeHistoryItem[] }> {
  const today = dateInTimeZone(now, account.timezone);
  const [stats, profile, history] = await Promise.all([
    searchTermStats(db, account.id, { costFrom: addDays(today, -filter.days), convFrom: addDays(today, -90), to: today, limit: 1000 }),
    getBusinessProfile(db, account.id),
    negativeHistory(db, account.id),
  ]);
  const active = stats.filter((s) => s.costMicros > 0 || s.clicks > 0);
  const labels = profile ? await getSearchTermLabels(db, account.id, profile.version, active.map((s) => s.term)) : new Map<string, SearchTermLabel>();
  const latestNegative = new Map<string, NegativeHistoryItem>();
  for (const h of history) if (!latestNegative.has(h.term)) latestNegative.set(h.term, h);
  const q = normalizeSearchTerm(filter.q);
  const rows = active
    .map((s) => ({ term: s.term, costMicros: s.costMicros, clicks: s.clicks, impressions: s.impressions, conversions90d: s.conversions, label: labels.get(s.term) ?? null, negative: latestNegative.get(s.term) ?? null }))
    .filter((r) => !q || r.term.includes(q))
    .filter((r) => {
      switch (filter.label) {
        case 'irrelevant':
          return r.label?.relevant === false;
        case 'relevant':
          return r.label?.relevant === true;
        case 'unlabelled':
          return !r.label;
        case 'negated':
          return r.negative !== null && !r.negative.excluded;
        default:
          return true;
      }
    });
  return { rows, profileVersion: profile?.version ?? null, history };
}

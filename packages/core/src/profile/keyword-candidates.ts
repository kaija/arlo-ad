// Keyword expansion candidates (ADR-0019, Requirement 14.7): search terms that converted but are
// not keywords yet, plus Keyword Planner ideas, de-duplicated and minus what the account already
// has or excludes. Pure; proposals made from them are always reviewed (Tier 2).
import { normalizeSearchTerm } from './business-profile';

export interface IdeaInput {
  text: string;
  avgMonthlySearches: number | null;
  competition: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  lowTopBidMicros: number | null;
  highTopBidMicros: number | null;
}

export interface MinedTermInput {
  term: string;
  conversions: number;
  clicks: number;
  costMicros: number;
}

export interface KeywordCandidate {
  text: string;
  source: 'search_term' | 'planner' | 'both';
  conversions: number;
  clicks: number;
  avgMonthlySearches: number | null;
  competition: IdeaInput['competition'] | null;
  highTopBidMicros: number | null;
  /** EXACT for proven converting terms, PHRASE for planner ideas. */
  matchType: 'EXACT' | 'PHRASE';
}

export interface CandidateOptions {
  /** Existing keyword texts in the account (any match type). */
  existing: readonly string[];
  /** Negative keyword texts; candidates containing one are dropped. */
  negatives: readonly string[];
  minConversions?: number;
  limit?: number;
}

export function keywordCandidates(ideas: readonly IdeaInput[], terms: readonly MinedTermInput[], opts: CandidateOptions): KeywordCandidate[] {
  const existing = new Set(opts.existing.map(normalizeSearchTerm));
  const negatives = opts.negatives.map(normalizeSearchTerm).filter(Boolean);
  const blocked = (t: string) => existing.has(t) || negatives.some((n) => ` ${t} `.includes(` ${n} `) || t === n);
  const out = new Map<string, KeywordCandidate>();

  for (const s of terms) {
    const text = normalizeSearchTerm(s.term);
    if (!text || blocked(text) || s.conversions < (opts.minConversions ?? 1)) continue;
    const prev = out.get(text);
    out.set(text, {
      text,
      source: 'search_term',
      conversions: (prev?.conversions ?? 0) + s.conversions,
      clicks: (prev?.clicks ?? 0) + s.clicks,
      avgMonthlySearches: null,
      competition: null,
      highTopBidMicros: null,
      matchType: 'EXACT',
    });
  }
  for (const i of ideas) {
    const text = normalizeSearchTerm(i.text);
    if (!text || blocked(text)) continue;
    const prev = out.get(text);
    if (prev?.source === 'planner' || prev?.source === 'both') {
      // The same idea twice (e.g. different spacing): keep the larger volume.
      if ((i.avgMonthlySearches ?? -1) > (prev.avgMonthlySearches ?? -1)) out.set(text, { ...prev, avgMonthlySearches: i.avgMonthlySearches, competition: i.competition, highTopBidMicros: i.highTopBidMicros });
      continue;
    }
    out.set(text, prev
      ? { ...prev, source: 'both', avgMonthlySearches: i.avgMonthlySearches, competition: i.competition, highTopBidMicros: i.highTopBidMicros }
      : { text, source: 'planner', conversions: 0, clicks: 0, avgMonthlySearches: i.avgMonthlySearches, competition: i.competition, highTopBidMicros: i.highTopBidMicros, matchType: 'PHRASE' });
  }
  return [...out.values()]
    .sort((a, b) => b.conversions - a.conversions || (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1) || a.text.localeCompare(b.text))
    .slice(0, opts.limit ?? 50);
}

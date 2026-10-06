// Business Profile (ADR-0019, Requirement 14.1): what an account sells and which search intents
// it wants, the context the search term classifier judges relevance against. Versioned in the
// database; every edit is a new version, which also invalidates cached classifications.
import { z } from 'zod';

export const COMPETITOR_POLICIES = ['exclude', 'allow', 'review'] as const;
export type CompetitorPolicy = (typeof COMPETITOR_POLICIES)[number];

const terms = (max: number) => z.array(z.string().trim().min(1).max(200)).max(max);

export const ProfileExampleSchema = z.object({
  term: z.string().trim().min(1).max(200),
  relevant: z.boolean(),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ProfileExample = z.infer<typeof ProfileExampleSchema>;

export const BusinessProfileSchema = z.object({
  /** Products and services the account advertises. */
  offerings: terms(50),
  /** Searches the account wants, e.g. "購買意圖", "型號比較". */
  targetIntents: terms(50),
  /** Searches to exclude, e.g. "免費", "求職", "維修教學". */
  excludedIntents: terms(50),
  /** Own brand words; terms containing them are never auto-negated. */
  brandTerms: terms(50),
  /** How searches for competitors are treated: exclude, allow, or leave for review. */
  competitorPolicy: z.enum(COMPETITOR_POLICIES),
  /** Labelled terms, including approver corrections (Requirement 14.6). */
  examples: z.array(ProfileExampleSchema).max(500),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

export const EMPTY_BUSINESS_PROFILE: BusinessProfile = {
  offerings: [],
  targetIntents: [],
  excludedIntents: [],
  brandTerms: [],
  competitorPolicy: 'review',
  examples: [],
};

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a search term contains any brand term (case, width and spacing insensitive). */
export function containsBrandTerm(term: string, brandTerms: readonly string[]): boolean {
  const t = normalize(term);
  const compact = t.replace(/ /g, '');
  return brandTerms.some((b) => {
    const n = normalize(b);
    return n.length > 0 && (t.includes(n) || compact.includes(n.replace(/ /g, '')));
  });
}

/** Adds or replaces the example for `term` (latest label wins). */
export function withExample(profile: BusinessProfile, example: ProfileExample): BusinessProfile {
  const key = normalize(example.term);
  return { ...profile, examples: [...profile.examples.filter((e) => normalize(e.term) !== key), example].slice(-500) };
}

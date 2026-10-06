// Business Profile editor (ADR-0019, Requirements 14.1, 18.4): one item per line; examples as
// "字詞 | 相關/不相關 | 備註".
import { BusinessProfileSchema, COMPETITOR_POLICIES, type BusinessProfile, type CompetitorPolicy } from '@arlo/core';

export const COMPETITOR_POLICY_LABEL: Record<CompetitorPolicy, string> = {
  exclude: '排除競品字詞',
  allow: '允許競品字詞',
  review: '交由人工審核',
};

export interface ProfileFormValues {
  offerings: string;
  targetIntents: string;
  excludedIntents: string;
  brandTerms: string;
  competitorPolicy: string;
  examples: string;
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const RELEVANT = new Set(['相關', 'relevant', 'yes', 'y', '✓', '+']);
const IRRELEVANT = new Set(['不相關', 'irrelevant', 'no', 'n', '✗', '-']);

export function profileFormValues(form: FormData): ProfileFormValues {
  const get = (k: keyof ProfileFormValues) => String(form.get(k) ?? '');
  return { offerings: get('offerings'), targetIntents: get('targetIntents'), excludedIntents: get('excludedIntents'), brandTerms: get('brandTerms'), competitorPolicy: get('competitorPolicy'), examples: get('examples') };
}

export function profileToForm(p: BusinessProfile): ProfileFormValues {
  return {
    offerings: p.offerings.join('\n'),
    targetIntents: p.targetIntents.join('\n'),
    excludedIntents: p.excludedIntents.join('\n'),
    brandTerms: p.brandTerms.join('\n'),
    competitorPolicy: p.competitorPolicy,
    examples: p.examples.map((e) => [e.term, e.relevant ? '相關' : '不相關', e.note ?? ''].join(' | ').replace(/ \| $/, '')).join('\n'),
  };
}

export type ProfileFormErrors = Partial<Record<keyof ProfileFormValues, string>>;

export function parseProfileForm(v: ProfileFormValues): { ok: true; value: BusinessProfile } | { ok: false; errors: ProfileFormErrors } {
  const errors: ProfileFormErrors = {};
  const examples = [];
  for (const [i, line] of lines(v.examples).entries()) {
    const [term, label, ...note] = line.split('|').map((x) => x.trim());
    const relevant = RELEVANT.has((label ?? '').toLowerCase()) ? true : IRRELEVANT.has((label ?? '').toLowerCase()) ? false : null;
    if (!term || relevant === null) {
      errors.examples = `第 ${i + 1} 行格式應為「字詞 | 相關 或 不相關 | 備註」`;
      break;
    }
    examples.push({ term, relevant, note: note.join('|').trim() || null });
  }
  if (!(COMPETITOR_POLICIES as readonly string[]).includes(v.competitorPolicy)) errors.competitorPolicy = '請選擇競品政策';
  const parsed = BusinessProfileSchema.safeParse({
    offerings: lines(v.offerings),
    targetIntents: lines(v.targetIntents),
    excludedIntents: lines(v.excludedIntents),
    brandTerms: lines(v.brandTerms),
    competitorPolicy: v.competitorPolicy,
    examples,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]) as keyof ProfileFormValues;
      errors[key] ??= issue.code === 'too_big' ? '項目太多或太長' : '內容不正確';
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

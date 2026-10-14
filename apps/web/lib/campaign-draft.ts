// Draft editor form ↔ CampaignDraft (Requirements 15.4, 18.5). Lists are one item per line;
// keywords as "text | MATCH" (MATCH defaults to PHRASE).
import { CampaignDraftSchema, MATCH_TYPES, type CampaignDraft } from '@arlo/core';
import { msg, type Msg } from './msg';

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function keywordsFrom(text: string) {
  return lines(text).map((l) => {
    const [t, m] = l.split('|').map((x) => x.trim());
    const matchType = (MATCH_TYPES as readonly string[]).includes((m ?? '').toUpperCase()) ? (m!.toUpperCase() as (typeof MATCH_TYPES)[number]) : 'PHRASE';
    return { text: t ?? '', matchType };
  });
}

export const keywordsToText = (ks: readonly { text: string; matchType: string }[]) => ks.map((k) => `${k.text} | ${k.matchType}`).join('\n');

/** Parses the editor form; ad groups ticked for removal are dropped. */
export function draftFromForm(form: FormData): { ok: true; draft: CampaignDraft } | { ok: false; error: Msg } {
  const g = (k: string) => String(form.get(k) ?? '');
  const groups = [];
  const groupCount = Number(g('g_count')) || 0;
  for (let i = 0; i < groupCount; i++) {
    if (form.get(`g${i}_remove`) === 'on') continue;
    const ads = [];
    for (let j = 0; j < (Number(g(`g${i}_adCount`)) || 0); j++) {
      const p = `g${i}_ad${j}_`;
      ads.push({ headlines: lines(g(`${p}headlines`)), descriptions: lines(g(`${p}descriptions`)), finalUrl: g(`${p}finalUrl`).trim(), path1: g(`${p}path1`).trim() || null, path2: g(`${p}path2`).trim() || null });
    }
    groups.push({ name: g(`g${i}_name`).trim(), keywords: keywordsFrom(g(`g${i}_keywords`)), ads });
  }
  const targetCpa = g('c_targetCpa').trim();
  const parsed = CampaignDraftSchema.safeParse({
    campaign: {
      name: g('c_name').trim(),
      dailyBudget: Number(g('c_budget').replace(/,/g, '')),
      biddingStrategy: g('c_strategy'),
      targetCpa: targetCpa ? Number(targetCpa.replace(/,/g, '')) : null,
      locations: lines(g('c_locations').replace(/[,，、]/g, '\n')),
      languages: lines(g('c_languages').replace(/[,，、]/g, '\n')),
    },
    adGroups: groups,
    negativeKeywords: keywordsFrom(g('negatives')),
    rationale: g('rationale'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.join('.');
    const key = /headlines/.test(where) ? 'draftHeadlines' : /descriptions/.test(where) ? 'draftDescriptions' : /keywords/.test(where) ? 'draftKeywords' : /adGroups/.test(where) ? 'draftAdGroups' : 'draftInvalidField';
    return { ok: false, error: msg(key, { where }) };
  }
  return { ok: true, draft: parsed.data };
}

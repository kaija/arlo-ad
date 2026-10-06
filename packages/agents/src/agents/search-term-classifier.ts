// Search term classifier (ADR-0019, Requirements 14.2, 14.3): a small model labels search terms
// against the account's Business Profile in batches, with structured output. Labels are cached
// per (account, term, profile version), so an unchanged profile never re-classifies a term.
import { normalizeSearchTerm, SEARCH_INTENTS, type BusinessProfile, type SearchTermLabel } from '@arlo/core';
import { getSearchTermLabels, saveSearchTermLabels, type Db } from '@arlo/db';
import { Agent, run, type Model } from '@openai/agents';
import { z } from 'zod';
import { UNTRUSTED_CONTENT_POLICY } from './prompts';

export const CLASSIFIER_BATCH_SIZE = 100;

export const SearchTermLabelsSchema = z.object({
  labels: z.array(
    z.object({
      index: z.number().int().min(0),
      intent: z.enum(SEARCH_INTENTS),
      relevant: z.boolean(),
      confidence: z.number().min(0).max(1),
      reason: z.string().max(300),
    }),
  ),
});
export type SearchTermLabels = z.infer<typeof SearchTermLabelsSchema>;

export const CLASSIFIER_INSTRUCTIONS = `
你是搜尋字詞分類器。輸入是 JSON：profile（帳戶的 Business Profile）與 terms（要分類的搜尋字詞，各有 index）。
對每個 term 輸出一筆 label（index 對應輸入）：
- intent：purchase（購買/價格/哪裡買）、research（比較/評測/推薦）、support（登入/客服/故障/說明書）、navigational（找官網或特定頁）、competitor（競品品牌）、jobs（求職/徵才）、free_or_diy（免費/破解/自己做/教學）、unrelated（與販售內容無關）。
- relevant：依 profile 判斷這個搜尋是否值得付費曝光。符合 offerings 與 target_intents → true；落在 excluded_intents、與 offerings 無關、或 competitor_policy=exclude 時的競品字詞 → false。含 brand_terms 的字詞一律 relevant=true，除非明顯是求職。examples 是人工標註，類似字詞要一致。
- confidence：0–1，代表你對 relevant 判斷的把握。只有非常確定時才給 ≥ 0.9；語意模糊、可能是潛在客戶、或 profile 沒涵蓋的情況給 ≤ 0.7。
- reason：一句繁體中文理由。
不要漏掉或新增 index。

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createSearchTermClassifier(opts: { model: string | Model }) {
  return new Agent<unknown, typeof SearchTermLabelsSchema>({
    name: 'search_term_classifier',
    instructions: CLASSIFIER_INSTRUCTIONS,
    model: opts.model,
    outputType: SearchTermLabelsSchema,
  });
}

/** The model input for one batch. */
export function classifierInput(profile: BusinessProfile, terms: readonly string[]): string {
  return JSON.stringify({
    profile: {
      offerings: profile.offerings,
      target_intents: profile.targetIntents,
      excluded_intents: profile.excludedIntents,
      brand_terms: profile.brandTerms,
      competitor_policy: profile.competitorPolicy,
      examples: profile.examples.map((e) => ({ term: e.term, relevant: e.relevant, ...(e.note ? { note: e.note } : {}) })),
    },
    terms: terms.map((term, index) => ({ index, term })),
  });
}

/** Valid labels by index; duplicates and out-of-range indexes are dropped. */
export function labelsByIndex(output: SearchTermLabels, count: number): Map<number, SearchTermLabel> {
  const out = new Map<number, SearchTermLabel>();
  for (const l of output.labels) {
    if (l.index >= count || out.has(l.index)) continue;
    out.set(l.index, { intent: l.intent, relevant: l.relevant, confidence: l.confidence, reason: l.reason });
  }
  return out;
}

export interface ClassifyOptions {
  db: Db;
  accountId: string;
  profile: BusinessProfile;
  profileVersion: number;
  terms: readonly string[];
  classifier: Agent<unknown, typeof SearchTermLabelsSchema>;
  /** Recorded on cached rows. */
  modelName?: string | null;
  batchSize?: number;
}

export interface ClassifyResult {
  /** Labels by normalized term; terms the model skipped are absent. */
  labels: Map<string, SearchTermLabel>;
  cached: number;
  classified: number;
  batches: number;
}

export async function classifySearchTerms(opts: ClassifyOptions): Promise<ClassifyResult> {
  const unique = [...new Set(opts.terms.map(normalizeSearchTerm).filter(Boolean))];
  const labels = await getSearchTermLabels(opts.db, opts.accountId, opts.profileVersion, unique);
  const cached = labels.size;
  const todo = unique.filter((t) => !labels.has(t));
  const size = opts.batchSize ?? CLASSIFIER_BATCH_SIZE;
  let batches = 0;
  let classified = 0;
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    batches++;
    const result = await run(opts.classifier, classifierInput(opts.profile, batch), { maxTurns: 1 });
    const byIndex = labelsByIndex(SearchTermLabelsSchema.parse(result.finalOutput), batch.length);
    const fresh = [...byIndex].map(([index, label]) => ({ ...label, term: batch[index]! }));
    await saveSearchTermLabels(opts.db, opts.accountId, opts.profileVersion, fresh, opts.modelName ?? null);
    for (const l of fresh) labels.set(l.term, { intent: l.intent, relevant: l.relevant, confidence: l.confidence, reason: l.reason });
    classified += fresh.length;
  }
  return { labels, cached, classified, batches };
}

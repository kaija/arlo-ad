// Ranks candidate causes of an anomaly (ADR-0021, Requirement 16.5). The worker gathers the
// candidates deterministically (changes within ±48h); the model only orders and explains them.
import { Agent, type Model } from '@openai/agents';
import { z } from 'zod';
import { UNTRUSTED_CONTENT_POLICY } from './prompts';

export const CauseRankingSchema = z.object({
  causes: z.array(z.object({ id: z.string(), likelihood: z.number().min(0).max(1), reason: z.string().max(300) })).max(10),
  summary: z.string().max(800),
});
export type CauseRanking = z.infer<typeof CauseRankingSchema>;

export const CAUSE_RANKER_INSTRUCTIONS = `
你是廣告成效異常的根因分析師。輸入 JSON：anomaly（哪個指標在哪天往哪個方向偏離基準多少）與 candidates（同帳戶前後 48 小時內的變更，各有 id、時間、內容、影響的 ID）。
- 依「可能造成這個異常」的程度排序 candidates，likelihood 0–1；與異常無關的不要列出。
- 考慮：時間先後（原因要在異常前或當天）、影響範圍是否包含異常的 entity、變更方向與異常方向是否一致（例如預算提高 → 花費與點擊上升；出價目標收緊 → 點擊下降；暫停 → 下降）。
- 沒有合理候選時 causes 給空陣列，summary 說明可能是外部因素（季節、競爭、追蹤問題）。
- summary：2–3 句繁體中文結論。

${UNTRUSTED_CONTENT_POLICY}
`.trim();

export function createCauseRanker(opts: { model: string | Model }) {
  return new Agent<unknown, typeof CauseRankingSchema>({ name: 'cause_ranker', instructions: CAUSE_RANKER_INSTRUCTIONS, model: opts.model, outputType: CauseRankingSchema });
}

export interface RankerAnomaly {
  date: string;
  metric: string;
  direction: 'up' | 'down';
  value: number;
  baseline: number;
  entity?: string | null;
}

export interface RankerCandidate {
  id: string;
  at: string;
  kind: string;
  who: string | null;
  summary: string;
  targets: string[];
}

export function causeRankerInput(anomaly: RankerAnomaly, candidates: readonly RankerCandidate[]): string {
  return JSON.stringify({ anomaly, candidates });
}

/** Keeps only causes that name a real candidate, best first. */
export function validCauses(ranking: CauseRanking, candidates: readonly { id: string }[]): CauseRanking['causes'] {
  const ids = new Set(candidates.map((c) => c.id));
  const seen = new Set<string>();
  return ranking.causes
    .filter((c) => ids.has(c.id) && !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => b.likelihood - a.likelihood);
}

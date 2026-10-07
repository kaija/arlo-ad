// budget_rebalance (ADR-0018, Requirements 13.1–13.4): per account, the bidding agent runs the
// optimizer, reviews it (it may only exclude campaigns) and sends it for approval with an
// explanation. The automation mode `off` skips the account.
import type { AgentContext } from '@arlo/agents';
import type { Section } from '@arlo/core';
import { getAutomationMode } from '@arlo/db';
import { run } from '@openai/agents';
import type { TemplateHandler } from '../types';

export const budgetRebalance: TemplateHandler = {
  critical: false,
  async run(ctx) {
    const sections: Section[] = [];
    const changesetIds: string[] = [];
    for (const account of ctx.accounts) {
      if ((await getAutomationMode(ctx.db, account.id, 'budget_rebalance')) === 'off') {
        sections.push({ kind: 'text', heading: account.name, text: '預算再分配在此帳戶為關閉。' });
        continue;
      }
      if (!ctx.agents.bidding || !ctx.propose) {
        sections.push({ kind: 'text', heading: account.name, text: '略過：bidding agent 或提案功能未設定。' });
        continue;
      }
      const propose = ctx.propose;
      const context: AgentContext = {
        db: ctx.db,
        allowedAccountIds: [account.id],
        now: ctx.now,
        source: { kind: 'schedule', jobRunId: ctx.run.id },
        traceId: ctx.traceId ?? null,
        propose: async (input) => {
          const cs = await propose(input);
          changesetIds.push(cs.id);
          return cs;
        },
      };
      const prompt = [
        `排程任務：帳戶 ${account.name}（${account.externalId}）的跨 campaign 預算再分配。`,
        '1. 呼叫 run_budget_optimizer。2. 檢視結果，只有在有正當理由時排除 campaign。3. 若有值得調整的分配，呼叫 propose_budget_reallocation 並寫清楚解釋；若變動很小或不合理，不要送審並說明原因。',
        ctx.job.extraInstructions ? `額外指示：${ctx.job.extraInstructions}` : '',
        '最後用 3–5 點繁體中文總結結果。',
      ]
        .filter(Boolean)
        .join('\n');
      try {
        const result = await run(ctx.agents.bidding(), prompt, { context, maxTurns: 10 });
        sections.push({ kind: 'text', heading: account.name, text: String(result.finalOutput ?? '').trim() || '（沒有產生說明）' });
      } catch (err) {
        ctx.logger.error({ err, account: account.externalId }, 'budget rebalance failed');
        sections.push({ kind: 'text', heading: account.name, text: '執行失敗，請查看 log。' });
      }
    }
    return { messages: [{ type: 'report', title: '預算再分配', sections: sections.length ? sections : [{ kind: 'text', text: '沒有可處理的帳戶。' }] }], changesetIds };
  },
};

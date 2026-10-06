// custom_prompt (ADR-0016, Requirements 11.1, 11.3): the Orchestrator runs the job's own
// instructions. Its output is limited to a Report (structured, schema-validated) and to
// ChangeSets created through the propose_* tools; nothing here can mutate a platform (ADR-0006).
import { ORCHESTRATOR_INSTRUCTIONS, type AgentContext } from '@arlo/agents';
import type { ChatMessage, Section } from '@arlo/core';
import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import type { TemplateHandler } from '../types';

export const CustomReportSchema = z.object({
  title: z.string().min(1).max(150).describe('報告標題'),
  summary: z.string().min(1).max(2500).describe('重點摘要（繁體中文，條列）'),
  sections: z
    .array(z.object({ heading: z.string().max(150).nullable(), text: z.string().min(1).max(2500) }))
    .max(8)
    .describe('補充段落；沒有就給空陣列'),
});
export type CustomReport = z.infer<typeof CustomReportSchema>;

const PREAMBLE = [
  '這是排程任務，沒有使用者在線上，無法追問；請依下列指示完成並輸出報告。',
  '需要調整預算、出價或狀態時，只能透過專業 agent 的 propose 工具提出（會送審核，不會直接生效），並在報告中列出 ChangeSet 編號。',
  '指示：',
].join('\n');

export function reportMessage(report: CustomReport, changesetIds: readonly string[]): ChatMessage {
  const sections: Section[] = [
    { kind: 'text', text: report.summary },
    ...report.sections.map((s): Section => ({ kind: 'text', ...(s.heading ? { heading: s.heading } : {}), text: s.text })),
  ];
  if (changesetIds.length) sections.push({ kind: 'text', heading: '已送審的變更', text: changesetIds.map((id) => `• ChangeSet \`${id}\``).join('\n') });
  return { type: 'report', title: report.title, sections };
}

export const customPrompt: TemplateHandler = {
  critical: false,
  async run(ctx) {
    const instructions = ctx.job.extraInstructions?.trim();
    if (!instructions) return { messages: [{ type: 'notice', level: 'warn', text: `排程「${ctx.job.name}」沒有設定指示內容。` }], changesetIds: [] };
    if (ctx.accounts.length === 0) return { messages: [{ type: 'notice', level: 'warn', text: `排程「${ctx.job.name}」沒有可用的帳戶。` }], changesetIds: [] };

    const changesetIds: string[] = [];
    const propose = ctx.propose;
    const context: AgentContext = {
      db: ctx.db,
      allowedAccountIds: ctx.accounts.map((a) => a.id),
      now: ctx.now,
      source: { kind: 'schedule', jobRunId: ctx.run.id },
      traceId: ctx.traceId ?? null,
      ...(propose
        ? {
            propose: async (input) => {
              const cs = await propose(input);
              changesetIds.push(cs.id);
              return cs;
            },
          }
        : {}),
    };
    // Same Orchestrator (specialists, read and propose tools only) with a structured Report output.
    const base = ctx.agents.orchestrator();
    const agent = new Agent<AgentContext, typeof CustomReportSchema>({
      name: base.name,
      instructions: typeof base.instructions === 'string' ? base.instructions : ORCHESTRATOR_INSTRUCTIONS,
      model: base.model,
      modelSettings: base.modelSettings,
      tools: [...base.tools],
      outputType: CustomReportSchema,
    });
    const accounts = ctx.accounts.map((a) => `${a.name}（${a.externalId}）`).join('、');
    const result = await run(agent, `${PREAMBLE}\n${instructions}\n\n可用帳戶：${accounts}`, { context, maxTurns: 16 });
    const report = CustomReportSchema.parse(result.finalOutput);
    return { messages: [reportMessage(report, changesetIds)], changesetIds };
  },
};

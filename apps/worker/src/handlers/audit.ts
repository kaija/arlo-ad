// audit.explain (ADR-0017, Requirement 12.5): after a Monitor ChangeSet runs or is simulated, the
// audit agent explains the likely root cause from change history and metrics. When today's LLM
// budget is spent or the run fails, a deterministic template says what is known instead.
import { runGuard, trackedRun, type AgentContext } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import type { ChangeSet, NoticeAction } from '@arlo/core';
import { getAdAccount, getChangeSet, listChangeEvents, type AdAccount, type Db } from '@arlo/db';
import { defineJob, Jobs } from '@arlo/queue';
import { run, type Agent } from '@openai/agents';
import type { Executor } from './executor';

export interface AuditDeps {
  db: Db;
  logger: Logger;
  now: () => Date;
  executor: Executor;
  /** DAILY_LLM_BUDGET_USD (Requirement 19.3). */
  llmBudgetUsd: number;
  agents: { audit?: () => Agent<AgentContext> };
}

const LOOKBACK_MS = 48 * 3_600_000;

/** What is known without an LLM: the rule's evidence and recent changes to the same targets. */
export async function templateExplanation(db: Db, cs: ChangeSet, account: AdAccount, now: Date): Promise<string> {
  const ids = [...new Set(cs.ops.map((op) => op.target.id))];
  const events = (await listChangeEvents(db, { accountIds: [account.id], from: new Date(now.getTime() - LOOKBACK_MS), to: now, limit: 200 })).filter((e) =>
    ids.some((id) => e.resourceName?.includes(`/${id}`)),
  );
  const lines = [`觸發依據：${cs.rationale ?? cs.summary}`];
  if (events.length) {
    lines.push(`近 48 小時相關變更 ${events.length} 筆，最近一筆：${events[0]!.changedAt.toISOString()} ${events[0]!.userEmail ?? events[0]!.clientType ?? '未知'} 修改 ${events[0]!.changedFields.join(', ') || events[0]!.resourceType}`);
  } else {
    lines.push('近 48 小時沒有相關的人為變更紀錄；可能是市場或流量變化，或資料延遲。');
  }
  lines.push('（AI 分析暫時無法使用，以上為自動彙整。）');
  return lines.join('\n');
}

export async function explainChangeSet(deps: AuditDeps, changesetId: string): Promise<{ mode: 'agent' | 'template' | 'skipped' }> {
  const { db, executor } = deps;
  const cs = await getChangeSet(db, changesetId);
  if (!cs || (cs.status !== 'EXECUTED' && cs.status !== 'SIMULATED' && cs.status !== 'REVERTED')) return { mode: 'skipped' };
  const account = await getAdAccount(db, cs.accountId);
  if (!account) return { mode: 'skipped' };

  let text: string | null = null;
  const budget = await runGuard({ db, defaultBudgetUsd: deps.llmBudgetUsd, critical: false, now: deps.now });
  if (budget.run && deps.agents.audit) {
    const context: AgentContext = { db, allowedAccountIds: [account.id], now: deps.now };
    const prompt = [
      `帳戶 ${account.name}（${account.externalId}）的 Monitor 剛${cs.status === 'SIMULATED' ? '模擬（shadow，未實際執行）' : '執行'}了一個熔斷：`,
      cs.summary,
      `依據：${cs.rationale ?? '—'}`,
      `變更內容：${JSON.stringify(cs.ops.map((o) => ({ kind: o.kind, target: `${o.target.kind} ${o.target.id}`, before: o.before, after: o.after })))}`,
      `請用 3–5 點說明最可能的根因（查變更紀錄與成效），最後給建議。現在時間 ${deps.now().toISOString()}。`,
    ].join('\n');
    try {
      const { result } = await trackedRun({ db, name: 'audit.explain', ref: { kind: 'changeset', id: cs.id }, now: deps.now }, () => run(deps.agents.audit!(), prompt, { context, maxTurns: 8 }));
      text = String(result.finalOutput ?? '').trim() || null;
    } catch (err) {
      deps.logger.warn({ err, changeset_id: cs.id }, 'audit agent failed; using the template');
    }
  }
  const mode = text ? 'agent' : 'template';
  const body = text ?? (await templateExplanation(db, cs, account, deps.now()));
  const actions: NoticeAction[] = cs.status === 'EXECUTED' ? ['undo', 'keep'] : [];
  const heading = cs.status === 'SIMULATED' ? `Shadow 熔斷說明：${cs.summary}` : `熔斷說明：${cs.summary}`;
  await executor.post(cs, await executor.origin(cs), { type: 'notice', level: 'warn', text: `${heading}\n${body}`, changesetId: cs.id, actions }, 'notice');
  return { mode };
}

export function auditJobs(deps: AuditDeps) {
  return [defineJob(Jobs.auditExplain, async ({ changesetId }) => explainChangeSet(deps, changesetId))];
}

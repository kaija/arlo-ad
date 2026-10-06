import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createAuditAgent } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import type { Op } from '@arlo/core';
import { DEFAULT_ORG_ID, insertChangeEvents, insertChangeSet, schema, setAutomationMode, setSetting, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled } from '@openai/agents';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../sync/sync';
import { explainChangeSet, type AuditDeps } from './audit';
import { createExecutor } from './executor';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z');
const APPROVAL = 'CAPPROVAL';

describe('audit.explain', () => {
  const t = useTestDatabase();
  let fake: FakePlatformAdapter;
  let chat: FakeChatAdapter;
  let account: AdAccount;
  const queued: { name: string; data: unknown }[] = [];

  const executor = () =>
    createExecutor({ db: t.db, platform: fake, chat, logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack', channelId: APPROVAL }, enqueue: async (spec, data) => (queued.push({ name: spec.name, data }), 'id') });
  const deps = (over: Partial<AuditDeps> = {}): AuditDeps => ({
    db: t.db,
    logger,
    now: () => NOW,
    executor: executor(),
    llmBudgetUsd: 30,
    agents: { audit: () => createAuditAgent({ model: new ScriptedModel(() => [say('• 10/06 22:00 有人把 Brand 預算從 500 提高到 1000\n建議：維持熔斷')]) }) },
    ...over,
  });

  const freshPlatform = () =>
    new FakePlatformAdapter()
      .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
      .addEntities(ACC, [{ kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1_000_000_000, bidStrategy: null, bidTarget: null } }])
      .setClock(() => NOW);

  beforeAll(async () => {
    fake = freshPlatform();
    const sync = { db: t.db, platform: fake, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    await insertChangeEvents(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: account.id, externalId: 'ce-9', changedAt: new Date('2026-10-06T14:00:00Z'), userEmail: 'pat@example.com', resourceType: 'CAMPAIGN', resourceName: `customers/${ACC}/campaigns/111`, changedFields: ['status'] },
    ]);
  });

  beforeEach(async () => {
    fake = freshPlatform();
    chat = new FakeChatAdapter();
    if (account) await setAutomationMode(t.db, account.id, 'circuit_breaker', 'shadow', { kind: 'system' });
    queued.length = 0;
    await t.db.delete(schema.approvalMessages);
    await t.db.delete(schema.settings);
  });

  const breaker = async (op: Op) => {
    const cs = await insertChangeSet(t.db, { accountId: account.id, feature: 'circuit_breaker', source: { kind: 'monitor', monitorRuleId: 'r1' }, ops: [op], summary: '熔斷：Brand 今日花費達進度的 300% → 暫停', rationale: 'Monitor 規則 SpendPacing：{"pacing":3}', requestedBy: { kind: 'system' } });
    await executor().process(cs.id);
    return cs.id;
  };
  const pause: Op = { kind: 'set_status', target: { platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '111' }, field: 'status', before: 'ENABLED', after: 'PAUSED' };
  const notices = () => chat.postedTo(APPROVAL).filter((m) => m.message.type === 'notice').map((m) => m.message);

  it('queues the explanation when a Monitor ChangeSet is simulated, and posts it without actions', async () => {
    const id = await breaker(pause);
    expect(queued).toEqual([{ name: 'audit.explain', data: { changesetId: id } }]);
    expect(await explainChangeSet(deps(), id)).toEqual({ mode: 'agent' });
    expect(notices()).toEqual([{ type: 'notice', level: 'warn', text: expect.stringContaining('Shadow 熔斷說明'), changesetId: id, actions: [] }]);
  });

  it('offers Undo and Keep after a live execution', async () => {
    await setAutomationMode(t.db, account.id, 'circuit_breaker', 'live', { kind: 'system' });
    const id = await breaker(pause);
    await explainChangeSet(deps(), id);
    expect(notices().at(-1)).toMatchObject({ text: expect.stringContaining('建議：維持熔斷'), actions: ['undo', 'keep'] });
  });

  it('falls back to a template when the LLM budget is spent', async () => {
    await setSetting(t.db, 'daily_llm_budget_usd', 0);
    const id = await breaker(pause);
    const result = await explainChangeSet(deps(), id);
    expect(result).toEqual({ mode: 'template' });
    expect(notices().at(-1)).toMatchObject({ text: expect.stringMatching(/觸發依據：Monitor 規則 SpendPacing[\s\S]*pat@example\.com[\s\S]*AI 分析暫時無法使用/) });
  });

  it('falls back to a template when the agent fails, and skips ChangeSets that did not run', async () => {
    const id = await breaker(pause);
    const broken = deps({ agents: { audit: () => createAuditAgent({ model: new ScriptedModel(() => { throw new Error('model down'); }) }) } });
    expect(await explainChangeSet(broken, id)).toEqual({ mode: 'template' });
    const pending = await insertChangeSet(t.db, { accountId: account.id, source: { kind: 'monitor' }, ops: [pause], summary: 'x', requestedBy: { kind: 'system' } });
    expect(await explainChangeSet(deps(), pending.id)).toEqual({ mode: 'skipped' });
  });
});

// Executor (ADR-0006, design.md flow 2): the only code that writes to an ad platform. No LLM:
// validate → tier → auto-execute (Tier 1) or request approval (Tier ≥ 2), and after approval
// re-fetch → diff → re-validate → mutate. Every status change is a CAS with an audit row.
import type { ChatAdapter } from '@arlo/adapters/chat';
import type { PlatformAdapter } from '@arlo/adapters/platform';
import { assertWriteAllowed, WriteNotAllowedError } from '@arlo/config';
import type { Logger } from '@arlo/config/logger';
import {
  changeSetView,
  computeTier,
  diffCurrent,
  entityKey,
  hasHardBlock,
  validate,
  type ChangeSet,
  type ChangeSetEvent,
  type ChatMessage,
  type ConversationRef,
  type Drift,
  type OpResult,
  type Violation,
} from '@arlo/core';
import {
  addApprovalMessage,
  applyTransition,
  getAdAccount,
  getChangeSet,
  getUserWithBindings,
  listApprovalMessages,
  loadOpTargetNames,
  loadRules,
  loadTierThresholds,
  loadValidationContext,
  recordOpResults,
  type Actor,
  type AdAccount,
  type Db,
  type StoredChangeSet,
} from '@arlo/db';
import { defineJob, Jobs } from '@arlo/queue';

export interface ExecutorDeps {
  db: Db;
  platform: PlatformAdapter;
  chat: ChatAdapter;
  logger: Logger;
  now: () => Date;
  /** ADS_WRITE_ALLOWED_CUSTOMER_IDS (ADR-0026). */
  writeAllowedCustomerIds: readonly string[];
  /** SLACK_APPROVAL_CHANNEL_ID: where non-conversation ChangeSets are reviewed. */
  approvalChannel: ConversationRef;
}

/** Approval TTL (Requirement 6.1): 24h, shorter for circuit-breaker follow-ups (ADR-0009). */
export function approvalTtlMs(cs: Pick<ChangeSet, 'feature'>): number {
  return (cs.feature === 'circuit_breaker' ? 4 : 24) * 3_600_000;
}

const SYSTEM: Actor = { kind: 'system' };

export function describeDrift(drifts: readonly Drift[]): string {
  return drifts
    .map((d) => (d.reason === 'missing' ? `op ${d.opIndex + 1}：目標已不存在` : `op ${d.opIndex + 1}：${d.field} 提議時為 ${String(d.expected)}，現在是 ${String(d.actual)}`))
    .join('；');
}

const violationText = (violations: readonly Violation[]) => violations.map((v) => `• ${v.message}`).join('\n');

function failureReason(results: readonly OpResult[]): string {
  const failed = results.filter((r) => !r.ok);
  return `${failed.length}/${results.length} 個變更失敗：${failed.map((r) => `op ${r.index + 1} ${r.error ?? ''}`.trim()).join('；')}`;
}

export function createExecutor(deps: ExecutorDeps) {
  const { db, chat, logger } = deps;

  async function account(cs: ChangeSet): Promise<AdAccount> {
    const acc = await getAdAccount(db, cs.accountId);
    if (!acc) throw new Error(`ad account ${cs.accountId} not found`);
    return acc;
  }

  /** Where the ChangeSet's cards and notices go: the source thread, else the approval channel. */
  function origin(cs: ChangeSet): ConversationRef {
    return cs.source.ref ?? deps.approvalChannel;
  }

  async function view(cs: ChangeSet, acc: AdAccount, outcome?: Parameters<typeof changeSetView>[1]['outcome']) {
    const [names, requester] = await Promise.all([
      loadOpTargetNames(db, acc, cs.ops),
      cs.requestedBy.userId ? getUserWithBindings(db, cs.requestedBy.userId) : undefined,
    ]);
    const requestedBy = requester ? (requester.displayName ?? requester.googleEmail) : cs.requestedBy.kind === 'agent' ? 'Arlo' : cs.requestedBy.kind === 'system' ? '系統' : undefined;
    return changeSetView(cs, { accountName: acc.name, currency: acc.currency, names, requestedBy, outcome });
  }

  /** Chat is best effort: a Slack outage must not undo or repeat a state change. */
  async function post(cs: ChangeSet, ref: ConversationRef, msg: ChatMessage, kind?: 'origin' | 'mirror' | 'notice') {
    try {
      const posted = await chat.post(ref, msg);
      if (kind) await addApprovalMessage(db, { changesetId: cs.id, channelId: posted.channelId, messageId: posted.messageId, threadId: posted.threadId ?? null, kind });
      return posted;
    } catch (err) {
      logger.error({ err, changeset_id: cs.id }, 'failed to post ChangeSet message');
      return undefined;
    }
  }

  async function move(seen: ChangeSet, event: ChangeSetEvent, actor: Actor, reason?: string | null, payload?: Record<string, unknown>) {
    const result = await applyTransition(db, seen, event, actor, { reason, payload });
    if (!result.ok) logger.info({ changeset_id: seen.id, from: seen.status, event: event.type, now: result.current?.status }, 'ChangeSet moved concurrently');
    return result;
  }

  /** Live values that no longer match the proposal (ADR-0009). */
  async function drift(cs: ChangeSet): Promise<Drift[]> {
    const refs = cs.ops.filter((op) => op.field).map((op) => op.target);
    if (refs.length === 0) return [];
    const current = await deps.platform.fetchCurrent(refs);
    return diffCurrent(cs.ops, current, (op) => entityKey(op.target));
  }

  /** EXECUTING → EXECUTED / FAILED. Each op's result is kept (Requirement 3.5). */
  async function runOps(cs: StoredChangeSet, acc: AdAccount, actor: Actor): Promise<StoredChangeSet> {
    let results: OpResult[];
    try {
      assertWriteAllowed(deps.writeAllowedCustomerIds, acc.externalId);
      results = await deps.platform.applyOps(acc.externalId, cs.ops);
    } catch (err) {
      const error = err instanceof WriteNotAllowedError ? `${err.code}: ${err.message}` : `APPLY_FAILED: ${(err as Error).message}`;
      logger.error({ err, changeset_id: cs.id }, 'applyOps failed');
      results = cs.ops.map((_, index) => ({ index, ok: false, error }));
    }
    await recordOpResults(db, cs.id, results);
    const ok = results.length === cs.ops.length && results.every((r) => r.ok);
    const event: ChangeSetEvent = ok ? { type: 'executed', at: deps.now() } : { type: 'fail' };
    const moved = await move(cs, event, actor, ok ? null : failureReason(results), { results: results.map((r) => ({ index: r.index, ok: r.ok, error: r.error ?? null })) });
    if (!moved.ok) throw new Error(`ChangeSet ${cs.id} left EXECUTING concurrently`);
    return moved.changeset;
  }

  async function postApprovalRequest(cs: StoredChangeSet, acc: AdAccount) {
    await post(cs, origin(cs), { type: 'approval_request', changeset: await view(cs, acc) }, 'origin');
  }

  /**
   * changeset.process: PENDING_VALIDATION → BLOCKED | STALE | EXECUTED/FAILED (Tier 1) |
   * PENDING_APPROVAL (Tier ≥ 2). Safe to retry: a ChangeSet already past validation is skipped
   * (an approval request whose card never got posted is posted then).
   */
  async function processChangeSet(changesetId: string): Promise<StoredChangeSet | undefined> {
    const cs = await getChangeSet(db, changesetId);
    if (!cs) {
      logger.warn({ changeset_id: changesetId }, 'ChangeSet not found');
      return undefined;
    }
    const acc = await account(cs);
    if (cs.status !== 'PENDING_VALIDATION') {
      if (cs.status === 'PENDING_APPROVAL' && (await listApprovalMessages(db, cs.id)).length === 0) await postApprovalRequest(cs, acc);
      return cs;
    }
    const log = logger.child({ changeset_id: cs.id });

    const [ctx, rules, thresholds] = await Promise.all([
      loadValidationContext(db, acc, cs.ops, deps.now()),
      loadRules(db, acc.id),
      loadTierThresholds(db, acc.id),
    ]);
    const violations = validate(cs, ctx, rules);

    if (hasHardBlock(violations)) {
      const moved = await move(cs, { type: 'block', violations }, SYSTEM, 'validator hard block');
      if (moved.ok) {
        log.info({ violations: violations.length }, 'ChangeSet blocked');
        await post(moved.changeset, origin(cs), { type: 'notice', level: 'error', text: `變更已被擋下：${cs.summary}\n${violationText(violations.filter((v) => v.severity === 'HARD_BLOCK'))}`, changesetId: cs.id }, 'notice');
      }
      return moved.ok ? moved.changeset : moved.current;
    }

    const tier = computeTier(cs, thresholds, violations);
    if (tier >= 2) {
      const moved = await move(cs, { type: 'request_approval', tier, violations, expiresAt: new Date(deps.now().getTime() + approvalTtlMs(cs)) }, SYSTEM);
      if (!moved.ok) return moved.current;
      log.info({ tier }, 'ChangeSet awaiting approval');
      await postApprovalRequest(moved.changeset, acc);
      return moved.changeset;
    }

    // Tier 1: protective, runs now. Never overwrite a change made since the proposal.
    const drifts = await drift(cs);
    if (drifts.length) {
      const moved = await move(cs, { type: 'stale' }, SYSTEM, describeDrift(drifts), { drifts });
      if (moved.ok) await post(moved.changeset, origin(cs), { type: 'notice', level: 'warn', text: `帳戶現況已變更，未執行：${cs.summary}\n${describeDrift(drifts)}`, changesetId: cs.id }, 'notice');
      return moved.ok ? moved.changeset : moved.current;
    }
    const executing = await move(cs, { type: 'auto_execute', tier, violations }, SYSTEM);
    if (!executing.ok) return executing.current;
    const done = await runOps(executing.changeset, acc, SYSTEM);
    log.info({ status: done.status }, 'Tier 1 ChangeSet executed');
    await post(
      done,
      origin(cs),
      done.status === 'EXECUTED'
        ? { type: 'notice', level: 'info', text: `已自動執行（Tier 1）：${cs.summary}\n${(await view(done, acc)).ops.map((o) => `• ${o.label}：${o.before} → ${o.after}`).join('\n')}`, changesetId: cs.id, actions: ['undo'] }
        : { type: 'notice', level: 'error', text: `自動執行失敗：${cs.summary}\n${done.statusReason ?? ''}`, changesetId: cs.id },
      'notice',
    );
    return done;
  }

  return { process: processChangeSet, drift, runOps, view, post, move, origin, account };
}

export type Executor = ReturnType<typeof createExecutor>;

export function executorJobs(deps: ExecutorDeps) {
  const executor = createExecutor(deps);
  return [
    defineJob(Jobs.changesetProcess, async (data) => {
      await executor.process(data.changesetId);
    }),
  ];
}

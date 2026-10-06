// Executor (ADR-0006, design.md flow 2): the only code that writes to an ad platform. No LLM:
// validate → tier → auto-execute (Tier 1) or request approval (Tier ≥ 2), and after approval
// re-fetch → diff → re-validate → mutate. Every status change is a CAS with an audit row.
import type { ChatAdapter } from '@arlo/adapters/chat';
import type { PlatformAdapter } from '@arlo/adapters/platform';
import { assertWriteAllowed, WriteNotAllowedError } from '@arlo/config';
import type { Logger } from '@arlo/config/logger';
import {
  authorize,
  computeTier,
  diffCurrent,
  entityKey,
  hasHardBlock,
  validate,
  type ChangeSet,
  type ChangeSetEvent,
  type ChangeSetStatus,
  type ChangeSetView,
  type ChatMessage,
  ConversationRefSchema,
  type ConversationRef,
  type Drift,
  type OpResult,
  type Violation,
} from '@arlo/core';
import {
  addApprovalMessage,
  applyTransition,
  claimSlaReminder,
  getSetting,
  getAdAccount,
  getAutomationMode,
  getChangeSet,
  getUserWithBindings,
  insertChangeSet,
  listApprovalMessages,
  listAudit,
  listActiveSlackUsers,
  listExpiredPending,
  listSlaOverdue,
  loadChangeSetView,
  loadRules,
  loadTierThresholds,
  loadValidationContext,
  recordOpResults,
  scheduleTargetForRun,
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

/** Approval SLA before approvers are reminded (Requirement 7.5); setting `approval_sla_minutes`. */
export const DEFAULT_APPROVAL_SLA_MINUTES = 120;
export const APPROVAL_SLA_SETTING = 'approval_sla_minutes';

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

export type ApproveOutcome = 'executed' | 'failed' | 'stale' | 'blocked' | 'expired' | 'not_pending' | 'not_found';

export interface ApproveResult {
  outcome: ApproveOutcome;
  status: ChangeSetStatus | null;
  changeset?: StoredChangeSet;
  /** Who handled it first, for "already handled by @x" (Requirement 6.6). */
  handledBy?: string | null;
}

/** Undo window after execution (ADR-0012). */
export const UNDO_WINDOW_MS = 24 * 3_600_000;

export type UndoResult =
  | { ok: true; revert: StoredChangeSet }
  | {
      ok: false;
      reason: 'not_found' | 'forbidden' | 'not_executed' | 'window_passed' | 'not_revertible' | 'drift' | 'in_progress' | 'failed';
      /** For drift: what is live now and who changed it last, when change history tells (Requirement 8.4). */
      drifts?: Drift[];
      lastModifiedBy?: string | null;
      revert?: StoredChangeSet;
    };

export type RejectResult = { ok: true; changeset: StoredChangeSet } | { ok: false; status: ChangeSetStatus | null; handledBy?: string | null; changeset?: StoredChangeSet };

export function createExecutor(deps: ExecutorDeps) {
  const { db, chat, logger } = deps;

  async function account(cs: ChangeSet): Promise<AdAccount> {
    const acc = await getAdAccount(db, cs.accountId);
    if (!acc) throw new Error(`ad account ${cs.accountId} not found`);
    return acc;
  }

  /**
   * Where the ChangeSet's card and notices go (ADR-0011, Requirements 7.1, 7.2): the source
   * conversation; for schedules the job's target channel; otherwise the approval channel.
   */
  async function origin(cs: ChangeSet): Promise<ConversationRef> {
    if (cs.source.ref) return cs.source.ref;
    if (cs.source.kind === 'schedule' && cs.source.jobRunId) {
      const target = ConversationRefSchema.safeParse(await scheduleTargetForRun(db, cs.source.jobRunId));
      if (target.success) return target.data;
    }
    return deps.approvalChannel;
  }

  /** Link back to the source thread (or the origin card) for mirrors (Requirement 7.3). */
  async function sourceLink(cs: ChangeSet, originCard: { channelId: string; messageId: string } | undefined): Promise<string | undefined> {
    const ref = cs.source.ref;
    const target = ref?.threadId ? { channelId: ref.channelId, messageId: ref.threadId } : originCard;
    if (!target) return undefined;
    return chat.permalink({ platform: 'slack', ...target }).catch((err: unknown) => {
      logger.warn({ err, changeset_id: cs.id }, 'failed to get permalink');
      return undefined;
    });
  }

  const view = (cs: ChangeSet, acc: AdAccount, outcome?: ChangeSetView['outcome']) => loadChangeSetView(db, cs, acc, outcome);

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

  async function userName(userId: string | null | undefined): Promise<string | undefined> {
    if (!userId) return undefined;
    const u = await getUserWithBindings(db, userId);
    return u ? (u.displayName ?? u.googleEmail) : undefined;
  }

  /** Who moved the ChangeSet to its current status, from the audit trail. */
  async function handledBy(cs: StoredChangeSet): Promise<string | null> {
    if (cs.approvedBy) return (await userName(cs.approvedBy)) ?? null;
    const last = (await listAudit(db, 'changeset', cs.id)).filter((a) => a.toStatus === cs.status).at(-1);
    return last?.actorKind === 'user' ? ((await userName(last.actorId)) ?? null) : last ? '系統' : null;
  }

  /** Updates every approval card of the ChangeSet with its outcome (Requirement 7.4). */
  async function refreshCards(cs: StoredChangeSet, acc: AdAccount, actor?: string | null) {
    const outcome: ChangeSetView['outcome'] = {
      status: cs.status,
      ...(actor ? { actor } : {}),
      at: (cs.executedAt ?? cs.updatedAt).toISOString(),
      ...(cs.statusReason ? { reason: cs.statusReason } : {}),
    };
    const v = await view(cs, acc, outcome);
    const cards = (await listApprovalMessages(db, cs.id)).filter((m) => m.kind !== 'notice');
    const link = cards.some((m) => m.kind === 'mirror') ? await sourceLink(cs, cards.find((m) => m.kind === 'origin')) : undefined;
    for (const m of cards) {
      const changeset = m.kind === 'mirror' && link ? { ...v, sourceLink: link } : v;
      try {
        await chat.update({ platform: 'slack', channelId: m.channelId, messageId: m.messageId, ...(m.threadId ? { threadId: m.threadId } : {}) }, { type: 'approval_request', changeset, mirror: m.kind === 'mirror' });
      } catch (err) {
        logger.error({ err, changeset_id: cs.id, channel: m.channelId }, 'failed to update approval card');
      }
    }
  }

  async function notify(cs: StoredChangeSet, level: 'info' | 'warn' | 'error', text: string) {
    await post(cs, await origin(cs), { type: 'notice', level, text, changesetId: cs.id }, 'notice');
  }

  /** The card in the origin conversation, plus a mirror in the approval channel when elsewhere. */
  async function postApprovalRequest(cs: StoredChangeSet, acc: AdAccount) {
    const where = await origin(cs);
    const v = await view(cs, acc);
    const card = await post(cs, where, { type: 'approval_request', changeset: v }, 'origin');
    if (where.channelId === deps.approvalChannel.channelId) return;
    const link = await sourceLink(cs, card);
    await post(cs, deps.approvalChannel, { type: 'approval_request', changeset: { ...v, ...(link ? { sourceLink: link } : {}) }, mirror: true }, 'mirror');
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
        await post(moved.changeset, await origin(cs), { type: 'notice', level: 'error', text: `變更已被擋下：${cs.summary}\n${violationText(violations.filter((v) => v.severity === 'HARD_BLOCK'))}`, changesetId: cs.id }, 'notice');
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
      if (moved.ok) await post(moved.changeset, await origin(cs), { type: 'notice', level: 'warn', text: `帳戶現況已變更，未執行：${cs.summary}\n${describeDrift(drifts)}`, changesetId: cs.id }, 'notice');
      return moved.ok ? moved.changeset : moved.current;
    }

    // Automations follow their mode right before the mutate step (ADR-0013), so shadow and live
    // share every check above. ChangeSets without a feature (people's requests) always run.
    const mode = cs.feature ? await getAutomationMode(db, acc.id, cs.feature) : 'live';
    if (mode === 'off') {
      const off: Violation = { ruleId: 'automation_mode', ruleType: 'AUTOMATION_OFF', severity: 'HARD_BLOCK', message: `自動化 ${cs.feature} 在此帳戶為 off` };
      const moved = await move(cs, { type: 'block', violations: [...violations, off] }, SYSTEM, 'automation off');
      return moved.ok ? moved.changeset : moved.current;
    }
    if (mode === 'shadow') {
      const simulated = await move(cs, { type: 'simulate', tier, violations }, SYSTEM, 'shadow mode: not executed', { feature: cs.feature });
      if (!simulated.ok) return simulated.current;
      log.info({ feature: cs.feature }, 'ChangeSet simulated (shadow)');
      await post(simulated.changeset, await origin(cs), { type: 'shadow_result', changeset: await view(simulated.changeset, acc) }, 'origin');
      return simulated.changeset;
    }

    const executing = await move(cs, { type: 'auto_execute', tier, violations }, SYSTEM);
    if (!executing.ok) return executing.current;
    const done = await runOps(executing.changeset, acc, SYSTEM);
    log.info({ status: done.status }, 'Tier 1 ChangeSet executed');
    await post(
      done,
      await origin(cs),
      done.status === 'EXECUTED'
        ? { type: 'notice', level: 'info', text: `已自動執行（Tier 1）：${cs.summary}\n${(await view(done, acc)).ops.map((o) => `• ${o.label}：${o.before} → ${o.after}`).join('\n')}`, changesetId: cs.id, actions: ['undo'] }
        : { type: 'notice', level: 'error', text: `自動執行失敗：${cs.summary}\n${done.statusReason ?? ''}`, changesetId: cs.id },
      'notice',
    );
    return done;
  }

  /**
   * Approve (ADR-0009): CAS PENDING_APPROVAL → APPROVED, then re-fetch and diff (→ STALE),
   * re-validate with fresh context (→ BLOCKED), mutate (→ EXECUTED / FAILED). Authorization is
   * the caller's job; a second click finds the ChangeSet no longer pending.
   */
  async function approve(changesetId: string, userId: string): Promise<ApproveResult> {
    const cs = await getChangeSet(db, changesetId);
    if (!cs) return { outcome: 'not_found', status: null };
    if (cs.status !== 'PENDING_APPROVAL') return { outcome: 'not_pending', status: cs.status, changeset: cs, handledBy: await handledBy(cs) };
    const acc = await account(cs);
    const actor: Actor = { kind: 'user', id: userId };
    const log = logger.child({ changeset_id: cs.id });

    if (cs.expiresAt && cs.expiresAt <= deps.now()) {
      const expired = await move(cs, { type: 'expire' }, SYSTEM, '已超過審核期限');
      if (!expired.ok) return { outcome: 'not_pending', status: expired.current?.status ?? null, changeset: expired.current };
      await refreshCards(expired.changeset, acc, '系統');
      return { outcome: 'expired', status: 'EXPIRED', changeset: expired.changeset };
    }

    const approved = await move(cs, { type: 'approve', by: userId }, actor);
    if (!approved.ok) {
      const current = approved.current;
      return { outcome: 'not_pending', status: current?.status ?? null, changeset: current, handledBy: current ? await handledBy(current) : null };
    }
    const approver = await userName(userId);
    let current = approved.changeset;

    const drifts = await drift(current);
    if (drifts.length) {
      const stale = await move(current, { type: 'stale' }, SYSTEM, describeDrift(drifts), { drifts });
      if (!stale.ok) throw new Error(`ChangeSet ${cs.id} left APPROVED concurrently`);
      log.info({ drifts: drifts.length }, 'ChangeSet stale at approval');
      await refreshCards(stale.changeset, acc, approver);
      await notify(stale.changeset, 'warn', `帳戶現況已在提議後變更，未執行，請重新提議：${cs.summary}\n${describeDrift(drifts)}`);
      return { outcome: 'stale', status: 'STALE', changeset: stale.changeset };
    }

    const [ctx, rules] = await Promise.all([loadValidationContext(db, acc, current.ops, deps.now()), loadRules(db, acc.id)]);
    const violations = validate(current, ctx, rules);
    if (hasHardBlock(violations)) {
      const blocked = await move(current, { type: 'block', violations }, SYSTEM, '執行前重驗未通過');
      if (!blocked.ok) throw new Error(`ChangeSet ${cs.id} left APPROVED concurrently`);
      await refreshCards(blocked.changeset, acc, approver);
      await notify(blocked.changeset, 'error', `執行前重驗未通過，未執行：${cs.summary}\n${violationText(violations.filter((v) => v.severity === 'HARD_BLOCK'))}`);
      return { outcome: 'blocked', status: 'BLOCKED', changeset: blocked.changeset };
    }

    const executing = await move(current, { type: 'execute' }, actor);
    if (!executing.ok) throw new Error(`ChangeSet ${cs.id} left APPROVED concurrently`);
    current = await runOps(executing.changeset, acc, actor);
    log.info({ status: current.status }, 'approved ChangeSet executed');
    await refreshCards(current, acc, approver);
    if (current.status === 'FAILED') await notify(current, 'error', `執行失敗：${cs.summary}\n${current.statusReason ?? ''}`);
    return { outcome: current.status === 'EXECUTED' ? 'executed' : 'failed', status: current.status, changeset: current };
  }

  /** Reject with an optional reason (Requirement 6.5). Idempotent like approve. */
  async function reject(changesetId: string, userId: string, reason?: string | null): Promise<RejectResult> {
    const cs = await getChangeSet(db, changesetId);
    if (!cs) return { ok: false, status: null };
    if (cs.status !== 'PENDING_APPROVAL') return { ok: false, status: cs.status, changeset: cs, handledBy: await handledBy(cs) };
    const text = reason?.trim() || null;
    const moved = await move(cs, { type: 'reject', by: userId, reason: text ?? undefined }, { kind: 'user', id: userId }, text);
    if (!moved.ok) {
      const current = moved.current;
      return { ok: false, status: current?.status ?? null, changeset: current, handledBy: current ? await handledBy(current) : null };
    }
    await refreshCards(moved.changeset, await account(cs), await userName(userId));
    return { ok: true, changeset: moved.changeset };
  }

  /** EXPIRED for every pending ChangeSet past expires_at; returns how many expired. */
  async function expireDue(): Promise<number> {
    let n = 0;
    for (const cs of await listExpiredPending(db, deps.now())) {
      const moved = await move(cs, { type: 'expire' }, SYSTEM, '已超過審核期限');
      if (!moved.ok) continue;
      n++;
      const acc = await account(cs);
      await refreshCards(moved.changeset, acc, '系統');
      await notify(moved.changeset, 'warn', `審核逾期，變更未執行：${cs.summary}`);
    }
    if (n) logger.info({ expired: n }, 'expired pending ChangeSets');
    return n;
  }

  /** Users who may approve the ChangeSet, by Slack id (the requester is excluded for Tier 3). */
  async function eligibleApprovers(cs: StoredChangeSet): Promise<string[]> {
    const target = { accountId: cs.accountId, tier: cs.tier, requestedByUserId: cs.requestedBy.userId };
    return (await listActiveSlackUsers(db)).filter((u) => authorize(u, 'approve', target).allowed).map((u) => u.slackUserId!);
  }

  /** One reminder per ChangeSet pending past the SLA, in the approval channel; returns how many. */
  async function remindSla(): Promise<number> {
    const configured = Number(await getSetting<number>(db, APPROVAL_SLA_SETTING));
    const minutes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_APPROVAL_SLA_MINUTES;
    const now = deps.now();
    let n = 0;
    for (const cs of await listSlaOverdue(db, new Date(now.getTime() - minutes * 60_000))) {
      if (!(await claimSlaReminder(db, cs.id, now))) continue;
      n++;
      const acc = await account(cs);
      const mentions = await eligibleApprovers(cs);
      const card = (await listApprovalMessages(db, cs.id)).find((m) => m.channelId === deps.approvalChannel.channelId && m.kind !== 'notice');
      const link = card ? await chat.permalink({ platform: 'slack', channelId: card.channelId, messageId: card.messageId }).catch(() => undefined) : undefined;
      const hours = Math.round(((now.getTime() - cs.createdAt.getTime()) / 3_600_000) * 10) / 10;
      const text = `待審核已超過 ${hours} 小時（Tier ${cs.tier ?? '?'} · ${acc.name}）：${cs.summary}${link ? `\n<${link}|前往審核>` : ''}${mentions.length ? '' : '\n目前沒有可核准的 approver，請 admin 調整權限。'}`;
      await post(cs, deps.approvalChannel, { type: 'notice', level: 'warn', text, changesetId: cs.id, mentions }, 'notice');
    }
    if (n) logger.info({ reminded: n }, 'approval SLA reminders sent');
    return n;
  }

  /** Who last changed the drifted targets after `since`, from live change history. */
  async function lastModifier(acc: AdAccount, cs: ChangeSet, drifts: readonly Drift[], since: Date): Promise<string | null> {
    try {
      const events = await deps.platform.fetchChangeHistory(acc.externalId, since);
      const targets = drifts.map((d) => cs.ops[d.opIndex]!);
      const touched = events.filter((e) =>
        targets.some((op) => e.resourceName?.endsWith(`/${op.target.id}`) || (op.field === 'budget_micros' && e.resourceType === 'CAMPAIGN_BUDGET')),
      );
      // Latest change wins; on equal times the later one in the (chronological) history.
      const last = touched.reduce<(typeof touched)[number] | undefined>((best, e) => (!best || e.changedAt >= best.changedAt ? e : best), undefined);
      return last ? (last.userEmail ?? last.clientType ?? null) : null;
    } catch (err) {
      logger.warn({ err, changeset_id: cs.id }, 'change history lookup failed');
      return null;
    }
  }

  /**
   * Undo (ADR-0012, Requirements 8.1–8.5): within 24h of execution, operator or above, and only
   * when every target still holds the value we wrote. Skips validator and approval; the revert
   * is a new ChangeSet (`revert_of`) and the original becomes REVERTED.
   */
  async function undo(changesetId: string, userId: string): Promise<UndoResult> {
    const original = await getChangeSet(db, changesetId);
    if (!original) return { ok: false, reason: 'not_found' };
    const user = await getUserWithBindings(db, userId);
    if (!user || !authorize(user, 'undo', { accountId: original.accountId }).allowed) return { ok: false, reason: 'forbidden' };
    if (original.status !== 'EXECUTED' || !original.executedAt) return { ok: false, reason: 'not_executed' };
    if (deps.now().getTime() - original.executedAt.getTime() > UNDO_WINDOW_MS) return { ok: false, reason: 'window_passed' };
    // Creates (keywords, negatives, campaigns) have no inverse op yet.
    if (original.ops.some((op) => !op.field)) return { ok: false, reason: 'not_revertible' };

    const acc = await account(original);
    const inverse = original.ops.map((op) => ({ kind: op.kind, target: op.target, field: op.field, before: op.after, after: op.before }));
    const drifts = await drift({ ...original, ops: inverse });
    if (drifts.length) {
      return { ok: false, reason: 'drift', drifts, lastModifiedBy: await lastModifier(acc, original, drifts, original.executedAt) };
    }

    let revert: StoredChangeSet;
    try {
      revert = await insertChangeSet(db, {
        accountId: original.accountId,
        source: { kind: 'undo', ...(original.source.ref ? { ref: original.source.ref } : {}) },
        ops: inverse,
        summary: `還原：${original.summary}`,
        requestedBy: { kind: 'user', userId },
        revertOf: original.id,
      });
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505' || (err as { code?: string }).code === '23505') return { ok: false, reason: 'in_progress' };
      throw err;
    }
    const actor: Actor = { kind: 'user', id: userId };
    const executing = await move(revert, { type: 'auto_execute', tier: original.tier ?? 1 }, actor, 'undo: no validator or approval (ADR-0012)');
    if (!executing.ok) return { ok: false, reason: 'in_progress' };
    const done = await runOps(executing.changeset, acc, actor);
    const name = await userName(userId);
    if (done.status !== 'EXECUTED') {
      await notify(done, 'error', `還原失敗：${original.summary}\n${done.statusReason ?? ''}`);
      return { ok: false, reason: 'failed', revert: done };
    }
    const reverted = await move(original, { type: 'revert' }, actor, `reverted by ${done.id}`, { revertId: done.id });
    if (!reverted.ok) logger.error({ changeset_id: original.id, revert_id: done.id }, 'original left EXECUTED concurrently');
    await notify(done, 'info', `${name ?? '使用者'} 已還原：${original.summary}`);
    return { ok: true, revert: done };
  }

  return { process: processChangeSet, approve, expireDue, remindSla, undo, reject, refreshCards, notify, drift, runOps, view, post, move, origin, account, handledBy, userName };
}

export type Executor = ReturnType<typeof createExecutor>;

export function executorJobs(executor: Executor) {
  return [
    defineJob(Jobs.changesetProcess, async (data) => {
      await executor.process(data.changesetId);
    }),
    defineJob(Jobs.changesetExpire, async () => ({ expired: await executor.expireDue() })),
    defineJob(Jobs.changesetRemind, async () => ({ reminded: await executor.remindSla() })),
  ];
}

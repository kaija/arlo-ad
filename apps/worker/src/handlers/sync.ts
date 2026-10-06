// Sync jobs (ADR-0003). A scheduled run without accountId fans out one job per active account,
// so pg-boss retries (exponential backoff, Requirement 2.6) only the account that failed.
import { getAdAccount, getSyncState, listActiveAccounts, markSyncAlerted, recordSyncAttempt, type AdAccount, type SyncState } from '@arlo/db';
import { defineJob, Jobs, type JobData, type JobDefinition, type JobSpec } from '@arlo/queue';
import { cleanupHourlyMetrics, syncAccounts, syncDaily, syncHourly, syncSnapshots, type SyncDeps } from '../sync/sync';

export interface OpsNotice {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface SyncJobDeps extends SyncDeps {
  enqueue: <J extends JobSpec>(spec: J, data: JobData<J>) => Promise<string>;
  /** Posts to the ops channel (Requirement 2.6). */
  notifyOps: (notice: OpsNotice) => Promise<void>;
}

/** Consecutive failed attempts of one account × job before ops is alerted (Requirement 2.6). */
export const SYNC_FAILURE_ALERT_THRESHOLD = 3;

export type SyncAlert = 'failing' | 'recovered' | null;

/** Alert once per failure streak, and once when a streak that alerted recovers. */
export function syncAlert(previous: Pick<SyncState, 'alertedAt'> | undefined, current: Pick<SyncState, 'consecutiveFailures' | 'alertedAt'>): SyncAlert {
  if (current.consecutiveFailures >= SYNC_FAILURE_ALERT_THRESHOLD && !current.alertedAt) return 'failing';
  if (current.consecutiveFailures === 0 && previous?.alertedAt) return 'recovered';
  return null;
}

type SyncSpec = typeof Jobs.syncSnapshots | typeof Jobs.syncHourly | typeof Jobs.syncDaily;

/** Short, credential-free description of a sync error for sync_state. */
export function syncErrorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string' || typeof e?.code === 'number') return String(e.code);
  return String(e?.message ?? e?.name ?? 'error').slice(0, 200);
}

export function syncJobs(deps: SyncJobDeps): JobDefinition[] {
  const job = (spec: SyncSpec, work: (d: SyncDeps, a: AdAccount) => Promise<unknown>, fanOut: () => Promise<AdAccount[]>, after?: () => Promise<unknown>) =>
    defineJob(spec, async ({ accountId }, ctx) => {
      if (!accountId) {
        const accounts = await fanOut();
        for (const account of accounts) await deps.enqueue(spec, { accountId: account.id });
        const cleanup = after ? await after() : undefined;
        return { accounts: accounts.length, cleanup };
      }

      const account = await getAdAccount(deps.db, accountId);
      if (!account?.active) {
        ctx.logger.info({ accountId }, 'account inactive, skipping sync');
        return { skipped: true };
      }
      const previous = await getSyncState(deps.db, accountId, spec.name);
      let result: unknown;
      let failure: unknown;
      try {
        result = await work({ ...deps, logger: ctx.logger }, account);
      } catch (err) {
        failure = err;
      }
      const state = await recordSyncAttempt(
        deps.db,
        failure === undefined
          ? { accountId, job: spec.name, at: deps.now(), ok: true }
          : { accountId, job: spec.name, at: deps.now(), ok: false, error: syncErrorCode(failure) },
      );
      await alertOps(spec.name, account, previous, state, ctx.logger);
      if (failure !== undefined) throw failure;
      return result;
    });

  async function alertOps(job: string, account: AdAccount, previous: SyncState | undefined, state: SyncState, logger: SyncDeps['logger']) {
    const alert = syncAlert(previous, state);
    if (!alert) return;
    const name = `${account.name}（${account.externalId}）`;
    const notice: OpsNotice =
      alert === 'failing'
        ? { level: 'error', text: `Google Ads 同步失敗：${job} 帳戶 ${name} 已連續失敗 ${state.consecutiveFailures} 次，最後錯誤：${state.lastError}` }
        : { level: 'info', text: `Google Ads 同步已恢復：${job} 帳戶 ${name}` };
    try {
      await deps.notifyOps(notice);
      if (alert === 'failing') await markSyncAlerted(deps.db, account.id, job, deps.now());
    } catch (err) {
      // Not marked as alerted, so the next failed attempt tries again.
      logger.error({ err }, 'ops notice failed');
    }
  }

  const active = () => listActiveAccounts(deps.db, deps.platform.platform);
  return [
    // The 15-minute run also refreshes the account list from the manager account.
    job(Jobs.syncSnapshots, syncSnapshots, () => syncAccounts(deps)),
    job(Jobs.syncHourly, syncHourly, active),
    job(Jobs.syncDaily, syncDaily, active, () => cleanupHourlyMetrics(deps)),
  ];
}

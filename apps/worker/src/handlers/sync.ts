// Sync jobs (ADR-0003). A scheduled run without accountId fans out one job per active account,
// so pg-boss retries (exponential backoff, Requirement 2.6) only the account that failed.
import { getAdAccount, listActiveAccounts, recordSyncAttempt, type AdAccount } from '@arlo/db';
import { defineJob, Jobs, type JobData, type JobDefinition, type JobSpec } from '@arlo/queue';
import { cleanupHourlyMetrics, syncAccounts, syncDaily, syncHourly, syncSnapshots, type SyncDeps } from '../sync/sync';

export interface SyncJobDeps extends SyncDeps {
  enqueue: <J extends JobSpec>(spec: J, data: JobData<J>) => Promise<string>;
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
      try {
        const result = await work({ ...deps, logger: ctx.logger }, account);
        await recordSyncAttempt(deps.db, { accountId, job: spec.name, at: deps.now(), ok: true });
        return result;
      } catch (err) {
        await recordSyncAttempt(deps.db, { accountId, job: spec.name, at: deps.now(), ok: false, error: syncErrorCode(err) });
        throw err;
      }
    });

  const active = () => listActiveAccounts(deps.db, deps.platform.platform);
  return [
    // The 15-minute run also refreshes the account list from the manager account.
    job(Jobs.syncSnapshots, syncSnapshots, () => syncAccounts(deps)),
    job(Jobs.syncHourly, syncHourly, active),
    job(Jobs.syncDaily, syncDaily, active, () => cleanupHourlyMetrics(deps)),
  ];
}

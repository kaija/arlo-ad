import type { Logger } from '@arlo/config/logger';
import { PgBoss, type QueueOptions, type SendOptions } from 'pg-boss';
import { DEFAULT_QUEUE_OPTIONS, type JobData, type JobSpec } from './spec';

export { PgBoss };

export interface BossOptions {
  connectionString: string;
  logger: Logger;
  /**
   * worker: installs/migrates the pg-boss schema, runs maintenance and cron.
   * migrator: installs/migrates the schema only (the `migrate` command).
   * producer: only sends jobs (web); relies on `migrate` or the worker for the schema.
   */
  role: 'worker' | 'migrator' | 'producer';
  max?: number;
}

export function createBoss({ connectionString, logger, role, max }: BossOptions): PgBoss {
  const worker = role === 'worker';
  const boss = new PgBoss({
    connectionString,
    max: max ?? (worker ? 10 : 4),
    application_name: `arlo-${role}`,
    migrate: role !== 'producer',
    supervise: worker,
    schedule: worker,
    instanceName: role,
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  boss.on('warning', (warning) => logger.warn({ warning }, 'pg-boss warning'));
  return boss;
}

/** Creates missing queues and applies option changes to existing ones. */
export async function ensureQueues(boss: PgBoss, specs: readonly Pick<JobSpec, 'name' | 'queue'>[]): Promise<void> {
  for (const spec of specs) {
    const options: QueueOptions = { ...DEFAULT_QUEUE_OPTIONS, ...spec.queue };
    // pg-boss rejects a backoff cap without backoff.
    if (!options.retryBackoff) delete options.retryDelayMax;
    if (await boss.getQueue(spec.name)) await boss.updateQueue(spec.name, options);
    else await boss.createQueue(spec.name, options);
  }
}

/** Validates the payload against the job's schema, then sends it. Returns the job id. */
export async function enqueue<J extends JobSpec>(
  boss: PgBoss,
  spec: J,
  data: JobData<J>,
  options?: SendOptions,
): Promise<string> {
  const parsed = spec.schema.parse(data) as object;
  const id = await boss.send(spec.name, parsed, options ?? {});
  // null only when a singleton/throttle option suppressed the job.
  if (id === null && !options?.singletonKey) throw new Error(`pg-boss did not create a job on ${spec.name}`);
  return id ?? '';
}

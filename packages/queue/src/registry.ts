// Typed job registry for the worker (ADR-0002): every handler declares its payload schema,
// and payloads are validated before the handler runs.
import type { Logger } from '@arlo/config/logger';
import type { JobResult, PgBoss, QueueOptions } from 'pg-boss';
import type { z } from 'zod';
import { ensureQueues } from './boss';
import type { JobSpec } from './spec';

export interface JobContext {
  id: string;
  /** 0 on the first attempt. */
  retryCount: number;
  logger: Logger;
  /** Aborted when the job expires or the worker stops. */
  signal: AbortSignal;
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  schema: S;
  handler: (data: z.output<S>, ctx: JobContext) => Promise<unknown>;
  queue?: QueueOptions;
  /** Jobs of this queue processed concurrently by this worker. */
  concurrency?: number;
  pollingIntervalSeconds?: number;
}

type WorkOptions = Pick<JobDefinition, 'queue' | 'concurrency' | 'pollingIntervalSeconds'>;

/** `defineJob(name, schema, handler)`, or `defineJob(spec, handler)` for a spec from the catalog. */
export function defineJob<S extends z.ZodType>(
  name: string,
  schema: S,
  handler: JobDefinition<S>['handler'],
  options?: WorkOptions,
): JobDefinition<S>;
export function defineJob<S extends z.ZodType>(
  spec: JobSpec<string, S>,
  handler: JobDefinition<S>['handler'],
  options?: Omit<WorkOptions, 'queue'>,
): JobDefinition<S>;
export function defineJob<S extends z.ZodType>(...args: unknown[]): JobDefinition<S> {
  if (typeof args[0] === 'string') {
    const [name, schema, handler, options] = args as [string, S, JobDefinition<S>['handler'], WorkOptions?];
    return { name, schema, handler, ...options };
  }
  const [spec, handler, options] = args as [JobSpec<string, S>, JobDefinition<S>['handler'], WorkOptions?];
  return { name: spec.name, schema: spec.schema, handler, queue: spec.queue, ...options };
}

export async function registerJobs(boss: PgBoss, defs: readonly JobDefinition[], { logger }: { logger: Logger }): Promise<void> {
  const names = new Set<string>();
  for (const def of defs) {
    if (names.has(def.name)) throw new Error(`job ${def.name} registered twice`);
    names.add(def.name);
  }
  await ensureQueues(boss, defs);

  for (const def of defs) {
    await boss.work(
      def.name,
      {
        batchSize: 1,
        perJobResults: true,
        localConcurrency: def.concurrency ?? 1,
        pollingIntervalSeconds: def.pollingIntervalSeconds ?? 2,
      },
      async (jobs): Promise<JobResult[]> => {
        const results: JobResult[] = [];
        for (const job of jobs) {
          const log = logger.child({ job_id: job.id, job: def.name });
          const parsed = def.schema.safeParse(job.data);
          if (!parsed.success) {
            // A malformed payload will not improve on retry: fail it terminally.
            log.error({ issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 'invalid job payload');
            results.push({ id: job.id, status: 'deadletter', output: { error: 'invalid_payload' } });
            continue;
          }
          // Throwing fails the batch; pg-boss retries it per the queue's retry policy.
          const output = await def.handler(parsed.data, { id: job.id, retryCount: job.retryCount, logger: log, signal: job.signal });
          results.push({ id: job.id, status: 'completed', output: (output ?? undefined) as object | undefined });
        }
        return results;
      },
    );
  }
}

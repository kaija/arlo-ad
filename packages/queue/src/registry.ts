// Typed job registry for the worker (ADR-0002): every handler declares its payload schema,
// and payloads are validated before the handler runs.
import type { Logger } from '@arlo/config/logger';
import type { Job, JobResult, PgBoss, QueueOptions } from 'pg-boss';
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
  /** Level of the per-job "job completed" line; `debug` for frequent cron jobs. Failures always log. */
  completedLogLevel?: 'info' | 'debug';
}

type WorkOptions = Pick<JobDefinition, 'queue' | 'concurrency' | 'pollingIntervalSeconds' | 'completedLogLevel'>;

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
        // Throwing fails the batch; pg-boss retries it per the queue's retry policy.
        for (const job of jobs) results.push(await runJob(def, job, logger));
        return results;
      },
    );
  }
}

/**
 * Validates and runs one job, logging its outcome under the job's logger (job_id, job).
 * Never logs the payload or full output: only numeric/boolean top-level output fields.
 */
export async function runJob(def: JobDefinition, job: Pick<Job<unknown>, 'id' | 'data' | 'retryCount' | 'signal'>, logger: Logger): Promise<JobResult> {
  const log = logger.child({ job_id: job.id, job: def.name });
  const parsed = def.schema.safeParse(job.data);
  if (!parsed.success) {
    // A malformed payload will not improve on retry: fail it terminally.
    log.warn({ issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 'invalid job payload');
    return { id: job.id, status: 'deadletter', output: { error: 'invalid_payload' } };
  }
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  let output: unknown;
  try {
    output = await def.handler(parsed.data, { id: job.id, retryCount: job.retryCount, logger: log, signal: job.signal });
  } catch (err) {
    log.error({ err, duration_ms: durationMs(), retry_count: job.retryCount }, 'job failed');
    throw err;
  }
  log[def.completedLogLevel ?? 'info']({ duration_ms: durationMs(), retry_count: job.retryCount, result: summarizeOutput(output) }, 'job completed');
  return { id: job.id, status: 'completed', output: (output ?? undefined) as object | undefined };
}

/** Top-level number/boolean fields of a handler's output (e.g. `{ accounts: 3 }`); strings and nested values are dropped. */
export function summarizeOutput(output: unknown): Record<string, number | boolean> | undefined {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined;
  const entries = Object.entries(output).filter((e): e is [string, number | boolean] => typeof e[1] === 'number' || typeof e[1] === 'boolean');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

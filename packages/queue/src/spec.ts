import type { QueueOptions } from 'pg-boss';
import type { z } from 'zod';

/**
 * A queue name with its payload schema. Shared by producers (web `enqueue`) and the worker
 * (`defineJob`), so both sides agree on the payload shape.
 */
export interface JobSpec<N extends string = string, S extends z.ZodType = z.ZodType> {
  name: N;
  schema: S;
  /** Overrides DEFAULT_QUEUE_OPTIONS for this queue. */
  queue?: QueueOptions;
}

export type JobData<J extends JobSpec> = z.input<J['schema']>;

export function jobSpec<N extends string, S extends z.ZodType>(name: N, schema: S, queue?: QueueOptions): JobSpec<N, S> {
  return { name, schema, queue };
}

// Google Ads quota / 5xx and other transient failures: exponential backoff, at most 5 retries
// (design.md「Error Handling」).
export const DEFAULT_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
  expireInSeconds: 15 * 60,
} satisfies QueueOptions;

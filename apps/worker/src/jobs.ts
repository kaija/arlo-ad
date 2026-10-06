// Job handlers registered with pg-boss. Each handler is defined from a spec in the
// @arlo/queue catalog so producers and the worker share one payload schema.
import type { JobDefinition } from '@arlo/queue';
import { syncJobs, type SyncJobDeps } from './handlers/sync';

export type WorkerDeps = SyncJobDeps;

export function jobDefinitions(deps: WorkerDeps): JobDefinition[] {
  return [...syncJobs(deps)];
}

// Job handlers registered with pg-boss. Each handler is defined from a spec in the
// @arlo/queue catalog so producers and the worker share one payload schema.
import type { JobDefinition, PgBoss } from '@arlo/queue';
import { chatJobs, type ChatJobDeps } from './handlers/chat';
import { executorJobs, type ExecutorDeps } from './handlers/executor';
import { syncJobs, type SyncJobDeps } from './handlers/sync';
import { schedulerJobs, type SchedulerDeps } from './scheduler/scheduler';

export type WorkerDeps = SyncJobDeps & ChatJobDeps & SchedulerDeps & ExecutorDeps & { boss: PgBoss };

export function jobDefinitions(deps: WorkerDeps): JobDefinition[] {
  return [...syncJobs(deps), ...chatJobs(deps), ...schedulerJobs(deps), ...executorJobs(deps)];
}

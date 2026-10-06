// Job handlers registered with pg-boss. Each handler is defined from a spec in the
// @arlo/queue catalog so producers and the worker share one payload schema.
import type { JobDefinition, PgBoss } from '@arlo/queue';
import { chatJobs, type ChatJobDeps } from './handlers/chat';
import { createExecutor, executorJobs, type ExecutorDeps } from './handlers/executor';
import { decisionJobs } from './handlers/decisions';
import { interactionJobs } from './handlers/interaction';
import { syncJobs, type SyncJobDeps } from './handlers/sync';
import { schedulerJobs, type SchedulerDeps } from './scheduler/scheduler';

export type WorkerDeps = SyncJobDeps & ChatJobDeps & SchedulerDeps & ExecutorDeps & { boss: PgBoss };

export function jobDefinitions(deps: WorkerDeps): JobDefinition[] {
  const executor = createExecutor(deps);
  return [...syncJobs(deps), ...chatJobs(deps), ...schedulerJobs(deps), ...executorJobs(executor), ...interactionJobs({ ...deps, executor }), ...decisionJobs({ ...deps, executor })];
}

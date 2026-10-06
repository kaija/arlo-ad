// Every queue the system uses, shared by producers and the worker. `migrate` creates them so
// web can enqueue before the worker has started once. Add a spec here when a job lands.
import { z } from 'zod';
import { jobSpec, type JobSpec } from './spec';

// Without accountId: fan out one job per active account. With it: sync that account.
const accountScoped = z.object({ accountId: z.uuid().optional() });

export const Jobs = {
  syncSnapshots: jobSpec('sync.snapshots', accountScoped),
  syncHourly: jobSpec('sync.hourly', accountScoped),
  syncDaily: jobSpec('sync.daily', accountScoped),
} satisfies Record<string, JobSpec>;

export const ALL_JOBS: readonly JobSpec[] = Object.values(Jobs);

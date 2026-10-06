// Every queue the system uses, shared by producers and the worker. `migrate` creates them so
// web can enqueue before the worker has started once. Add a spec here when a job lands.
import type { JobSpec } from './spec';

export const Jobs = {} satisfies Record<string, JobSpec>;

export const ALL_JOBS: readonly JobSpec[] = Object.values(Jobs);

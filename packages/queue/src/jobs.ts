// Every queue the system uses, shared by producers and the worker. `migrate` creates them so
// web can enqueue before the worker has started once. Add a spec here when a job lands.
import { z } from 'zod';
import { jobSpec, type JobSpec } from './spec';

// Without accountId: fan out one job per active account. With it: sync that account.
const accountScoped = z.object({ accountId: z.uuid().optional() });

// Slack app_mention (Requirement 10.x); ts values are Slack message timestamps.
const chatMention = z.object({
  eventId: z.string(),
  teamId: z.string().optional(),
  channelId: z.string(),
  userId: z.string(),
  text: z.string(),
  messageTs: z.string(),
  /** Set when the mention is a thread reply. */
  threadTs: z.string().optional(),
});

// Slack interactivity, reduced to what handlers use (Requirements 1.5, 6.6).
const chatInteraction = z.object({
  type: z.enum(['block_actions', 'view_submission']),
  userId: z.string(),
  teamId: z.string().optional(),
  channelId: z.string().optional(),
  messageTs: z.string().optional(),
  threadTs: z.string().optional(),
  actions: z
    .array(z.object({ actionId: z.string(), value: z.string().optional(), selected: z.array(z.string()).optional() }))
    .default([]),
  responseUrl: z.string().optional(),
  view: z.object({ callbackId: z.string(), privateMetadata: z.string(), values: z.record(z.string(), z.unknown()) }).optional(),
});

const changesetRef = z.object({ changesetId: z.uuid() });

const schedulerRun = z.object({ scheduledJobId: z.uuid(), trigger: z.enum(['schedule', 'manual']).default('schedule') });

export const Jobs = {
  syncSnapshots: jobSpec('sync.snapshots', accountScoped),
  syncHourly: jobSpec('sync.hourly', accountScoped),
  syncDaily: jobSpec('sync.daily', accountScoped),
  // Interactive: a late answer is worth little, so retry only briefly.
  chatMention: jobSpec('chat.mention', chatMention, { retryLimit: 2 }),
  chatInteraction: jobSpec('chat.interaction', chatInteraction, { retryLimit: 2 }),
  // A failed run is recorded in job_runs and reported; retrying could post a report twice.
  schedulerRun: jobSpec('scheduler.run', schedulerRun, { retryLimit: 0 }),
  // Deterministic Monitor for one account, queued after each snapshot sync (ADR-0017).
  monitorRun: jobSpec('monitor.run', z.object({ accountId: z.uuid() }), { retryLimit: 1 }),
  // Validation → tier → auto-execute or approval request (ADR-0006). Idempotent per status.
  changesetProcess: jobSpec('changeset.process', changesetRef),
  // Cron: PENDING_APPROVAL past expires_at → EXPIRED, cards disabled (Requirement 6.2).
  changesetExpire: jobSpec('changeset.expire', z.object({})),
  // Cron: remind approvers once about ChangeSets pending past the SLA (Requirement 7.5).
  changesetRemind: jobSpec('changeset.remind', z.object({})),
  // Approve / reject / undo from the Web console, through the same checks as Slack (Requirement 18.8).
  changesetDecide: jobSpec(
    'changeset.decide',
    z.object({
      changesetId: z.uuid(),
      userId: z.uuid(),
      verb: z.enum(['approve', 'confirm', 'reject', 'undo']),
      reason: z.string().max(500).nullable().default(null),
    }),
    { retryLimit: 2 },
  ),
  // Re-applies scheduled_jobs to pg-boss cron after a change in the Web console.
  schedulerSync: jobSpec('scheduler.sync', z.object({})),
} satisfies Record<string, JobSpec>;

export const ALL_JOBS: readonly JobSpec[] = Object.values(Jobs);

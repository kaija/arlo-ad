// campaign.generate (ADR-0020, Requirements 15.1–15.3, 15.8): queued → running → draft (or
// failed). The Campaign agent writes the draft; lint issues are stored with it.
import { briefPrompt, generateCampaignDraft, trackedRun, type AgentContext } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import type { CampaignDraftSchema } from '@arlo/core';
import { getAdAccount, getCampaignTask, saveCampaignDraft, setCampaignTaskStatus, type Db } from '@arlo/db';
import { defineJob, Jobs } from '@arlo/queue';
import type { Agent } from '@openai/agents';

export interface CampaignDeps {
  db: Db;
  logger: Logger;
  now: () => Date;
  agents: { campaign?: () => Agent<AgentContext, typeof CampaignDraftSchema> };
}

export async function generateForTask(deps: CampaignDeps, taskId: string): Promise<{ status: string }> {
  const { db } = deps;
  const task = await getCampaignTask(db, taskId);
  if (!task) return { status: 'missing' };
  // A retried job finds the task still running; anything else was handled already.
  const running = await setCampaignTaskStatus(db, taskId, ['queued', 'running'], 'running');
  if (!running) return { status: task.status };
  const account = await getAdAccount(db, task.accountId);
  try {
    if (!account) throw new Error('ad account not found');
    if (!deps.agents.campaign) throw new Error('campaign agent is not configured');
    const context: AgentContext = { db, allowedAccountIds: [account.id], now: deps.now, user: task.createdBy ? { id: task.createdBy } : null };
    const { result, traceId } = await trackedRun({ db, name: 'campaign.generate', ref: { kind: 'campaign_task', id: task.id }, now: deps.now }, () =>
      generateCampaignDraft({ agent: deps.agents.campaign!(), context, prompt: briefPrompt(task.brief, account), landingPageUrl: task.brief.landingPageUrl }),
    );
    await saveCampaignDraft(db, { taskId: task.id, draft: result.draft, lintIssues: result.issues, origin: 'generate' });
    await setCampaignTaskStatus(db, task.id, ['running'], 'draft', { traceId, error: null });
    deps.logger.info({ task_id: task.id, attempts: result.attempts, issues: result.issues.length }, 'campaign draft generated');
    return { status: 'draft' };
  } catch (err) {
    deps.logger.error({ err, task_id: task.id }, 'campaign generation failed');
    await setCampaignTaskStatus(db, task.id, ['running'], 'failed', { error: String((err as Error)?.message ?? err).slice(0, 500) });
    return { status: 'failed' };
  }
}

export function campaignJobs(deps: CampaignDeps) {
  return [defineJob(Jobs.campaignGenerate, ({ taskId }) => generateForTask(deps, taskId))];
}

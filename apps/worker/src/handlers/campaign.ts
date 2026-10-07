// campaign.generate (ADR-0020, Requirements 15.1–15.3, 15.8): queued → running → draft (or
// failed). The Campaign agent writes the draft; lint issues are stored with it.
import { briefPrompt, generateCampaignDraft, regeneratePrompt, trackedRun, type AgentContext } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import { CampaignDraftSchema, lintStructure, mergeDraftSection, SECTION_LABEL, type DraftSection } from '@arlo/core';
import { getAdAccount, getCampaignTask, latestCampaignDraft, saveCampaignDraft, setCampaignTaskStatus, type Db } from '@arlo/db';
import { defineJob, Jobs } from '@arlo/queue';
import { run, type Agent } from '@openai/agents';

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

/**
 * campaign.regenerate (Requirement 15.4): the agent rewrites one section; only that section is
 * merged into the latest draft, which becomes a new version. Drafts already submitted are final.
 */
export async function regenerateSection(deps: CampaignDeps, input: { taskId: string; section: DraftSection; instructions: string | null; userId: string | null }): Promise<{ status: string; version?: number }> {
  const { db } = deps;
  const task = await getCampaignTask(db, input.taskId);
  const current = await latestCampaignDraft(db, input.taskId);
  if (!task || !current || task.status !== 'draft') return { status: task?.status ?? 'missing' };
  const account = await getAdAccount(db, task.accountId);
  if (!account || !deps.agents.campaign) return { status: 'unavailable' };
  const context: AgentContext = { db, allowedAccountIds: [account.id], now: deps.now, user: input.userId ? { id: input.userId } : null };
  try {
    const { result } = await trackedRun({ db, name: 'campaign.regenerate', ref: { kind: 'campaign_task', id: task.id }, now: deps.now }, () =>
      run(deps.agents.campaign!(), regeneratePrompt(task.brief, current.draft, SECTION_LABEL[input.section], input.instructions), { context, maxTurns: 10 }),
    );
    const merged = mergeDraftSection(current.draft, CampaignDraftSchema.parse(result.finalOutput), input.section);
    const saved = await saveCampaignDraft(db, { taskId: task.id, draft: merged, lintIssues: lintStructure(merged, { landingPageUrl: task.brief.landingPageUrl }), origin: `regenerate:${input.section}`, createdBy: input.userId });
    return { status: 'draft', version: saved.version };
  } catch (err) {
    deps.logger.error({ err, task_id: task.id, section: input.section }, 'section regeneration failed');
    return { status: 'failed' };
  }
}

export function campaignJobs(deps: CampaignDeps) {
  return [
    defineJob(Jobs.campaignGenerate, ({ taskId }) => generateForTask(deps, taskId)),
    defineJob(Jobs.campaignRegenerate, (data) => regenerateSection(deps, data)),
  ];
}

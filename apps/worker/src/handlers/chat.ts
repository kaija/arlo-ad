// Slack @mention → Orchestrator (design.md flow 1, ADR-0015, Requirements 10.1–10.6, 1.5).
import type { ChatAdapter } from '@arlo/adapters/chat';
import { PgSession, slackSessionId, trackedRun, type AgentContext } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import { authorize, readableAccountIds, type ChatTurn, type ConversationRef } from '@arlo/core';
import { resolveSlackUser, type Db } from '@arlo/db';
import { defineJob, Jobs, type JobData } from '@arlo/queue';
import { run, type Agent, type AgentInputItem } from '@openai/agents';

export interface ChatJobDeps {
  db: Db;
  chat: ChatAdapter;
  logger: Logger;
  now: () => Date;
  /** Builds the Orchestrator for one run (models come from config). */
  orchestrator: () => Agent<AgentContext>;
  /** Stores a ChangeSet and queues changeset.process (propose_* tools, ADR-0006). */
  propose?: AgentContext['propose'];
  createCampaignTask?: AgentContext['createCampaignTask'];
  keywordIdeas?: AgentContext['keywordIdeas'];
}

export const PROGRESS_EMOJI = 'hourglass_flowing_sand';
/** Thread context: the root plus the latest N replies (Requirement 10.1). */
export const THREAD_CONTEXT_LIMIT = 20;
/** Main-line context: the N messages before the mention (Requirement 10.2). */
export const CHANNEL_CONTEXT_LIMIT = 10;
const MAX_TURNS = 12;

const DENIED = {
  unbound: '你的 Slack 帳號尚未對應到 Arlo 使用者。請先用公司 Google 帳號登入 Web console，或請 admin 協助綁定。',
  disabled: '你的 Arlo 帳號已停用。',
  role: '你沒有使用 Arlo Ads Bot 的權限，請洽 admin。',
} as const;

/** Removes the leading bot mention(s) from the message text. */
export function stripMentions(text: string): string {
  return text.replace(/^(\s*<@[A-Z0-9]+>\s*)+/, '').trim();
}

async function contextItems(chat: ChatAdapter, turns: ChatTurn[]): Promise<AgentInputItem[]> {
  const names = new Map<string, string>();
  const items: AgentInputItem[] = [];
  for (const t of turns) {
    if (!t.text.trim()) continue;
    let who = '系統訊息';
    if (!t.bot && t.userId) {
      if (!names.has(t.userId)) names.set(t.userId, (await chat.resolveUser(t.userId).catch(() => ({ displayName: t.userId! }))).displayName);
      who = `其他參與者 ${names.get(t.userId)}`;
    }
    items.push({ type: 'message', role: 'user', content: `[${who}]\n${t.text}` });
  }
  return items;
}

export async function handleMention(deps: ChatJobDeps, job: JobData<typeof Jobs.chatMention>, logger: Logger): Promise<void> {
  const { chat, db } = deps;
  const mention = { platform: 'slack' as const, channelId: job.channelId, messageId: job.messageTs };
  // A mention on the main line starts a new thread under it (Requirement 10.2).
  const threadTs = job.threadTs ?? job.messageTs;
  const conversation: ConversationRef = { platform: 'slack', channelId: job.channelId, threadId: threadTs };

  await chat.react(mention, PROGRESS_EMOJI, true);
  try {
    const resolved = await resolveSlackUser(db, job.userId);
    if (!resolved.ok) {
      await chat.ephemeral(conversation, job.userId, DENIED[resolved.reason]);
      return;
    }
    const user = resolved.user;
    if (!authorize(user, 'view').allowed) {
      await chat.ephemeral(conversation, job.userId, DENIED.role);
      return;
    }

    const sessionId = slackSessionId(job.channelId, threadTs);
    const session = new PgSession({ db, sessionId });
    const since = await session.getLastSlackTs();
    let turns: ChatTurn[];
    if (since) {
      // Later mention in the same thread: only what was said since (Requirement 10.4).
      turns = await chat.fetchContext(conversation, { mode: 'thread', since, before: job.messageTs });
    } else if (job.threadTs) {
      turns = await chat.fetchContext(conversation, { mode: 'thread', before: job.messageTs, limit: THREAD_CONTEXT_LIMIT });
    } else {
      turns = await chat.fetchContext({ platform: 'slack', channelId: job.channelId }, { mode: 'channel', before: job.messageTs, limit: CHANNEL_CONTEXT_LIMIT });
    }
    const delta = await contextItems(chat, turns);
    if (delta.length) await session.addItems(delta);

    const context: AgentContext = {
      db,
      allowedAccountIds: readableAccountIds(user),
      user: { id: user.id, displayName: user.displayName },
      now: deps.now,
      source: { kind: 'chat', ref: conversation },
      propose: deps.propose,
      createCampaignTask: deps.createCampaignTask,
      keywordIdeas: deps.keywordIdeas,
    };
    const question = stripMentions(job.text) || '（使用者只標記了你，沒有其他內容）';
    let answer: string;
    try {
      const { result } = await trackedRun(
        { db, name: 'chat.mention', ref: { kind: 'session', id: sessionId }, metadata: { user_id: user.id }, now: deps.now },
        (traceId) => {
          context.traceId = traceId;
          return run(deps.orchestrator(), `[發問者 ${user.displayName ?? user.googleEmail}]\n${question}`, {
            session,
            context,
            maxTurns: MAX_TURNS,
          });
        },
      );
      answer = String(result.finalOutput ?? '').trim() || '（沒有產生回覆）';
    } catch (err) {
      logger.error({ err }, 'orchestrator run failed');
      answer = '抱歉，處理這個問題時發生錯誤，請稍後再試或換個問法。';
    }
    const reply = await chat.post(conversation, { type: 'reply', text: answer });
    await session.setLastSlackTs(reply.messageId);
  } finally {
    await chat.react(mention, PROGRESS_EMOJI, false).catch((err) => logger.warn({ err }, 'failed to clear progress reaction'));
  }
}

export function chatJobs(deps: ChatJobDeps) {
  return [defineJob(Jobs.chatMention, (data, ctx) => handleMention(deps, data, ctx.logger), { pollingIntervalSeconds: 0.5, concurrency: 4 })];
}

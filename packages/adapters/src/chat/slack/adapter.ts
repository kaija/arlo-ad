// ChatAdapter for Slack (ADR-0005) over @slack/web-api.
import type { ChangeSetView, ChatMessage, ChatTurn, ConversationRef, MessageRef } from '@arlo/core';
import type { WebClient } from '@slack/web-api';
import type { ChatAdapter, FetchContextOptions } from '../types';
import { renderConfirmModal, renderMessage } from './render';

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

const slackError = (err: unknown) => (err as { data?: { error?: string } }).data?.error;

export class SlackAdapter implements ChatAdapter {
  private readonly users = new Map<string, Promise<{ email?: string; displayName: string }>>();

  constructor(private readonly client: WebClient) {}

  async post(ref: ConversationRef, msg: ChatMessage): Promise<MessageRef> {
    const { text, blocks } = renderMessage(msg);
    const res = await this.client.chat.postMessage({
      channel: ref.channelId,
      thread_ts: ref.threadId,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    return { platform: 'slack', channelId: res.channel ?? ref.channelId, messageId: res.ts!, threadId: ref.threadId };
  }

  async update(msg: MessageRef, next: ChatMessage): Promise<void> {
    const { text, blocks } = renderMessage(next);
    await this.client.chat.update({ channel: msg.channelId, ts: msg.messageId, text, blocks });
  }

  async ephemeral(ref: ConversationRef, platformUserId: string, text: string): Promise<void> {
    await this.client.chat.postEphemeral({ channel: ref.channelId, user: platformUserId, thread_ts: ref.threadId, text });
  }

  async fetchContext(ref: ConversationRef, opts: FetchContextOptions): Promise<ChatTurn[]> {
    const messages: SlackMessage[] = [];
    if (opts.mode === 'thread') {
      if (!ref.threadId) throw new Error('thread context needs threadId');
      let cursor: string | undefined;
      do {
        const res = await this.client.conversations.replies({ channel: ref.channelId, ts: ref.threadId, cursor, limit: 200 });
        messages.push(...((res.messages ?? []) as SlackMessage[]));
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } else {
      // Newest first from Slack; enough for the requested limit.
      const res = await this.client.conversations.history({
        channel: ref.channelId,
        latest: opts.before,
        inclusive: false,
        limit: Math.min(opts.limit ?? 100, 200),
      });
      messages.push(...((res.messages ?? []) as SlackMessage[]).reverse());
    }

    let turns = messages
      .filter((m) => m.ts && (!m.subtype || m.subtype === 'bot_message' || m.subtype === 'thread_broadcast'))
      .map((m): ChatTurn => ({ messageId: m.ts!, userId: m.user ?? null, bot: Boolean(m.bot_id), text: m.text ?? '' }));
    if (opts.since) turns = turns.filter((t) => Number(t.messageId) > Number(opts.since));
    if (opts.before) turns = turns.filter((t) => Number(t.messageId) < Number(opts.before));
    if (opts.limit !== undefined && turns.length > opts.limit) {
      const root = opts.mode === 'thread' ? turns.find((t) => t.messageId === ref.threadId) : undefined;
      const recent = turns.slice(-opts.limit);
      turns = root && !recent.includes(root) ? [root, ...recent] : recent;
    }
    return turns;
  }

  resolveUser(platformUserId: string): Promise<{ email?: string; displayName: string }> {
    let cached = this.users.get(platformUserId);
    if (!cached) {
      cached = this.client.users.info({ user: platformUserId }).then((res) => ({
        email: res.user?.profile?.email,
        displayName: res.user?.profile?.display_name || res.user?.real_name || res.user?.name || platformUserId,
      }));
      cached.catch(() => this.users.delete(platformUserId));
      this.users.set(platformUserId, cached);
    }
    return cached;
  }

  async permalink(msg: MessageRef): Promise<string> {
    const res = await this.client.chat.getPermalink({ channel: msg.channelId, message_ts: msg.messageId });
    return res.permalink!;
  }

  async react(msg: MessageRef, emoji: string, on: boolean): Promise<void> {
    try {
      if (on) await this.client.reactions.add({ channel: msg.channelId, timestamp: msg.messageId, name: emoji });
      else await this.client.reactions.remove({ channel: msg.channelId, timestamp: msg.messageId, name: emoji });
    } catch (err) {
      // Reactions are cosmetic progress markers: an existing or missing one is fine.
      if (slackError(err) === 'already_reacted' || slackError(err) === 'no_reaction') return;
      throw err;
    }
  }

  async openConfirm(triggerId: string, changeset: ChangeSetView, where?: ConversationRef): Promise<void> {
    await this.client.views.open({ trigger_id: triggerId, view: renderConfirmModal(changeset, where) });
  }
}

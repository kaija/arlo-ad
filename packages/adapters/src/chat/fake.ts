// In-memory ChatAdapter for integration tests: records what was posted and serves seeded
// conversation history.
import type { ChangeSetView, ChatMessage, ChatTurn, ConversationRef, MessageRef } from '@arlo/core';
import type { ChatAdapter, FetchContextOptions } from './types';

export interface FakeMessage {
  ref: MessageRef;
  message: ChatMessage;
  history: ChatMessage[];
}

interface StoredTurn extends ChatTurn {
  channelId: string;
  threadId?: string;
}

export class FakeChatAdapter implements ChatAdapter {
  readonly messages: FakeMessage[] = [];
  readonly ephemerals: { ref: ConversationRef; userId: string; text: string }[] = [];
  readonly modals: { triggerId: string; changeset: ChangeSetView; where?: ConversationRef }[] = [];
  readonly reactions = new Map<string, Set<string>>();
  /** Every reaction call, e.g. "+hourglass_flowing_sand@C1:1.000001". */
  readonly reactionLog: string[] = [];
  private readonly turns: StoredTurn[] = [];
  private readonly users = new Map<string, { email?: string; displayName: string }>();
  private seq = 0;

  constructor(private readonly botUserId = 'UBOT') {}

  /** Seeds a user message; returns its id. Omit threadId for a main-line message. */
  say(channelId: string, userId: string | null, text: string, threadId?: string, opts: { bot?: boolean } = {}): string {
    const messageId = this.nextTs();
    this.turns.push({ channelId, threadId, messageId, userId, text, bot: opts.bot ?? false });
    return messageId;
  }

  addUser(userId: string, user: { email?: string; displayName: string }): this {
    this.users.set(userId, user);
    return this;
  }

  /** Messages posted to a conversation, in order. */
  postedTo(channelId: string, threadId?: string): FakeMessage[] {
    return this.messages.filter((m) => m.ref.channelId === channelId && (threadId === undefined || m.ref.threadId === threadId));
  }

  find(ref: MessageRef): FakeMessage | undefined {
    return this.messages.find((m) => m.ref.channelId === ref.channelId && m.ref.messageId === ref.messageId);
  }

  async post(ref: ConversationRef, message: ChatMessage): Promise<MessageRef> {
    const msgRef: MessageRef = { platform: 'slack', channelId: ref.channelId, messageId: this.nextTs(), threadId: ref.threadId };
    this.messages.push({ ref: msgRef, message, history: [message] });
    this.turns.push({ channelId: ref.channelId, threadId: ref.threadId, messageId: msgRef.messageId, userId: this.botUserId, text: summarize(message), bot: true });
    return msgRef;
  }

  async update(ref: MessageRef, next: ChatMessage): Promise<void> {
    const found = this.find(ref);
    if (!found) throw new Error(`message_not_found: ${ref.channelId}/${ref.messageId}`);
    found.message = next;
    found.history.push(next);
  }

  async openConfirm(triggerId: string, changeset: ChangeSetView, where?: ConversationRef): Promise<void> {
    this.modals.push({ triggerId, changeset, where });
  }

  async ephemeral(ref: ConversationRef, userId: string, text: string): Promise<void> {
    this.ephemerals.push({ ref, userId, text });
  }

  async fetchContext(ref: ConversationRef, opts: FetchContextOptions): Promise<ChatTurn[]> {
    let turns =
      opts.mode === 'thread'
        ? this.turns.filter((t) => t.channelId === ref.channelId && (t.messageId === ref.threadId || t.threadId === ref.threadId))
        : this.turns.filter((t) => t.channelId === ref.channelId && !t.threadId);
    if (opts.since) turns = turns.filter((t) => t.messageId > opts.since!);
    if (opts.before) turns = turns.filter((t) => t.messageId < opts.before!);
    if (opts.limit !== undefined && turns.length > opts.limit) {
      const root = opts.mode === 'thread' ? turns.find((t) => t.messageId === ref.threadId) : undefined;
      const recent = turns.slice(-opts.limit);
      turns = root && !recent.includes(root) ? [root, ...recent] : recent;
    }
    return turns.map(({ messageId, userId, bot, text }) => ({ messageId, userId, bot, text }));
  }

  async resolveUser(userId: string) {
    return this.users.get(userId) ?? { displayName: userId };
  }

  async permalink(ref: MessageRef): Promise<string> {
    return `https://slack.test/archives/${ref.channelId}/p${ref.messageId.replace('.', '')}`;
  }

  async react(ref: MessageRef, emoji: string, on: boolean): Promise<void> {
    const key = `${ref.channelId}:${ref.messageId}`;
    const set = this.reactions.get(key) ?? new Set<string>();
    if (on) set.add(emoji);
    else set.delete(emoji);
    this.reactions.set(key, set);
    this.reactionLog.push(`${on ? '+' : '-'}${emoji}@${key}`);
  }

  private nextTs(): string {
    // Slack-style ts: seconds.micro, monotonically increasing and lexically ordered.
    return `${1_700_000_000 + ++this.seq}.000100`;
  }
}

function summarize(m: ChatMessage): string {
  switch (m.type) {
    case 'reply':
      return m.text;
    case 'report':
      return m.title;
    case 'notice':
      return m.text;
    case 'approval_request':
    case 'shadow_result':
      return m.changeset.summary;
  }
}

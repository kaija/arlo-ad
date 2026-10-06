import type { ChangeSetView, ChatMessage, ChatTurn, ConversationRef, MessageRef } from '@arlo/core';

export interface FetchContextOptions {
  /** thread: replies of `ref.threadId` (root first); channel: main-line messages before `before`. */
  mode: 'thread' | 'channel';
  /** Only messages after this message id (exclusive). */
  since?: string;
  /** Only messages before this message id (exclusive). */
  before?: string;
  /** Most recent N messages (thread mode keeps the root regardless). */
  limit?: number;
}

/** Platform-neutral chat operations (ADR-0005). v1: SlackAdapter. */
export interface ChatAdapter {
  post(ref: ConversationRef, msg: ChatMessage): Promise<MessageRef>;
  update(msg: MessageRef, next: ChatMessage): Promise<void>;
  /** A message only `platformUserId` sees, e.g. a permission denial (Requirement 1.5). */
  ephemeral(ref: ConversationRef, platformUserId: string, text: string): Promise<void>;
  fetchContext(ref: ConversationRef, opts: FetchContextOptions): Promise<ChatTurn[]>;
  resolveUser(platformUserId: string): Promise<{ email?: string; displayName: string }>;
  permalink(msg: MessageRef): Promise<string>;
  react(msg: MessageRef, emoji: string, on: boolean): Promise<void>;
  /**
   * Tier 3 confirmation dialog (Requirement 4.4). `triggerId` comes from the click and is only
   * valid for a few seconds, so this runs in the web request, not the worker.
   */
  openConfirm(triggerId: string, changeset: ChangeSetView, where?: ConversationRef): Promise<void>;
}

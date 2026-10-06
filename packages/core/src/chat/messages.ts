// Semantic chat messages (ADR-0005, Requirement 7.6). Core modules, the Executor, the
// Scheduler and the Monitor only produce these; a ChatAdapter renders them per platform.

export type ChatPlatform = 'slack';

/** Where a conversation happens. `threadId` is the thread root (Slack thread_ts). */
export interface ConversationRef {
  platform: ChatPlatform;
  channelId: string;
  threadId?: string;
}

/** A posted message. `messageId` is the Slack ts. */
export interface MessageRef {
  platform: ChatPlatform;
  channelId: string;
  messageId: string;
  threadId?: string;
}

export type Section =
  | { kind: 'text'; heading?: string; text: string }
  | { kind: 'fields'; heading?: string; fields: { label: string; value: string }[] }
  | { kind: 'table'; heading?: string; columns: string[]; rows: string[][] };

export interface OpView {
  /** Human label, e.g. "Brand · 每日預算". */
  label: string;
  before: string;
  after: string;
  /** e.g. "-20%". */
  change?: string;
  /** Excluded by the approver (negative keyword batches, Requirement 14.5). */
  excluded?: boolean;
}

export interface ViolationView {
  severity: 'HARD_BLOCK' | 'WARN';
  message: string;
}

export interface ChangeSetView {
  id: string;
  accountName: string;
  summary: string;
  rationale?: string;
  tier: 0 | 1 | 2 | 3 | null;
  status: string;
  ops: OpView[];
  violations: ViolationView[];
  requestedBy?: string;
  /** ISO timestamp. */
  expiresAt?: string;
  /** Who acted and how, once handled: shown on every linked card (Requirement 7.4). */
  outcome?: { status: string; actor?: string; at?: string; reason?: string };
  /** Permalink to the originating thread on mirrored cards (Requirement 7.3). */
  sourceLink?: string;
  traceUrl?: string;
  /** Ops can be toggled individually before approval (Requirement 14.5). */
  selectable?: boolean;
}

export type NoticeAction = 'undo' | 'keep';

export type ChatMessage =
  | { type: 'report'; title: string; sections: Section[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; changesetId?: string; actions?: NoticeAction[] }
  | { type: 'approval_request'; changeset: ChangeSetView; mirror?: boolean }
  | { type: 'shadow_result'; changeset: ChangeSetView; feedback?: { up: number; down: number } };

/** One message of conversation context. */
export interface ChatTurn {
  messageId: string;
  userId: string | null;
  /** Posted by a bot (including this app). */
  bot: boolean;
  text: string;
}

// Agents SDK Session stored in Postgres (ADR-0015, Requirement 10.3): one per Slack thread,
// keeping the agent's tool calls and results. Beyond `maxItems`, the oldest items are folded
// into a text summary that is replayed ahead of the retained items.
import type { AgentInputItem, Session } from '@openai/agents';
import { DEFAULT_ORG_ID, schema, type Db } from '@arlo/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

const { agentSessions, agentSessionItems } = schema;

export interface PgSessionOptions {
  db: Db;
  sessionId: string;
  /** Items kept verbatim; older ones are summarized. */
  maxItems?: number;
  /** Folds dropped items into the running summary. Defaults to a deterministic text digest. */
  summarize?: (dropped: AgentInputItem[], previous: string | null) => Promise<string> | string;
}

export const DEFAULT_MAX_ITEMS = 60;
const SUMMARY_LIMIT = 4000;

export function slackSessionId(channelId: string, threadTs: string): string {
  return `slack:${channelId}:${threadTs}`;
}

function itemText(item: AgentInputItem): string | null {
  const i = item as { type?: string; role?: string; content?: unknown; name?: string };
  if (i.type === 'function_call') return `[tool ${i.name ?? ''}]`;
  if (i.type !== undefined && i.type !== 'message') return null;
  const content = i.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c: { text?: string }) => c.text ?? '').join(' ')
        : '';
  return text.trim() ? `${i.role ?? 'unknown'}: ${text.trim().replace(/\s+/g, ' ').slice(0, 300)}` : null;
}

/** Deterministic digest of dropped turns; keeps the most recent text when over the limit. */
export function digestSummary(dropped: AgentInputItem[], previous: string | null): string {
  const lines = dropped.map(itemText).filter((l): l is string => l !== null);
  const combined = [previous, ...lines].filter(Boolean).join('\n');
  return combined.length > SUMMARY_LIMIT ? `…${combined.slice(combined.length - SUMMARY_LIMIT)}` : combined;
}

// Outputs must stay with their calls: the model API rejects an output whose call is missing.
const OUTPUT_TYPES = new Set(['function_call_result', 'computer_call_result', 'shell_call_output', 'apply_patch_call_output', 'tool_search_output']);
const isOutput = (item: AgentInputItem) => OUTPUT_TYPES.has((item as { type?: string }).type ?? '');

export class PgSession implements Session {
  private readonly db: Db;
  private readonly sessionId: string;
  private readonly maxItems: number;
  private readonly summarize: NonNullable<PgSessionOptions['summarize']>;

  constructor(opts: PgSessionOptions) {
    this.db = opts.db;
    this.sessionId = opts.sessionId;
    this.maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
    this.summarize = opts.summarize ?? digestSummary;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const [session] = await this.db.select().from(agentSessions).where(eq(agentSessions.id, this.sessionId));
    const rows = await this.db
      .select({ item: agentSessionItems.item })
      .from(agentSessionItems)
      .where(eq(agentSessionItems.sessionId, this.sessionId))
      .orderBy(asc(agentSessionItems.seq));
    const items = rows.map((r) => r.item as AgentInputItem);
    const all: AgentInputItem[] = session?.summary
      ? [{ type: 'message', role: 'system', content: `先前對話摘要（較早的訊息已截斷）：\n${session.summary}` }, ...items]
      : items;
    return limit === undefined ? all : all.slice(Math.max(0, all.length - limit));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.transaction(async (tx) => {
      await this.ensure(tx);
      // Row lock serializes concurrent runs on the same thread.
      await tx.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, this.sessionId)).for('update');
      const [last] = await tx
        .select({ seq: sql<number>`coalesce(max(${agentSessionItems.seq}), 0)`.mapWith(Number) })
        .from(agentSessionItems)
        .where(eq(agentSessionItems.sessionId, this.sessionId));
      const start = last?.seq ?? 0;
      await tx.insert(agentSessionItems).values(
        items.map((item, i) => ({ sessionId: this.sessionId, orgId: DEFAULT_ORG_ID, seq: start + i + 1, item })),
      );
      await this.truncate(tx);
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const [row] = await this.db
      .delete(agentSessionItems)
      .where(
        and(
          eq(agentSessionItems.sessionId, this.sessionId),
          eq(
            agentSessionItems.seq,
            sql`(select max(seq) from ${agentSessionItems} where ${agentSessionItems.sessionId} = ${this.sessionId})`,
          ),
        ),
      )
      .returning({ item: agentSessionItems.item });
    return row?.item as AgentInputItem | undefined;
  }

  async clearSession(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(agentSessionItems).where(eq(agentSessionItems.sessionId, this.sessionId));
      await tx.update(agentSessions).set({ summary: null, lastSlackTs: null }).where(eq(agentSessions.id, this.sessionId));
    });
  }

  /** Last Slack message already folded into this session (Requirement 10.4). */
  async getLastSlackTs(): Promise<string | null> {
    const [row] = await this.db.select({ ts: agentSessions.lastSlackTs }).from(agentSessions).where(eq(agentSessions.id, this.sessionId));
    return row?.ts ?? null;
  }

  async setLastSlackTs(ts: string): Promise<void> {
    await this.ensure(this.db);
    await this.db.update(agentSessions).set({ lastSlackTs: ts }).where(eq(agentSessions.id, this.sessionId));
  }

  private async ensure(db: Pick<Db, 'insert'>) {
    await db.insert(agentSessions).values({ id: this.sessionId, orgId: DEFAULT_ORG_ID }).onConflictDoNothing();
  }

  private async truncate(tx: Parameters<Parameters<Db['transaction']>[0]>[0]) {
    const rows = await tx
      .select({ seq: agentSessionItems.seq, item: agentSessionItems.item })
      .from(agentSessionItems)
      .where(eq(agentSessionItems.sessionId, this.sessionId))
      .orderBy(asc(agentSessionItems.seq));
    if (rows.length <= this.maxItems) return;

    let cut = rows.length - this.maxItems;
    while (cut < rows.length && isOutput(rows[cut]!.item as AgentInputItem)) cut++;
    const dropped = rows.slice(0, cut);
    const lastDropped = dropped.at(-1)!.seq;

    const [session] = await tx.select({ summary: agentSessions.summary }).from(agentSessions).where(eq(agentSessions.id, this.sessionId));
    const summary = await this.summarize(dropped.map((r) => r.item as AgentInputItem), session?.summary ?? null);
    await tx
      .delete(agentSessionItems)
      .where(and(eq(agentSessionItems.sessionId, this.sessionId), lte(agentSessionItems.seq, lastDropped)));
    await tx.update(agentSessions).set({ summary }).where(eq(agentSessions.id, this.sessionId));
  }
}


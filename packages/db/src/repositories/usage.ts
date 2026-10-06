import { and, eq, gte, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, llmUsage, settings } from '../schema';
import type { DbOrTx, Insert } from './upsert';

export type LlmUsageInsert = Omit<Insert<typeof llmUsage>, 'orgId' | 'id'>;

export async function insertLlmUsage(db: DbOrTx, rows: readonly LlmUsageInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(llmUsage).values(rows.map((r) => ({ ...r, orgId: DEFAULT_ORG_ID })));
}

/** Total estimated LLM cost since an instant. */
export async function llmCostSince(db: DbOrTx, since: Date): Promise<number> {
  const [row] = await db
    .select({ cost: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`.mapWith(Number) })
    .from(llmUsage)
    .where(and(eq(llmUsage.orgId, DEFAULT_ORG_ID), gte(llmUsage.at, since)));
  return row?.cost ?? 0;
}

// --- settings (key/value, Requirement 18.4) --------------------------------------------

export async function getSetting<T>(db: DbOrTx, key: string): Promise<T | undefined> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.orgId, DEFAULT_ORG_ID), eq(settings.key, key)));
  return row?.value as T | undefined;
}

export async function setSetting(db: DbOrTx, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ orgId: DEFAULT_ORG_ID, key, value })
    .onConflictDoUpdate({ target: [settings.orgId, settings.key], set: { value, updatedAt: sql`now()` } });
}

/** Sets the key only if it does not hold `value` yet; true when this call changed it. */
export async function setSettingOnce(db: DbOrTx, key: string, value: unknown): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ orgId: DEFAULT_ORG_ID, key, value })
    .onConflictDoUpdate({
      target: [settings.orgId, settings.key],
      set: { value, updatedAt: sql`now()` },
      setWhere: sql`${settings.value} is distinct from ${JSON.stringify(value)}::jsonb`,
    })
    .returning({ key: settings.key });
  return rows.length === 1;
}

import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../client';

/** A Drizzle database or an open transaction. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Insert shape without the timestamps the database maintains. */
export type Insert<T extends PgTable> = Omit<T['$inferInsert'], 'createdAt' | 'updatedAt'>;

/** `SET col = excluded.col` for each key, and updated_at = now(). */
export function setExcluded<T extends PgTable>(table: T, keys: readonly (keyof T['$inferInsert'] & string)[]) {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  const set: Record<string, SQL> = { updatedAt: sql`now()` };
  for (const key of keys) set[key] = sql.raw(`excluded."${columns[key]!.name}"`);
  return set;
}

// Postgres allows 65535 bind parameters per statement.
const MAX_PARAMS = 60_000;

/** Runs `fn` over row batches sized to stay under the bind-parameter limit. */
export async function inBatches<R, T>(
  table: PgTable,
  rows: readonly R[],
  fn: (batch: R[]) => Promise<T[]>,
): Promise<T[]> {
  const size = Math.max(1, Math.floor(MAX_PARAMS / Object.keys(getTableColumns(table)).length));
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += size) out.push(...(await fn(rows.slice(i, i + size))));
  return out;
}

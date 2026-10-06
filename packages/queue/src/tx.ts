import { sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type SendOptions } from 'pg-boss';

/**
 * Send options that enqueue inside a Drizzle transaction: the job exists only if the
 * transaction commits (e.g. a ChangeSet row and its `changeset.process` job).
 */
export function inTransaction(tx: DrizzleTransactionLike): SendOptions {
  return { db: fromDrizzle(tx, sql) };
}

import { lt, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, slackEventsSeen } from '../schema';
import type { DbOrTx } from './upsert';

const TTL = sql`interval '1 day'`;

/** True the first time an event id is seen; false for Slack retries of the same event. */
export async function markSlackEventSeen(db: DbOrTx, eventId: string): Promise<boolean> {
  const inserted = await db
    .insert(slackEventsSeen)
    .values({ eventId, orgId: DEFAULT_ORG_ID })
    .onConflictDoNothing()
    .returning({ eventId: slackEventsSeen.eventId });
  // Event volume is low (one internal workspace), so pruning inline keeps the table small.
  await db.delete(slackEventsSeen).where(lt(slackEventsSeen.seenAt, sql`now() - ${TTL}`));
  return inserted.length === 1;
}

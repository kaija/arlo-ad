// The write path for agents (ADR-0006): store a ChangeSet and queue changeset.process in the same
// transaction, so a ChangeSet never exists without its job (or the other way round).
import { insertChangeSet, type Db, type NewChangeSet } from '@arlo/db';
import { enqueue, inTransaction, Jobs, type PgBoss } from '@arlo/queue';

export function createProposer(db: Db, boss: PgBoss) {
  return (input: NewChangeSet) =>
    db.transaction(async (tx) => {
      const cs = await insertChangeSet(tx, input);
      await enqueue(boss, Jobs.changesetProcess, { changesetId: cs.id }, inTransaction(tx));
      return { id: cs.id };
    });
}

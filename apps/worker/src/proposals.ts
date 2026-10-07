// The write path for agents (ADR-0006): store a ChangeSet and queue changeset.process in the same
// transaction, so a ChangeSet never exists without its job (or the other way round).
import type { CampaignBrief } from '@arlo/core';
import { createCampaignTask, insertChangeSet, type Db, type NewChangeSet } from '@arlo/db';
import { enqueue, inTransaction, Jobs, type PgBoss } from '@arlo/queue';

export function createProposer(db: Db, boss: PgBoss) {
  return (input: NewChangeSet) =>
    db.transaction(async (tx) => {
      const cs = await insertChangeSet(tx, input);
      await enqueue(boss, Jobs.changesetProcess, { changesetId: cs.id }, inTransaction(tx));
      return { id: cs.id };
    });
}

/** Campaign tasks from chat: the task and its campaign.generate job commit together. */
export function createCampaignTaskCreator(db: Db, boss: PgBoss) {
  return (input: { accountId: string; brief: CampaignBrief; createdBy: string | null }) =>
    db.transaction(async (tx) => {
      const task = await createCampaignTask(tx, input);
      await enqueue(boss, Jobs.campaignGenerate, { taskId: task.id }, inTransaction(tx));
      return { id: task.id };
    });
}

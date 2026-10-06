'use server';

import { getChangeSet } from '@arlo/db';
import { Jobs } from '@arlo/queue';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { mayDecide, type DecisionVerb } from '../../../lib/changesets';
import { enqueueJob } from '../../../lib/queue';
import { getDb } from '../../../lib/server';
import { ForbiddenError, readableAccounts, requireUser } from '../../../lib/session';

// Approve / reject / undo from the Web console: checked here for a clear error, then handed to the
// worker, which runs the same authorize + Executor path as Slack (Requirement 18.8).
export async function decideAction(changesetId: string, verb: DecisionVerb, form: FormData): Promise<void> {
  const user = await requireUser();
  const cs = await getChangeSet(getDb(), changesetId);
  const allowed = readableAccounts(user);
  if (!cs || (allowed !== null && !allowed.includes(cs.accountId))) throw new ForbiddenError('missing_target');
  if (!mayDecide(user, cs, verb, new Date())) throw new ForbiddenError('not_allowed');
  if (verb === 'confirm' && form.get('confirm') !== 'on') redirect(`/changesets/${changesetId}?error=confirm`);
  const reason = String(form.get('reason') ?? '').trim().slice(0, 500) || null;
  await enqueueJob(Jobs.changesetDecide, { changesetId, userId: user.id, verb, reason });
  revalidatePath('/changesets');
  redirect(`/changesets/${changesetId}?submitted=${verb}`);
}

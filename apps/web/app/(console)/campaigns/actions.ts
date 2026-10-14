'use server';

import { authorize } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { briefFormValues, parseBriefForm, submitBrief, type BriefFormValues } from '../../../lib/campaigns';
import { translateErrors } from '../../../lib/i18n-server';
import { getBoss } from '../../../lib/queue';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';

export interface BriefFormState {
  errors?: Partial<Record<keyof BriefFormValues, string>>;
  values?: BriefFormValues;
}

// Briefs are proposals (operator or above on the account, Requirement 1.4).
export async function submitBriefAction(_prev: BriefFormState, form: FormData): Promise<BriefFormState> {
  const user = await requireUser();
  const db = getDb();
  const accounts = (await resolveAccounts(db, { allowed: readableAccounts(user) })).filter((a) => authorize(user, 'propose', { accountId: a.id }).allowed).map((a) => a.id);
  const values = briefFormValues(form);
  const parsed = parseBriefForm(values, accounts);
  if (!parsed.ok) return { errors: await translateErrors(parsed.errors), values };
  const task = await submitBrief(db, await getBoss(), { accountId: parsed.accountId, brief: parsed.brief, userId: user.id });
  revalidatePath('/campaigns');
  redirect(`/campaigns/${task.id}`);
}

'use server';

import { deleteRule, saveRule } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { translateErrors } from '../../../../lib/i18n-server';
import { parseRuleForm, ruleFormValues, type RuleFormValues } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireAuthorized } from '../../../../lib/session';

export interface RuleFormState {
  errors?: Partial<Record<string, string>>;
  values?: RuleFormValues;
}

// Validator rules are settings (Requirement 18.4): admins only.
export async function saveRuleAction(id: string | null, _prev: RuleFormState, form: FormData): Promise<RuleFormState> {
  const user = await requireAuthorized('admin');
  const values = ruleFormValues(form);
  const parsed = parseRuleForm(values);
  if (!parsed.ok) return { errors: await translateErrors(parsed.errors), values };
  await saveRule(getDb(), { ...parsed.value, ...(id ? { id } : {}) }, { kind: 'user', id: user.id });
  revalidatePath('/settings/rules');
  redirect('/settings/rules?saved=1');
}

export async function deleteRuleAction(id: string): Promise<void> {
  const user = await requireAuthorized('admin');
  await deleteRule(getDb(), id, { kind: 'user', id: user.id });
  revalidatePath('/settings/rules');
  redirect('/settings/rules');
}

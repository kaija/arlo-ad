'use server';

import { clearTierThresholds, setTierThresholds } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { parseThresholdForm, type ThresholdFormValues } from '../../../../lib/rules';
import { getDb } from '../../../../lib/server';
import { requireAuthorized } from '../../../../lib/session';

export interface ThresholdFormState {
  errors?: Partial<Record<keyof ThresholdFormValues, string>>;
  values?: ThresholdFormValues;
  saved?: boolean;
}

// Tier thresholds are settings (Requirement 18.4): admins only. accountId null = org default.
export async function saveThresholdsAction(accountId: string | null, _prev: ThresholdFormState, form: FormData): Promise<ThresholdFormState> {
  const user = await requireAuthorized('admin');
  const values: ThresholdFormValues = {
    tier3Pct: String(form.get('tier3Pct') ?? ''),
    tier3Amount: String(form.get('tier3Amount') ?? ''),
    tier1MaxReducePct: String(form.get('tier1MaxReducePct') ?? ''),
  };
  const parsed = parseThresholdForm(values);
  if (!parsed.ok) return { errors: parsed.errors, values };
  await setTierThresholds(getDb(), accountId, parsed.value, { kind: 'user', id: user.id });
  revalidatePath('/settings/thresholds');
  return { values, saved: true };
}

export async function clearThresholdsAction(accountId: string): Promise<void> {
  const user = await requireAuthorized('admin');
  await clearTierThresholds(getDb(), accountId, { kind: 'user', id: user.id });
  revalidatePath('/settings/thresholds');
}

'use server';

import { saveBusinessProfile } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { parseProfileForm, profileFormValues, type ProfileFormValues } from '../../../../lib/business-profile';
import { translateErrors } from '../../../../lib/i18n-server';
import { getDb } from '../../../../lib/server';
import { ForbiddenError, requireAuthorized } from '../../../../lib/session';

export interface ProfileFormState {
  errors?: Partial<Record<keyof ProfileFormValues, string>>;
  values?: ProfileFormValues;
  savedVersion?: number;
}

// Business Profile is a setting (Requirement 18.4): admins only. Every save is a new version.
export async function saveProfileAction(accountId: string, _prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await requireAuthorized('admin');
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new ForbiddenError('invalid');
  const values = profileFormValues(form);
  const parsed = parseProfileForm(values);
  if (!parsed.ok) return { errors: await translateErrors(parsed.errors), values };
  const saved = await saveBusinessProfile(getDb(), accountId, parsed.value, { kind: 'user', id: user.id });
  revalidatePath('/settings/business-profile');
  return { values, savedVersion: saved.version };
}

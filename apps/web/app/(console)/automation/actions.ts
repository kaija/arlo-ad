'use server';

import { setAutomationMode } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { isFeature, isMode } from '../../../lib/automation';
import { getDb } from '../../../lib/server';
import { ForbiddenError, requireAuthorized } from '../../../lib/session';

// Only admins switch automation modes (Requirement 9.5).
export async function setModeAction(accountId: string, feature: string, form: FormData): Promise<void> {
  const user = await requireAuthorized('admin');
  const mode = form.get('mode');
  if (!isFeature(feature) || !isMode(mode) || !/^[0-9a-f-]{36}$/i.test(accountId)) throw new ForbiddenError('invalid');
  await setAutomationMode(getDb(), accountId, feature, mode, { kind: 'user', id: user.id });
  revalidatePath('/automation');
}

'use server';

import { setGa4Property } from '@arlo/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '../../../lib/server';
import { requireAuthorized } from '../../../lib/session';

// Linking GA4 is a setting (Requirement 18.4): admins only.
export async function setGa4PropertyAction(accountId: string, form: FormData): Promise<void> {
  const user = await requireAuthorized('admin');
  const raw = String(form.get('propertyId') ?? '').trim();
  const propertyId = raw === '' ? null : raw.replace(/^properties\//, '');
  if (propertyId !== null && !/^\d{4,20}$/.test(propertyId)) redirect(`/tracking?account=${accountId}&error=ga4`);
  await setGa4Property(getDb(), accountId, propertyId, { kind: 'user', id: user.id });
  revalidatePath('/tracking');
  redirect(`/tracking?account=${accountId}`);
}

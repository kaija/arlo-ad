// Server-side session helpers for console pages and server actions (Requirement 18.8).
import { authorize, readableAccountIds, type Action, type AuthzTarget } from '@arlo/core';
import { redirect } from 'next/navigation';
import { auth } from '../auth';
import type { ArloSessionUser } from './auth-config';

export async function requireUser(): Promise<ArloSessionUser> {
  const session = await auth();
  if (!session?.arlo) redirect('/signin');
  return session.arlo;
}

export function readableAccounts(user: ArloSessionUser): string[] | null {
  return readableAccountIds(user);
}

export class ForbiddenError extends Error {
  constructor(readonly reason: string) {
    super(`forbidden: ${reason}`);
  }
}

/** Throws unless the user may perform the action; server actions call this first. */
export async function requireAuthorized(action: Action, target?: AuthzTarget): Promise<ArloSessionUser> {
  const user = await requireUser();
  const result = authorize(user, action, target);
  if (!result.allowed) throw new ForbiddenError(result.reason);
  return user;
}

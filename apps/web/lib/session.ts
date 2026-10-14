// Server-side session helpers for console pages and server actions (Requirement 18.8).
import { authorize, readableAccountIds, type Action, type AuthzTarget } from '@arlo/core';
import { redirect } from 'next/navigation';
import { auth } from '../auth';
import type { ArloSessionUser } from './auth-config';

/** Any signed-in user, with or without a role; only the pending page uses this directly. */
export async function requireSignedIn(): Promise<ArloSessionUser> {
  const session = await auth();
  if (!session?.arlo) redirect('/signin');
  return session.arlo;
}

/** A signed-in user with at least one role binding; users awaiting a role are held at /pending. */
export async function requireUser(): Promise<ArloSessionUser> {
  const user = await requireSignedIn();
  if (user.bindings.length === 0) redirect('/pending');
  return user;
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

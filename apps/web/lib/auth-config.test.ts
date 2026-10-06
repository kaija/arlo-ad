import { createLogger } from '@arlo/config/logger';
import { DEFAULT_ORG_ID, findUserByEmail, schema } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import type { Session } from 'next-auth';
import { describe, expect, it } from 'vitest';
import { buildAuthConfig } from './auth-config';

const env = {
  AUTH_SECRET: 'test-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  ALLOWED_WORKSPACE_DOMAIN: 'example.com',
};
const logger = createLogger({ component: 'test', level: 'silent' });

type Callbacks = Required<NonNullable<ReturnType<typeof buildAuthConfig>['callbacks']>>;
type SignInArgs = Parameters<Callbacks['signIn']>[0];

describe('Auth.js config', () => {
  const t = useTestDatabase();
  const callbacks = () => buildAuthConfig(env, { db: t.db, logger }).callbacks as Callbacks;

  const signIn = (profile: Record<string, unknown>, provider = 'google') =>
    callbacks().signIn({
      user: {},
      account: { provider, type: 'oidc', providerAccountId: 'sub' },
      profile,
    } as SignInArgs);

  const profile = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    email_verified: true,
    hd: email.split('@')[1],
    name: 'Pat',
    ...extra,
  });

  it('restricts Google account selection to the Workspace domain', () => {
    const config = buildAuthConfig(env, { db: t.db, logger });
    const google = config.providers[0] as unknown as { options: { authorization: { params: Record<string, string> } } };
    expect(google.options.authorization.params).toMatchObject({ hd: 'example.com' });
  });

  it.each([
    ['consumer account', profile('pat@gmail.com', { hd: undefined })],
    ['other Workspace domain', profile('pat@other.com')],
    ['unverified email', profile('pat@example.com', { email_verified: false })],
  ])('rejects %s without creating a user', async (_, p) => {
    expect(await signIn(p)).toBe(false);
    expect(await findUserByEmail(t.db, p.email)).toBeUndefined();
  });

  it('rejects other providers', async () => {
    expect(await signIn(profile('pat@example.com'), 'github')).toBe(false);
  });

  it('creates an unbound user on first sign-in and exposes it in the session', async () => {
    expect(await signIn(profile('New.User@example.com'))).toBe(true);
    const user = await findUserByEmail(t.db, 'new.user@example.com');
    expect(user).toMatchObject({ status: 'unbound', displayName: 'Pat', orgId: DEFAULT_ORG_ID });

    await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: user!.id, role: 'approver', maxTier: 2 });
    const token = await callbacks().jwt({ token: {}, profile: { email: 'new.user@example.com' } } as Parameters<Callbacks['jwt']>[0]);
    expect(token).toMatchObject({ uid: user!.id });

    const session = (await callbacks().session({ session: { expires: '' }, token } as never)) as Session;
    expect(session.arlo).toEqual({
      id: user!.id,
      email: 'new.user@example.com',
      displayName: 'Pat',
      status: 'unbound',
      slackUserId: null,
      bindings: [{ role: 'approver', accountIds: null, maxTier: 2 }],
    });
  });

  it('rejects disabled users at sign-in and drops them from existing sessions', async () => {
    const [user] = await t.db
      .insert(schema.users)
      .values({ orgId: DEFAULT_ORG_ID, googleEmail: 'gone@example.com', status: 'disabled' })
      .returning();
    expect(await signIn(profile('gone@example.com'))).toBe(false);
    const session = (await callbacks().session({ session: { expires: '' }, token: { uid: user!.id } } as never)) as Session;
    expect(session.arlo).toBeUndefined();
  });
});

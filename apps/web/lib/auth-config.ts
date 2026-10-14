// Auth.js configuration (Requirement 1.1, ADR-0010). Kept separate from `auth.ts` so tests
// can drive the callbacks against a test database without a Next.js request.
import { checkWorkspaceProfile, type GoogleProfile } from '@arlo/core';
import type { Logger } from '@arlo/config/logger';
import type { UserDirectory } from '@arlo/adapters/chat';
import { bindSlackUserByEmail, findUserByEmail, getUserWithBindings, upsertUserOnSignIn, type Db } from '@arlo/db';
import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

export interface AuthEnv {
  AUTH_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Unset: any verified Google account may sign in. */
  ALLOWED_WORKSPACE_DOMAIN?: string | undefined;
}

export interface AuthDeps {
  db: Db;
  logger: Logger;
  /** Slack directory for binding users on sign-in (Requirement 1.2). */
  directory: UserDirectory;
}

/** The signed-in internal user, re-read from Postgres on every request so role changes apply at once. */
export interface ArloSessionUser {
  id: string;
  email: string;
  displayName: string | null;
  status: 'active' | 'unbound' | 'disabled';
  slackUserId: string | null;
  bindings: { role: 'viewer' | 'operator' | 'approver' | 'admin'; accountIds: string[] | null; maxTier: number }[];
}

declare module 'next-auth' {
  interface Session {
    arlo?: ArloSessionUser;
  }
}

export function buildAuthConfig(env: AuthEnv, { db, logger, directory }: AuthDeps): NextAuthConfig {
  const domain = env.ALLOWED_WORKSPACE_DOMAIN;
  return {
    secret: env.AUTH_SECRET,
    // Served behind Caddy; the Host header is the configured APP_DOMAIN.
    trustHost: true,
    session: { strategy: 'jwt' },
    pages: { signIn: '/signin', error: '/signin' },
    providers: [
      Google({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        // `hd` only narrows Google's account chooser; the signIn callback enforces the domain.
        authorization: { params: { ...(domain ? { hd: domain } : {}), prompt: 'select_account' } },
      }),
    ],
    callbacks: {
      async signIn({ account, profile }) {
        if (account?.provider !== 'google') return false;
        const decision = checkWorkspaceProfile(profile as GoogleProfile | undefined, domain);
        if (!decision.ok) {
          logger.warn({ reason: decision.reason, email: profile?.email }, 'sign-in rejected');
          return false;
        }
        const user = await upsertUserOnSignIn(db, { email: decision.email, displayName: profile?.name ?? null });
        if (user.status === 'disabled') {
          logger.warn({ userId: user.id }, 'sign-in rejected: user disabled');
          return false;
        }
        if (user.status === 'unbound') {
          // Binding is best effort: a Slack outage must not block Web sign-in.
          try {
            const outcome = await bindSlackUserByEmail(db, user, (email) => directory.lookupByEmail(email));
            if (outcome !== 'bound') logger.warn({ userId: user.id, outcome }, 'slack binding left unbound');
          } catch (err) {
            logger.error({ err, userId: user.id }, 'slack lookup failed');
          }
        }
        return true;
      },
      async jwt({ token, profile }) {
        // `profile` is only present on the sign-in request; `uid` is the internal user id.
        if (profile?.email) token.uid = (await findUserByEmail(db, profile.email))?.id;
        return token;
      },
      async session({ session, token }) {
        const user = typeof token.uid === 'string' ? await getUserWithBindings(db, token.uid) : undefined;
        if (user && user.status !== 'disabled') {
          session.arlo = {
            id: user.id,
            email: user.googleEmail,
            displayName: user.displayName,
            status: user.status,
            slackUserId: user.slackUserId,
            bindings: user.bindings.map((b) => ({ role: b.role, accountIds: b.accountIds, maxTier: b.maxTier })),
          };
        }
        return session;
      },
    },
  };
}

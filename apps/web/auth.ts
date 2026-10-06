import { EnvSchema, parseEnv } from '@arlo/config';
import NextAuth from 'next-auth';
import { buildAuthConfig } from './lib/auth-config';
import { getDb, logger } from './lib/server';

const AuthEnv = EnvSchema.pick({
  AUTH_SECRET: true,
  GOOGLE_OAUTH_CLIENT_ID: true,
  GOOGLE_OAUTH_CLIENT_SECRET: true,
  ALLOWED_WORKSPACE_DOMAIN: true,
});

// Lazy: configuration is read per request so `next build` needs no secrets.
export const { handlers, auth, signIn, signOut } = NextAuth(() =>
  buildAuthConfig(parseEnv(AuthEnv), { db: getDb(), logger }),
);

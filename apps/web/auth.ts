import { createSlackDirectory } from '@arlo/adapters/chat';
import { EnvSchema, parseEnv } from '@arlo/config';
import { WebClient } from '@slack/web-api';
import NextAuth from 'next-auth';
import { buildAuthConfig } from './lib/auth-config';
import { getDb, logger } from './lib/server';

const AuthEnv = EnvSchema.pick({
  AUTH_SECRET: true,
  GOOGLE_OAUTH_CLIENT_ID: true,
  GOOGLE_OAUTH_CLIENT_SECRET: true,
  ALLOWED_WORKSPACE_DOMAIN: true,
  SLACK_BOT_TOKEN: true,
});

// Lazy: configuration is read per request so `next build` needs no secrets.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = parseEnv(AuthEnv);
  return buildAuthConfig(env, {
    db: getDb(),
    logger,
    directory: createSlackDirectory(new WebClient(env.SLACK_BOT_TOKEN)),
  });
});

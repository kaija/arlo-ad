import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { createPool, type Pool } from '@arlo/db';

export const logger = createLogger({ component: 'web' });

// Validate only the keys web uses so far; extend the pick as features land. Parsed lazily
// so `next build` does not need runtime secrets.
const WebEnv = EnvSchema.pick({ DATABASE_URL: true });

// Cached on globalThis so dev hot reloads reuse one pool.
const cache = globalThis as typeof globalThis & { arloPool?: Pool };

export function getPool(): Pool {
  if (!cache.arloPool) {
    let env;
    try {
      env = parseEnv(WebEnv);
    } catch (err) {
      logger.error({ err }, 'invalid configuration');
      throw err;
    }
    cache.arloPool = createPool({ connectionString: env.DATABASE_URL, logger });
  }
  return cache.arloPool;
}

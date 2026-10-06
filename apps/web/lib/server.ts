import { createLogger } from '@arlo/config/logger';
import { createPool, type Pool } from '@arlo/db';

export const logger = createLogger({ component: 'web' });

// Cached on globalThis so dev hot reloads reuse one pool. Created lazily so `next build`
// does not need DATABASE_URL.
const cache = globalThis as typeof globalThis & { arloPool?: Pool };

export function getPool(): Pool {
  if (!cache.arloPool) {
    // TODO(task 1.4): read from the validated env schema in @arlo/config.
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    cache.arloPool = createPool({ connectionString, logger });
  }
  return cache.arloPool;
}

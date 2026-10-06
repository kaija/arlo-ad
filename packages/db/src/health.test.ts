import { createLogger } from '@arlo/config/logger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from './client';
import { checkDatabase } from './health';
import { startTestPostgres } from './testing';

const logger = createLogger({ component: 'test', level: 'silent' });

describe('checkDatabase', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await startTestPostgres();
    pool = createPool({ connectionString: container.getConnectionUri(), logger });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('is ok when Postgres answers', async () => {
    const result = await checkDatabase(pool, { logger });
    expect(result).toMatchObject({ ok: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports the error code when Postgres is unreachable', async () => {
    const dead = createPool({ connectionString: 'postgres://arlo:x@127.0.0.1:1/arlo', logger });
    try {
      expect(await checkDatabase(dead, { logger })).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    } finally {
      await dead.end();
    }
  });

  it('reports a timeout when the query hangs', async () => {
    const hung = { query: () => new Promise(() => {}) } as unknown as Pool;
    expect(await checkDatabase(hung, { logger, timeoutMs: 20 })).toMatchObject({ ok: false, error: 'timeout' });
  });
});

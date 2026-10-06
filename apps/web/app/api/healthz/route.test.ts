import { createLogger } from '@arlo/config/logger';
import { useTestDatabase } from '@arlo/db/testing';
import { createBoss } from '@arlo/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBoss } from '../../../lib/queue';
import { getPool } from '../../../lib/server';
import { GET } from './route';

describe('GET /api/healthz', () => {
  const t = useTestDatabase();

  beforeAll(async () => {
    process.env.DATABASE_URL = t.url;
    // `migrate` installs the pg-boss schema in production; web only produces jobs.
    const migrator = createBoss({ connectionString: t.url, logger: createLogger({ component: 'test', level: 'silent' }), role: 'migrator' });
    await migrator.start();
    await migrator.stop({ graceful: false, close: true });
  });

  afterAll(async () => {
    // Cached connections must close before the test database is dropped.
    await (await getBoss()).stop({ graceful: false, close: true });
    await getPool().end();
  });

  it('returns 200 with DB and queue status when Postgres is up', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { db: { ok: true }, queue: { ok: true } } });
  });
});

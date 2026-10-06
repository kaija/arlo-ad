import { useTestDatabase } from '@arlo/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '../../../lib/server';
import { GET } from './route';

describe('GET /api/healthz', () => {
  const t = useTestDatabase();

  beforeAll(() => {
    process.env.DATABASE_URL = t.url;
  });

  afterAll(async () => {
    // The route's cached pool must close before the test database is dropped.
    await getPool().end();
  });

  it('returns 200 with DB status when Postgres is up', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { db: { ok: true } } });
  });
});

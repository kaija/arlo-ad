import { startTestPostgres } from '@arlo/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '../../../lib/server';
import { GET } from './route';

describe('GET /api/healthz', () => {
  let stop: (() => Promise<unknown>) | undefined;

  beforeAll(async () => {
    const container = await startTestPostgres();
    stop = () => container.stop();
    process.env.DATABASE_URL = container.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await getPool().end();
    await stop?.();
  });

  it('returns 200 with DB status when Postgres is up', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { db: { ok: true } } });
  });
});

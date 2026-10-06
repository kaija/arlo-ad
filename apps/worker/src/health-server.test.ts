import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@arlo/config/logger';
import { checkDatabase, createPool, type Pool } from '@arlo/db';
import { startTestPostgres } from '@arlo/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeServer, startHealthServer } from './health-server';

const logger = createLogger({ component: 'test', level: 'silent' });

async function serve(pool: Pool): Promise<{ url: string; server: Server }> {
  const server = await startHealthServer({
    port: 0,
    host: '127.0.0.1',
    checks: { db: () => checkDatabase(pool, { logger }) },
    logger,
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('worker /healthz', () => {
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

  it('returns 200 with DB status when Postgres is up', async () => {
    const { url, server } = await serve(pool);
    try {
      const res = await fetch(`${url}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ status: 'ok', checks: { db: { ok: true } } });
    } finally {
      await closeServer(server);
    }
  });

  it('returns 503 with DB error code when Postgres is unreachable', async () => {
    const dead = createPool({ connectionString: 'postgres://arlo:x@127.0.0.1:1/arlo', logger });
    const { url, server } = await serve(dead);
    try {
      const res = await fetch(`${url}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: 'fail', checks: { db: { ok: false, error: 'ECONNREFUSED' } } });
    } finally {
      await closeServer(server);
      await dead.end();
    }
  });

  it('returns 404 for other paths and methods', async () => {
    const { url, server } = await serve(pool);
    try {
      expect((await fetch(`${url}/`)).status).toBe(404);
      expect((await fetch(`${url}/healthz`, { method: 'POST' })).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });
});

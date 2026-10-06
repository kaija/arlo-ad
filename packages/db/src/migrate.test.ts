import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@arlo/config/logger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from './client';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import { startTestPostgres } from './testing';

const logger = createLogger({ component: 'test', level: 'silent' });

function migrationsWith(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-migrations-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(join(dir, '0000_init.sql'), sql);
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1_700_000_000_000, tag: '0000_init', breakpoints: true }],
    }),
  );
  return dir;
}

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const tmpDirs: string[] = [];

  beforeAll(async () => {
    container = await startTestPostgres();
    pool = createPool({ connectionString: container.getConnectionUri(), logger });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  const applied = async () => (await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n;

  it('runs the repository migrations folder', async () => {
    await runMigrations(pool, { logger, migrationsFolder: MIGRATIONS_FOLDER });
    expect(await applied()).toBeGreaterThanOrEqual(0);
  });

  it('applies a migration once and is idempotent', async () => {
    const dir = migrationsWith('create table probe (id int primary key);');
    tmpDirs.push(dir);
    await runMigrations(pool, { logger, migrationsFolder: dir });
    await runMigrations(pool, { logger, migrationsFolder: dir });
    expect(await applied()).toBe(1);
    expect((await pool.query("select to_regclass('public.probe') as t")).rows[0].t).toBe('probe');
  });

  it('serializes concurrent runs', async () => {
    const dir = migrationsWith('create table probe_concurrent (id int primary key);');
    tmpDirs.push(dir);
    await pool.query('drop schema drizzle cascade');
    await Promise.all([1, 2, 3].map(() => runMigrations(pool, { logger, migrationsFolder: dir })));
    expect(await applied()).toBe(1);
  });

  it('fails on invalid SQL and leaves nothing applied', async () => {
    const dir = migrationsWith('create table broken (;');
    tmpDirs.push(dir);
    await pool.query('drop schema drizzle cascade');
    await expect(runMigrations(pool, { logger, migrationsFolder: dir })).rejects.toThrow();
    expect(await applied()).toBe(0);
  });
});

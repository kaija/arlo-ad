import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@arlo/config/logger';
import { afterAll, describe, expect, it } from 'vitest';
import type { Pool } from './client';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate';
import { DEFAULT_ORG_ID } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

const logger = createLogger({ component: 'test', level: 'silent' });
const cleanups: (() => Promise<unknown> | void)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

// Each case gets an empty database: drizzle only applies migrations newer than the last applied one.
async function blankDatabase(): Promise<TestDatabase> {
  const t = await createTestDatabase({ migrated: false });
  cleanups.push(() => t.drop());
  return t;
}

function migrationsWith(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-migrations-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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

const applied = async (pool: Pool) =>
  (await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n;

describe('runMigrations', () => {
  it('applies every repository migration and seeds the default org', async () => {
    const { pool } = await blankDatabase();
    await runMigrations(pool, { logger });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
    expect(await applied(pool)).toBe(journal.entries.length);
    expect((await pool.query('select id from orgs')).rows).toEqual([{ id: DEFAULT_ORG_ID }]);
  });

  it('applies a migration once and is idempotent', async () => {
    const { pool } = await blankDatabase();
    const dir = migrationsWith('create table probe (id int primary key);');
    await runMigrations(pool, { logger, migrationsFolder: dir });
    await runMigrations(pool, { logger, migrationsFolder: dir });
    expect(await applied(pool)).toBe(1);
    expect((await pool.query("select to_regclass('public.probe') as t")).rows[0].t).toBe('probe');
  });

  it('serializes concurrent runs', async () => {
    const { pool } = await blankDatabase();
    const dir = migrationsWith('create table probe (id int primary key);');
    await Promise.all([1, 2, 3].map(() => runMigrations(pool, { logger, migrationsFolder: dir })));
    expect(await applied(pool)).toBe(1);
  });

  it('fails on invalid SQL and leaves nothing applied', async () => {
    const { pool } = await blankDatabase();
    const dir = migrationsWith('create table broken (;');
    await expect(runMigrations(pool, { logger, migrationsFolder: dir })).rejects.toThrow();
    expect(await applied(pool)).toBe(0);
  });
});

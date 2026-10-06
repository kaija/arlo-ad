import { createLogger } from '@arlo/config/logger';
import { describe, expect, inject, it } from 'vitest';
import { createPool } from '../client';
import { createTestDatabase } from './database';

const logger = createLogger({ component: 'test', level: 'silent' });

describe('createTestDatabase', () => {
  it('gives each caller an isolated, migrated database and drops it afterwards', async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      expect(a.name).not.toBe(b.name);
      await a.pool.query(`insert into settings (org_id, key, value) select id, 'probe', '1' from orgs`);
      expect((await a.pool.query('select count(*)::int as n from settings')).rows[0].n).toBe(1);
      expect((await b.pool.query('select count(*)::int as n from settings')).rows[0].n).toBe(0);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
    const admin = createPool({ connectionString: inject('arloTestPostgres').adminUrl, logger, max: 1 });
    try {
      const { rows } = await admin.query('select datname from pg_database where datname = any($1)', [[a.name, b.name]]);
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('can create an empty database', async () => {
    const t = await createTestDatabase({ migrated: false });
    try {
      expect((await t.pool.query("select to_regclass('public.orgs') as t")).rows[0].t).toBeNull();
    } finally {
      await t.drop();
    }
  });
});

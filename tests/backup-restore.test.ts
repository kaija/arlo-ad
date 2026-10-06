// Integration test for scripts/backup.sh and scripts/restore.sh (task 2.3) against a real Postgres.
// S3 is replaced by a fake `aws` CLI over a temp directory; the Slack webhook by a local HTTP server.
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const BUCKET = 'arlo-backups';

const FAKE_AWS = `#!/bin/sh
# Fake \`aws s3 cp [--only-show-errors] SRC DST\` backed by $FAKE_S3_ROOT.
[ "$1 $2" = "s3 cp" ] || { echo "unsupported: $*" >&2; exit 64; }
shift 2
[ "$1" = "--only-show-errors" ] && shift
map() { case "$1" in s3://*) echo "$FAKE_S3_ROOT/\${1#s3://}" ;; *) echo "$1" ;; esac; }
src=$(map "$1"); dst=$(map "$2")
mkdir -p "$(dirname "$dst")" && cp "$src" "$dst"
`;

describe('backup.sh / restore.sh', () => {
  let pg: StartedPostgreSqlContainer;
  let dir: string;
  let webhook: Server;
  let webhookUrl: string;
  let notifications: string[] = [];

  beforeAll(async () => {
    // Same image as docker-compose.prod.yml.
    pg = await new PostgreSqlContainer('postgres:18-alpine').start();
    dir = mkdtempSync(join(tmpdir(), 'arlo-backup-test-'));
    writeFileSync(join(dir, 'aws'), FAKE_AWS);
    chmodSync(join(dir, 'aws'), 0o755);
    webhook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        notifications.push(JSON.parse(body).text);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    webhookUrl = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => webhook?.close(resolve));
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    notifications = [];
  });

  const env = (overrides: Record<string, string> = {}) => ({
    ...process.env,
    ENV_FILE: '/dev/null',
    PG_EXEC: `docker exec -i ${pg.getId()}`,
    PG_USER: pg.getUsername(),
    PG_DB: pg.getDatabase(),
    AWS_CLI: join(dir, 'aws'),
    FAKE_S3_ROOT: join(dir, 's3'),
    BACKUP_S3_BUCKET: BUCKET,
    SLACK_OPS_WEBHOOK_URL: webhookUrl,
    ...overrides,
  });

  const script = (name: string, args: string[], overrides?: Record<string, string>) =>
    run('bash', [join(REPO, 'scripts', name), ...args], { env: env(overrides) });

  const sql = async (query: string, db = pg.getDatabase()) => {
    const res = await pg.exec(['psql', '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', pg.getUsername(), '-d', db, '-c', query]);
    if (res.exitCode !== 0) throw new Error(res.output);
    return res.stdout.trim();
  };

  const backups = () => {
    try {
      return readdirSync(join(dir, 's3', BUCKET, 'postgres'));
    } catch {
      return [];
    }
  };

  const fingerprint = () =>
    sql(`select count(*) || ':' || md5(string_agg(t::text, ',' order by id)) from campaigns t`);

  it('backs up, then restores to exactly the backed-up state', async () => {
    await sql(`
      create table campaigns (id serial primary key, name text not null, budget numeric(12,2), meta jsonb);
      insert into campaigns (name, budget, meta)
        select 'c' || i, i * 10.5, jsonb_build_object('i', i) from generate_series(1, 500) i;`);
    const original = await fingerprint();

    const { stdout } = await script('backup.sh', []);
    expect(stdout).toMatch(/backup uploaded: s3:\/\/arlo-backups\/postgres\/test-\d{8}T\d{6}Z\.dump\.gz/);
    const [key] = backups();
    expect(key).toMatch(/\.dump\.gz$/);
    expect(notifications).toEqual([]);

    // Diverge after the backup: changed rows plus an object the backup does not know about.
    await sql(`update campaigns set budget = 0 where id <= 250; delete from campaigns where id > 400;
               create table created_after_backup (x int);`);
    expect(await fingerprint()).not.toBe(original);

    await script('restore.sh', [`postgres/${key}`, '--yes', '--keep-services']);

    expect(await fingerprint()).toBe(original);
    expect(await sql(`select to_regclass('public.created_after_backup') is null`)).toBe('t');
    expect(await sql(`select nextval('campaigns_id_seq')`)).toBe('501');
    const dbs = (await sql(`select string_agg(datname, ',' order by datname) from pg_database`, 'postgres')).split(',');
    expect(dbs.filter((d) => d.startsWith('test_pre_restore_'))).toHaveLength(1);
    expect(dbs.filter((d) => d.startsWith('test_restore_'))).toHaveLength(0);
  }, 120_000);

  it('leaves the database untouched when the dump cannot be restored', async () => {
    const before = await fingerprint();
    const bad = join(dir, 'garbage.dump.gz');
    await run('sh', ['-c', `echo 'not a dump' | gzip > '${bad}'`]);

    await expect(script('restore.sh', [bad, '--yes', '--keep-services'])).rejects.toMatchObject({ code: expect.any(Number) });

    expect(await fingerprint()).toBe(before);
    const dbs = await sql(`select string_agg(datname, ',') from pg_database where datname like 'test_restore_%'`, 'postgres');
    expect(dbs).toBe('');
  }, 60_000);

  it('notifies Slack and uploads nothing when pg_dump fails', async () => {
    const count = backups().length;
    await expect(script('backup.sh', [], { PG_EXEC: 'docker exec -i arlo-no-such-container' })).rejects.toMatchObject({
      stderr: expect.stringContaining("backup failed at step 'dump'"),
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("at step 'dump'");
    expect(backups()).toHaveLength(count);
  }, 60_000);

  it('notifies Slack when the bucket is not configured', async () => {
    await expect(script('backup.sh', [], { BACKUP_S3_BUCKET: '' })).rejects.toMatchObject({
      stderr: expect.stringContaining('BACKUP_S3_BUCKET is not set'),
    });
    expect(notifications).toEqual([expect.stringContaining("at step 'config'")]);
  }, 60_000);
});

import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { getSyncState, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { Jobs } from '@arlo/queue';
import { beforeAll, describe, expect, it } from 'vitest';
import { syncAccounts } from '../sync/sync';
import { syncAlert, syncJobs, type OpsNotice } from './sync';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';

describe('syncAlert', () => {
  const at = new Date();
  it.each([
    ['below threshold', undefined, { consecutiveFailures: 2, alertedAt: null }, null],
    ['third failure', undefined, { consecutiveFailures: 3, alertedAt: null }, 'failing'],
    ['already alerted this streak', { alertedAt: at }, { consecutiveFailures: 4, alertedAt: at }, null],
    ['recovered after alert', { alertedAt: at }, { consecutiveFailures: 0, alertedAt: null }, 'recovered'],
    ['recovered without alert', { alertedAt: null }, { consecutiveFailures: 0, alertedAt: null }, null],
  ] as const)('%s', (_, previous, current, expected) => {
    expect(syncAlert(previous, current)).toBe(expected);
  });
});

describe('sync failure notices', () => {
  const t = useTestDatabase();
  const fake = new FakePlatformAdapter().addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' });
  const notices: OpsNotice[] = [];
  let account: AdAccount;
  let failOps = false;

  const deps = () => ({
    db: t.db,
    platform: fake,
    logger,
    now: () => new Date('2026-10-06T04:00:00Z'),
    enqueue: async () => 'id',
    notifyOps: async (n: OpsNotice) => {
      if (failOps) throw new Error('slack down');
      notices.push(n);
    },
  });
  const run = () => {
    const hourly = syncJobs(deps()).find((d) => d.name === Jobs.syncHourly.name)!;
    return hourly.handler({ accountId: account.id }, { id: 'j', retryCount: 0, logger, signal: new AbortController().signal });
  };

  beforeAll(async () => {
    account = (await syncAccounts(deps()))[0]!;
  });

  it('counts consecutive failures and notifies ops once at the threshold', async () => {
    for (let i = 0; i < 2; i++) {
      fake.failNext('fetchMetrics', Object.assign(new Error('boom'), { code: 'UNAVAILABLE' }));
      await expect(run()).rejects.toThrow('boom');
    }
    expect(notices).toEqual([]);

    fake.failNext('fetchMetrics', Object.assign(new Error('boom'), { code: 'UNAVAILABLE' }));
    await expect(run()).rejects.toThrow('boom');
    expect(notices).toEqual([{ level: 'error', text: expect.stringContaining('已連續失敗 3 次，最後錯誤：UNAVAILABLE') }]);

    fake.failNext('fetchMetrics');
    await expect(run()).rejects.toThrow();
    expect(notices).toHaveLength(1);
    expect(await getSyncState(t.db, account.id, 'sync.hourly')).toMatchObject({ consecutiveFailures: 4 });
  });

  it('announces recovery and resets the streak', async () => {
    await run();
    expect(notices.at(-1)).toEqual({ level: 'info', text: expect.stringContaining('同步已恢復') });
    expect(await getSyncState(t.db, account.id, 'sync.hourly')).toMatchObject({ consecutiveFailures: 0, alertedAt: null });
  });

  it('retries the notice on the next failure when posting it failed', async () => {
    failOps = true;
    for (let i = 0; i < 3; i++) {
      fake.failNext('fetchMetrics');
      await expect(run()).rejects.toThrow();
    }
    expect((await getSyncState(t.db, account.id, 'sync.hourly'))?.alertedAt).toBeNull();
    failOps = false;
    fake.failNext('fetchMetrics');
    await expect(run()).rejects.toThrow();
    expect(notices.filter((n) => n.level === 'error')).toHaveLength(2);
  });
});

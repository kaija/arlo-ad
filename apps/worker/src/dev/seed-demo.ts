// Local demo data for UI work: `DATABASE_URL=... pnpm --filter @arlo/worker seed:demo [admin-email]`.
// Refuses anything but a local database. Idempotent (upserts).
import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { addDays, dateInTimeZone, type Op } from '@arlo/core';
import {
  applyTransition,
  createDb,
  createPool,
  DEFAULT_ORG_ID,
  insertChangeEvents,
  insertChangeSet,
  insertEntitySnapshots,
  recordOpResults,
  schema,
  setSlackBinding,
  upsertAdAccounts,
  upsertEntities,
  upsertMetricsDaily,
  upsertSearchTerms,
  upsertUserOnSignIn,
} from '@arlo/db';
import { eq } from 'drizzle-orm';

const logger = createLogger({ component: 'seed-demo' });
const env = parseEnv(EnvSchema.pick({ DATABASE_URL: true }));
const host = new URL(env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
  logger.fatal({ host }, 'seed-demo only runs against a local database');
  process.exit(1);
}

const pool = createPool({ connectionString: env.DATABASE_URL, logger });
const db = createDb(pool);
const orgId = DEFAULT_ORG_ID;
const M = 1_000_000;
// Deterministic pseudo-random noise.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

try {
  const accounts = await upsertAdAccounts(db, [
    { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
    { orgId, platform: 'google_ads', externalId: '2234567890', name: 'Arlo US', currency: 'USD', timezone: 'America/Los_Angeles' },
  ]);
  const today = dateInTimeZone(new Date(), 'Asia/Taipei');
  for (const account of accounts) {
    const tw = account.externalId === '1234567890';
    const scale = tw ? 1 : 0.03;
    const [acc] = await upsertEntities(db, [{ orgId, accountId: account.id, kind: 'account', externalId: account.externalId, name: account.externalId }]);
    const campaigns = await upsertEntities(
      db,
      [
        ['101', 'Brand - Search', 'ENABLED', 1500, 'TARGET_CPA', 180],
        ['102', 'Generic - Cameras', 'ENABLED', 4000, 'MAXIMIZE_CONVERSION_VALUE', null],
        ['103', 'Competitor', 'PAUSED', 800, 'TARGET_CPA', 400],
        ['104', 'Doorbell - Search', 'ENABLED', 2000, 'TARGET_ROAS', null],
      ].map(([id, name, status]) => ({ orgId, accountId: account.id, kind: 'campaign' as const, externalId: id as string, parentId: acc!.id, name: name as string, status: status as string })),
    );
    const adGroups = await upsertEntities(
      db,
      campaigns.map((c) => ({ orgId, accountId: account.id, kind: 'ad_group' as const, externalId: `${c.externalId}1`, parentId: c.id, name: 'Main', status: 'ENABLED' })),
    );
    await insertEntitySnapshots(
      db,
      campaigns.map((c, i) => ({
        orgId,
        entityId: c.id,
        capturedAt: new Date(Math.floor(Date.now() / 900_000) * 900_000),
        budgetMicros: Math.round([1500, 4000, 800, 2000][i]! * scale * M),
        status: i === 2 ? 'PAUSED' : 'ENABLED',
        bidStrategy: ['TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS'][i]!,
        bidTarget: [180 * scale * M, null, 400 * scale * M, 4.5][i] ?? null,
      })),
    );
    const rows = [];
    for (let d = addDays(today, -60); d <= today; d = addDays(d, 1)) {
      let total = { cost: 0, impressions: 0, clicks: 0, conv: 0, value: 0 };
      for (const [i, c] of campaigns.entries()) {
        if (i === 2) continue;
        const weekend = [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
        const base = [1400, 3600, 0, 1800][i]! * scale * (weekend ? 0.7 : 1) * (0.85 + rand() * 0.3) * (d === today ? 0.45 : 1);
        const clicks = Math.round(base / (12 * scale) );
        const conv = Math.round(clicks * (0.04 + rand() * 0.03) * 10) / 10;
        const value = conv * 3200 * scale;
        rows.push({
          orgId,
          accountId: account.id,
          entityId: c.id,
          level: 'campaign' as const,
          date: d,
          costMicros: Math.round(base * M),
          impressions: clicks * 18,
          clicks,
          conversions: conv,
          convValue: value,
          searchIs: 0.55 + rand() * 0.3,
          lostIsBudget: i === 1 ? 0.15 + rand() * 0.1 : 0.02,
          lostIsRank: 0.1 + rand() * 0.1,
        });
        total = { cost: total.cost + base, impressions: total.impressions + clicks * 18, clicks: total.clicks + clicks, conv: total.conv + conv, value: total.value + value };
      }
      rows.push({
        orgId,
        accountId: account.id,
        entityId: acc!.id,
        level: 'account' as const,
        date: d,
        costMicros: Math.round(total.cost * M),
        impressions: total.impressions,
        clicks: total.clicks,
        conversions: total.conv,
        convValue: total.value,
      });
    }
    await upsertMetricsDaily(db, rows);
    await insertChangeEvents(db, [
      {
        orgId,
        accountId: account.id,
        externalId: `demo-${account.externalId}-1`,
        changedAt: new Date(`${addDays(today, -9)}T03:00:00Z`),
        userEmail: 'pat@example.com',
        clientType: 'GOOGLE_ADS_WEB_CLIENT',
        resourceType: 'CAMPAIGN_BUDGET',
        resourceName: `customers/${account.externalId}/campaigns/102`,
        changedFields: ['amount_micros'],
        old: { amount_micros: 3000 * M },
        new: { amount_micros: 4000 * M },
      },
      {
        orgId,
        accountId: account.id,
        externalId: `demo-${account.externalId}-2`,
        changedAt: new Date(`${addDays(today, -4)}T06:00:00Z`),
        userEmail: 'kai@example.com',
        clientType: 'GOOGLE_ADS_WEB_CLIENT',
        resourceType: 'CAMPAIGN',
        resourceName: `customers/${account.externalId}/campaigns/103`,
        changedFields: ['status'],
        old: { status: 'ENABLED' },
        new: { status: 'PAUSED' },
      },
    ]);
    await upsertSearchTerms(
      db,
      ['arlo camera', 'arlo pro 5 price', 'free security camera', 'arlo login', 'how to install doorbell'].flatMap((term, i) =>
        [1, 2, 3].map((back) => ({
          orgId,
          accountId: account.id,
          campaignId: campaigns[i % 2]!.id,
          adGroupId: adGroups[i % 2]!.id,
          term,
          date: addDays(today, -back),
          costMicros: Math.round((20 + i * 15) * scale * M),
          impressions: 40 + i * 10,
          clicks: 3 + i,
          conversions: i === 2 ? 0 : 1,
          convValue: i === 2 ? 0 : 3000 * scale,
        })),
      ),
    );
  }

  // Review queue demo: a few ChangeSets in different states for the TW account (once).
  const tw = accounts.find((a) => a.externalId === '1234567890')!;
  if ((await db.select({ id: schema.changesets.id }).from(schema.changesets).where(eq(schema.changesets.accountId, tw.id)).limit(1)).length === 0) {
    const target = (id: string) => ({ platform: 'google_ads' as const, accountId: tw.externalId, kind: 'campaign' as const, id });
    const budget = (id: string, before: number, after: number): Op => ({ kind: 'set_budget', target: target(id), field: 'budget_micros', before: before * M, after: after * M });
    const system = { kind: 'system' as const };
    const demo = async (summary: string, ops: Op[], steps: Parameters<typeof applyTransition>[2][], rationale?: string) => {
      let cs = await insertChangeSet(db, { accountId: tw.id, source: { kind: 'web' }, ops, summary, rationale, requestedBy: { kind: 'agent' } });
      for (const step of steps) {
        const moved = await applyTransition(db, cs, step, system);
        if (!moved.ok) break;
        cs = moved.changeset;
        if (step.type === 'auto_execute') await recordOpResults(db, cs.id, ops.map((_, index) => ({ index, ok: true })));
      }
    };
    const expiresAt = new Date(Date.now() + 20 * 3_600_000);
    await demo('Generic - Cameras 每日預算 NT$4,000 → NT$4,800', [budget('102', 4000, 4800)], [{ type: 'request_approval', tier: 2, expiresAt }], '預算受限流失 20% 曝光，ROAS 4.8 高於目標');
    await demo('Doorbell - Search 每日預算 NT$2,000 → NT$4,000', [budget('104', 2000, 4000)], [{ type: 'request_approval', tier: 3, expiresAt }], '新品檔期');
    await demo('Brand - Search 每日預算 NT$1,500 → NT$1,350', [budget('101', 1500, 1350)], [{ type: 'auto_execute', tier: 1 }, { type: 'executed', at: new Date() }]);
    await demo(
      'Generic - Cameras 每日預算 NT$4,000 → NT$12,000',
      [budget('102', 4000, 12000)],
      [{ type: 'block', violations: [{ ruleId: 'demo', ruleType: 'DailyBudgetCap', severity: 'HARD_BLOCK', opIndex: 0, message: '每日預算 TWD 12,000 超過上限 TWD 8,000' }] }],
    );
  }

  const email = process.argv[2];
  if (email) {
    const user = await upsertUserOnSignIn(db, { email, displayName: email.split('@')[0] });
    await setSlackBinding(db, user.id, 'UDEMOADMIN');
    const existing = await db.select().from(schema.roleBindings).where(eq(schema.roleBindings.userId, user.id));
    if (existing.length === 0) await db.insert(schema.roleBindings).values({ orgId, userId: user.id, role: 'admin', maxTier: 3 });
    logger.info({ userId: user.id }, 'demo admin ready');
  }
  logger.info('demo data seeded');
} finally {
  await pool.end();
}

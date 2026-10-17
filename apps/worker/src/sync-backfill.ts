// One-off history for accounts whose metrics_daily starts at onboarding: daily metrics (and
// search terms) for D-days..D-1, a week per request. Read-only against Google Ads; idempotent.
//   DATABASE_URL=... pnpm --filter @arlo/worker sync:backfill --days 60 [--account <externalId>] [--no-search-terms]
// In the image: `docker compose -f docker-compose.prod.yml run --rm worker sync-backfill --days 60`.
import { parseArgs } from 'node:util';
import { createGoogleAdsClient, GoogleAdsAdapter } from '@arlo/adapters/platform/google';
import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { createDb, createPool, listActiveAccounts } from '@arlo/db';
import { BACKFILL_CHUNK_DAYS, backfillMetrics } from './sync/sync';

const logger = createLogger({ component: 'sync-backfill' });

const { values } = parseArgs({
  options: {
    days: { type: 'string' },
    account: { type: 'string', multiple: true },
    'chunk-days': { type: 'string', default: String(BACKFILL_CHUNK_DAYS) },
    'no-search-terms': { type: 'boolean', default: false },
  },
});
const days = Number(values.days);
const chunkDays = Number(values['chunk-days']);
if (!Number.isInteger(days) || days < 1 || !Number.isInteger(chunkDays) || chunkDays < 1) {
  logger.fatal('usage: sync-backfill --days <n> [--account <externalId>]... [--chunk-days <n>] [--no-search-terms]');
  process.exit(2);
}

const BackfillEnv = EnvSchema.pick({
  DATABASE_URL: true,
  GOOGLE_ADS_DEVELOPER_TOKEN: true,
  GOOGLE_ADS_CLIENT_ID: true,
  GOOGLE_ADS_CLIENT_SECRET: true,
  GOOGLE_ADS_REFRESH_TOKEN: true,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: true,
});

function loadEnv() {
  try {
    return parseEnv(BackfillEnv);
  } catch (err) {
    logger.fatal({ err }, 'invalid configuration');
    process.exit(1);
  }
}

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL, logger });
const db = createDb(pool);
const platform = new GoogleAdsAdapter(
  createGoogleAdsClient({
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  }),
  // Backfill only reads; no account is writable from here.
  { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, writeAllowedCustomerIds: [] },
);

try {
  // Accounts and their entities come from the running worker's snapshot sync.
  const active = await listActiveAccounts(db, platform.platform);
  const wanted = values.account?.map((a) => a.replace(/-/g, ''));
  const accounts = wanted ? active.filter((a) => wanted.includes(a.externalId)) : active;
  const missing = wanted?.filter((id) => !active.some((a) => a.externalId === id)) ?? [];
  if (missing.length) logger.warn({ missing }, 'not active ad accounts in the database, skipping');

  let failed = missing.length;
  for (const account of accounts) {
    try {
      await backfillMetrics({ db, platform, logger, now: () => new Date() }, account, { days, chunkDays, searchTerms: !values['no-search-terms'] });
    } catch (err) {
      // Keep going: a rerun is idempotent, so only the failed accounts need it.
      failed++;
      logger.error({ err, account: account.externalId }, 'backfill failed');
    }
  }
  logger.info({ accounts: accounts.length, failed }, 'backfill finished');
  if (failed) process.exitCode = 1;
} catch (err) {
  logger.fatal({ err }, 'backfill failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}

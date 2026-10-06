import { createGa4Adapter } from '@arlo/adapters/analytics';
import { SlackAdapter } from '@arlo/adapters/chat';
import { createGoogleAdsClient, GoogleAdsAdapter } from '@arlo/adapters/platform/google';
import { createAnalystAgent, createAuditAgent, createBiddingAgent, createKeywordAgent, createOrchestrator, createSearchTermClassifier, meteredModelFactory, modelNameFor, type AgentName } from '@arlo/agents';
import { EnvSchema, parseEnv } from '@arlo/config';
import { createLogger } from '@arlo/config/logger';
import { checkDatabase, createDb, createPool } from '@arlo/db';
import { checkQueue, createBoss, enqueue, registerJobs } from '@arlo/queue';
import { OpenAIProvider, setDefaultOpenAIKey } from '@openai/agents';
import { WebClient } from '@slack/web-api';
import { closeServer, startHealthServer } from './health-server';
import { jobDefinitions } from './jobs';
import { createProposer } from './proposals';
import { syncSchedules } from './scheduler/scheduler';
import { TEMPLATES } from './scheduler/templates';
import { applySystemSchedules } from './schedules';
import { createShutdown } from './shutdown';

const logger = createLogger({ component: 'worker' });
const shutdown = createShutdown({ logger });
shutdown.listen();
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown.shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled rejection');
  void shutdown.shutdown('unhandledRejection', 1);
});

// Validate only the keys the worker uses so far; extend the pick as features land.
const WorkerEnv = EnvSchema.pick({
  DATABASE_URL: true,
  WORKER_HEALTH_PORT: true,
  GOOGLE_ADS_DEVELOPER_TOKEN: true,
  GOOGLE_ADS_CLIENT_ID: true,
  GOOGLE_ADS_CLIENT_SECRET: true,
  GOOGLE_ADS_REFRESH_TOKEN: true,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: true,
  ADS_WRITE_ALLOWED_CUSTOMER_IDS: true,
  SLACK_BOT_TOKEN: true,
  SLACK_OPS_CHANNEL_ID: true,
  SLACK_APPROVAL_CHANNEL_ID: true,
  OPENAI_API_KEY: true,
  MODEL_FLAGSHIP: true,
  MODEL_SMALL: true,
  DAILY_LLM_BUDGET_USD: true,
  GA4_SERVICE_ACCOUNT_JSON: true,
});

function loadEnv() {
  try {
    return parseEnv(WorkerEnv);
  } catch (err) {
    logger.fatal({ err }, 'invalid configuration');
    process.exit(1);
  }
}

const env = loadEnv();
const healthPort = env.WORKER_HEALTH_PORT;

const pool = createPool({ connectionString: env.DATABASE_URL, logger });
shutdown.register('postgres', () => pool.end());

const db = createDb(pool);

const platform = new GoogleAdsAdapter(
  createGoogleAdsClient({
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  }),
  { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, writeAllowedCustomerIds: env.ADS_WRITE_ALLOWED_CUSTOMER_IDS },
);

// GA4 is optional: without credentials the tracking audit compares nothing (ADR-0021).
const ga4 = env.GA4_SERVICE_ACCOUNT_JSON ? createGa4Adapter(env.GA4_SERVICE_ACCOUNT_JSON) : undefined;

const chat = new SlackAdapter(new WebClient(env.SLACK_BOT_TOKEN));
const opsChannel = { platform: 'slack' as const, channelId: env.SLACK_OPS_CHANNEL_ID };

setDefaultOpenAIKey(env.OPENAI_API_KEY);
// Models per agent from config/models.ts; every call's usage is metered (ADR-0023).
const metered = meteredModelFactory(new OpenAIProvider());
const model = (agent: AgentName) => metered(agent, modelNameFor(agent, env));
const analyst = () => createAnalystAgent({ model: model('analyst') });
const bidding = () => createBiddingAgent({ model: model('bidding') });
const keyword = () => createKeywordAgent({ model: model('keyword') });
const audit = () => createAuditAgent({ model: model('audit') });
const searchTermClassifier = () => createSearchTermClassifier({ model: model('search_term_classifier') });
const orchestrator = () => createOrchestrator({ model: model('orchestrator'), specialists: { analyst: analyst(), bidding: bidding(), keyword: keyword(), audit: audit() } });

const boss = createBoss({ connectionString: env.DATABASE_URL, logger, role: 'worker' });
await boss.start();
// Registered after postgres so it stops first: in-flight jobs finish while the pool is open.
shutdown.register('pg-boss', () => boss.stop({ graceful: true, timeout: 8_000, close: true }));
await registerJobs(
  boss,
  jobDefinitions({
    db,
    platform,
    ga4,
    chat,
    orchestrator,
    agents: { analyst, audit, bidding, keyword, orchestrator, searchTermClassifier },
    propose: createProposer(db, boss),
    templates: TEMPLATES,
    llmBudgetUsd: env.DAILY_LLM_BUDGET_USD,
    boss,
    logger,
    now: () => new Date(),
    enqueue: (spec, data) => enqueue(boss, spec, data),
    writeAllowedCustomerIds: env.ADS_WRITE_ALLOWED_CUSTOMER_IDS,
    approvalChannel: { platform: 'slack', channelId: env.SLACK_APPROVAL_CHANNEL_ID },
    notifyOps: async (notice) => void (await chat.post(opsChannel, { type: 'notice', ...notice })),
  }),
  { logger },
);
await applySystemSchedules(boss);
await syncSchedules({ boss, db, logger });

const server = await startHealthServer({
  port: healthPort,
  checks: { db: () => checkDatabase(pool, { logger }), queue: () => checkQueue(boss, { logger }) },
  logger,
});
shutdown.register('health-server', () => closeServer(server));

logger.info({ healthPort }, 'worker started');

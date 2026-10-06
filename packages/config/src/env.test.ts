import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, EnvSchema, parseEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://arlo:pw@localhost:5432/arlo',
  APP_BASE_URL: 'https://ads-bot.example.com',
  AUTH_SECRET: 'auth-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'oauth-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'oauth-secret',
  ALLOWED_WORKSPACE_DOMAIN: 'example.com',
  SLACK_BOT_TOKEN: 'xoxb-1',
  SLACK_SIGNING_SECRET: 'signing',
  SLACK_APPROVAL_CHANNEL_ID: 'C1',
  SLACK_OPS_CHANNEL_ID: 'C2',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
  GOOGLE_ADS_CLIENT_ID: 'ads-id',
  GOOGLE_ADS_CLIENT_SECRET: 'ads-secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1112223333',
  ADS_WRITE_ALLOWED_CUSTOMER_IDS: '123-456-7890',
  OPENAI_API_KEY: 'sk-1',
  MODEL_FLAGSHIP: 'flagship',
  MODEL_SMALL: 'small',
};

const without = (keys: string[]) => Object.fromEntries(Object.entries(valid).filter(([k]) => !keys.includes(k)));

function issuesOf(source: Record<string, string | undefined>, schema: Parameters<typeof parseEnv>[0] = EnvSchema) {
  try {
    parseEnv(schema, source);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return Object.fromEntries((err as ConfigError).issues.map((i) => [i.key, i.message]));
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('parses a complete environment with defaults', () => {
    const env = parseEnv(EnvSchema, valid);
    expect(env).toMatchObject({
      DATABASE_URL: valid.DATABASE_URL,
      WORKER_HEALTH_PORT: 9090,
      DAILY_LLM_BUDGET_USD: 30,
      ADS_WRITE_ALLOWED_CUSTOMER_IDS: ['1234567890'],
    });
    expect(env.GA4_SERVICE_ACCOUNT_JSON).toBeUndefined();
    expect(env.BACKUP_S3_BUCKET).toBeUndefined();
  });

  it('reports every missing variable at once', () => {
    expect(issuesOf(without(['SLACK_BOT_TOKEN', 'OPENAI_API_KEY', 'DATABASE_URL']))).toEqual({
      DATABASE_URL: 'is required',
      SLACK_BOT_TOKEN: 'is required',
      OPENAI_API_KEY: 'is required',
    });
  });

  it('treats blank values as missing', () => {
    expect(issuesOf({ ...valid, AUTH_SECRET: '', SLACK_SIGNING_SECRET: '   ' })).toEqual({
      AUTH_SECRET: 'is required',
      SLACK_SIGNING_SECRET: 'is required',
    });
  });

  it('never echoes values in the error message', () => {
    const source = { ...valid, DATABASE_URL: 'mysql://arlo:hunter2@db/arlo', DAILY_LLM_BUDGET_USD: 'lots-of-hunter2' };
    expect(issuesOf(source)).toEqual({
      DATABASE_URL: 'must be a valid URL',
      DAILY_LLM_BUDGET_USD: 'must be a number',
    });
    expect(() => parseEnv(EnvSchema, source)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });

  it('coerces and range-checks numbers', () => {
    expect(parseEnv(EnvSchema, { ...valid, WORKER_HEALTH_PORT: '9191', DAILY_LLM_BUDGET_USD: '12.5' })).toMatchObject({
      WORKER_HEALTH_PORT: 9191,
      DAILY_LLM_BUDGET_USD: 12.5,
    });
    expect(Object.keys(issuesOf({ ...valid, WORKER_HEALTH_PORT: '70000', DAILY_LLM_BUDGET_USD: '0' }))).toEqual([
      'WORKER_HEALTH_PORT',
      'DAILY_LLM_BUDGET_USD',
    ]);
  });

  it('turns blank optional values into undefined', () => {
    expect(parseEnv(EnvSchema, { ...valid, GA4_SERVICE_ACCOUNT_JSON: '', BACKUP_S3_BUCKET: 'bkt' })).toMatchObject({
      GA4_SERVICE_ACCOUNT_JSON: undefined,
      BACKUP_S3_BUCKET: 'bkt',
    });
  });

  it('validates only the picked keys', () => {
    const schema = EnvSchema.pick({ DATABASE_URL: true, WORKER_HEALTH_PORT: true });
    expect(parseEnv(schema, { DATABASE_URL: valid.DATABASE_URL })).toEqual({
      DATABASE_URL: valid.DATABASE_URL,
      WORKER_HEALTH_PORT: 9090,
    });
    expect(issuesOf({}, schema)).toEqual({ DATABASE_URL: 'is required' });
  });
});

describe('ADS_WRITE_ALLOWED_CUSTOMER_IDS', () => {
  const schema = EnvSchema.pick({ ADS_WRITE_ALLOWED_CUSTOMER_IDS: true });

  it.each([
    ['123-456-7890', ['1234567890']],
    [' 1234567890 , 111-222-3333 ', ['1234567890', '1112223333']],
    ['1234567890,123-456-7890', ['1234567890']],
    ['', []],
    [' , ', []],
  ])('parses %j', (raw, expected) => {
    expect(parseEnv(schema, { ADS_WRITE_ALLOWED_CUSTOMER_IDS: raw }).ADS_WRITE_ALLOWED_CUSTOMER_IDS).toEqual(expected);
  });

  it('is required even though it may be empty', () => {
    expect(issuesOf({}, schema)).toEqual({ ADS_WRITE_ALLOWED_CUSTOMER_IDS: 'is required (leave empty to allow no writes)' });
  });

  it('rejects malformed IDs by position', () => {
    expect(issuesOf({ ADS_WRITE_ALLOWED_CUSTOMER_IDS: '1234567890,abc,12345' }, schema)).toEqual({
      ADS_WRITE_ALLOWED_CUSTOMER_IDS: 'entry 3 is not a 10-digit customer ID',
    });
  });
});

describe('.env.example', () => {
  // Keys consumed outside the app schema.
  const NON_APP_KEYS = ['APP_DOMAIN', 'LOG_LEVEL']; // Caddy, logger

  it('lists exactly the schema keys plus infrastructure keys', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const keys = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...Object.keys(EnvSchema.shape), ...NON_APP_KEYS].sort());
  });
});

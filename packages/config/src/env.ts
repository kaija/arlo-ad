import { z } from 'zod';
import { parseCustomerIds } from './write-guard';

// Environment schema (design.md「Config」). Every process validates only the keys it uses:
//   parseEnv(EnvSchema.pick({ DATABASE_URL: true }))
// so a missing Slack token does not stop the worker from serving healthz before Slack exists.
// Error messages name keys only, never values.

// `KEY=` in .env / compose env_file arrives as ''; treat it as unset.
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const required = () => z.preprocess(blankToUndefined, z.string({ error: 'is required' }).trim());
const optional = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const url = (protocol?: RegExp) =>
  z.preprocess(blankToUndefined, z.url({ error: (iss) => (iss.input === undefined ? 'is required' : 'must be a valid URL'), protocol }));
const number = () => z.preprocess(blankToUndefined, z.coerce.number({ error: 'must be a number' }));

// Required, but an empty value is meaningful: no account may be written (ADR-0026).
const customerIdList = () =>
  z.string({ error: 'is required (leave empty to allow no writes)' }).transform((raw, ctx) => {
    const result = parseCustomerIds(raw);
    if (result.ok) return result.ids;
    for (const position of result.invalidPositions) {
      ctx.addIssue({ code: 'custom', message: `entry ${position} is not a 10-digit customer ID` });
    }
    return z.NEVER;
  });

export const EnvSchema = z.object({
  DATABASE_URL: url(/^postgres(ql)?$/),
  APP_BASE_URL: url(/^https?$/),
  WORKER_HEALTH_PORT: number().pipe(z.int().min(1).max(65535)).default(9090),

  AUTH_SECRET: required(),
  GOOGLE_OAUTH_CLIENT_ID: required(),
  GOOGLE_OAUTH_CLIENT_SECRET: required(),
  ALLOWED_WORKSPACE_DOMAIN: required(),

  SLACK_BOT_TOKEN: required(),
  SLACK_SIGNING_SECRET: required(),
  SLACK_APPROVAL_CHANNEL_ID: required(),
  SLACK_OPS_CHANNEL_ID: required(),

  GOOGLE_ADS_DEVELOPER_TOKEN: required(),
  GOOGLE_ADS_CLIENT_ID: required(),
  GOOGLE_ADS_CLIENT_SECRET: required(),
  GOOGLE_ADS_REFRESH_TOKEN: required(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: required(),
  ADS_WRITE_ALLOWED_CUSTOMER_IDS: customerIdList(),

  GA4_SERVICE_ACCOUNT_JSON: optional(),

  OPENAI_API_KEY: required(),
  MODEL_FLAGSHIP: required(),
  MODEL_SMALL: required(),
  DAILY_LLM_BUDGET_USD: number().pipe(z.number().positive()).default(30),

  BACKUP_S3_BUCKET: optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: readonly { key: string; message: string }[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  throw new ConfigError(result.error.issues.map((i) => ({ key: i.path.join('.') || '(root)', message: i.message })));
}

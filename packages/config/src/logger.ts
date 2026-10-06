import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

// JSON logs to stdout, collected by docker logging (ADR-0024). Standard fields:
// level, msg, component, changeset_id, job_id, trace_id — add the last three via logger.child().

const SECRET_KEYS = [
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'developerToken',
  'password',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'connectionString',
];
const EMAIL_KEYS = ['email'];

// pino wildcards match exactly one level, so cover keys at depth 0–2.
const atDepths = (keys: string[]) => keys.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);
const REDACT_PATHS = [...atDepths(SECRET_KEYS), ...atDepths(EMAIL_KEYS)];

export function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return '[Redacted]';
  const at = value.indexOf('@');
  return at > 0 ? `${value[0]}***${value.slice(at)}` : '[Redacted]';
}

// Error properties that hold live connection objects (pg attaches `client`, including its
// cancel secretKey); the default err serializer would dump them into the log.
const ERROR_OMIT_KEYS = ['client', 'connection', 'socket'];

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pino.stdSerializers.err(err) };
  for (const key of ERROR_OMIT_KEYS) delete out[key];
  return out;
}

export interface LoggerOptions {
  component: string;
  level?: string;
}

export function createLogger(opts: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
      base: { component: opts.component },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { err: serializeError },
      redact: {
        paths: REDACT_PATHS,
        censor: (value, path) => (EMAIL_KEYS.includes(path.at(-1) ?? '') ? maskEmail(value) : '[Redacted]'),
      },
    },
    destination,
  );
}

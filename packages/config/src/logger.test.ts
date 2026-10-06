import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, maskEmail } from './logger';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { lines, logger: createLogger({ component: 'test', level: 'debug' }, stream) };
}

describe('createLogger', () => {
  it('writes JSON with level label, component and msg', () => {
    const { lines, logger } = capture();
    logger.child({ job_id: 'j1', trace_id: 't1' }).info('hello');
    expect(lines[0]).toMatchObject({ level: 'info', component: 'test', msg: 'hello', job_id: 'j1', trace_id: 't1' });
    expect(lines[0]).toHaveProperty('time');
  });

  it('redacts secrets at top level and nested', () => {
    const { lines, logger } = capture();
    logger.info({
      token: 'xoxb-1',
      refresh_token: 'r1',
      ads: { developerToken: 'd1', clientSecret: 'c1' },
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: 'json' } },
    });
    expect(lines[0]).toMatchObject({
      token: '[Redacted]',
      refresh_token: '[Redacted]',
      ads: { developerToken: '[Redacted]', clientSecret: '[Redacted]' },
      req: { headers: { authorization: '[Redacted]', cookie: '[Redacted]', accept: 'json' } },
    });
    expect(JSON.stringify(lines[0])).not.toMatch(/xoxb-1|r1|d1|c1|abc|sid=1/);
  });

  it('serializes errors without attached connection objects', () => {
    const { lines, logger } = capture();
    const err = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      client: { secretKey: 123, connectionParameters: { user: 'arlo', host: 'db' } },
    });
    logger.error({ err }, 'idle client error');
    expect(lines[0]?.err).toMatchObject({ type: 'Error', message: 'terminating connection', code: '57P01' });
    expect(lines[0]?.err).not.toHaveProperty('client');
    expect(lines[0]?.err).toHaveProperty('stack');
  });

  it('partially masks emails', () => {
    const { lines, logger } = capture();
    logger.info({ email: 'kaija@example.com', user: { email: 'pat@example.com' } });
    expect(lines[0]).toMatchObject({ email: 'k***@example.com', user: { email: 'p***@example.com' } });
  });
});

describe('maskEmail', () => {
  it.each([
    ['a@b.co', 'a***@b.co'],
    ['no-at-sign', '[Redacted]'],
    ['@leading.at', '[Redacted]'],
    [42, '[Redacted]'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});

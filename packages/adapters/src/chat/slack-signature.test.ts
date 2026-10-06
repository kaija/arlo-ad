import { describe, expect, it } from 'vitest';
import { signSlackRequest, verifySlackSignature } from './slack-signature';

const secret = '8f742231b10e8888abcd99yyyzzz85a5';
const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather';
const ts = '1531420618';

describe('verifySlackSignature', () => {
  it('computes v0 HMAC-SHA256 over v0:timestamp:body', () => {
    // Reference: printf 'v0:<ts>:<body>' | openssl dgst -sha256 -hmac <secret>
    expect(signSlackRequest(secret, ts, body)).toBe('v0=6b8b0b4cff7baf56906b6a54056df891b9cc8292bc01770e0e1d6dd9bc623977');
  });

  it.each([
    ['valid', { signature: signSlackRequest(secret, ts, body) }, { ok: true }],
    ['tampered body', { signature: signSlackRequest(secret, ts, `${body}&x=1`) }, { ok: false, reason: 'bad_signature' }],
    ['wrong secret', { signature: signSlackRequest('other', ts, body) }, { ok: false, reason: 'bad_signature' }],
    ['malformed signature', { signature: 'v0=abc' }, { ok: false, reason: 'bad_signature' }],
    ['missing signature', { signature: null }, { ok: false, reason: 'missing_headers' }],
    ['missing timestamp', { signature: signSlackRequest(secret, ts, body), timestamp: null }, { ok: false, reason: 'missing_headers' }],
    ['expired (6 min old)', { signature: signSlackRequest(secret, ts, body), nowSeconds: Number(ts) + 360 }, { ok: false, reason: 'stale_timestamp' }],
    ['from the future', { signature: signSlackRequest(secret, ts, body), nowSeconds: Number(ts) - 360 }, { ok: false, reason: 'stale_timestamp' }],
    ['within window', { signature: signSlackRequest(secret, ts, body), nowSeconds: Number(ts) + 299 }, { ok: true }],
  ] as const)('%s', (_, override, expected) => {
    expect(verifySlackSignature({ signingSecret: secret, rawBody: body, timestamp: ts, nowSeconds: Number(ts), ...override })).toEqual(expected);
  });
});

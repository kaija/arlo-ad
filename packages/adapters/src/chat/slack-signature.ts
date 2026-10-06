// Slack request signing (v0 HMAC-SHA256) with a 5-minute replay window (design.md「Security」).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export type SlackSignatureResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

export function signSlackRequest(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowSeconds?: number;
}): SlackSignatureResult {
  const { signingSecret, rawBody, timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'missing_headers' };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const expected = Buffer.from(signSlackRequest(signingSecret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

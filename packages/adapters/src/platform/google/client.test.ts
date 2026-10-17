import type { Customer } from 'google-ads-api';
import { describe, expect, it } from 'vitest';
import { createGoogleAdsClient } from './client';

const creds = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', loginCustomerId: '123-456-7890' };

// The protected getter every gRPC and REST call reads its headers from.
const callHeaders = (c: Customer) => Reflect.get(c, 'callHeaders') as Record<string, string>;

describe('createGoogleAdsClient call headers', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('omits developer-token when the token is %s', (_label, developerToken) => {
    const client = createGoogleAdsClient({ ...creds, developerToken });
    expect(callHeaders(client.customer('1112223333'))).toEqual({ 'login-customer-id': '1234567890' });
  });

  it('sends a configured developer-token', () => {
    const client = createGoogleAdsClient({ ...creds, developerToken: 'legacy-token' });
    expect(callHeaders(client.customer('1112223333'))).toEqual({ 'developer-token': 'legacy-token', 'login-customer-id': '1234567890' });
  });

  it('keeps omitting the header on the cached Customer', () => {
    const client = createGoogleAdsClient(creds);
    const first = client.customer('1112223333');
    expect(client.customer('1112223333')).toBe(first);
    expect(callHeaders(first)).not.toHaveProperty('developer-token');
  });

  it('leaves developer-token out of the REST request the library builds', () => {
    const c = createGoogleAdsClient(creds).customer('1112223333');
    const build = Reflect.get(c, 'prepareGoogleAdsServicePostRequestArgs') as (fn: string, token: string) => { headers: Record<string, string> };
    expect(build.call(c, 'search', 'access').headers).toEqual({ Authorization: 'Bearer access', 'login-customer-id': '1234567890' });
  });
});

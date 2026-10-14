import { describe, expect, it } from 'vitest';
import { checkWorkspaceProfile } from './sso';

describe('checkWorkspaceProfile', () => {
  it.each([
    ['allowed domain', { email: 'Pat@Example.com', email_verified: true, hd: 'example.com' }, { ok: true, email: 'pat@example.com' }],
    ['hd claim case-insensitive', { email: 'pat@example.com', email_verified: true, hd: 'EXAMPLE.COM' }, { ok: true, email: 'pat@example.com' }],
    ['consumer account (no hd)', { email: 'pat@gmail.com', email_verified: true }, { ok: false, reason: 'wrong_domain' }],
    ['other Workspace', { email: 'pat@other.com', email_verified: true, hd: 'other.com' }, { ok: false, reason: 'wrong_domain' }],
    ['address spoofs domain, hd differs', { email: 'pat@example.com', email_verified: true, hd: 'other.com' }, { ok: false, reason: 'wrong_domain' }],
    ['alias on another domain', { email: 'pat@alias.io', email_verified: true, hd: 'example.com' }, { ok: false, reason: 'wrong_domain' }],
    ['subdomain suffix', { email: 'pat@evil-example.com', email_verified: true, hd: 'example.com' }, { ok: false, reason: 'wrong_domain' }],
    ['unverified email', { email: 'pat@example.com', email_verified: false, hd: 'example.com' }, { ok: false, reason: 'unverified' }],
    ['missing email', { email_verified: true, hd: 'example.com' }, { ok: false, reason: 'no_email' }],
  ])('%s', (_, profile, expected) => {
    expect(checkWorkspaceProfile(profile, 'example.com')).toEqual(expected);
  });

  it.each([
    ['consumer account', { email: 'Pat@Gmail.com', email_verified: true }, { ok: true, email: 'pat@gmail.com' }],
    ['any Workspace', { email: 'pat@other.com', email_verified: true, hd: 'other.com' }, { ok: true, email: 'pat@other.com' }],
    ['unverified email', { email: 'pat@gmail.com', email_verified: false }, { ok: false, reason: 'unverified' }],
    ['missing email', { email_verified: true }, { ok: false, reason: 'no_email' }],
  ])('without a configured domain: %s', (_, profile, expected) => {
    expect(checkWorkspaceProfile(profile, undefined)).toEqual(expected);
    expect(checkWorkspaceProfile(profile, '  ')).toEqual(expected);
  });

  it('rejects a missing profile', () => {
    expect(checkWorkspaceProfile(undefined, 'example.com')).toEqual({ ok: false, reason: 'no_email' });
  });
});

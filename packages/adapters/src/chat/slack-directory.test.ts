import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { createSlackDirectory } from './slack-directory';

const clientWith = (lookupByEmail: (args: { email: string }) => Promise<unknown>) =>
  ({ users: { lookupByEmail } }) as unknown as WebClient;

describe('createSlackDirectory', () => {
  it('maps a found user', async () => {
    const dir = createSlackDirectory(
      clientWith(async () => ({ ok: true, user: { id: 'U1', real_name: 'Pat Lee', profile: { display_name: '' } } })),
    );
    expect(await dir.lookupByEmail('pat@example.com')).toEqual({ slackUserId: 'U1', displayName: 'Pat Lee' });
  });

  it('returns null for users_not_found', async () => {
    const dir = createSlackDirectory(
      clientWith(() => Promise.reject(Object.assign(new Error('An API error occurred: users_not_found'), { data: { error: 'users_not_found' } }))),
    );
    expect(await dir.lookupByEmail('nobody@example.com')).toBeNull();
  });

  it('rethrows other Slack errors', async () => {
    const dir = createSlackDirectory(
      clientWith(() => Promise.reject(Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }))),
    );
    await expect(dir.lookupByEmail('pat@example.com')).rejects.toThrow('ratelimited');
  });
});

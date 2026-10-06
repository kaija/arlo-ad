import { EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { DEFAULT_ORG_ID, saveBusinessProfile, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { runGetBusinessProfile } from './keyword';

describe('get_business_profile', () => {
  const t = useTestDatabase();
  const ctx = (allowed: string[] | null = null): AgentContext => ({ db: t.db, allowedAccountIds: allowed, now: () => new Date() });

  it('returns the latest version within scope, or a hint when missing', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    expect(await runGetBusinessProfile(ctx(), { account: 'Arlo TW' })).toMatchObject({ version: null, profile: null });
    await saveBusinessProfile(t.db, acc!.id, { ...EMPTY_BUSINESS_PROFILE, brandTerms: ['arlo'] }, { kind: 'system' });
    expect(await runGetBusinessProfile(ctx(), { account: '123-456-7890' })).toMatchObject({ version: 1, profile: { brandTerms: ['arlo'] } });
    await expect(runGetBusinessProfile(ctx([]), { account: 'Arlo TW' })).rejects.toThrow('找不到');
  });
});

import type { Op } from '@arlo/core';
import { applyTransition, DEFAULT_ORG_ID, insertChangeSet, recordShadowFeedback, setAutomationMode, upsertAdAccounts, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import { loadAutomation } from './automation';

describe('automation page data', () => {
  const t = useTestDatabase();

  it('shows default shadow modes and majority-vote accuracy per feature', async () => {
    const [tw] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const users = await Promise.all(['a', 'b', 'c'].map((n) => upsertUserOnSignIn(t.db, { email: `${n}@example.com` })));
    const op: Op = { kind: 'set_status', target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '1' }, field: 'status', before: 'ENABLED', after: 'PAUSED' };
    const simulate = async (votes: ('up' | 'down')[]) => {
      const cs = await insertChangeSet(t.db, { accountId: tw!.id, feature: 'circuit_breaker', source: { kind: 'monitor' }, ops: [op], summary: 's', requestedBy: { kind: 'system' } });
      await applyTransition(t.db, cs, { type: 'simulate', tier: 1 }, { kind: 'system' });
      for (const [i, v] of votes.entries()) await recordShadowFeedback(t.db, cs.id, users[i]!.id, v);
    };
    await simulate(['up', 'up', 'down']); // correct
    await simulate(['down']); // wrong
    await simulate(['up', 'down']); // tie counts as wrong
    await simulate([]); // not judged
    await setAutomationMode(t.db, tw!.id, 'negative_kw_auto', 'live', { kind: 'system' });

    const { rows, totals } = await loadAutomation(t.db, null);
    expect(rows[0]!.features.circuit_breaker).toEqual({ mode: 'shadow', simulated: 4, judged: 3, correct: 1, accuracy: 1 / 3 });
    expect(rows[0]!.features.negative_kw_auto).toMatchObject({ mode: 'live', simulated: 0, accuracy: null });
    expect(totals.circuit_breaker).toMatchObject({ simulated: 4, judged: 3, correct: 1 });
    expect((await loadAutomation(t.db, [])).rows).toEqual([]);
  });
});

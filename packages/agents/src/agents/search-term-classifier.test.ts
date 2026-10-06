import { EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { DEFAULT_ORG_ID, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled, type ModelRequest } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { say, ScriptedModel } from '../testing';
import { classifierInput, classifySearchTerms, createSearchTermClassifier, labelsByIndex } from './search-term-classifier';

setTracingDisabled(true);
const profile = { ...EMPTY_BUSINESS_PROFILE, offerings: ['家用監視器'], excludedIntents: ['免費'], brandTerms: ['arlo'] };

const inputOf = (req: ModelRequest) => {
  const items = typeof req.input === 'string' ? [{ content: req.input }] : req.input;
  const last = items.at(-1) as { content?: unknown };
  const text = typeof last.content === 'string' ? last.content : (last.content as { text?: string }[])[0]!.text!;
  return JSON.parse(text) as { terms: { index: number; term: string }[] };
};

/** Labels every term: "free" → irrelevant 0.95, everything else relevant 0.8. */
const labeller = () =>
  new ScriptedModel((req) => {
    const { terms } = inputOf(req);
    return [
      say(
        JSON.stringify({
          labels: terms.map(({ index, term }) =>
            term.includes('free') ? { index, intent: 'free_or_diy', relevant: false, confidence: 0.95, reason: '免費' } : { index, intent: 'purchase', relevant: true, confidence: 0.8, reason: '購買' },
          ),
        }),
      ),
    ];
  });

describe('search term classifier', () => {
  const t = useTestDatabase();

  it('builds the batch input from the profile', () => {
    expect(JSON.parse(classifierInput(profile, ['a', 'b']))).toMatchObject({ profile: { brand_terms: ['arlo'], excluded_intents: ['免費'] }, terms: [{ index: 0, term: 'a' }, { index: 1, term: 'b' }] });
  });

  it('drops duplicate and out-of-range indexes', () => {
    const l = { intent: 'purchase' as const, relevant: true, confidence: 1, reason: '' };
    expect([...labelsByIndex({ labels: [{ index: 0, ...l }, { index: 0, ...l, relevant: false }, { index: 5, ...l }] }, 2).keys()]).toEqual([0]);
  });

  it('classifies in batches of 100, caches by profile version, and reclassifies after an edit', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const terms = [...Array.from({ length: 249 }, (_, i) => `camera ${i}`), 'free camera', 'FREE   Camera'];
    const model = labeller();
    const classifier = createSearchTermClassifier({ model });
    const first = await classifySearchTerms({ db: t.db, accountId: acc!.id, profile, profileVersion: 1, terms, classifier, modelName: 'small' });
    expect(first).toMatchObject({ cached: 0, classified: 250, batches: 3 });
    expect(first.labels.get('free camera')).toEqual({ intent: 'free_or_diy', relevant: false, confidence: 0.95, reason: '免費' });
    expect(model.requests.map((r) => inputOf(r).terms.length)).toEqual([100, 100, 50]);

    const again = await classifySearchTerms({ db: t.db, accountId: acc!.id, profile, profileVersion: 1, terms, classifier });
    expect(again).toMatchObject({ cached: 250, classified: 0, batches: 0 });
    expect(again.labels.get('camera 7')).toMatchObject({ relevant: true, confidence: 0.8 });

    const edited = await classifySearchTerms({ db: t.db, accountId: acc!.id, profile, profileVersion: 2, terms: ['free camera'], classifier });
    expect(edited).toMatchObject({ cached: 0, classified: 1, batches: 1 });
  });

  it('leaves terms the model skipped unlabelled (they are retried next run)', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '2234567890', name: 'US', currency: 'USD', timezone: 'UTC' }]);
    const classifier = createSearchTermClassifier({ model: new ScriptedModel(() => [say(JSON.stringify({ labels: [{ index: 1, intent: 'jobs', relevant: false, confidence: 0.99, reason: '求職' }] }))]) });
    const r = await classifySearchTerms({ db: t.db, accountId: acc!.id, profile, profileVersion: 1, terms: ['arlo camera', 'arlo jobs'], classifier });
    expect([...r.labels.keys()]).toEqual(['arlo jobs']);
    expect((await classifySearchTerms({ db: t.db, accountId: acc!.id, profile, profileVersion: 1, terms: ['arlo camera', 'arlo jobs'], classifier })).cached).toBe(1);
  });
});

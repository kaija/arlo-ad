import { describe, expect, it } from 'vitest';
import { passRate, precisionAtConfidence, scoreCase } from './scoring';
import { loadSuites, sampleCases } from './suite';

describe('scoreCase', () => {
  const obs = { tools: ['analyst'], answer: 'ChangeSet 已送審核' };

  it.each([
    [{ tools: ['analyst'] }, obs, true],
    [{ tools: ['bidding'] }, obs, false],
    [{ tools: [] }, obs, false],
    [{ tools: [] }, { tools: [], answer: 'hi' }, true],
    [{ notTools: ['analyst'] }, obs, false],
    [{ answerIncludes: ['審核'] }, obs, true],
    [{ answerIncludes: ['changeset'] }, obs, true],
    [{ answerExcludes: ['已執行'] }, obs, true],
    [{ output: { intent: 'navigational', relevant: false } }, { tools: [], answer: '', output: { intent: 'navigational', relevant: false, confidence: 0.9 } }, true],
    [{ output: { relevant: true } }, { tools: [], answer: '', output: { relevant: false } }, false],
  ])('%j', (expectation, observation, pass) => {
    expect(scoreCase(expectation, observation).pass).toBe(pass);
  });

  it('fails runs that errored, with the reason', () => {
    expect(scoreCase({}, { tools: [], answer: '', error: 'max turns' })).toEqual({ pass: false, failures: ['error: max turns'] });
  });

  it('computes pass rate and precision at a confidence threshold', () => {
    expect(passRate([{ pass: true, failures: [] }, { pass: false, failures: ['x'] }])).toBe(0.5);
    expect(passRate([])).toBe(1);
    const preds = [
      { predicted: true, actual: true, confidence: 0.95 },
      { predicted: true, actual: false, confidence: 0.92 },
      { predicted: true, actual: true, confidence: 0.5 },
      { predicted: false, actual: true, confidence: 0.99 },
    ];
    expect(precisionAtConfidence(preds, 0.9)).toEqual({ precision: 0.5, support: 2 });
    expect(precisionAtConfidence(preds, 0.99)).toEqual({ precision: null, support: 0 });
  });
});

describe('golden sets', () => {
  it('all suites in evals/cases parse with unique ids', async () => {
    const suites = await loadSuites();
    expect(suites.map((s) => s.suite)).toContain('orchestrator_routing');
  });

  it('samples deterministically per seed', async () => {
    const [suite] = await loadSuites();
    const a = sampleCases(suite!.cases, 3, 'ci');
    expect(a).toHaveLength(3);
    expect(sampleCases(suite!.cases, 3, 'ci')).toEqual(a);
    expect(sampleCases(suite!.cases, undefined)).toHaveLength(suite!.cases.length);
  });
});

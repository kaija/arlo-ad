import { describe, expect, it } from 'vitest';
import { assessConversionAction, assessTracking, type ConversionActionHealthInput } from './health';

const NOW = new Date('2026-10-07T04:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const action = (over: Partial<ConversionActionHealthInput> = {}): ConversionActionHealthInput => ({
  externalId: '1',
  name: 'Purchase',
  status: 'ENABLED',
  primary: true,
  lastConversionAt: hoursAgo(2),
  conversions30d: 90,
  ecDiagnostics: null,
  ...over,
});

describe('assessConversionAction (Requirement 16.2)', () => {
  it.each<[string, ConversionActionHealthInput, string, string[]]>([
    ['healthy', action(), 'ok', []],
    ['silent for 30h with 3/day', action({ lastConversionAt: hoursAgo(30) }), 'critical', ['SILENT']],
    ['silent but rarely converts', action({ lastConversionAt: hoursAgo(30), conversions30d: 10 }), 'ok', []],
    ['never converted in 30 days', action({ lastConversionAt: null, conversions30d: 0 }), 'warn', ['NO_CONVERSIONS_30D']],
    ['exactly 24h is not yet silent', action({ lastConversionAt: hoursAgo(24) }), 'ok', []],
    ['secondary actions are not checked for silence', action({ primary: false, lastConversionAt: hoursAgo(100) }), 'ok', []],
    ['primary but hidden', action({ status: 'HIDDEN' }), 'warn', ['NOT_ENABLED']],
    ['upload needs attention', action({ ecDiagnostics: { status: 'NEEDS_ATTENTION', alerts: [] } }), 'warn', ['UPLOAD_NEEDS_ATTENTION']],
    ['no recent upload on a primary action', action({ ecDiagnostics: { status: 'NO_RECENT_UPLOAD' } }), 'critical', ['NO_RECENT_UPLOAD']],
    ['low upload success rate', action({ ecDiagnostics: { status: 'GOOD', totalEventCount: 40, successfulEventCount: 31, alerts: [] } }), 'warn', ['UPLOAD_ERRORS']],
  ])('%s', (_, input, status, codes) => {
    const r = assessConversionAction(input, NOW);
    expect(r.status).toBe(status);
    expect(r.issues.map((i) => i.code)).toEqual(codes);
  });

  it('explains silence in hours and daily average', () => {
    expect(assessConversionAction(action({ lastConversionAt: hoursAgo(30) }), NOW).issues[0]!.message).toBe('已 30 小時沒有轉換（過去 30 天日均 3.0），追蹤可能失效');
  });
});

describe('assessTracking', () => {
  it('is critical without an enabled primary action, else the worst action', () => {
    expect(assessTracking([action({ primary: false })], NOW)).toMatchObject({ status: 'critical', noPrimary: true });
    expect(assessTracking([action(), action({ externalId: '2', ecDiagnostics: { status: 'NEEDS_ATTENTION' } })], NOW).status).toBe('warn');
    expect(assessTracking([action()], NOW).status).toBe('ok');
  });
});

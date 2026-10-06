import { describe, expect, it } from 'vitest';
import { previewCron } from './cron';

describe('previewCron', () => {
  it('returns the next runs in the timezone', () => {
    expect(previewCron('0 9 * * 1-5', 'Asia/Taipei', { from: new Date('2026-10-09T00:00:00Z'), count: 2 })).toEqual({
      ok: true,
      next: [new Date('2026-10-09T01:00:00Z'), new Date('2026-10-12T01:00:00Z')],
    });
  });

  it.each([
    ['bad cron', 'Asia/Taipei'],
    ['0 9 * * *', 'Mars/Base'],
  ])('rejects %s in %s', (cron, tz) => {
    expect(previewCron(cron, tz)).toMatchObject({ ok: false });
  });
});

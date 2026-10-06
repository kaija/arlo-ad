import type { ChangeSetView } from '@arlo/core';
import { describe, expect, it } from 'vitest';
import { defuseBroadcasts, escape, renderConfirmModal, renderMessage } from './render';

const id = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
const changeset: ChangeSetView = {
  id,
  accountName: 'Arlo TW',
  summary: '降低 Brand 每日預算 20%',
  rationale: 'CPA 連續 3 天高於目標 1.8 倍',
  tier: 2,
  status: 'PENDING_APPROVAL',
  ops: [{ label: 'Brand · 每日預算', before: 'NT$3,000', after: 'NT$2,400', change: '-20%' }],
  violations: [{ severity: 'WARN', message: '超過單日變動上限 15%（MaxChangePct）' }],
  requestedBy: 'Pat',
  expiresAt: '2026-10-07T04:00:00.000Z',
  traceUrl: 'https://platform.openai.com/traces/trace_123',
};

describe('Slack Block Kit renderer', () => {
  it('renders a report with text, fields and a table', () => {
    expect(
      renderMessage({
        type: 'report',
        title: '每日報告 · 2026-10-05',
        sections: [
          { kind: 'text', text: '昨日花費 NT$12,345，較前日 +8%。' },
          { kind: 'fields', heading: '帳戶', fields: [{ label: 'MTD 花費', value: 'NT$250,000' }, { label: 'Pacing', value: '103%' }] },
          { kind: 'table', heading: 'Campaigns', columns: ['Campaign', 'Spend', 'CPA'], rows: [['Brand', '3,000', '250'], ['Generic', '9,345', '410']] },
          { kind: 'table', columns: ['A', 'B'], rows: [['1', '2']] },
        ],
      }),
    ).toMatchSnapshot();
  });

  it('renders a reply, splitting long text into sections', () => {
    expect(renderMessage({ type: 'reply', text: '昨天花費 *NT$12,345*' })).toEqual({
      text: '昨天花費 *NT$12,345*',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '昨天花費 *NT$12,345*' } }],
    });
    expect(renderMessage({ type: 'reply', text: 'x'.repeat(7000) }).blocks).toHaveLength(3);
  });

  it('renders a notice with Undo / keep actions', () => {
    expect(renderMessage({ type: 'notice', level: 'warn', text: '已暫停 Generic（熔斷：花費 pacing 180%）', changesetId: id, actions: ['undo', 'keep'] })).toMatchSnapshot();
  });

  it('renders a pending approval request with buttons', () => {
    expect(renderMessage({ type: 'approval_request', changeset })).toMatchSnapshot();
  });

  it('renders a mirrored approval card with the source link', () => {
    const rendered = renderMessage({ type: 'approval_request', changeset: { ...changeset, sourceLink: 'https://slack.test/archives/C1/p1' }, mirror: true });
    expect(rendered.text.startsWith('[鏡像]')).toBe(true);
    expect(JSON.stringify(rendered.blocks)).toContain('<https://slack.test/archives/C1/p1|來源對話>');
  });

  it('replaces buttons with the outcome once handled', () => {
    expect(
      renderMessage({
        type: 'approval_request',
        changeset: { ...changeset, status: 'EXECUTED', outcome: { status: 'EXECUTED', actor: '@kai', at: '2026-10-06T05:00:00.000Z' } },
      }),
    ).toMatchSnapshot();
  });

  it('renders selectable negative keyword batches as per-op checkboxes', () => {
    const batch: ChangeSetView = {
      ...changeset,
      summary: '新增 2 個否定關鍵字',
      selectable: true,
      ops: [
        { label: 'arlo-auto-negatives', before: '—', after: 'free camera [EXACT]' },
        { label: 'arlo-auto-negatives', before: '—', after: 'diy camera [EXACT]', excluded: true },
      ],
    };
    expect(renderMessage({ type: 'approval_request', changeset: batch })).toMatchSnapshot();
  });

  it('renders the Tier 3 confirm modal with amounts and ratios', () => {
    const modal = renderConfirmModal({ ...changeset, tier: 3 }, { platform: 'slack', channelId: 'C1', threadId: '1.2' });
    expect(modal).toMatchObject({ type: 'modal', callback_id: `cs:confirm:${id}` });
    expect(JSON.parse(modal.private_metadata!)).toEqual({ changesetId: id, channelId: 'C1', threadId: '1.2' });
    expect(modal).toMatchSnapshot();
  });

  it('renders a shadow result with feedback buttons', () => {
    expect(renderMessage({ type: 'shadow_result', changeset: { ...changeset, tier: 1, status: 'SIMULATED' }, feedback: { up: 3, down: 1 } })).toMatchSnapshot();
  });

  it('caps long op lists and keeps under 50 blocks', () => {
    const many = { ...changeset, ops: Array.from({ length: 300 }, (_, i) => ({ label: `kw ${i}`, before: '—', after: 'x' })) };
    const plain = renderMessage({ type: 'approval_request', changeset: many });
    expect(JSON.stringify(plain.blocks)).toContain('…另有 275 項');
    const selectable = renderMessage({ type: 'approval_request', changeset: { ...many, selectable: true } });
    expect(selectable.blocks.length).toBeLessThanOrEqual(50);
  });

  it('escapes untrusted text and defuses broadcast mentions', () => {
    expect(escape('<@U1> & <!channel>')).toBe('&lt;@U1&gt; &amp; &lt;!channel&gt;');
    expect(defuseBroadcasts('hi <!here> and <!subteam^S1|@ads>')).toBe('hi @here and @subteam^S1');
    const rendered = renderMessage({ type: 'approval_request', changeset: { ...changeset, summary: 'pause <!channel>' } });
    expect(JSON.stringify(rendered.blocks)).not.toContain('<!channel>');
  });
});

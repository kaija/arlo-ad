// Block Kit rendering of semantic chat messages (ADR-0005). Slack limits: 50 blocks per
// message, 3000 chars per section text, 10 fields per section, one table per message.
import { encodeAction, type ChangeSetView, type ChatMessage, type ConversationRef, type OpView, type Section } from '@arlo/core';
import type { ActionsBlock, ContextBlock, KnownBlock, ModalView, SectionBlock } from '@slack/types';

export interface SlackRendered {
  /** Notification / fallback text. */
  text: string;
  blocks: KnownBlock[];
}

const MAX_TEXT = 2900;
const MAX_OPS_LISTED = 25;
const MAX_SELECTABLE_OPS = 40;

const truncate = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Slack mrkdwn control characters in untrusted text (search terms, account names).
export const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Report and notice text may carry agent-written content: never let it page a whole channel.
export const defuseBroadcasts = (s: string) => s.replace(/<!(channel|here|everyone|subteam\^[^>|]*)(\|[^>]*)?>/g, '@$1');

const mrkdwn = (text: string): SectionBlock => ({ type: 'section', text: { type: 'mrkdwn', text: truncate(text) } });
const context = (...texts: string[]): ContextBlock => ({
  type: 'context',
  elements: texts.map((t) => ({ type: 'mrkdwn' as const, text: truncate(t) })),
});
const header = (text: string): KnownBlock => ({ type: 'header', text: { type: 'plain_text', text: truncate(text, 150), emoji: true } });

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

const LEVEL_ICON = { info: ':information_source:', warn: ':warning:', error: ':rotating_light:' } as const;

const STATUS_LABEL: Record<string, string> = {
  PENDING_APPROVAL: '待審核',
  APPROVED: '已核准',
  EXECUTING: '執行中',
  EXECUTED: ':white_check_mark: 已執行',
  FAILED: ':x: 執行失敗',
  REJECTED: ':no_entry_sign: 已拒絕',
  EXPIRED: ':hourglass: 已過期',
  STALE: ':arrows_counterclockwise: 現況已變更，請重新提議',
  BLOCKED: ':no_entry: 已擋下',
  SIMULATED: ':mag: 已模擬（shadow）',
  REVERTED: ':leftwards_arrow_with_hook: 已還原',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function renderSections(sections: Section[]): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let tableUsed = false;
  for (const s of sections) {
    if (s.heading) blocks.push(mrkdwn(`*${escape(s.heading)}*`));
    if (s.kind === 'text') blocks.push(mrkdwn(defuseBroadcasts(s.text)));
    else if (s.kind === 'fields') {
      for (let i = 0; i < s.fields.length; i += 10) {
        blocks.push({
          type: 'section',
          fields: s.fields
            .slice(i, i + 10)
            .map((f) => ({ type: 'mrkdwn' as const, text: truncate(`*${escape(f.label)}*\n${defuseBroadcasts(f.value)}`, 1900) })),
        });
      }
    } else if (!tableUsed) {
      tableUsed = true;
      blocks.push({
        type: 'table',
        rows: [s.columns, ...s.rows].slice(0, 100).map((row) => row.slice(0, 20).map((cell) => ({ type: 'raw_text' as const, text: cell }))),
      });
    } else {
      // Only one table block per message; later tables fall back to preformatted text.
      blocks.push(mrkdwn(`\`\`\`${[s.columns, ...s.rows].map((r) => r.join(' | ')).join('\n')}\`\`\``));
    }
  }
  return blocks;
}

function opLine(op: OpView): string {
  const change = op.change ? ` (${op.change})` : '';
  const line = `• ${escape(op.label)}：${escape(op.before)} → *${escape(op.after)}*${change}`;
  return op.excluded ? `~${line}~ _（已剔除）_` : line;
}

function opsBlocks(cs: ChangeSetView, interactive: boolean): KnownBlock[] {
  if (cs.selectable && interactive) {
    const shown = cs.ops.slice(0, MAX_SELECTABLE_OPS);
    const blocks: KnownBlock[] = shown.map((op, i) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(opLine({ ...op, excluded: false })) },
      accessory: {
        type: 'checkboxes',
        action_id: encodeAction({ kind: 'neg_toggle', changesetId: cs.id, opIndex: i }),
        options: [{ text: { type: 'plain_text', text: '套用' }, value: String(i) }],
        ...(op.excluded ? {} : { initial_options: [{ text: { type: 'plain_text' as const, text: '套用' }, value: String(i) }] }),
      },
    }));
    if (cs.ops.length > shown.length) blocks.push(context(`另有 ${cs.ops.length - shown.length} 項未列出，請至 Web 審核頁逐項檢視。`));
    return blocks;
  }
  const lines = cs.ops.slice(0, MAX_OPS_LISTED).map(opLine);
  if (cs.ops.length > MAX_OPS_LISTED) lines.push(`…另有 ${cs.ops.length - MAX_OPS_LISTED} 項`);
  return [mrkdwn(lines.join('\n'))];
}

function changesetBlocks(cs: ChangeSetView, opts: { title: string; interactive: boolean }): KnownBlock[] {
  const blocks: KnownBlock[] = [header(opts.title), mrkdwn(`*${escape(cs.summary)}*`)];
  const fields = [
    { label: '帳戶', value: escape(cs.accountName) },
    { label: '風險等級', value: cs.tier === null ? '—' : `Tier ${cs.tier}` },
    ...(cs.requestedBy ? [{ label: '提出者', value: escape(cs.requestedBy) }] : []),
    ...(cs.expiresAt && !cs.outcome ? [{ label: '到期', value: `<!date^${Math.floor(Date.parse(cs.expiresAt) / 1000)}^{date_short_pretty} {time}|${cs.expiresAt}>` }] : []),
  ];
  blocks.push({ type: 'section', fields: fields.map((f) => ({ type: 'mrkdwn' as const, text: `*${f.label}*\n${f.value}` })) });
  blocks.push(...opsBlocks(cs, opts.interactive));
  if (cs.rationale) blocks.push(context(`:speech_balloon: ${escape(cs.rationale)}`));
  for (const v of cs.violations) {
    blocks.push(context(`${v.severity === 'HARD_BLOCK' ? ':no_entry:' : ':warning:'} ${escape(v.message)}`));
  }
  const links = [
    ...(cs.sourceLink ? [`<${cs.sourceLink}|來源對話>`] : []),
    ...(cs.traceUrl ? [`<${cs.traceUrl}|Trace>`] : []),
    `ChangeSet \`${cs.id}\``,
  ];
  blocks.push(context(links.join(' · ')));
  return blocks;
}

function outcomeBlock(cs: ChangeSetView): KnownBlock {
  const o = cs.outcome!;
  const by = o.actor ? ` · ${escape(o.actor)}` : '';
  const at = o.at ? ` · <!date^${Math.floor(Date.parse(o.at) / 1000)}^{date_short_pretty} {time}|${o.at}>` : '';
  const reason = o.reason ? `\n> ${escape(o.reason)}` : '';
  return mrkdwn(`${statusLabel(o.status)}${by}${at}${reason}`);
}

function buttons(...elements: ActionsBlock['elements']): ActionsBlock {
  return { type: 'actions', elements };
}

export function renderMessage(msg: ChatMessage): SlackRendered {
  switch (msg.type) {
    case 'reply': {
      // Long answers are split across sections (3000 chars each).
      const text = defuseBroadcasts(msg.text);
      const chunks = text.match(/[\s\S]{1,2900}/g) ?? [''];
      return { text: truncate(text, 3000), blocks: chunks.slice(0, 20).map((c) => ({ type: 'section', text: { type: 'mrkdwn', text: c } })) };
    }

    case 'report':
      return { text: msg.title, blocks: [header(msg.title), ...renderSections(msg.sections)].slice(0, 50) };

    case 'notice': {
      const mentions = (msg.mentions ?? []).filter((u) => SLACK_USER_ID.test(u)).map((u) => `<@${u}>`);
      const blocks: KnownBlock[] = [mrkdwn(`${LEVEL_ICON[msg.level]} ${mentions.length ? `${mentions.join(' ')} ` : ''}${defuseBroadcasts(msg.text)}`)];
      if (msg.changesetId && msg.actions?.length) {
        const id = msg.changesetId;
        blocks.push(
          buttons(
            ...msg.actions.map((a) =>
              a === 'undo'
                ? { type: 'button' as const, text: { type: 'plain_text' as const, text: 'Undo' }, action_id: encodeAction({ kind: 'changeset', verb: 'undo', changesetId: id }), style: 'danger' as const }
                : { type: 'button' as const, text: { type: 'plain_text' as const, text: '維持' }, action_id: encodeAction({ kind: 'changeset', verb: 'keep', changesetId: id }) },
            ),
          ),
        );
      }
      return { text: msg.text, blocks };
    }

    case 'approval_request': {
      const cs = msg.changeset;
      const pending = cs.status === 'PENDING_APPROVAL' && !cs.outcome;
      const title = `${msg.mirror ? '[鏡像] ' : ''}待審核變更 · Tier ${cs.tier ?? '?'}`;
      const blocks = changesetBlocks(cs, { title, interactive: pending });
      if (pending) {
        blocks.push(
          buttons(
            { type: 'button', text: { type: 'plain_text', text: '核准' }, style: 'primary', action_id: encodeAction({ kind: 'changeset', verb: 'approve', changesetId: cs.id }) },
            { type: 'button', text: { type: 'plain_text', text: '拒絕' }, style: 'danger', action_id: encodeAction({ kind: 'changeset', verb: 'reject', changesetId: cs.id }) },
          ),
        );
      } else {
        blocks.push(cs.outcome ? outcomeBlock(cs) : mrkdwn(statusLabel(cs.status)));
      }
      return { text: `${title}：${cs.summary}`, blocks: blocks.slice(0, 50) };
    }

    case 'shadow_result': {
      const cs = msg.changeset;
      const blocks = changesetBlocks(cs, { title: 'Shadow 模式 · 若為 live 會執行', interactive: false });
      blocks.push(
        buttons(
          { type: 'button', text: { type: 'plain_text', text: ':+1: 判斷正確', emoji: true }, action_id: encodeAction({ kind: 'shadow', verdict: 'up', changesetId: cs.id }) },
          { type: 'button', text: { type: 'plain_text', text: ':-1: 判斷錯誤', emoji: true }, action_id: encodeAction({ kind: 'shadow', verdict: 'down', changesetId: cs.id }) },
        ),
      );
      if (msg.feedback && msg.feedback.up + msg.feedback.down > 0) blocks.push(context(`回饋：:+1: ${msg.feedback.up} · :-1: ${msg.feedback.down}`));
      return { text: `Shadow：${cs.summary}`, blocks: blocks.slice(0, 50) };
    }
  }
}

/** Metadata the confirm modal carries back on submit: the ChangeSet and where it was clicked. */
export interface ConfirmMetadata {
  changesetId: string;
  channelId?: string;
  threadId?: string;
}

/** Tier 3 confirm modal: amounts and ratios of every op; submitting approves (cs:confirm). */
export function renderConfirmModal(cs: ChangeSetView, where?: ConversationRef): ModalView {
  const metadata: ConfirmMetadata = { changesetId: cs.id, ...(where ? { channelId: where.channelId, ...(where.threadId ? { threadId: where.threadId } : {}) } : {}) };
  const lines = cs.ops.slice(0, MAX_OPS_LISTED).map(opLine);
  if (cs.ops.length > MAX_OPS_LISTED) lines.push(`…另有 ${cs.ops.length - MAX_OPS_LISTED} 項`);
  const blocks: KnownBlock[] = [
    mrkdwn(`:warning: *這是 Tier 3 變更*，核准後會立即執行。\n*${escape(cs.summary)}*`),
    { type: 'section', fields: [{ type: 'mrkdwn', text: `*帳戶*\n${escape(cs.accountName)}` }, ...(cs.requestedBy ? [{ type: 'mrkdwn' as const, text: `*提出者*\n${escape(cs.requestedBy)}` }] : [])] },
    mrkdwn(lines.join('\n')),
    ...cs.violations.map((v) => context(`${v.severity === 'HARD_BLOCK' ? ':no_entry:' : ':warning:'} ${escape(v.message)}`)),
    context(`ChangeSet \`${cs.id}\``),
  ];
  return {
    type: 'modal',
    callback_id: encodeAction({ kind: 'changeset', verb: 'confirm', changesetId: cs.id }),
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: '確認 Tier 3 變更' },
    submit: { type: 'plain_text', text: '核准並執行' },
    close: { type: 'plain_text', text: '取消' },
    blocks,
  };
}

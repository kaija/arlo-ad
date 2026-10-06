// ChangeSet → ChangeSetView for chat cards and the Web review queue (Requirement 7.6). Pure:
// callers pass the account name, currency and entity names they already loaded.
import type { ChangeSetView, OpView } from '../chat/messages';
import { formatChange, formatMoney } from '../format';
import { entityKey, type Op } from '../platform/types';
import type { ChangeSet } from './types';

export interface ViewContext {
  accountName: string;
  currency: string;
  /** Entity display names keyed by entityKey(op.target). */
  names?: ReadonlyMap<string, string>;
  requestedBy?: string;
  sourceLink?: string;
  traceUrl?: string;
  outcome?: ChangeSetView['outcome'];
  /** Op indexes the approver excluded (Requirement 14.5). */
  excludedOps?: ReadonlySet<number>;
  selectable?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  campaign: 'Campaign',
  ad_group: '廣告群組',
  keyword: '關鍵字',
  shared_set: '否定關鍵字清單',
  account: '帳戶',
  campaign_budget: '預算',
};

const STATUS_LABEL: Record<string, string> = { ENABLED: '啟用', PAUSED: '暫停', REMOVED: '移除' };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const keywordText = (v: unknown) => {
  const k = (v ?? {}) as { text?: unknown; matchType?: unknown };
  return `${String(k.text ?? '')} [${String(k.matchType ?? '?')}]`;
};

export function opView(op: Op, ctx: Pick<ViewContext, 'currency' | 'names'>): OpView {
  const name = ctx.names?.get(entityKey(op.target)) ?? `${KIND_LABEL[op.target.kind] ?? op.target.kind} ${op.target.id}`;
  const money = (v: unknown) => formatMoney(num(v), ctx.currency);
  switch (op.kind) {
    case 'set_budget':
      return { label: `${name} · 每日預算`, before: money(op.before), after: money(op.after), change: formatChange(num(op.before), num(op.after)) };
    case 'set_status':
      return { label: `${name} · 狀態`, before: STATUS_LABEL[String(op.before)] ?? String(op.before ?? '—'), after: STATUS_LABEL[String(op.after)] ?? String(op.after) };
    case 'set_bid_target': {
      const roas = op.field === 'target_roas';
      const fmt = (v: unknown) => (num(v) === null ? '—' : roas ? `${(num(v)! * 100).toFixed(0)}%` : money(v));
      return { label: `${name} · ${roas ? '目標 ROAS' : '目標 CPA'}`, before: fmt(op.before), after: fmt(op.after), change: formatChange(num(op.before), num(op.after)) };
    }
    case 'google.add_negative_keyword':
      return { label: `${name} · 新增否定關鍵字`, before: '—', after: keywordText(op.after) };
    case 'google.add_keyword':
      return { label: `${name} · 新增關鍵字`, before: '—', after: keywordText(op.after) };
    case 'google.set_audience_bid_modifier': {
      const m = (v: unknown) => {
        const b = num((v as { bidModifier?: unknown } | null)?.bidModifier);
        return b === null ? '—' : `×${b.toFixed(2)}`;
      };
      return { label: `${name} · 受眾 ${String((op.after as { userListId?: unknown } | null)?.userListId ?? '')} 出價調整`, before: m(op.before), after: m(op.after) };
    }
    case 'google.exclude_audience':
      return { label: `${name} · 排除受眾`, before: '—', after: String((op.after as { userListId?: unknown } | null)?.userListId ?? '') };
    case 'google.create_campaign_bundle': {
      const b = (op.after ?? {}) as { name?: unknown; budgetMicros?: unknown };
      return { label: `${name} · 建立 campaign（暫停）`, before: '—', after: `${String(b.name ?? '')}（${money(b.budgetMicros)}/日）` };
    }
  }
}

export function changeSetView(cs: ChangeSet, ctx: ViewContext): ChangeSetView {
  return {
    id: cs.id,
    accountName: ctx.accountName,
    summary: cs.summary,
    ...(cs.rationale ? { rationale: cs.rationale } : {}),
    tier: cs.tier,
    status: cs.status,
    ops: cs.ops.map((op, i) => ({ ...opView(op, ctx), ...(ctx.excludedOps?.has(i) || cs.excludedOps?.includes(i) ? { excluded: true } : {}) })),
    violations: cs.violations.map((v) => ({ severity: v.severity, message: v.message })),
    ...(ctx.requestedBy ? { requestedBy: ctx.requestedBy } : {}),
    ...(cs.expiresAt ? { expiresAt: cs.expiresAt.toISOString() } : {}),
    ...(ctx.outcome ? { outcome: ctx.outcome } : {}),
    ...(ctx.sourceLink ? { sourceLink: ctx.sourceLink } : {}),
    ...(ctx.traceUrl ? { traceUrl: ctx.traceUrl } : {}),
    ...(ctx.selectable ? { selectable: true } : {}),
  };
}

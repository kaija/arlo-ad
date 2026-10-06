// Platform-neutral references and ChangeSet operations (ADR-0004, ADR-0006). Adapters speak
// in platform ids: `accountId` is the platform account (Google customer ID without dashes),
// `id` the entity's platform id (Google keywords: `adGroupId~criterionId`).

export const PLATFORMS = ['google_ads'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ENTITY_KINDS = ['account', 'campaign', 'ad_group', 'keyword', 'shared_set', 'campaign_budget'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityRef {
  platform: Platform;
  accountId: string;
  kind: EntityKind;
  id: string;
}

/** Stable map key for an entity reference. */
export function entityKey(ref: EntityRef): string {
  return `${ref.platform}:${ref.accountId}:${ref.kind}:${ref.id}`;
}

/** Fields returned by `fetchCurrent` and compared against `Op.before` (ADR-0009). */
export const CURRENT_FIELDS = ['status', 'budget_micros', 'bid_strategy', 'target_cpa_micros', 'target_roas'] as const;
export type CurrentField = (typeof CURRENT_FIELDS)[number];
export type CurrentState = Partial<Record<CurrentField, string | number | null>>;

export const OP_KINDS = [
  'set_budget',
  'set_status',
  'set_bid_target',
  'google.add_negative_keyword',
  'google.add_keyword',
  'google.set_audience_bid_modifier',
  'google.exclude_audience',
  'google.create_campaign_bundle',
] as const;
export type OpKind = (typeof OP_KINDS)[number];

export type EntityStatus = 'ENABLED' | 'PAUSED';
export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';

/**
 * One write. `before` is the value when proposed (null for creates); `field` names the
 * CurrentField the op changes, when it changes one.
 *
 * - set_budget: campaign, field budget_micros, daily budget in micros.
 * - set_status: campaign / ad_group / keyword, field status, ENABLED | PAUSED.
 * - set_bid_target: campaign, field target_cpa_micros (micros) or target_roas (ratio).
 * - google.add_negative_keyword: shared_set (or campaign), after { text, matchType }.
 * - google.add_keyword: ad_group, after { text, matchType, cpcBidMicros? }.
 * - google.set_audience_bid_modifier: campaign, after { userListId, bidModifier }.
 * - google.exclude_audience: campaign, after { userListId }.
 * - google.create_campaign_bundle: account, after is the campaign bundle; created PAUSED.
 */
export interface Op {
  kind: OpKind;
  target: EntityRef;
  field?: CurrentField;
  before: unknown;
  after: unknown;
  meta?: Record<string, unknown>;
}

export interface OpResult {
  index: number;
  ok: boolean;
  error?: string;
  /** Platform resource created or changed, e.g. customers/1/campaigns/2. */
  resourceName?: string;
}

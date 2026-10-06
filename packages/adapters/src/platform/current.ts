import type { CurrentState } from '@arlo/core';
import type { EntityRecord } from './types';

// Strategies whose target is a CPA (micros) vs a ROAS (ratio).
const CPA_STRATEGIES = new Set(['TARGET_CPA', 'MAXIMIZE_CONVERSIONS']);
const ROAS_STRATEGIES = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);

/** The comparable state of an entity, in fetchCurrent's shape. */
export function currentFromRecord(record: Pick<EntityRecord, 'status' | 'state'>): CurrentState {
  const current: CurrentState = { status: record.status };
  if (record.state) {
    const { budgetMicros, bidStrategy, bidTarget } = record.state;
    current.budget_micros = budgetMicros;
    current.bid_strategy = bidStrategy;
    current.target_cpa_micros = bidStrategy && CPA_STRATEGIES.has(bidStrategy) ? bidTarget : null;
    current.target_roas = bidStrategy && ROAS_STRATEGIES.has(bidStrategy) ? bidTarget : null;
  }
  return current;
}

// Risk direction of an op (ADR-0007): protective ops may run automatically as Tier 1,
// expansive ops always need approval, neutral ops are ordinary Tier 2 changes.
import type { CurrentState, Op } from '../platform/types';

export type OpClass = 'protective' | 'expansive' | 'neutral';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Direction of a numeric change; `null` when either side is unknown. */
function direction(before: unknown, after: unknown): -1 | 0 | 1 | null {
  const b = num(before);
  const a = num(after);
  if (b === null || a === null) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function classifyOp(op: Op): OpClass {
  switch (op.kind) {
    case 'set_budget': {
      const d = direction(op.before, op.after);
      // Without a known previous budget a reduction cannot be proven.
      return d === null || d > 0 ? 'expansive' : d < 0 ? 'protective' : 'neutral';
    }
    case 'set_status':
      if (op.after === 'PAUSED') return op.before === 'PAUSED' ? 'neutral' : 'protective';
      if (op.after === 'ENABLED') return op.before === 'ENABLED' ? 'neutral' : 'expansive';
      // Anything else (e.g. REMOVED) is irreversible from here: always reviewed.
      return 'expansive';
    case 'set_bid_target': {
      const d = direction(op.before, op.after);
      if (d === null) return 'expansive';
      if (d === 0) return 'neutral';
      // A lower target CPA or a higher target ROAS makes bidding more conservative.
      if (op.field === 'target_roas') return d > 0 ? 'protective' : 'expansive';
      return d < 0 ? 'protective' : 'expansive';
    }
    case 'google.add_negative_keyword':
      // Only EXACT negatives are narrow enough to add automatically (Requirement 4.2).
      return (op.after as { matchType?: string } | null)?.matchType === 'EXACT' ? 'protective' : 'neutral';
    case 'google.set_audience_bid_modifier': {
      const before = (op.before as { bidModifier?: number } | null)?.bidModifier ?? 1;
      const after = (op.after as { bidModifier?: number } | null)?.bidModifier;
      return after === undefined || after > before ? 'expansive' : 'neutral';
    }
    case 'google.exclude_audience':
      return 'neutral';
    case 'google.add_keyword':
    case 'google.create_campaign_bundle':
      return 'expansive';
  }
}

/** Relative size of a numeric change (|after − before| / before); null when not numeric. */
export function changeRatio(op: Op): number | null {
  const b = num(op.before);
  const a = num(op.after);
  if (b === null || a === null) return null;
  if (b === 0) return a === 0 ? 0 : Infinity;
  return Math.abs(a - b) / Math.abs(b);
}

/** Absolute daily-budget change in micros for set_budget ops; 0 otherwise. */
export function budgetDeltaMicros(op: Op): number {
  if (op.kind !== 'set_budget') return 0;
  const b = num(op.before) ?? 0;
  const a = num(op.after) ?? 0;
  return Math.abs(a - b);
}

export interface Drift {
  opIndex: number;
  field?: string;
  expected: unknown;
  actual: unknown;
  reason: 'changed' | 'missing';
}

const same = (a: unknown, b: unknown) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return (a ?? null) === (b ?? null);
};

/**
 * Ops whose live value no longer equals what was proposed against (ADR-0009). Ops that create
 * things (no field) are not compared. `current` is keyed by entityKey.
 */
export function diffCurrent(ops: readonly Op[], current: ReadonlyMap<string, CurrentState>, keyOf: (op: Op) => string): Drift[] {
  const drifts: Drift[] = [];
  ops.forEach((op, opIndex) => {
    if (!op.field) return;
    const state = current.get(keyOf(op));
    if (!state) {
      drifts.push({ opIndex, field: op.field, expected: op.before, actual: undefined, reason: 'missing' });
      return;
    }
    const actual = state[op.field];
    if (!same(op.before, actual)) drifts.push({ opIndex, field: op.field, expected: op.before, actual, reason: 'changed' });
  });
  return drifts;
}

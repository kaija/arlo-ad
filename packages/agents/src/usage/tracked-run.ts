// Runs agent work inside an OpenAI trace (ADR-0024) and records token usage and estimated
// cost to llm_usage, linked to what the run was for (Requirements 19.2, 19.4).
import { DEFAULT_MODEL_PRICES, estimateCostUsd, type ModelPrice } from '@arlo/core';
import { getSetting, insertLlmUsage, type Db } from '@arlo/db';
import { withTrace } from '@openai/agents';
import { collectUsage, summarizeUsage, type UsageEntry } from './ledger';

export type UsageRefKind = 'session' | 'job_run' | 'campaign_task' | 'changeset';

export interface TrackedRunOptions {
  db: Db;
  /** Trace name shown in the OpenAI Traces dashboard. */
  name: string;
  ref: { kind: UsageRefKind; id: string };
  metadata?: Record<string, string>;
  now?: () => Date;
}

export interface TrackedRunResult<T> {
  result: T;
  traceId: string | null;
  costUsd: number;
  usage: UsageEntry[];
}

/** Model prices with the `model_prices` setting layered over the defaults. */
export async function modelPrices(db: Db): Promise<Record<string, ModelPrice> | undefined> {
  const overrides = await getSetting<Record<string, ModelPrice>>(db, 'model_prices');
  return overrides ? { ...DEFAULT_MODEL_PRICES, ...overrides } : undefined;
}

export async function trackedRun<T>(opts: TrackedRunOptions, fn: (traceId: string | null) => Promise<T>): Promise<TrackedRunResult<T>> {
  let traceId: string | null = null;
  const { result, usage } = await collectUsage(() =>
    withTrace(
      opts.name,
      async (trace) => {
        // A disabled tracer hands out a no-op trace.
        traceId = trace.traceId && !trace.traceId.startsWith('no-op') ? trace.traceId : null;
        return fn(traceId);
      },
      { metadata: { ref_kind: opts.ref.kind, ref_id: opts.ref.id, ...opts.metadata } },
    ),
  );
  const prices = await modelPrices(opts.db);
  const rows = summarizeUsage(usage).map((u) => ({
    ...u,
    at: (opts.now ?? (() => new Date()))(),
    costUsd: estimateCostUsd(u.model, u, prices),
    refKind: opts.ref.kind,
    refId: opts.ref.id,
    traceId,
  }));
  await insertLlmUsage(opts.db, rows);
  return { result, traceId, costUsd: Math.round(rows.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6, usage: rows };
}

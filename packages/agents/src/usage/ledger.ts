// Collects token usage of every model call made while a function runs, including nested
// agent-as-tool runs, via AsyncLocalStorage.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Usage } from '@openai/agents';

export interface UsageEntry {
  agent: string;
  model: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const storage = new AsyncLocalStorage<UsageEntry[]>();

function cachedTokens(usage: Usage): number {
  return usage.inputTokensDetails.reduce((sum, d) => sum + (d.cached_tokens ?? 0), 0);
}

export function recordUsage(agent: string, model: string, usage: Usage): void {
  storage.getStore()?.push({
    agent,
    model,
    requests: usage.requests || 1,
    inputTokens: usage.inputTokens,
    cachedInputTokens: cachedTokens(usage),
    outputTokens: usage.outputTokens,
  });
}

export async function collectUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: UsageEntry[] }> {
  const usage: UsageEntry[] = [];
  const result = await storage.run(usage, fn);
  return { result, usage };
}

/** Sums entries per agent × model. */
export function summarizeUsage(entries: readonly UsageEntry[]): UsageEntry[] {
  const out = new Map<string, UsageEntry>();
  for (const e of entries) {
    const key = `${e.agent}\u0000${e.model}`;
    const acc = out.get(key) ?? { agent: e.agent, model: e.model, requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    acc.requests += e.requests;
    acc.inputTokens += e.inputTokens;
    acc.cachedInputTokens += e.cachedInputTokens;
    acc.outputTokens += e.outputTokens;
    out.set(key, acc);
  }
  return [...out.values()];
}

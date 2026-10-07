// Agents under evaluation. Specialists behind the Orchestrator are stubs answering canned text,
// so routing suites measure the Orchestrator's choice without paying for nested runs.
import { classifierInput, createCauseRanker, createOrchestrator, createSearchTermClassifier, type AgentContext } from '@arlo/agents';
import { BusinessProfileSchema } from '@arlo/core';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { Agent, type Model } from '@openai/agents';
import type { AgentFactory } from './runner';

const STUB_ANSWER = '（評測用假資料：查詢完成，昨日花費 NT$12,345，轉換 12 次。）';

function stubSpecialist(name: string): Agent<AgentContext> {
  return new Agent<AgentContext>({ name, instructions: 'stub', model: new ScriptedModel(() => [say(STUB_ANSWER)], { inputTokens: 0, outputTokens: 0 }) });
}

export function agentFactory(models: { flagship: string | Model; small: string | Model }): AgentFactory {
  return (suite) => {
    switch (suite.agent) {
      case 'orchestrator':
        return {
          agent: createOrchestrator({
            model: models.flagship,
            specialists: {
              analyst: stubSpecialist('analyst'),
              bidding: stubSpecialist('bidding'),
              keyword: stubSpecialist('keyword'),
              audit: stubSpecialist('audit'),
            },
          }),
          context: { db: undefined, allowedAccountIds: null, now: () => new Date() },
        };
      case 'search_term_classifier': {
        // One term per case against the suite's profile; the batch label is scored.
        const profile = BusinessProfileSchema.parse(suite.fixture?.profile);
        return {
          agent: createSearchTermClassifier({ model: models.small }),
          formatInput: (input) => classifierInput(profile, [String((input as { term?: unknown }).term ?? input)]),
          project: (output) => (output as { labels?: unknown[] } | undefined)?.labels?.[0],
        };
      }
      case 'cause_ranker':
        // Scored on the most likely cause only (null when the model names none).
        return {
          agent: createCauseRanker({ model: models.flagship }),
          project: (output) => {
            const causes = [...((output as { causes?: { id: string; likelihood: number }[] } | undefined)?.causes ?? [])].sort((a, b) => b.likelihood - a.likelihood);
            return { topCause: causes[0]?.id ?? null };
          },
        };
      default:
        throw new Error(`no eval agent registered for "${suite.agent}"`);
    }
  };
}

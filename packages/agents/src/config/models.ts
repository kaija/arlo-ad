// Which model each agent uses (ADR-0023, Requirement 19.1): agents map to a tier here, and the
// tier's model name comes from the environment (MODEL_FLAGSHIP / MODEL_SMALL), so models can
// be swapped without code changes.

export const AGENT_NAMES = ['orchestrator', 'analyst', 'keyword', 'bidding', 'audit', 'audience', 'campaign', 'search_term_classifier'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type ModelTier = 'flagship' | 'small';

export const AGENT_MODEL_TIER: Record<AgentName, ModelTier> = {
  orchestrator: 'flagship',
  analyst: 'flagship',
  keyword: 'flagship',
  bidding: 'flagship',
  audit: 'flagship',
  audience: 'flagship',
  campaign: 'flagship',
  search_term_classifier: 'small',
};

export interface ModelEnv {
  MODEL_FLAGSHIP: string;
  MODEL_SMALL: string;
}

export function modelNameFor(agent: AgentName, env: ModelEnv): string {
  return AGENT_MODEL_TIER[agent] === 'small' ? env.MODEL_SMALL : env.MODEL_FLAGSHIP;
}

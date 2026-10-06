import type { AgentContext } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import type { ChatMessage } from '@arlo/core';
import type { AdAccount, Db, JobRun, ScheduledJob } from '@arlo/db';
import type { Agent } from '@openai/agents';

export interface AgentFactories {
  analyst: () => Agent<AgentContext>;
  orchestrator: () => Agent<AgentContext>;
}

export interface TemplateContext {
  db: Db;
  logger: Logger;
  now: () => Date;
  agents: AgentFactories;
  job: ScheduledJob;
  run: JobRun;
  /** The job's accounts that are still active. */
  accounts: AdAccount[];
}

export interface TemplateResult {
  messages: ChatMessage[];
  changesetIds: string[];
}

/** One handler per job template (ADR-0016). */
export interface TemplateHandler {
  /** Runs even when the daily LLM budget is exhausted (Requirement 19.3). */
  critical: boolean;
  run(ctx: TemplateContext): Promise<TemplateResult>;
}

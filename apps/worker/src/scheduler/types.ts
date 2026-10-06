import type { AgentContext, SearchTermLabelsSchema } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import type { ChatMessage } from '@arlo/core';
import type { AdAccount, Db, JobRun, ScheduledJob } from '@arlo/db';
import type { Agent } from '@openai/agents';

export interface AgentFactories {
  analyst: () => Agent<AgentContext>;
  bidding?: () => Agent<AgentContext>;
  keyword?: () => Agent<AgentContext>;
  orchestrator: () => Agent<AgentContext>;
  /** Small-model search term classifier (ADR-0019, ADR-0023). */
  searchTermClassifier?: () => Agent<unknown, typeof SearchTermLabelsSchema>;
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
  /** Trace of this run, recorded on ChangeSets it proposes. */
  traceId?: string | null;
  /** Stores a ChangeSet and queues it for the Executor (propose_* tools only, ADR-0006). */
  propose?: AgentContext['propose'];
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

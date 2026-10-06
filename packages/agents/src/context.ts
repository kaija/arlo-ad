import type { ChangeSetSource } from '@arlo/core';
import type { Db, NewChangeSet } from '@arlo/db';

/** Run context shared by every tool (ADR-0014). Tools only read Postgres or create ChangeSets. */
export interface AgentContext {
  db: Db;
  /** Accounts the requesting user may read (ad_accounts.id); null = every account. */
  allowedAccountIds: readonly string[] | null;
  /** The person the run acts for, when there is one (chat, Web). */
  user?: { id: string; displayName?: string | null } | null;
  now: () => Date;
  /** Where ChangeSets proposed in this run come from (Requirement 3.7). */
  source?: ChangeSetSource;
  /** Trace of the current run, recorded on proposed ChangeSets. */
  traceId?: string | null;
  /**
   * Stores a ChangeSet and queues it for the Executor (ADR-0006). Absent where proposing is not
   * allowed; propose_* tools then refuse.
   */
  propose?: (input: NewChangeSet) => Promise<{ id: string }>;
}

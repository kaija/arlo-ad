import type { Db } from '@arlo/db';

/** Run context shared by every tool (ADR-0014). Tools only read Postgres or create ChangeSets. */
export interface AgentContext {
  db: Db;
  /** Accounts the requesting user may read (ad_accounts.id); null = every account. */
  allowedAccountIds: readonly string[] | null;
  /** The person the run acts for, when there is one (chat, Web). */
  user?: { id: string; displayName?: string | null } | null;
  now: () => Date;
}

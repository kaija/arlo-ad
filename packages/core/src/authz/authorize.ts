// Central permission check shared by Slack and Web (ADR-0010, Requirements 1.4–1.6, 18.8).

/** Ordered by privilege. */
export const ROLES = ['viewer', 'operator', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type Tier = 0 | 1 | 2 | 3;

export interface RoleGrant {
  role: Role;
  /** Account ids (ad_accounts.id) this grant covers; null means every account. */
  accountIds: readonly string[] | null;
  /** Highest ChangeSet tier this grant may approve. */
  maxTier: number;
}

export interface AuthzUser {
  id: string;
  status: 'active' | 'unbound' | 'disabled';
  bindings: readonly RoleGrant[];
}

export type Action =
  | 'view' // read dashboards and data, ask the bot questions
  | 'propose' // ask for changes that become ChangeSets, submit briefs, run schedules manually
  | 'approve'
  | 'reject'
  | 'undo' // Requirement 8.2
  | 'admin'; // settings, rules, thresholds, automation modes, RBAC

/** The ChangeSet (or account) an action applies to. */
export interface AuthzTarget {
  accountId?: string;
  tier?: Tier | null;
  requestedByUserId?: string | null;
}

export type DenyReason = 'disabled' | 'role' | 'scope' | 'tier' | 'four_eyes' | 'missing_target';
export type AuthzResult = { allowed: true } | { allowed: false; reason: DenyReason };

const MIN_ROLE: Record<Action, Role> = {
  view: 'viewer',
  propose: 'operator',
  approve: 'approver',
  reject: 'approver',
  undo: 'operator',
  admin: 'admin',
};

// Actions that change an account and therefore need its id.
const ACCOUNT_ACTIONS: ReadonlySet<Action> = new Set(['propose', 'approve', 'reject', 'undo']);

const rank = (role: Role) => ROLES.indexOf(role);
const covers = (grant: RoleGrant, accountId: string | undefined) =>
  grant.accountIds === null || (accountId !== undefined && grant.accountIds.includes(accountId));

const deny = (reason: DenyReason): AuthzResult => ({ allowed: false, reason });

export function authorize(user: AuthzUser, action: Action, target: AuthzTarget = {}): AuthzResult {
  if (user.status === 'disabled') return deny('disabled');
  if (ACCOUNT_ACTIONS.has(action) && target.accountId === undefined) return deny('missing_target');
  if (action === 'approve' && (target.tier === undefined || target.tier === null)) return deny('missing_target');

  const byRole = user.bindings.filter((g) => rank(g.role) >= rank(MIN_ROLE[action]));
  if (byRole.length === 0) return deny('role');

  // Org-wide actions (admin, unscoped view) need no account; account-scoped ones need a covering grant.
  const scoped = target.accountId === undefined ? byRole : byRole.filter((g) => covers(g, target.accountId));
  if (scoped.length === 0) return deny('scope');

  if (action === 'approve') {
    const tier = target.tier!;
    if (!scoped.some((g) => g.maxTier >= tier)) return deny('tier');
    // Four-eyes (Requirement 1.6): the requester cannot approve their own Tier 3 change.
    if (tier === 3 && target.requestedByUserId === user.id) return deny('four_eyes');
  }
  return { allowed: true };
}

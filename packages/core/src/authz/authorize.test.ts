import { describe, expect, it } from 'vitest';
import type { Tier } from '../changeset/types';
import { authorize, ROLES, type Action, type AuthzUser, type Role } from './authorize';

const ACCOUNT = 'acc-1';
const OTHER = 'acc-2';
const TIERS: Tier[] = [0, 1, 2, 3];
const ACTIONS: Action[] = ['view', 'propose', 'approve', 'reject', 'undo', 'admin'];

const user = (role: Role, opts: { accountIds?: string[] | null; maxTier?: number; id?: string } = {}): AuthzUser => ({
  id: opts.id ?? 'u-1',
  status: 'active',
  bindings: [{ role, accountIds: opts.accountIds ?? null, maxTier: opts.maxTier ?? 3 }],
});

// Expected minimum role per action, written independently of the implementation's table.
const allowedRoles: Record<Action, Role[]> = {
  view: ['viewer', 'operator', 'approver', 'admin'],
  propose: ['operator', 'approver', 'admin'],
  approve: ['approver', 'admin'],
  reject: ['approver', 'admin'],
  undo: ['operator', 'approver', 'admin'],
  admin: ['admin'],
};

describe('authorize', () => {
  describe('role × action × tier (all-account grant, maxTier 3, someone else requested)', () => {
    const cases = ROLES.flatMap((role) =>
      ACTIONS.flatMap((action) => TIERS.map((tier) => [role, action, tier, allowedRoles[action].includes(role)] as const)),
    );
    it.each(cases)('%s %s tier %i → %s', (role, action, tier, expected) => {
      const result = authorize(user(role), action, { accountId: ACCOUNT, tier, requestedByUserId: 'someone-else' });
      expect(result).toEqual(expected ? { allowed: true } : { allowed: false, reason: 'role' });
    });
  });

  describe('max_tier limits approval only', () => {
    const cases = ([0, 1, 2, 3] as const).flatMap((maxTier) => TIERS.map((tier) => [maxTier, tier, tier <= maxTier] as const));
    it.each(cases)('approver maxTier %i approving tier %i → %s', (maxTier, tier, expected) => {
      const result = authorize(user('approver', { maxTier }), 'approve', { accountId: ACCOUNT, tier });
      expect(result).toEqual(expected ? { allowed: true } : { allowed: false, reason: 'tier' });
    });

    it('applies to admins as well', () => {
      expect(authorize(user('admin', { maxTier: 2 }), 'approve', { accountId: ACCOUNT, tier: 3 })).toEqual({
        allowed: false,
        reason: 'tier',
      });
    });

    it.each(['reject', 'undo', 'propose'] as const)('does not limit %s', (action) => {
      expect(authorize(user('approver', { maxTier: 0 }), action, { accountId: ACCOUNT, tier: 3 })).toEqual({ allowed: true });
    });
  });

  describe('account scope', () => {
    it.each(['view', 'propose', 'approve', 'reject', 'undo'] as const)('%s needs a grant covering the account', (action) => {
      const scoped = user('admin', { accountIds: [ACCOUNT] });
      expect(authorize(scoped, action, { accountId: ACCOUNT, tier: 2 })).toEqual({ allowed: true });
      expect(authorize(scoped, action, { accountId: OTHER, tier: 2 })).toEqual({ allowed: false, reason: 'scope' });
    });

    it('allows org-wide view with any grant, and admin actions regardless of account scope', () => {
      expect(authorize(user('viewer', { accountIds: [ACCOUNT] }), 'view')).toEqual({ allowed: true });
      expect(authorize(user('admin', { accountIds: [ACCOUNT] }), 'admin')).toEqual({ allowed: true });
    });

    it('combines grants: the covering grant must itself satisfy role and tier', () => {
      const mixed: AuthzUser = {
        id: 'u-1',
        status: 'active',
        bindings: [
          { role: 'approver', accountIds: [ACCOUNT], maxTier: 2 },
          { role: 'viewer', accountIds: null, maxTier: 0 },
          { role: 'approver', accountIds: [OTHER], maxTier: 3 },
        ],
      };
      expect(authorize(mixed, 'approve', { accountId: ACCOUNT, tier: 2 })).toEqual({ allowed: true });
      expect(authorize(mixed, 'approve', { accountId: ACCOUNT, tier: 3 })).toEqual({ allowed: false, reason: 'tier' });
      expect(authorize(mixed, 'approve', { accountId: OTHER, tier: 3 })).toEqual({ allowed: true });
      expect(authorize(mixed, 'approve', { accountId: 'acc-3', tier: 2 })).toEqual({ allowed: false, reason: 'scope' });
      expect(authorize(mixed, 'view', { accountId: 'acc-3' })).toEqual({ allowed: true });
    });
  });

  describe('four-eyes for Tier 3 (Requirement 1.6)', () => {
    it.each(TIERS)('requester approving own tier %i change', (tier) => {
      const result = authorize(user('admin', { id: 'req' }), 'approve', { accountId: ACCOUNT, tier, requestedByUserId: 'req' });
      expect(result).toEqual(tier === 3 ? { allowed: false, reason: 'four_eyes' } : { allowed: true });
    });

    it('lets the requester reject their own Tier 3 change', () => {
      expect(authorize(user('approver', { id: 'req' }), 'reject', { accountId: ACCOUNT, tier: 3, requestedByUserId: 'req' })).toEqual({
        allowed: true,
      });
    });
  });

  describe('user state and input', () => {
    it.each(ACTIONS)('denies disabled users: %s', (action) => {
      const disabled = { ...user('admin'), status: 'disabled' as const };
      expect(authorize(disabled, action, { accountId: ACCOUNT, tier: 1 })).toEqual({ allowed: false, reason: 'disabled' });
    });

    it('treats unbound Web users like active ones', () => {
      expect(authorize({ ...user('operator'), status: 'unbound' }, 'propose', { accountId: ACCOUNT })).toEqual({ allowed: true });
    });

    it('denies users without bindings', () => {
      expect(authorize({ id: 'u', status: 'active', bindings: [] }, 'view')).toEqual({ allowed: false, reason: 'role' });
    });

    it.each(['propose', 'approve', 'reject', 'undo'] as const)('%s requires an account', (action) => {
      expect(authorize(user('admin'), action, { tier: 2 })).toEqual({ allowed: false, reason: 'missing_target' });
    });

    it('approve requires a tier', () => {
      expect(authorize(user('admin'), 'approve', { accountId: ACCOUNT, tier: null })).toEqual({
        allowed: false,
        reason: 'missing_target',
      });
    });
  });
});

describe('readableAccountIds', () => {
  it('unions scoped grants, is null with any all-account grant, empty when disabled', async () => {
    const { readableAccountIds } = await import('./authorize');
    const scoped = {
      id: 'u',
      status: 'active' as const,
      bindings: [
        { role: 'viewer' as const, accountIds: ['a', 'b'], maxTier: 0 },
        { role: 'approver' as const, accountIds: ['b', 'c'], maxTier: 2 },
      ],
    };
    expect(readableAccountIds(scoped)).toEqual(['a', 'b', 'c']);
    expect(readableAccountIds({ ...scoped, bindings: [...scoped.bindings, { role: 'viewer', accountIds: null, maxTier: 0 }] })).toBeNull();
    expect(readableAccountIds({ ...scoped, status: 'disabled' })).toEqual([]);
  });
});

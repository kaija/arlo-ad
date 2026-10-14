// Google Workspace sign-in policy (Requirement 1.1, ADR-0010). The `hd` authorization
// parameter only pre-selects an account in Google's UI; the ID token's `hd` claim is what
// proves Workspace membership, so it is checked here on every sign-in. Without a configured
// domain any verified Google account passes; access still requires a role binding.

export interface GoogleProfile {
  email?: string | null;
  email_verified?: boolean | null;
  /** Hosted domain; absent for consumer (gmail.com) accounts. */
  hd?: string | null;
}

export type SsoDecision = { ok: true; email: string } | { ok: false; reason: 'no_email' | 'unverified' | 'wrong_domain' };

export function checkWorkspaceProfile(profile: GoogleProfile | null | undefined, allowedDomain: string | undefined): SsoDecision {
  const email = profile?.email?.trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };
  if (profile?.email_verified !== true) return { ok: false, reason: 'unverified' };
  const domain = allowedDomain?.trim().toLowerCase();
  if (!domain) return { ok: true, email };
  // Both the hosted-domain claim and the address must match: an alias on another domain
  // inside the same Workspace is still rejected.
  if (profile.hd?.toLowerCase() !== domain || !email.endsWith(`@${domain}`)) return { ok: false, reason: 'wrong_domain' };
  return { ok: true, email };
}

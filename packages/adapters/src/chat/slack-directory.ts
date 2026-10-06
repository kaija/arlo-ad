// Slack workspace directory lookups used to bind internal users (ADR-0010).
import type { WebClient } from '@slack/web-api';

export interface DirectoryUser {
  slackUserId: string;
  displayName?: string;
}

export interface UserDirectory {
  /** null when no Slack user has this email. */
  lookupByEmail(email: string): Promise<DirectoryUser | null>;
}

export function createSlackDirectory(client: WebClient): UserDirectory {
  return {
    async lookupByEmail(email) {
      try {
        const res = await client.users.lookupByEmail({ email });
        if (!res.user?.id) return null;
        return { slackUserId: res.user.id, displayName: res.user.profile?.display_name || res.user.real_name || undefined };
      } catch (err) {
        if ((err as { data?: { error?: string } }).data?.error === 'users_not_found') return null;
        throw err;
      }
    },
  };
}

/** In-memory directory for tests. */
export class FakeUserDirectory implements UserDirectory {
  readonly lookups: string[] = [];
  constructor(private readonly byEmail: Record<string, string> = {}) {}

  async lookupByEmail(email: string): Promise<DirectoryUser | null> {
    this.lookups.push(email);
    const slackUserId = this.byEmail[email.toLowerCase()];
    return slackUserId ? { slackUserId } : null;
  }
}

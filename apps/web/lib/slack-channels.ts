// Slack channels the bot can post to, for target selection (Requirement 11.2).
import { EnvSchema, parseEnv } from '@arlo/config';
import { WebClient } from '@slack/web-api';
import { logger } from './server';

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}

const TTL_MS = 5 * 60_000;
const cache = globalThis as typeof globalThis & { arloSlackChannels?: { at: number; channels: SlackChannel[] } };

/** Channels the bot is a member of; empty when Slack is unreachable (the form then takes an ID). */
export async function listBotChannels(): Promise<SlackChannel[]> {
  if (cache.arloSlackChannels && Date.now() - cache.arloSlackChannels.at < TTL_MS) return cache.arloSlackChannels.channels;
  try {
    const client = new WebClient(parseEnv(EnvSchema.pick({ SLACK_BOT_TOKEN: true })).SLACK_BOT_TOKEN);
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.users.conversations({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
      for (const c of res.channels ?? []) if (c.id) channels.push({ id: c.id, name: c.name ?? c.id, private: Boolean(c.is_private) });
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    channels.sort((a, b) => a.name.localeCompare(b.name));
    cache.arloSlackChannels = { at: Date.now(), channels };
    return channels;
  } catch (err) {
    logger.warn({ err }, 'could not list Slack channels');
    return [];
  }
}

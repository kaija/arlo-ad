// Slack request handling for route handlers (Requirement 7.7): verify, ack fast, enqueue.
import { verifySlackSignature } from '@arlo/adapters/chat';
import { EnvSchema, parseEnv } from '@arlo/config';
import type { JobData } from '@arlo/queue';
import type { Jobs } from '@arlo/queue';
import { logger } from './server';

const SlackEnv = EnvSchema.pick({ SLACK_SIGNING_SECRET: true });

/** Reads the raw body and checks the Slack signature; returns the body or a 401 response. */
export async function verifiedBody(req: Request): Promise<{ ok: true; raw: string } | { ok: false; response: Response }> {
  const raw = await req.text();
  const result = verifySlackSignature({
    signingSecret: parseEnv(SlackEnv).SLACK_SIGNING_SECRET,
    rawBody: raw,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
  });
  if (result.ok) return { ok: true, raw };
  logger.warn({ reason: result.reason }, 'rejected Slack request');
  return { ok: false, response: new Response('invalid signature', { status: 401 }) };
}

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event?: { type?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string; channel?: string };
}

export function parseEnvelope(raw: string): SlackEventEnvelope | null {
  try {
    const body = JSON.parse(raw) as SlackEventEnvelope;
    return typeof body?.type === 'string' ? body : null;
  } catch {
    return null;
  }
}

/** app_mention from a person → chat.mention payload; anything else → null. */
export function mentionJob(envelope: SlackEventEnvelope): JobData<typeof Jobs.chatMention> | null {
  const e = envelope.event;
  if (envelope.type !== 'event_callback' || !envelope.event_id || e?.type !== 'app_mention') return null;
  if (e.bot_id || !e.user || !e.channel || !e.ts) return null;
  return {
    eventId: envelope.event_id,
    teamId: envelope.team_id,
    channelId: e.channel,
    userId: e.user,
    text: e.text ?? '',
    messageTs: e.ts,
    threadTs: e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : undefined,
  };
}

interface SlackInteractionPayload {
  type?: string;
  user?: { id?: string; team_id?: string };
  team?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string; selected_options?: { value?: string }[] }[];
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, unknown> } };
}

/** Interactivity form body (`payload=<json>`) → chat.interaction payload; unsupported types → null. */
export function interactionJob(raw: string): JobData<typeof Jobs.chatInteraction> | null {
  let p: SlackInteractionPayload;
  try {
    p = JSON.parse(new URLSearchParams(raw).get('payload') ?? '') as SlackInteractionPayload;
  } catch {
    return null;
  }
  if ((p.type !== 'block_actions' && p.type !== 'view_submission') || !p.user?.id) return null;
  return {
    type: p.type,
    userId: p.user.id,
    teamId: p.team?.id ?? p.user.team_id,
    channelId: p.channel?.id ?? p.container?.channel_id,
    messageTs: p.message?.ts ?? p.container?.message_ts,
    threadTs: p.message?.thread_ts ?? p.container?.thread_ts,
    actions: (p.actions ?? []).flatMap((a) =>
      a.action_id
        ? [{ actionId: a.action_id, value: a.value, selected: a.selected_options?.flatMap((o) => (o.value ? [o.value] : [])) }]
        : [],
    ),
    responseUrl: p.response_url,
    view:
      p.type === 'view_submission' && p.view?.callback_id
        ? { callbackId: p.view.callback_id, privateMetadata: p.view.private_metadata ?? '', values: p.view.state?.values ?? {} }
        : undefined,
  };
}

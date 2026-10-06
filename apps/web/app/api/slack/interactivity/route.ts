import { SlackAdapter } from '@arlo/adapters/chat';
import { EnvSchema, parseEnv } from '@arlo/config';
import { enqueue, Jobs } from '@arlo/queue';
import { WebClient } from '@slack/web-api';
import { confirmClick, openTier3Confirm } from '../../../../lib/confirm';
import { getBoss } from '../../../../lib/queue';
import { getDb, logger } from '../../../../lib/server';
import { interactionJob, verifiedBody } from '../../../../lib/slack';

export const dynamic = 'force-dynamic';

let slack: SlackAdapter | undefined;
const chat = () => (slack ??= new SlackAdapter(new WebClient(parseEnv(EnvSchema.pick({ SLACK_BOT_TOKEN: true })).SLACK_BOT_TOKEN)));

// Slack interactivity (buttons, modals): verify, enqueue, ack within 3 seconds (Requirement 7.7).
// Repeated clicks are made idempotent by the Executor's compare-and-set, not here (Requirement 6.6).
export async function POST(req: Request): Promise<Response> {
  const verified = await verifiedBody(req);
  if (!verified.ok) return verified.response;

  // Tier 3 approve opens the confirm modal now: its trigger_id would expire before the worker ran.
  const click = confirmClick(verified.raw);
  if (click) {
    await openTier3Confirm(getDb(), chat(), click).catch((err: unknown) => logger.error({ err, changeset_id: click.changesetId }, 'failed to open confirm modal'));
  }

  const job = interactionJob(verified.raw);
  if (job) await enqueue(await getBoss(), Jobs.chatInteraction, job);
  return new Response(null, { status: 200 });
}

import { enqueue, Jobs } from '@arlo/queue';
import { getBoss } from '../../../../lib/queue';
import { interactionJob, verifiedBody } from '../../../../lib/slack';

export const dynamic = 'force-dynamic';

// Slack interactivity (buttons, modals): verify, enqueue, ack within 3 seconds (Requirement 7.7).
// Repeated clicks are made idempotent by the Executor's compare-and-set, not here (Requirement 6.6).
export async function POST(req: Request): Promise<Response> {
  const verified = await verifiedBody(req);
  if (!verified.ok) return verified.response;

  const job = interactionJob(verified.raw);
  if (job) await enqueue(await getBoss(), Jobs.chatInteraction, job);
  return new Response(null, { status: 200 });
}

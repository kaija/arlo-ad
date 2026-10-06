import { markSlackEventSeen } from '@arlo/db';
import { enqueue, inTransaction, Jobs } from '@arlo/queue';
import { getBoss } from '../../../../lib/queue';
import { getDb, logger } from '../../../../lib/server';
import { mentionJob, parseEnvelope, verifiedBody } from '../../../../lib/slack';

export const dynamic = 'force-dynamic';

// Slack Events API: verify, de-duplicate by event_id, enqueue, ack within 3 seconds (Requirement 7.7).
export async function POST(req: Request): Promise<Response> {
  const verified = await verifiedBody(req);
  if (!verified.ok) return verified.response;

  const envelope = parseEnvelope(verified.raw);
  if (!envelope) return new Response('bad request', { status: 400 });
  if (envelope.type === 'url_verification') return Response.json({ challenge: envelope.challenge });

  const job = mentionJob(envelope);
  if (!job) return new Response(null, { status: 200 });

  const boss = await getBoss();
  // Seen-marker and job commit together: a failed enqueue leaves the retry unmarked.
  const queued = await getDb().transaction(async (tx) => {
    if (!(await markSlackEventSeen(tx, job.eventId))) return false;
    await enqueue(boss, Jobs.chatMention, job, inTransaction(tx));
    return true;
  });
  if (!queued) logger.info({ eventId: job.eventId }, 'duplicate Slack event ignored');
  return new Response(null, { status: 200 });
}

import { runHealthChecks } from '@arlo/core';
import { checkDatabase } from '@arlo/db';
import { getPool, logger } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { httpStatus, body } = await runHealthChecks({
    db: () => checkDatabase(getPool(), { logger }),
  });
  return Response.json(body, { status: httpStatus, headers: { 'cache-control': 'no-store' } });
}

// Health report shared by web `/api/healthz` and worker `:9090/healthz` (Requirement 20.8).
// The body is served publicly, so failures carry a short code only; details belong in logs.

export type CheckResult =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: string };

export type HealthCheck = () => Promise<CheckResult>;

export interface HealthReport {
  status: 'ok' | 'fail';
  checks: Record<string, CheckResult>;
}

export interface HealthResponse {
  httpStatus: 200 | 503;
  body: HealthReport;
}

export async function runHealthChecks(checks: Record<string, HealthCheck>): Promise<HealthResponse> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
      try {
        return [name, await check()];
      } catch {
        return [name, { ok: false, latencyMs: 0, error: 'check_threw' }];
      }
    }),
  );
  const ok = entries.every(([, result]) => result.ok);
  return {
    httpStatus: ok ? 200 : 503,
    body: { status: ok ? 'ok' : 'fail', checks: Object.fromEntries(entries) },
  };
}

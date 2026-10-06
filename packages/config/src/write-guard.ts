// Last line of defence against mutating a production account from dev (ADR-0026):
// the Executor calls assertWriteAllowed before every PlatformAdapter.applyOps.

/** Google Ads customer IDs are compared without dashes: "123-456-7890" → "1234567890". */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[\s-]/g, '');
}

const CUSTOMER_ID = /^\d{10}$/;

export type ParsedCustomerIds = { ok: true; ids: string[] } | { ok: false; invalidPositions: number[] };

/** Parses a comma-separated allowlist. Empty input means no account is writable. */
export function parseCustomerIds(raw: string): ParsedCustomerIds {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeCustomerId);
  const invalidPositions = entries.flatMap((id, i) => (CUSTOMER_ID.test(id) ? [] : [i + 1]));
  return invalidPositions.length ? { ok: false, invalidPositions } : { ok: true, ids: [...new Set(entries)] };
}

export class WriteNotAllowedError extends Error {
  readonly code = 'WRITE_NOT_ALLOWED';

  constructor(readonly customerId: string) {
    super(`Customer ${customerId} is not in ADS_WRITE_ALLOWED_CUSTOMER_IDS`);
    this.name = 'WriteNotAllowedError';
  }
}

export function assertWriteAllowed(allowed: readonly string[], customerId: string): void {
  const id = normalizeCustomerId(customerId);
  if (!allowed.includes(id)) throw new WriteNotAllowedError(id);
}

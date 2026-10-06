import { describe, expect, it } from 'vitest';
import { assertWriteAllowed, normalizeCustomerId, parseCustomerIds, WriteNotAllowedError } from './write-guard';

describe('assertWriteAllowed', () => {
  const allowed = ['1234567890', '1112223333'];

  it.each(['1234567890', '123-456-7890', ' 111-222-3333 '])('allows %j', (id) => {
    expect(() => assertWriteAllowed(allowed, id)).not.toThrow();
  });

  it('rejects an account outside the allowlist', () => {
    expect(() => assertWriteAllowed(allowed, '999-888-7777')).toThrow(WriteNotAllowedError);
    try {
      assertWriteAllowed(allowed, '999-888-7777');
    } catch (err) {
      expect(err).toMatchObject({ code: 'WRITE_NOT_ALLOWED', customerId: '9998887777' });
    }
  });

  it('rejects every account when the allowlist is empty', () => {
    expect(() => assertWriteAllowed([], '1234567890')).toThrow(WriteNotAllowedError);
  });

  it('does not match on prefixes or substrings', () => {
    expect(() => assertWriteAllowed(allowed, '123456789')).toThrow(WriteNotAllowedError);
    expect(() => assertWriteAllowed(allowed, '12345678901')).toThrow(WriteNotAllowedError);
  });
});

describe('parseCustomerIds', () => {
  it('reports all invalid positions', () => {
    expect(parseCustomerIds('abc,1234567890,1-2')).toEqual({ ok: false, invalidPositions: [1, 3] });
  });
});

describe('normalizeCustomerId', () => {
  it('strips dashes and whitespace', () => {
    expect(normalizeCustomerId(' 123-456 7890 ')).toBe('1234567890');
  });
});

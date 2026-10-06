import { describe, expect, it } from 'vitest';
import { formatChange, formatMoney, formatNumber, formatPct } from './format';

describe('format', () => {
  it('formats money per currency', () => {
    expect(formatMoney(12_345_600_000, 'TWD')).toBe('NT$12,346');
    expect(formatMoney(1_234_560_000, 'USD')).toBe('$1,234.56');
    expect(formatMoney(null, 'USD')).toBe('—');
  });

  it('formats ratios and changes', () => {
    expect(formatPct(0.1234)).toBe('12.3%');
    expect(formatChange(100, 112.5)).toBe('+12.5%');
    expect(formatChange(100, 80)).toBe('-20.0%');
    expect(formatChange(0, 5)).toBe('—');
    expect(formatNumber(1234.5, 1)).toBe('1,234.5');
  });
});

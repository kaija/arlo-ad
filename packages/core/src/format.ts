// Display formatting for chat and Web. Money arrives in micros of the account currency.

const ZERO_DECIMAL = new Set(['TWD', 'JPY', 'KRW', 'VND', 'IDR', 'CLP']);
const money = new Map<string, Intl.NumberFormat>();

export function formatMoney(micros: number | null | undefined, currency: string): string {
  if (micros === null || micros === undefined) return '—';
  let f = money.get(currency);
  if (!f) {
    const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
    f = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    money.set(currency, f);
  }
  return f.format(micros / 1_000_000);
}

export function formatPct(ratio: number | null | undefined, digits = 1): string {
  return ratio === null || ratio === undefined ? '—' : `${(ratio * 100).toFixed(digits)}%`;
}

/** Relative change a → b as a signed percentage, e.g. "+12.5%". */
export function formatChange(before: number | null | undefined, after: number | null | undefined): string {
  if (before === null || before === undefined || after === null || after === undefined || before === 0) return '—';
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

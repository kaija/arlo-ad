// Month-end spend forecast (Requirement 18.1): recent daily run-rate with day-of-week
// seasonality, plus the plain linear projection for comparison.
import { addDays, daysInMonth } from '../time';

export interface DailySpend {
  date: string; // YYYY-MM-DD
  costMicros: number;
}

export interface PacingInput {
  /** Today in the account timezone. */
  today: string;
  /** Daily spend history, ideally the last 28+ days including the month so far and today. */
  history: DailySpend[];
  /** Today's spend so far (also counted in MTD). Defaults to the history row for today. */
  todaySoFarMicros?: number;
  /** Sum of current daily budgets, used for the budget-based pace. */
  dailyBudgetMicros?: number | null;
}

export interface PacingResult {
  mtdMicros: number;
  /** Forecast month total: run-rate × weekday factors for the remaining days. */
  projectedMicros: number;
  /** MTD / completed days × days in month. */
  linearProjectedMicros: number;
  /** De-seasonalized daily run-rate from the last 7 completed days. */
  dailyRateMicros: number;
  /** Spend relative to the average day, indexed by getUTCDay() (0 = Sunday). */
  weekdayFactors: number[];
  daysElapsed: number;
  daysInMonth: number;
  /** Month-to-date spend over budget × elapsed days; null without a budget. */
  budgetPace: number | null;
}

const RATE_DAYS = 7;
const SEASONALITY_DAYS = 28;
const MIN_SEASONALITY_DAYS = 14;

export const weekday = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
};

/** Average spend per weekday over the window relative to the overall average; flat when data is thin. */
export function weekdayFactors(history: DailySpend[], today: string): number[] {
  const window = history.filter((h) => h.date < today && h.date >= addDays(today, -SEASONALITY_DAYS));
  const total = window.reduce((s, h) => s + h.costMicros, 0);
  if (window.length < MIN_SEASONALITY_DAYS || total <= 0) return Array(7).fill(1);
  const mean = total / window.length;
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  for (const h of window) {
    sums[weekday(h.date)] += h.costMicros;
    counts[weekday(h.date)]++;
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] / mean : 1));
}

export function forecastMonthSpend(input: PacingInput): PacingResult {
  const { today } = input;
  const monthStart = `${today.slice(0, 8)}01`;
  const dim = daysInMonth(today);
  const dayOfMonth = Number(today.slice(8, 10));
  const byDate = new Map(input.history.map((h) => [h.date, h.costMicros]));
  const todaySoFar = input.todaySoFarMicros ?? byDate.get(today) ?? 0;

  let completed = 0;
  for (let d = monthStart; d < today; d = addDays(d, 1)) completed += byDate.get(d) ?? 0;
  const mtd = completed + todaySoFar;
  const daysElapsed = dayOfMonth - 1;

  const factors = weekdayFactors(input.history, today);
  const recent: number[] = [];
  for (let i = 1; i <= RATE_DAYS; i++) {
    const d = addDays(today, -i);
    if (byDate.has(d)) recent.push(byDate.get(d)! / factors[weekday(d)]!);
  }
  const rate = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : daysElapsed ? completed / daysElapsed : todaySoFar;

  let remaining = Math.max(todaySoFar, rate * factors[weekday(today)]!);
  for (let d = addDays(today, 1); d.slice(0, 7) === today.slice(0, 7); d = addDays(d, 1)) remaining += rate * factors[weekday(d)]!;

  const budget = input.dailyBudgetMicros ?? null;
  const budgetPace = budget && budget > 0 ? mtd / (budget * Math.max(daysElapsed + 1, 1)) : null;

  return {
    mtdMicros: Math.round(mtd),
    projectedMicros: Math.round(completed + remaining),
    linearProjectedMicros: Math.round(daysElapsed ? (completed / daysElapsed) * dim : todaySoFar * dim),
    dailyRateMicros: Math.round(rate),
    weekdayFactors: factors,
    daysElapsed,
    daysInMonth: dim,
    budgetPace,
  };
}

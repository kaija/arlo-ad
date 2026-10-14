// Automation modes and shadow accuracy (ADR-0013, Requirements 9.1, 9.5).
import { AUTOMATION_FEATURES, AUTOMATION_MODES, DEFAULT_AUTOMATION_MODE, type AutomationFeature, type AutomationMode } from '@arlo/core';
import { listAutomationModes, resolveAccounts, shadowAccuracy, type AdAccount, type DbOrTx } from '@arlo/db';

export function isMode(v: unknown): v is AutomationMode {
  return (AUTOMATION_MODES as readonly unknown[]).includes(v);
}
export function isFeature(v: unknown): v is AutomationFeature {
  return (AUTOMATION_FEATURES as readonly unknown[]).includes(v);
}

export interface FeatureCell {
  mode: AutomationMode;
  simulated: number;
  judged: number;
  correct: number;
  /** correct / judged; null before anyone voted. */
  accuracy: number | null;
}

export interface AutomationRow {
  account: AdAccount;
  features: Record<AutomationFeature, FeatureCell>;
}

export async function loadAutomation(db: DbOrTx, allowed: readonly string[] | null): Promise<{ rows: AutomationRow[]; totals: Record<AutomationFeature, Omit<FeatureCell, 'mode'>> }> {
  const accounts = await resolveAccounts(db, { allowed });
  const [modes, accuracy] = await Promise.all([listAutomationModes(db), shadowAccuracy(db, { accountIds: accounts.map((a) => a.id) })]);
  const stats = new Map(accuracy.map((r) => [`${r.accountId}:${r.feature}`, r]));
  const empty = () => ({ simulated: 0, judged: 0, correct: 0, accuracy: null as number | null });
  const totals = Object.fromEntries(AUTOMATION_FEATURES.map((f) => [f, empty()])) as Record<AutomationFeature, Omit<FeatureCell, 'mode'>>;
  const rows = accounts.map((account) => {
    const features = {} as Record<AutomationFeature, FeatureCell>;
    for (const f of AUTOMATION_FEATURES) {
      const s = stats.get(`${account.id}:${f}`);
      const cell = { simulated: s?.simulated ?? 0, judged: s?.judged ?? 0, correct: s?.correct ?? 0 };
      features[f] = { mode: modes.get(`${account.id}:${f}`) ?? DEFAULT_AUTOMATION_MODE, ...cell, accuracy: cell.judged ? cell.correct / cell.judged : null };
      const t = totals[f];
      t.simulated += cell.simulated;
      t.judged += cell.judged;
      t.correct += cell.correct;
      t.accuracy = t.judged ? t.correct / t.judged : null;
    }
    return { account, features };
  });
  return { rows, totals };
}

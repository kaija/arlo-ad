// Tracking health page (Requirement 18.7): conversion action health, GA4 gap, recent anomalies.
import { addDays, assessTracking, dateInTimeZone, ga4Gap, type ConversionActionHealthInput } from '@arlo/core';
import { conversionGapSeries, listAnomalies, listConversionActions, type AdAccount, type DbOrTx } from '@arlo/db';

export async function loadTracking(db: DbOrTx, account: AdAccount, now: Date) {
  const today = dateInTimeZone(now, account.timezone);
  const actions = await listConversionActions(db, account.id);
  const health = assessTracking(
    actions.map((a) => ({ ...a, ecDiagnostics: (a.ecDiagnostics ?? null) as ConversionActionHealthInput['ecDiagnostics'] })),
    now,
  );
  const series = account.ga4PropertyId ? await conversionGapSeries(db, account, addDays(today, -17), addDays(today, -1)) : [];
  const gap = account.ga4PropertyId ? ga4Gap(series) : null;
  const anomalies = await listAnomalies(db, { accountIds: [account.id], since: addDays(today, -14), limit: 30 });
  return { health, gap, series, anomalies, categories: new Map(actions.map((a) => [a.externalId, a.category])) };
}

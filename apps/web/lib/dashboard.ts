// Dashboard query layer (Requirement 18.1, 18.2): reads Postgres only (Requirement 2.8).
import { addDays, dateInTimeZone, deriveMetrics, forecastMonthSpend, type DerivedMetrics } from '@arlo/core';
import {
  dailySpend,
  listCampaigns,
  listChangeEvents,
  listExecutedChangeSets,
  queryMetrics,
  resolveAccounts,
  type AdAccount,
  type CampaignRow,
  type Db,
  type MetricsRow,
} from '@arlo/db';

export interface AccountOverview {
  account: Pick<AdAccount, 'id' | 'name' | 'externalId' | 'currency' | 'timezone'>;
  today: string;
  monthStart: string;
  mtdMicros: number;
  projectedMicros: number;
  linearProjectedMicros: number;
  dailyRateMicros: number;
  enabledBudgetMicros: number;
  budgetPace: number | null;
  /** MonthlySpendCap (Requirement 5.5); null when no cap rule applies. */
  monthlyCapMicros: number | null;
  daysElapsed: number;
  daysInMonth: number;
}

export async function accountOverviews(db: Db, opts: { allowed: readonly string[] | null; account?: string | null; now: Date }): Promise<AccountOverview[]> {
  const accounts = await resolveAccounts(db, { allowed: opts.allowed, account: opts.account });
  return Promise.all(
    accounts.map(async (account) => {
      const today = dateInTimeZone(opts.now, account.timezone);
      const [history, campaigns] = await Promise.all([dailySpend(db, [account.id], addDays(today, -35), today), listCampaigns(db, [account.id])]);
      const enabledBudgetMicros = campaigns.filter((c) => c.status === 'ENABLED').reduce((s, c) => s + (c.budgetMicros ?? 0), 0);
      const f = forecastMonthSpend({ today, history, dailyBudgetMicros: enabledBudgetMicros || null });
      return {
        account: { id: account.id, name: account.name, externalId: account.externalId, currency: account.currency, timezone: account.timezone },
        today,
        monthStart: `${today.slice(0, 8)}01`,
        mtdMicros: f.mtdMicros,
        projectedMicros: f.projectedMicros,
        linearProjectedMicros: f.linearProjectedMicros,
        dailyRateMicros: f.dailyRateMicros,
        enabledBudgetMicros,
        budgetPace: f.budgetPace,
        monthlyCapMicros: null,
        daysElapsed: f.daysElapsed,
        daysInMonth: f.daysInMonth,
      };
    }),
  );
}

export interface CampaignTableRow extends DerivedMetrics {
  campaignId: string;
  externalId: string;
  name: string | null;
  status: string | null;
  budgetMicros: number | null;
  bidStrategy: string | null;
  bidTarget: number | null;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
  searchIs: number | null;
  lostIsBudget: number | null;
  lostIsRank: number | null;
}

/** Every non-removed campaign with its metrics over the range (zeros when it did not serve). */
export async function campaignTable(db: Db, opts: { accountId: string; from: string; to: string }): Promise<CampaignTableRow[]> {
  const [campaigns, metrics] = await Promise.all([
    listCampaigns(db, [opts.accountId]),
    queryMetrics(db, { accountIds: [opts.accountId], level: 'campaign', from: opts.from, to: opts.to, groupBy: 'entity', limit: 1000 }),
  ]);
  const byId = new Map<string, MetricsRow>(metrics.map((m) => [m.entityId!, m]));
  const empty = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0, searchIs: null, lostIsBudget: null, lostIsRank: null };
  return campaigns
    .map((c: CampaignRow) => {
      const m = byId.get(c.campaignId) ?? empty;
      return {
        campaignId: c.campaignId,
        externalId: c.externalId,
        name: c.name,
        status: c.status,
        budgetMicros: c.budgetMicros,
        bidStrategy: c.bidStrategy,
        bidTarget: c.bidTarget,
        costMicros: m.costMicros,
        impressions: m.impressions,
        clicks: m.clicks,
        conversions: m.conversions,
        convValue: m.convValue,
        searchIs: m.searchIs,
        lostIsBudget: m.lostIsBudget,
        lostIsRank: m.lostIsRank,
        ...deriveMetrics(m),
      };
    })
    .sort((a, b) => b.costMicros - a.costMicros);
}

export interface TrendPoint extends DerivedMetrics {
  date: string;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions: number;
  convValue: number;
}

export interface TrendMarker {
  /** Calendar date in the account timezone, to place the marker on the daily axis. */
  date: string;
  at: string;
  kind: 'change_event' | 'changeset';
  label: string;
  actor: string | null;
  changesetId?: string;
}

/** Daily series for an account or one campaign, with change markers (Requirement 18.2). */
export async function trend(db: Db, opts: { account: AdAccount; from: string; to: string; campaignId?: string; externalCampaignId?: string }): Promise<{ points: TrendPoint[]; markers: TrendMarker[] }> {
  const level = opts.campaignId ? 'campaign' : 'account';
  const rows = await queryMetrics(db, {
    accountIds: [opts.account.id],
    level,
    from: opts.from,
    to: opts.to,
    entityIds: opts.campaignId ? [opts.campaignId] : undefined,
    groupBy: 'day',
  });
  const byDate = new Map(rows.map((r) => [r.date!, r]));
  const points: TrendPoint[] = [];
  for (let d = opts.from; d <= opts.to; d = addDays(d, 1)) {
    const r = byDate.get(d) ?? { costMicros: 0, clicks: 0, impressions: 0, conversions: 0, convValue: 0 };
    points.push({ date: d, costMicros: r.costMicros, clicks: r.clicks, impressions: r.impressions, conversions: r.conversions, convValue: r.convValue, ...deriveMetrics(r) });
  }
  const events = await listChangeEvents(db, {
    accountIds: [opts.account.id],
    // Widen by a day on each side: account-local dates vs UTC instants.
    from: new Date(`${addDays(opts.from, -1)}T00:00:00Z`),
    to: new Date(`${addDays(opts.to, 2)}T00:00:00Z`),
    resourceContains: opts.externalCampaignId,
    limit: 500,
  });
  const changesets = await listExecutedChangeSets(db, opts.account.id, new Date(`${addDays(opts.from, -1)}T00:00:00Z`), new Date(`${addDays(opts.to, 2)}T00:00:00Z`));
  const markers: TrendMarker[] = [
    ...events.map((e) => ({
      date: dateInTimeZone(e.changedAt, opts.account.timezone),
      at: e.changedAt.toISOString(),
      kind: 'change_event' as const,
      label: `${e.resourceType ?? 'CHANGE'} ${e.changedFields.join(', ')}`.trim(),
      actor: e.userEmail ?? e.clientType,
    })),
    ...changesets
      .filter((cs) => !opts.externalCampaignId || cs.ops.some((op) => op.target.kind === 'campaign' && op.target.id === opts.externalCampaignId))
      .map((cs) => ({
        date: dateInTimeZone(cs.executedAt!, opts.account.timezone),
        at: cs.executedAt!.toISOString(),
        kind: 'changeset' as const,
        label: `ChangeSet：${cs.summary}`,
        actor: cs.status === 'REVERTED' ? 'Arlo（已還原）' : 'Arlo',
        changesetId: cs.id,
      })),
  ]
    .filter((m) => m.date >= opts.from && m.date <= opts.to)
    .sort((a, b) => a.at.localeCompare(b.at));
  return { points, markers };
}

// Options shared by settings pages (pages cannot export helpers).
import { firingCounts, listCampaigns, listMonitorRules, resolveAccounts, type Db } from '@arlo/db';

export async function ruleFormOptions(db: Db) {
  const accounts = await resolveAccounts(db, { allowed: null });
  const campaigns = await listCampaigns(db, accounts.map((a) => a.id));
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    campaigns: campaigns.map((c) => ({ id: c.campaignId, accountId: c.accountId, name: c.name ?? c.externalId })),
  };
}

/** Monitor rules within the user's accounts, with names and firings over the last 7 days. */
export async function monitorPageData(db: Db, allowed: readonly string[] | null, now = new Date()) {
  const accounts = await resolveAccounts(db, { allowed });
  const ids = new Set(accounts.map((a) => a.id));
  const [rules, campaigns, counts] = await Promise.all([listMonitorRules(db), listCampaigns(db, [...ids]), firingCounts(db, new Date(now.getTime() - 7 * 86_400_000))]);
  return {
    rules: rules.filter((r) => ids.has(r.accountId)),
    accountName: new Map(accounts.map((a) => [a.id, a.name])),
    campaignName: new Map(campaigns.map((c) => [c.campaignId, c.name ?? c.externalId])),
    counts,
  };
}

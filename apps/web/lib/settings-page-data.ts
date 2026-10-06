// Options shared by settings pages (pages cannot export helpers).
import { listCampaigns, resolveAccounts, type Db } from '@arlo/db';

export async function ruleFormOptions(db: Db) {
  const accounts = await resolveAccounts(db, { allowed: null });
  const campaigns = await listCampaigns(db, accounts.map((a) => a.id));
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    campaigns: campaigns.map((c) => ({ id: c.campaignId, accountId: c.accountId, name: c.name ?? c.externalId })),
  };
}

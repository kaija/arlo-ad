// GoogleAdsAdapter (ADR-0004): reads through GAQL (queries.ts), maps rows (mappers.ts),
// writes one mutate request per op (mutations.ts) behind the write allowlist (ADR-0026).
import { assertWriteAllowed, normalizeCustomerId } from '@arlo/config';
import {
  addDays,
  dateInTimeZone,
  dateTimeInTimeZone,
  entityKey,
  type CurrentState,
  type EntityKind,
  type EntityRef,
  type Op,
  type OpResult,
} from '@arlo/core';
import { currentFromRecord } from '../current';
import type {
  AccountInfo,
  AudienceRow,
  BudgetSimRow,
  ChangeEventRow,
  ConversionActionRow,
  DateRange,
  EntityRecord,
  GoogleAdsPlatform,
  KeywordIdea,
  MetricRow,
  MetricsQuery,
  SearchTermRow,
} from '../types';
import type { GoogleAdsClient } from './client';
import * as M from './mappers';
import { buildMutation, campaignsNeedingContext, mapCampaignWriteContext, mutateErrorMessage, resultResourceName, type CampaignWriteContext } from './mutations';
import * as Q from './queries';

export interface GoogleAdsAdapterOptions {
  loginCustomerId: string;
  /** ADS_WRITE_ALLOWED_CUSTOMER_IDS; empty means applyOps refuses every account. */
  writeAllowedCustomerIds: readonly string[];
  now?: () => Date;
}

// Google Ads keeps change_event for 30 days; stay just inside the window.
const CHANGE_HISTORY_DAYS = 29;
const CHANGE_EVENT_PAGE = 10_000;

export class GoogleAdsAdapter implements GoogleAdsPlatform {
  readonly platform = 'google_ads' as const;
  private readonly loginCustomerId: string;
  private readonly writeAllowed: readonly string[];
  private readonly now: () => Date;
  private readonly timeZones = new Map<string, string>();

  constructor(
    private readonly client: GoogleAdsClient,
    opts: GoogleAdsAdapterOptions,
  ) {
    this.loginCustomerId = opts.loginCustomerId.replace(/-/g, '');
    this.writeAllowed = opts.writeAllowedCustomerIds.map(normalizeCustomerId);
    this.now = opts.now ?? (() => new Date());
  }

  async listAccounts(): Promise<AccountInfo[]> {
    return M.mapAccessibleAccounts(await this.client.query(this.loginCustomerId, Q.ACCESSIBLE_ACCOUNTS));
  }

  async fetchEntities(accountId: string, kinds: EntityKind[]): Promise<EntityRecord[]> {
    const out: EntityRecord[] = [];
    for (const kind of new Set(kinds)) {
      switch (kind) {
        case 'account': {
          const [row] = await this.client.query(accountId, Q.CUSTOMER);
          if (row) out.push(M.mapAccountEntity(row));
          break;
        }
        case 'campaign':
          out.push(...M.mapCampaigns(await this.client.query(accountId, Q.CAMPAIGNS)));
          break;
        case 'ad_group':
          out.push(...M.mapAdGroups(await this.client.query(accountId, Q.AD_GROUPS)));
          break;
        case 'keyword':
          out.push(...M.mapKeywords(await this.client.query(accountId, Q.KEYWORDS)));
          break;
        case 'shared_set':
          out.push(...M.mapSharedSets(await this.client.query(accountId, Q.NEGATIVE_SHARED_SETS)));
          break;
        case 'campaign_budget':
          out.push(...M.mapCampaignBudgets(await this.client.query(accountId, Q.CAMPAIGN_BUDGETS)));
          break;
      }
    }
    return out;
  }

  async fetchMetrics(q: MetricsQuery): Promise<MetricRow[]> {
    const rows = await this.client.query(q.accountId, Q.metrics(q.level, q.range, q.hourly));
    return M.mapMetrics(q.level, rows, q.hourly);
  }

  async fetchChangeHistory(accountId: string, since: Date): Promise<ChangeEventRow[]> {
    const tz = await this.timeZone(accountId);
    const now = this.now();
    const floor = new Date(now.getTime() - CHANGE_HISTORY_DAYS * 86_400_000);
    let from = since > floor ? since : floor;
    const until = dateTimeInTimeZone(now, tz);
    const seen = new Map<string, ChangeEventRow>();
    // Pages by time: a full page restarts from its last change time (overlap is de-duplicated).
    for (;;) {
      const rows = await this.client.query(accountId, Q.changeEvents(dateTimeInTimeZone(from, tz), until, CHANGE_EVENT_PAGE));
      const mapped = M.mapChangeEvents(rows, tz);
      for (const e of mapped) seen.set(e.externalId, e);
      const last = mapped.at(-1);
      if (rows.length < CHANGE_EVENT_PAGE || !last || last.changedAt.getTime() <= from.getTime()) break;
      from = last.changedAt;
    }
    return [...seen.values()];
  }

  async fetchCurrent(refs: EntityRef[]): Promise<Map<string, CurrentState>> {
    const out = new Map<string, CurrentState>();
    const byAccount = new Map<string, EntityRef[]>();
    for (const ref of refs) byAccount.set(ref.accountId, [...(byAccount.get(ref.accountId) ?? []), ref]);

    for (const [accountId, accountRefs] of byAccount) {
      const key = (kind: EntityKind, id: string) => entityKey({ platform: 'google_ads', accountId, kind, id });
      const idsOf = (kind: EntityKind) => [...new Set(accountRefs.filter((r) => r.kind === kind).map((r) => r.id))];

      const campaigns = idsOf('campaign');
      if (campaigns.length) {
        for (const row of await this.client.query(accountId, Q.currentCampaigns(campaigns))) {
          out.set(key('campaign', String(row.campaign?.id)), M.currentFromCampaignRow(row));
        }
      }
      const adGroups = idsOf('ad_group');
      if (adGroups.length) {
        for (const r of M.mapAdGroups(await this.client.query(accountId, Q.currentAdGroups(adGroups)))) {
          out.set(key('ad_group', r.externalId), currentFromRecord(r));
        }
      }
      const keywords = idsOf('keyword').map((id) => id.split('~') as [string, string]);
      if (keywords.length) {
        const wanted = new Set(keywords.map(([a, c]) => `${a}~${c}`));
        const rows = await this.client.query(
          accountId,
          Q.currentKeywords([...new Set(keywords.map(([a]) => a))], [...new Set(keywords.map(([, c]) => c))]),
        );
        for (const r of M.mapKeywords(rows)) if (wanted.has(r.externalId)) out.set(key('keyword', r.externalId), currentFromRecord(r));
      }
    }
    return out;
  }

  /**
   * Applies ops in order, one mutate request each, so a failure leaves earlier ops applied and
   * reports per-op results (Requirement 3.5). Throws WriteNotAllowedError before any request when
   * the account is not on the allowlist.
   */
  async applyOps(accountId: string, ops: Op[]): Promise<OpResult[]> {
    const customerId = normalizeCustomerId(accountId);
    assertWriteAllowed(this.writeAllowed, customerId);

    let campaigns = new Map<string, CampaignWriteContext>();
    // Invalid ids are left out here and rejected per op by buildMutation.
    const needed = campaignsNeedingContext(ops.filter((op) => op.target.kind === 'campaign')).filter((id) => /^\d+$/.test(id));
    if (needed.length) {
      try {
        campaigns = mapCampaignWriteContext(await this.client.query(customerId, Q.campaignWriteContext(needed)));
      } catch (err) {
        const error = `CONTEXT_LOOKUP_FAILED: ${mutateErrorMessage(err)}`;
        return ops.map((_, index) => ({ index, ok: false, error }));
      }
    }

    const results: OpResult[] = [];
    for (const [index, op] of ops.entries()) {
      try {
        if (normalizeCustomerId(op.target.accountId) !== customerId) throw new Error('ACCOUNT_MISMATCH: op target is in another account');
        const mutation = buildMutation(customerId, op, campaigns);
        assertWriteAllowed(this.writeAllowed, customerId);
        const response = await this.client.mutate(customerId, [mutation]);
        results.push({ index, ok: true, resourceName: resultResourceName(response.mutate_operation_responses?.[0]) });
      } catch (err) {
        results.push({ index, ok: false, error: mutateErrorMessage(err) });
      }
    }
    return results;
  }

  async fetchSearchTerms(accountId: string, range: DateRange): Promise<SearchTermRow[]> {
    return M.mapSearchTerms(await this.client.query(accountId, Q.searchTerms(range)));
  }

  async fetchConversionActions(accountId: string): Promise<ConversionActionRow[]> {
    const tz = await this.timeZone(accountId);
    const today = dateInTimeZone(this.now(), tz);
    const [actions, activity, uploads] = await Promise.all([
      this.client.query(accountId, Q.CONVERSION_ACTIONS),
      this.client.query(accountId, Q.conversionActivity({ from: addDays(today, -30), to: today })),
      // Only accounts that upload conversions have summaries; diagnostics are best effort.
      this.client.query(accountId, Q.CONVERSION_UPLOAD_SUMMARIES).catch(() => []),
    ]);
    return M.mapConversionActions(actions, activity, uploads, tz);
  }

  async fetchUserListMetrics(accountId: string, range: DateRange): Promise<AudienceRow[]> {
    const [rows, lists] = await Promise.all([
      this.client.query(accountId, Q.userListMetrics(range)),
      this.client.query(accountId, Q.USER_LISTS),
    ]);
    return M.mapUserListMetrics(rows, lists);
  }

  async fetchBudgetSimulations(accountId: string, campaignIds: string[]): Promise<BudgetSimRow[]> {
    if (campaignIds.length === 0) return [];
    return M.mapBudgetSimulations(await this.client.query(accountId, Q.budgetSimulations(campaignIds)));
  }

  async generateKeywordIdeas(): Promise<KeywordIdea[]> {
    throw new Error('generateKeywordIdeas is not implemented yet (task 21.1)');
  }

  private async timeZone(accountId: string): Promise<string> {
    let tz = this.timeZones.get(accountId);
    if (!tz) {
      const [row] = await this.client.query(accountId, Q.CUSTOMER);
      tz = row?.customer?.time_zone ?? 'UTC';
      this.timeZones.set(accountId, tz);
    }
    return tz;
  }
}

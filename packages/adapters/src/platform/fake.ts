// In-memory PlatformAdapter for Executor and sync integration tests (ADR-0004). Tests seed
// state, inject drift (someone else's change) and errors, and inspect applied ops.
import { entityKey, type CurrentState, type EntityKind, type EntityRef, type Op, type OpResult } from '@arlo/core';
import { currentFromRecord } from './current';
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
} from './types';

type Method = Exclude<keyof GoogleAdsPlatform, 'platform'>;

interface AccountState {
  info: AccountInfo;
  entities: Map<string, EntityRecord>; // `${kind}:${externalId}`
  metrics: MetricRow[];
  changeEvents: ChangeEventRow[];
  searchTerms: SearchTermRow[];
  conversionActions: ConversionActionRow[];
  audience: AudienceRow[];
  budgetSims: BudgetSimRow[];
  keywordIdeas: KeywordIdea[];
  negatives: Map<string, { text: string; matchType: string }[]>; // by target entity id
  audienceModifiers: Map<string, number | 'excluded'>; // `${campaignId}:${userListId}`
}

const inRange = (date: string, range: DateRange) => date >= range.from && date <= range.to;
const clone = <T>(value: T): T => structuredClone(value);

export class FakePlatformAdapter implements GoogleAdsPlatform {
  readonly platform = 'google_ads' as const;
  /** Every applyOps call, in order. */
  readonly applied: { accountId: string; ops: Op[]; results: OpResult[] }[] = [];
  readonly calls: Partial<Record<Method, number>> = {};

  private readonly accounts = new Map<string, AccountState>();
  private readonly failures = new Map<Method, Error[]>();
  private opFailure: ((op: Op, index: number) => string | undefined) | undefined;
  private seq = 0;
  private clock: () => Date = () => new Date();

  // --- seeding -------------------------------------------------------------------------

  addAccount(info: AccountInfo): this {
    this.accounts.set(info.externalId, {
      info,
      entities: new Map(),
      metrics: [],
      changeEvents: [],
      searchTerms: [],
      conversionActions: [],
      audience: [],
      budgetSims: [],
      keywordIdeas: [],
      negatives: new Map(),
      audienceModifiers: new Map(),
    });
    return this;
  }

  addEntities(accountId: string, records: EntityRecord[]): this {
    const account = this.account(accountId);
    for (const r of records) account.entities.set(`${r.kind}:${r.externalId}`, clone(r));
    return this;
  }

  addMetrics(accountId: string, rows: MetricRow[]): this {
    this.account(accountId).metrics.push(...clone(rows));
    return this;
  }

  /** Replaces rows with the same (level, entity, date, hour), e.g. to simulate conversion backfill. */
  replaceMetrics(accountId: string, rows: MetricRow[]): this {
    const account = this.account(accountId);
    const key = (r: MetricRow) => `${r.level}:${r.externalId}:${r.date}:${r.hour ?? ''}`;
    const replaced = new Set(rows.map(key));
    account.metrics = [...account.metrics.filter((r) => !replaced.has(key(r))), ...clone(rows)];
    return this;
  }

  addChangeEvents(accountId: string, rows: ChangeEventRow[]): this {
    this.account(accountId).changeEvents.push(...clone(rows));
    return this;
  }

  setSearchTerms(accountId: string, rows: SearchTermRow[]): this {
    this.account(accountId).searchTerms = clone(rows);
    return this;
  }

  setConversionActions(accountId: string, rows: ConversionActionRow[]): this {
    this.account(accountId).conversionActions = clone(rows);
    return this;
  }

  setAudienceRows(accountId: string, rows: AudienceRow[]): this {
    this.account(accountId).audience = clone(rows);
    return this;
  }

  setBudgetSimulations(accountId: string, rows: BudgetSimRow[]): this {
    this.account(accountId).budgetSims = clone(rows);
    return this;
  }

  setKeywordIdeas(accountId: string, ideas: KeywordIdea[]): this {
    this.account(accountId).keywordIdeas = clone(ideas);
    return this;
  }

  setClock(now: () => Date): this {
    this.clock = now;
    return this;
  }

  // --- fault injection -----------------------------------------------------------------

  /** The next call to `method` rejects with `error` (queued; one error per call). */
  failNext(method: Method, error: Error = new Error(`${method} failed`)): this {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
    return this;
  }

  /** Ops for which `fn` returns a message fail with it; the others still apply. */
  failOps(fn: ((op: Op, index: number) => string | undefined) | undefined): this {
    this.opFailure = fn;
    return this;
  }

  /** Someone else changes an entity outside the system (ADR-0009 drift). */
  drift(ref: EntityRef, change: { status?: string; budgetMicros?: number; bidTarget?: number }, userEmail = 'someone@example.com'): this {
    const record = this.entity(ref);
    if (!record) throw new Error(`unknown entity ${entityKey(ref)}`);
    const old = currentFromRecord(record);
    if (change.status !== undefined) record.status = change.status;
    if (record.state) {
      if (change.budgetMicros !== undefined) record.state.budgetMicros = change.budgetMicros;
      if (change.bidTarget !== undefined) record.state.bidTarget = change.bidTarget;
    }
    this.recordChange(ref, userEmail, 'GOOGLE_ADS_WEB_CLIENT', old, currentFromRecord(record));
    return this;
  }

  // --- inspection ----------------------------------------------------------------------

  entity(ref: EntityRef): EntityRecord | undefined {
    return this.accounts.get(ref.accountId)?.entities.get(`${ref.kind}:${ref.id}`);
  }

  negativesOf(accountId: string, targetId: string) {
    return this.account(accountId).negatives.get(targetId) ?? [];
  }

  audienceModifierOf(accountId: string, campaignId: string, userListId: string) {
    return this.account(accountId).audienceModifiers.get(`${campaignId}:${userListId}`);
  }

  // --- PlatformAdapter -----------------------------------------------------------------

  async listAccounts(): Promise<AccountInfo[]> {
    this.enter('listAccounts');
    return [...this.accounts.values()].map((a) => clone(a.info));
  }

  async fetchEntities(accountId: string, kinds: EntityKind[]): Promise<EntityRecord[]> {
    this.enter('fetchEntities');
    return [...this.account(accountId).entities.values()].filter((e) => kinds.includes(e.kind)).map(clone);
  }

  async fetchMetrics(q: MetricsQuery): Promise<MetricRow[]> {
    this.enter('fetchMetrics');
    return this.account(q.accountId)
      .metrics.filter((r) => r.level === q.level && inRange(r.date, q.range) && (r.hour !== undefined) === Boolean(q.hourly))
      .map(clone);
  }

  async fetchChangeHistory(accountId: string, since: Date): Promise<ChangeEventRow[]> {
    this.enter('fetchChangeHistory');
    return this.account(accountId)
      .changeEvents.filter((e) => e.changedAt >= since)
      .map(clone);
  }

  async fetchCurrent(refs: EntityRef[]): Promise<Map<string, CurrentState>> {
    this.enter('fetchCurrent');
    const out = new Map<string, CurrentState>();
    for (const ref of refs) {
      const record = this.entity(ref);
      if (record) out.set(entityKey(ref), currentFromRecord(record));
    }
    return out;
  }

  async applyOps(accountId: string, ops: Op[]): Promise<OpResult[]> {
    this.enter('applyOps');
    const results = ops.map((op, index): OpResult => {
      const error = this.opFailure?.(op, index);
      if (error) return { index, ok: false, error };
      try {
        return { index, ok: true, resourceName: this.apply(accountId, op) };
      } catch (err) {
        return { index, ok: false, error: (err as Error).message };
      }
    });
    this.applied.push({ accountId, ops: clone(ops), results: clone(results) });
    return results;
  }

  // --- GoogleAdsExtensions -------------------------------------------------------------

  async fetchSearchTerms(accountId: string, range: DateRange): Promise<SearchTermRow[]> {
    this.enter('fetchSearchTerms');
    return this.account(accountId).searchTerms.filter((r) => inRange(r.date, range)).map(clone);
  }

  async fetchConversionActions(accountId: string): Promise<ConversionActionRow[]> {
    this.enter('fetchConversionActions');
    return clone(this.account(accountId).conversionActions);
  }

  async fetchUserListMetrics(accountId: string, range: DateRange): Promise<AudienceRow[]> {
    this.enter('fetchUserListMetrics');
    return this.account(accountId).audience.filter((r) => inRange(r.date, range)).map(clone);
  }

  async fetchBudgetSimulations(accountId: string, campaignIds: string[]): Promise<BudgetSimRow[]> {
    this.enter('fetchBudgetSimulations');
    return this.account(accountId).budgetSims.filter((r) => campaignIds.includes(r.campaignExternalId)).map(clone);
  }

  async generateKeywordIdeas(accountId: string): Promise<KeywordIdea[]> {
    this.enter('generateKeywordIdeas');
    return clone(this.account(accountId).keywordIdeas);
  }

  // --- internals -----------------------------------------------------------------------

  private enter(method: Method) {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    const queued = this.failures.get(method);
    const error = queued?.shift();
    if (error) throw error;
  }

  private account(accountId: string): AccountState {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    return account;
  }

  private resourceName(ref: EntityRef, suffix = ref.id) {
    return `customers/${ref.accountId}/${ref.kind}s/${suffix}`;
  }

  private apply(accountId: string, op: Op): string {
    if (op.target.accountId !== accountId) throw new Error('op target is in another account');
    const account = this.account(accountId);
    const after = op.after as Record<string, unknown>;

    if (op.kind === 'google.create_campaign_bundle') {
      const id = String(9_000_000 + ++this.seq);
      const bundle = after as { name?: string; budgetMicros?: number };
      account.entities.set(`campaign:${id}`, {
        kind: 'campaign',
        externalId: id,
        name: bundle.name ?? `Campaign ${id}`,
        status: 'PAUSED',
        attrs: { bundle: clone(op.after) },
        state: { budgetMicros: bundle.budgetMicros ?? null, bidStrategy: null, bidTarget: null },
      });
      return `customers/${accountId}/campaigns/${id}`;
    }

    if (op.kind === 'google.add_negative_keyword') {
      const list = account.negatives.get(op.target.id) ?? [];
      const kw = after as { text: string; matchType: string };
      if (!list.some((n) => n.text === kw.text && n.matchType === kw.matchType)) list.push({ text: kw.text, matchType: kw.matchType });
      account.negatives.set(op.target.id, list);
      return this.resourceName(op.target, `${op.target.id}~${list.length}`);
    }

    if (op.kind === 'google.set_audience_bid_modifier' || op.kind === 'google.exclude_audience') {
      const { userListId, bidModifier } = after as { userListId: string; bidModifier?: number };
      account.audienceModifiers.set(`${op.target.id}:${userListId}`, op.kind === 'google.exclude_audience' ? 'excluded' : bidModifier!);
      return this.resourceName(op.target, `${op.target.id}~${userListId}`);
    }

    if (op.kind === 'google.add_keyword') {
      const id = `${op.target.id}~${9_000_000 + ++this.seq}`;
      const kw = after as { text: string; matchType: string };
      account.entities.set(`keyword:${id}`, {
        kind: 'keyword',
        externalId: id,
        parent: { kind: 'ad_group', externalId: op.target.id },
        name: kw.text,
        status: 'ENABLED',
        attrs: { matchType: kw.matchType },
      });
      return `customers/${accountId}/adGroupCriteria/${id}`;
    }

    const record = this.entity(op.target);
    if (!record) throw new Error(`RESOURCE_NOT_FOUND: ${entityKey(op.target)}`);
    const old = currentFromRecord(record);
    switch (op.kind) {
      case 'set_status':
        record.status = String(op.after);
        break;
      case 'set_budget':
        if (!record.state) throw new Error('entity has no budget');
        record.state.budgetMicros = Number(op.after);
        break;
      case 'set_bid_target':
        if (!record.state) throw new Error('entity has no bid target');
        record.state.bidTarget = Number(op.after);
        break;
    }
    this.recordChange(op.target, null, 'GOOGLE_ADS_API', old, currentFromRecord(record));
    return this.resourceName(op.target);
  }

  private recordChange(ref: EntityRef, userEmail: string | null, clientType: string, old: CurrentState, next: CurrentState) {
    const changedFields = Object.keys(next).filter((k) => old[k as keyof CurrentState] !== next[k as keyof CurrentState]);
    this.account(ref.accountId).changeEvents.push({
      externalId: `customers/${ref.accountId}/changeEvents/${++this.seq}`,
      changedAt: this.clock(),
      userEmail,
      clientType,
      resourceType: ref.kind.toUpperCase(),
      resourceName: this.resourceName(ref),
      changedFields,
      old,
      new: next,
    });
  }
}

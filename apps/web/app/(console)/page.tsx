import { addDays, formatMoney, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { CampaignTable } from '../../components/campaign-table';
import { AutoSubmitForm } from '../../components/client';
import { TrendChart } from '../../components/trend-chart';
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Progress, type Tone } from '../../components/ui';
import { accountOverviews, campaignTable, trend } from '../../lib/dashboard';
import { getDb } from '../../lib/server';
import { readableAccounts, requireUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

type Search = { account?: string; from?: string; to?: string; campaign?: string };
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const md = (date: string) => date.slice(5).replace('-', '/');

function StatCard({ label, value, hint, badge, children }: { label: string; value: string; hint: string; badge?: { tone: Tone; label: string }; children?: React.ReactNode }) {
  return (
    <div className="card card-sm flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta text-muted">{label}</span>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      </div>
      <span className="stat-value">{value}</span>
      <span className="text-meta text-faint">{hint}</span>
      {children}
    </div>
  );
}

// Overview (Requirement 18.1) and trend with change markers (Requirement 18.2).
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const allowed = readableAccounts(user);
  const accounts = await resolveAccounts(db, { allowed });
  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title="總覽" subtitle="尚無帳戶" />
        <EmptyState icon="waveform" title="沒有可檢視的帳戶">
          你的權限目前不包含任何廣告帳戶。帳戶會在第一次同步後出現；權限請聯絡 Admin 在「設定 / 使用者與權限」加入帳戶範圍。
        </EmptyState>
      </>
    );
  }
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0]!;
  const [overview] = await accountOverviews(db, { allowed, account: account.id, now: new Date() });
  const o = overview!;
  const from = isDate(params.from) ? params.from! : o.monthStart;
  const to = isDate(params.to) ? params.to! : o.today;
  const rows = await campaignTable(db, { accountId: account.id, from, to });
  const selected = rows.find((r) => r.campaignId === params.campaign);
  const trendFrom = addDays(to, -29) < from ? addDays(to, -29) : from;
  const series = await trend(db, { account, from: trendFrom, to, campaignId: selected?.campaignId, externalCampaignId: selected?.externalId });
  const cur = account.currency;
  const capUse = o.monthlyCapMicros ? o.projectedMicros / o.monthlyCapMicros : null;
  const overPace = o.budgetPace !== null && o.budgetPace > 1.1;
  const query = (extra: Record<string, string | undefined>) =>
    `/?${new URLSearchParams(Object.entries({ account: account.id, from, to, ...extra }).filter((e): e is [string, string] => !!e[1])).toString()}`;

  return (
    <>
      <PageHeader
        title="總覽"
        subtitle={`${account.name} · 金額以 ${cur}、時間以 ${account.timezone} 顯示`}
        actions={
          <AutoSubmitForm method="get" className="flex flex-wrap items-end gap-2.5">
            <input type="hidden" name="account" value={account.id} />
            {selected ? <input type="hidden" name="campaign" value={selected.campaignId} /> : null}
            <div className="w-40">
              <Input label="起" type="date" size="sm" name="from" defaultValue={from} max={to} />
            </div>
            <div className="w-40">
              <Input label="訖" type="date" size="sm" name="to" defaultValue={to} />
            </div>
          </AutoSubmitForm>
        }
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4">
        <StatCard label="本月至今花費" value={formatMoney(o.mtdMicros, cur)} hint={`第 ${o.daysElapsed + 1} 天 / ${o.daysInMonth} 天`}>
          <Progress value={(o.daysElapsed + 1) / o.daysInMonth} />
        </StatCard>
        <StatCard label="月底預測花費" value={formatMoney(o.projectedMicros, cur)} hint={`線性推估：${formatMoney(o.linearProjectedMicros, cur)} · 日均 ${formatMoney(o.dailyRateMicros, cur)}`} />
        <StatCard
          label="預算 pacing"
          value={formatPct(o.budgetPace, 1)}
          hint={`啟用中每日預算合計 ${formatMoney(o.enabledBudgetMicros, cur)} · 超過 110% 警示`}
          badge={o.budgetPace === null ? undefined : { tone: overPace ? 'warn' : 'ok', label: overPace ? '超速' : '正常' }}
        />
        <StatCard
          label="月預算上限"
          value={o.monthlyCapMicros ? formatMoney(o.monthlyCapMicros, cur) : '未設定'}
          hint={capUse === null ? '可在 Validator 規則設定月花費上限' : `預測使用率 ${formatPct(capUse, 1)}`}
          badge={capUse === null ? { tone: 'neutral', label: '未設定' } : capUse > 1 ? { tone: 'bad', label: '預計超支' } : capUse > 0.9 ? { tone: 'warn', label: '接近上限' } : { tone: 'ok', label: '正常' }}
        >
          {capUse === null ? null : <Progress value={capUse} tone={capUse > 1 ? 'danger' : 'success'} />}
        </StatCard>
      </div>

      <Card
        className="gap-5"
        title={selected ? `Campaign：${selected.name ?? selected.externalId}` : '帳戶整體趨勢'}
        subtitle={`${md(trendFrom)} – ${md(to)} · 虛線為變更事件`}
        action={selected ? <LinkButton size="sm" href={query({})}>← 回到帳戶整體</LinkButton> : null}
      >
        <TrendChart currency={cur} points={series.points} markers={series.markers} />
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="section-title">Campaign</h2>
          <span className="text-meta text-faint">
            {md(from)} – {md(to)} · 點名稱即以該 campaign 篩選趨勢圖
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">這段期間沒有 campaign 資料。</div>
        ) : (
          <CampaignTable rows={rows} currency={cur} selectedId={selected?.campaignId} hrefFor={(r) => query({ campaign: r.campaignId === selected?.campaignId ? undefined : r.campaignId })} />
        )}
      </div>
    </>
  );
}

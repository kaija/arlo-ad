import { addDays, formatMoney, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { CampaignTable } from '../../components/campaign-table';
import { TrendChart } from '../../components/trend-chart';
import { Card, inputClass, PageTitle, Stat } from '../../components/ui';
import { accountOverviews, campaignTable, trend } from '../../lib/dashboard';
import { getDb } from '../../lib/server';
import { readableAccounts, requireUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

type Search = { account?: string; from?: string; to?: string; campaign?: string };
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Overview (Requirement 18.1) and trend with change markers (Requirement 18.2).
export default async function OverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const allowed = readableAccounts(user);
  const accounts = await resolveAccounts(db, { allowed });
  if (accounts.length === 0) {
    return (
      <Card title="總覽">
        <p className="text-sm text-zinc-500">目前沒有你有權限檢視的廣告帳戶。帳戶會在第一次同步後出現；權限請洽 admin。</p>
      </Card>
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
  const query = (extra: Record<string, string | undefined>) =>
    `/?${new URLSearchParams(Object.entries({ account: account.id, from, to, ...extra }).filter((e): e is [string, string] => !!e[1])).toString()}`;

  return (
    <>
      <PageTitle
        actions={
          <form className="flex flex-wrap items-center gap-2" method="get">
            <select name="account" defaultValue={account.id} className={inputClass}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.externalId}）
                </option>
              ))}
            </select>
            <input type="date" name="from" defaultValue={from} className={inputClass} />
            <span className="text-zinc-400">–</span>
            <input type="date" name="to" defaultValue={to} className={inputClass} />
            <button className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">套用</button>
          </form>
        }
      >
        總覽 · {account.name}
      </PageTitle>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="本月至今花費" value={formatMoney(o.mtdMicros, cur)} hint={`第 ${o.daysElapsed + 1} / ${o.daysInMonth} 天`} />
        <Stat label="月底預測" value={formatMoney(o.projectedMicros, cur)} hint={`線性推估 ${formatMoney(o.linearProjectedMicros, cur)}`} />
        <Stat
          label="預算 pacing"
          value={formatPct(o.budgetPace, 0)}
          hint={`啟用中每日預算合計 ${formatMoney(o.enabledBudgetMicros, cur)}`}
          tone={o.budgetPace !== null && o.budgetPace > 1.1 ? 'warn' : undefined}
        />
        <Stat
          label="月預算上限"
          value={o.monthlyCapMicros ? formatMoney(o.monthlyCapMicros, cur) : '未設定'}
          hint={capUse === null ? '於規則設定 MonthlySpendCap' : `預測使用 ${formatPct(capUse, 0)}`}
          tone={capUse !== null && capUse > 1 ? 'bad' : capUse !== null && capUse > 0.9 ? 'warn' : undefined}
        />
      </div>

      <Card
        className="mb-4"
        title={selected ? `趨勢 · ${selected.name}` : '趨勢 · 帳戶'}
        actions={selected ? <a className="text-sm text-zinc-500 hover:underline" href={query({})}>顯示帳戶整體</a> : null}
      >
        <TrendChart
          currency={cur}
          points={series.points.map((p) => ({ date: p.date, cost: p.costMicros / 1e6, conversions: p.conversions, cpa: p.cpaMicros === null ? null : p.cpaMicros / 1e6 }))}
          markers={series.markers}
        />
        {series.markers.length ? (
          <ul className="mt-3 space-y-1 text-xs text-zinc-500">
            {series.markers.slice(-8).map((m) => (
              <li key={`${m.at}-${m.label}`}>
                <span className="text-red-500">▲</span> {m.date} {m.label}
                {m.actor ? ` · ${m.actor}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title={`Campaigns · ${from} – ${to}`}>
        <CampaignTable rows={rows} currency={cur} hrefFor={(r) => query({ campaign: r.campaignId })} />
      </Card>
    </>
  );
}

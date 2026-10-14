import { authorize, formatNumber } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { Alert, Badge, Button, Card, DataTable, Input, PageHeader } from '../../../components/ui';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';
import { loadTracking } from '../../../lib/tracking';
import { setGa4PropertyAction } from './actions';

export const dynamic = 'force-dynamic';

const TONE = { ok: 'ok', warn: 'warn', critical: 'bad' } as const;
const LABEL = { ok: '正常', warn: '注意', critical: '異常' } as const;
const METRIC_LABEL: Record<string, string> = { clicks: '點擊', ctr: 'CTR', cpc: 'CPC', cvr: '轉換率', cost: '花費', conversions: '轉換', clicks_vs_sessions: '點擊 vs GA4 工作階段' };

const sinceLast = (hours: number | null) => (hours === null ? '30 天以上' : hours < 1 ? `${Math.round(hours * 60)} 分鐘前` : hours < 48 ? `${Math.round(hours)} 小時前` : `${Math.floor(hours / 24)} 天前`);

// Conversion tracking health, GA4 gap and anomalies (Requirement 18.7, ADR-0021).
export default async function TrackingPage({ searchParams }: { searchParams: Promise<{ account?: string; error?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const params = await searchParams;
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0];
  if (!account) {
    return (
      <>
        <PageHeader title="追蹤健康" subtitle="轉換動作、GA4 比對與近 14 天異常。" />
        <div className="card flex flex-col items-center gap-2.5 px-7 py-16 text-center">
          <h2 className="section-title">沒有可檢視的帳戶</h2>
          <p className="text-sm text-muted">取得帳戶權限後，這裡會顯示轉換追蹤的健康狀態。</p>
        </div>
      </>
    );
  }
  const { health, gap, series, anomalies, categories, primary } = await loadTracking(db, account, new Date());
  const ratio = (r: number | null) => (r === null ? '—' : formatNumber(r, 2));

  return (
    <>
      <PageHeader
        title="追蹤健康"
        subtitle={`轉換動作、GA4 比對與近 14 天異常。每日同步後更新（${account.timezone}）。`}
        actions={
          <div className="flex items-center gap-2.5 rounded-pill border border-border bg-bg px-4 py-2.5">
            <span className="text-meta text-muted">整體健康</span>
            <Badge tone={TONE[health.status]} dot>
              {LABEL[health.status]}
            </Badge>
          </div>
        }
      />

      {health.noPrimary ? (
        <Alert tone="danger" title="沒有啟用中的主要轉換動作">
          出價策略與 CPA、ROAS 計算都依賴主要轉換。目前所有主要轉換動作都不在啟用狀態，請到 Google Ads「目標 / 轉換」檢查。
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="section-title">轉換動作</h2>
        {health.actions.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">尚未同步轉換動作（每日同步）。</div>
        ) : (
          <DataTable minWidth={860}>
            <thead>
              <tr>
                <th>名稱</th>
                <th>類別</th>
                <th>狀態</th>
                <th className="text-right">30 天日均轉換</th>
                <th className="text-right">距最後一次轉換</th>
                <th>問題</th>
              </tr>
            </thead>
            <tbody>
              {health.actions.map((a) => (
                <tr key={a.externalId}>
                  <td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-faint">{primary.has(a.externalId) ? '主要' : '次要'}</span>
                    </div>
                  </td>
                  <td className="text-muted">{categories.get(a.externalId) ?? '—'}</td>
                  <td>
                    <Badge tone={TONE[a.status]}>{LABEL[a.status]}</Badge>
                  </td>
                  <td className="table-num">{formatNumber(a.dailyAverage, 1)}</td>
                  <td className={`table-num ${a.hoursSinceLast === null || a.hoursSinceLast > 72 ? 'text-warning' : ''}`}>{sinceLast(a.hoursSinceLast)}</td>
                  <td className={`text-meta ${a.issues.length ? 'text-warning' : 'text-faint'}`}>{a.issues.map((i) => i.message).join('；') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>

      <Card
        className="gap-[18px]"
        title="GA4 比對"
        subtitle="比較 GA4（google / cpc）與 Google Ads 的轉換比例"
        action={gap ? <Badge tone={gap.alert ? 'warn' : 'ok'}>{gap.alert ? '偏移' : '穩定'}</Badge> : null}
      >
        {gap ? (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
              <div className="panel gap-1">
                <span className="text-xs text-faint">GA4 property</span>
                <span className="font-mono text-ui">{account.ga4PropertyId}</span>
              </div>
              <div className="panel gap-1">
                <span className="text-xs text-faint">14 天基準比例</span>
                <span className="text-xl font-bold">{ratio(gap.baselineRatio)}</span>
              </div>
              <div className="panel gap-1">
                <span className="text-xs text-faint">近 3 天比例</span>
                <span className={`text-xl font-bold ${gap.alert ? 'text-warning' : ''}`}>{ratio(gap.recentRatio)}</span>
              </div>
            </div>
            <p className="text-sm text-pretty text-muted">
              {gap.reason} <span className="text-faint">· 資料 {series.length} 天</span>
            </p>
          </>
        ) : (
          <div className="panel text-sm">
            <span className="font-semibold">尚未連結 GA4</span>
            <span className="text-muted">連結後，每日同步會比對 GA4 與 Google Ads 的轉換，偵測追蹤碼遺失或重複計算。請在 GA4「管理 / 資源設定」找到數字的 property ID，並確認服務帳號已加入檢視者權限。</span>
          </div>
        )}
        {isAdmin ? (
          <form action={setGa4PropertyAction.bind(null, account.id)} className="flex flex-wrap items-start gap-2.5 border-t border-border pt-4">
            <div className="max-w-80 flex-[1_1_240px]">
              <Input
                label="GA4 property ID"
                size="sm"
                name="propertyId"
                defaultValue={account.ga4PropertyId ?? ''}
                placeholder="例如 312845507"
                className="font-mono"
                error={params.error === 'ga4' ? 'Property ID 應為數字（不是 G- 開頭的評估 ID）' : undefined}
                hint="留空並儲存可解除連結"
              />
            </div>
            <div className="pt-[25px]">
              <Button variant="primary" size="sm">
                {account.ga4PropertyId ? '更新' : '連結'}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-meta text-faint">只有 Admin 可以連結或更新 GA4 property。</p>
        )}
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="section-title">近 14 天異常</h2>
        {anomalies.length === 0 ? <div className="card card-sm p-8 text-center text-sm text-muted">近 14 天沒有偵測到異常。</div> : null}
        {anomalies.map((a) => (
          <div key={a.id} className="card card-sm flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-meta text-muted">{a.detectedOn.slice(5).replace('-', '/')}</span>
              <span className="font-semibold">{METRIC_LABEL[a.metric] ?? a.metric}</span>
              <Badge tone={a.direction === 'up' ? 'warn' : 'bad'}>{a.direction === 'up' ? '↑ 上升' : '↓ 下降'}</Badge>
              <Badge>{a.segment || '帳戶整體'}</Badge>
              <span className="ml-auto font-mono text-meta text-muted">
                實際 {formatNumber(a.value, 2)} · 基準 {formatNumber(a.baseline, 2)} · z = {a.z > 0 ? '+' : '−'}
                {Math.abs(a.z).toFixed(1)}
              </span>
            </div>
            {a.explanation ? (
              <div className="panel gap-1 px-4 py-3.5">
                <span className="eyebrow">AI 原因分析{a.explainedAt ? ` · ${formatAt(a.explainedAt, account.timezone)}` : ''}</span>
                <p className="text-sm text-pretty whitespace-pre-line">{a.explanation}</p>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

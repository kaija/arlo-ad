import { authorize, formatNumber, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../components/ui';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';
import { loadTracking } from '../../../lib/tracking';
import { setGa4PropertyAction } from './actions';

export const dynamic = 'force-dynamic';

const TONE = { ok: 'ok', warn: 'warn', critical: 'bad' } as const;
const LABEL = { ok: '正常', warn: '注意', critical: '異常' } as const;
const METRIC_LABEL: Record<string, string> = { clicks: '點擊', ctr: 'CTR', cpc: 'CPC', cvr: '轉換率', cost: '花費', conversions: '轉換', clicks_vs_sessions: '點擊 vs GA4 工作階段' };

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
      <Card title="追蹤健康">
        <p className="text-sm text-zinc-500">沒有可檢視的帳戶。</p>
      </Card>
    );
  }
  const now = new Date();
  const { health, gap, series, anomalies, categories } = await loadTracking(db, account, now);

  return (
    <>
      <PageTitle
        actions={
          <form method="get" className="flex gap-2">
            <select name="account" defaultValue={account.id} className={inputClass} aria-label="帳戶">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" type="submit">
              切換
            </Button>
          </form>
        }
      >
        追蹤健康 <Badge tone={TONE[health.status]}>{LABEL[health.status]}</Badge>
      </PageTitle>

      <Card title="轉換動作">
        {health.noPrimary ? <p className="mb-3 text-sm text-red-600">沒有啟用中的主要轉換動作：出價沒有目標可優化。</p> : null}
        {health.actions.length === 0 ? (
          <p className="text-sm text-zinc-500">尚未同步轉換動作（每日同步）。</p>
        ) : (
          <Table head={['轉換動作', '類別', '狀態', '30 天日均', '距最後轉換', '問題']}>
            {health.actions.map((a) => (
              <tr key={a.externalId}>
                <Td first className="font-medium">
                  {a.name}
                </Td>
                <Td>{categories.get(a.externalId) ?? '—'}</Td>
                <Td>
                  <Badge tone={TONE[a.status]}>{LABEL[a.status]}</Badge>
                </Td>
                <Td>{formatNumber(a.dailyAverage, 1)}</Td>
                <Td>{a.hoursSinceLast === null ? '30 天以上' : `${Math.round(a.hoursSinceLast)} 小時`}</Td>
                <Td className="max-w-md text-left text-xs">{a.issues.map((i) => i.message).join('；') || '—'}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="GA4 比對（google / cpc）" className="mt-4">
        {params.error === 'ga4' ? <p className="mb-2 text-sm text-red-600">GA4 property ID 應為數字，例如 123456789。</p> : null}
        {gap ? (
          <div className="mb-3 space-y-1 text-sm">
            <p>
              <Badge tone={gap.alert ? 'warn' : 'ok'}>{gap.alert ? '落差偏移' : '穩定'}</Badge> {gap.reason}
            </p>
            <p className="text-xs text-zinc-500">
              基準（14 天）GA4/Ads {gap.baselineRatio === null ? '—' : formatPct(gap.baselineRatio, 0)} · 近 3 天 {gap.recentRatio === null ? '—' : formatPct(gap.recentRatio, 0)} · 資料 {series.length} 天
            </p>
          </div>
        ) : (
          <p className="mb-3 text-sm text-zinc-500">尚未連結 GA4 property；連結後每日同步會比對 GA4 與 Ads 轉換。</p>
        )}
        {isAdmin ? (
          <form action={setGa4PropertyAction.bind(null, account.id)} className="flex flex-wrap items-center gap-2">
            <input name="propertyId" defaultValue={account.ga4PropertyId ?? ''} placeholder="GA4 property ID" className={`${inputClass} font-mono`} />
            <Button type="submit" variant="secondary">
              {account.ga4PropertyId ? '更新' : '連結'}
            </Button>
            <span className="text-xs text-zinc-500">需要 GA4_SERVICE_ACCOUNT_JSON 的 service account 有該 property 的檢視權限；留空可解除連結。</span>
          </form>
        ) : null}
      </Card>

      <Card title="近 14 天異常" className="mt-4">
        {anomalies.length === 0 ? (
          <p className="text-sm text-zinc-500">沒有偵測到異常（anomaly_watch 排程每日執行）。</p>
        ) : (
          <ul className="space-y-3">
            {anomalies.map((a) => (
              <li key={a.id} className="text-sm">
                <div className="font-medium">
                  {a.detectedOn} · {METRIC_LABEL[a.metric] ?? a.metric} {a.direction === 'up' ? '↑' : '↓'}
                  {a.segment ? ` · ${a.segment}` : ''} <span className="text-xs text-zinc-500">（{formatNumber(a.value, 2)}，基準 {formatNumber(a.baseline, 2)}，z={a.z.toFixed(1)}）</span>
                </div>
                {a.explanation ? <p className="mt-1 whitespace-pre-line text-xs text-zinc-600 dark:text-zinc-400">{a.explanation}</p> : null}
                {a.explainedAt ? <p className="text-xs text-zinc-400">分析於 {formatAt(a.explainedAt, account.timezone)}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

import { authorize, formatMoney, formatNumber, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { AutoSubmitForm } from '../../../components/client';
import { Alert, Badge, DataTable, EmptyState, Icon, Input, LinkButton, PageHeader, PillTabs, Select } from '../../../components/ui';
import { STATUS_LABEL, STATUS_TONE } from '../../../lib/changesets';
import { INTENT_LABEL, loadSearchTerms, parseTermFilter } from '../../../lib/search-terms';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

const FILTER_LABEL = { all: '全部', irrelevant: '判定不相關', relevant: '判定相關', unlabelled: '尚未分類', negated: '已提出否定' } as const;
const SUBTITLE = 'AI 依 Business Profile 判斷每個搜尋字詞的意圖與相關性，不相關的字詞會被提出為否定關鍵字。';

// Search terms, classification and negative keyword history (Requirement 18.6).
export default async function SearchTermsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0];
  if (!account) {
    return (
      <>
        <PageHeader title="搜尋字詞" subtitle={SUBTITLE} />
        <EmptyState icon="search" title="沒有搜尋字詞資料">
          尚無可檢視的帳戶。
        </EmptyState>
      </>
    );
  }
  const filter = parseTermFilter(params);
  const { rows, profileVersion, history } = await loadSearchTerms(db, account, filter, new Date());
  const cur = account.currency;
  const isAdmin = authorize(user, 'admin').allowed;
  const profileHref = `/settings/business-profile?account=${account.id}`;
  const filtered = filter.label !== 'all' || !!filter.q;
  const href = (days: number) => `/search-terms?${new URLSearchParams({ account: account.id, days: String(days), label: filter.label, ...(filter.q ? { q: filter.q } : {}) }).toString()}`;

  return (
    <>
      <PageHeader title="搜尋字詞" subtitle={SUBTITLE} />

      {profileVersion ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-bg px-4 py-3 text-sm">
          <Icon name="file" size={16} />
          <span>
            分類依據 <strong className="font-semibold">Business Profile v{profileVersion}</strong>
          </span>
          <Link href={profileHref} className="link ml-auto">
            {isAdmin ? '編輯 Business Profile' : '檢視 Business Profile'} →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Alert tone="warning" title="此帳戶尚未設定 Business Profile">
            沒有 Business Profile 時無法判斷搜尋字詞是否相關，下方字詞皆為「尚未分類」，也不會提出否定關鍵字。
          </Alert>
          <div className="flex">
            <LinkButton size="sm" href={profileHref}>
              {isAdmin ? '設定 Business Profile' : '檢視設定頁'} →
            </LinkButton>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-[7px]">
          <span className="field-label">期間</span>
          <PillTabs tabs={([7, 30, 90] as const).map((d) => ({ href: href(d), label: `近 ${d} 天`, active: filter.days === d }))} />
        </div>
        <AutoSubmitForm method="get" className="contents">
          <input type="hidden" name="account" value={account.id} />
          <input type="hidden" name="days" value={filter.days} />
          <div className="w-[170px]">
            <Select label="分類" size="sm" name="label" defaultValue={filter.label}>
              {Object.entries(FILTER_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="max-w-80 flex-[1_1_220px]">
            <Input label="搜尋" size="sm" icon="search" name="q" defaultValue={filter.q} placeholder="輸入字詞後按 Enter" />
          </div>
        </AutoSubmitForm>
      </div>

      {rows.length === 0 ? (
        <div className="card flex flex-col items-center gap-2.5 px-7 py-14 text-center">
          <h2 className="section-title">{filtered ? '沒有符合條件的字詞' : '沒有搜尋字詞資料'}</h2>
          <p className="max-w-[420px] text-sm text-muted">{filtered ? '試試調整分類、期間或搜尋文字。' : '這段期間帳戶沒有產生搜尋字詞。'}</p>
        </div>
      ) : (
        <DataTable minWidth={1080}>
          <thead>
            <tr>
              <th className="w-[34%]">字詞</th>
              <th className="text-right">花費</th>
              <th className="text-right">點擊</th>
              <th className="text-right">90 天轉換</th>
              <th>意圖分類</th>
              <th className="text-right">信心</th>
              <th>否定狀態</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.term}>
                <td>
                  <div className="flex flex-col gap-[3px]">
                    <span className="font-medium">{r.term}</span>
                    <span className="text-xs leading-normal text-pretty text-faint">{r.label ? r.label.reason : profileVersion ? '新出現字詞，等待下一次分類掃描。' : '未設定 Business Profile，無法分類。'}</span>
                  </div>
                </td>
                <td className="table-num">{formatMoney(r.costMicros, cur)}</td>
                <td className="table-num">{formatNumber(r.clicks)}</td>
                <td className="table-num">{formatNumber(r.conversions90d, 1)}</td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge>{r.label ? (INTENT_LABEL[r.label.intent] ?? r.label.intent) : '尚未分類'}</Badge>
                    {r.label ? <Badge tone={r.label.relevant ? 'ok' : 'bad'}>{r.label.relevant ? '相關' : '不相關'}</Badge> : null}
                  </div>
                </td>
                <td className="table-num">{r.label ? formatPct(r.label.confidence, 0) : '—'}</td>
                <td className="whitespace-nowrap">
                  {r.negative ? (
                    <Link href={`/changesets/${r.negative.changesetId}`} className="link inline-flex items-center gap-1.5 text-meta">
                      <Badge tone={r.negative.excluded ? 'neutral' : STATUS_TONE[r.negative.status]}>{r.negative.excluded ? '已剔除' : STATUS_LABEL[r.negative.status]}</Badge>
                      <span className="font-mono">{r.negative.changesetId.slice(-8)}</span>
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <div className="mt-2 flex flex-col gap-3">
        <h2 className="section-title">否定關鍵字紀錄</h2>
        {history.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">尚未新增任何否定關鍵字。</div>
        ) : (
          <DataTable minWidth={640}>
            <thead>
              <tr>
                <th>字詞</th>
                <th>比對類型</th>
                <th>來源</th>
                <th>狀態</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 100).map((h, i) => (
                <tr key={`${h.changesetId}-${i}`}>
                  <td className="font-medium">{h.term}</td>
                  <td>
                    <span className="font-mono text-meta text-muted">{h.matchType}</span>
                  </td>
                  <td>{h.auto ? '自動' : '審核'}</td>
                  <td>
                    <Link href={`/changesets/${h.changesetId}`}>
                      <Badge tone={h.excluded ? 'neutral' : STATUS_TONE[h.status]}>{h.excluded ? '已剔除' : STATUS_LABEL[h.status]}</Badge>
                    </Link>
                  </td>
                  <td className="table-num text-left">{formatAt(h.createdAt, account.timezone)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </>
  );
}

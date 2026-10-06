import { formatMoney, formatNumber, formatPct } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import Link from 'next/link';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../components/ui';
import { STATUS_LABEL, STATUS_TONE } from '../../../lib/changesets';
import { INTENT_LABEL, loadSearchTerms, parseTermFilter } from '../../../lib/search-terms';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { formatAt } from '../../../lib/time';

export const dynamic = 'force-dynamic';

const FILTER_LABEL = { all: '全部', irrelevant: '判定不相關', relevant: '判定相關', unlabelled: '尚未分類', negated: '已提出否定' } as const;

// Search terms, classification and negative keyword history (Requirement 18.6).
export default async function SearchTermsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const db = getDb();
  const params = await searchParams;
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const account = accounts.find((a) => a.id === params.account) ?? accounts[0];
  if (!account) {
    return (
      <Card title="搜尋字詞">
        <p className="text-sm text-zinc-500">沒有可檢視的帳戶。</p>
      </Card>
    );
  }
  const filter = parseTermFilter(params);
  const { rows, profileVersion, history } = await loadSearchTerms(db, account, filter, new Date());
  const cur = account.currency;

  return (
    <>
      <PageTitle
        actions={
          <form className="flex flex-wrap items-center gap-2" method="get">
            <select name="account" defaultValue={account.id} className={inputClass} aria-label="帳戶">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select name="days" defaultValue={String(filter.days)} className={inputClass} aria-label="期間">
              <option value="7">近 7 天</option>
              <option value="30">近 30 天</option>
              <option value="90">近 90 天</option>
            </select>
            <select name="label" defaultValue={filter.label} className={inputClass} aria-label="分類">
              {Object.entries(FILTER_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input name="q" defaultValue={filter.q} placeholder="搜尋字詞" className={inputClass} />
            <Button variant="secondary" type="submit">
              篩選
            </Button>
          </form>
        }
      >
        搜尋字詞
      </PageTitle>
      <p className="mb-4 text-sm text-zinc-500">
        {profileVersion ? `分類依據 Business Profile 第 ${profileVersion} 版` : '尚未設定 Business Profile，無法分類。'} ·{' '}
        <Link href={`/settings/business-profile?account=${account.id}`} className="hover:underline">
          編輯 Business Profile
        </Link>
      </p>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">沒有符合條件的搜尋字詞。</p>
        ) : (
          <Table head={['搜尋字詞', '花費', '點擊', '90 天轉換', '分類', '信心', '否定']}>
            {rows.slice(0, 300).map((r) => (
              <tr key={r.term}>
                <Td first>
                  <span className="font-medium">{r.term}</span>
                  {r.label ? <div className="max-w-md truncate text-xs text-zinc-500">{r.label.reason}</div> : null}
                </Td>
                <Td>{formatMoney(r.costMicros, cur)}</Td>
                <Td>{formatNumber(r.clicks)}</Td>
                <Td>{formatNumber(r.conversions90d, 1)}</Td>
                <Td>{r.label ? <Badge tone={r.label.relevant ? 'ok' : 'warn'}>{`${INTENT_LABEL[r.label.intent] ?? r.label.intent} · ${r.label.relevant ? '相關' : '不相關'}`}</Badge> : <span className="text-zinc-400">—</span>}</Td>
                <Td>{r.label ? formatPct(r.label.confidence, 0) : '—'}</Td>
                <Td>
                  {r.negative ? (
                    <Link href={`/changesets/${r.negative.changesetId}`} className="hover:underline">
                      <Badge tone={r.negative.excluded ? 'neutral' : STATUS_TONE[r.negative.status]}>{r.negative.excluded ? '已剔除' : STATUS_LABEL[r.negative.status]}</Badge>
                    </Link>
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="否定關鍵字紀錄" className="mt-4">
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500">還沒有否定關鍵字的變更。</p>
        ) : (
          <Table head={['字詞', '比對', '來源', '狀態', '時間']}>
            {history.slice(0, 100).map((h, i) => (
              <tr key={`${h.changesetId}-${i}`}>
                <Td first>{h.term}</Td>
                <Td>{h.matchType}</Td>
                <Td>{h.auto ? '自動' : '審核'}</Td>
                <Td>
                  <Link href={`/changesets/${h.changesetId}`} className="hover:underline">
                    <Badge tone={h.excluded ? 'neutral' : STATUS_TONE[h.status]}>{h.excluded ? '已剔除' : STATUS_LABEL[h.status]}</Badge>
                  </Link>
                </Td>
                <Td className="whitespace-nowrap text-zinc-500">{formatAt(h.createdAt, account.timezone)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

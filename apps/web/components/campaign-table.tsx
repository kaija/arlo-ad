import { formatMoney, formatNumber, formatPct } from '@arlo/core';
import Link from 'next/link';
import type { CampaignTableRow } from '../lib/dashboard';
import { Badge, Table, Td } from './ui';

export function statusTone(status: string | null) {
  return status === 'ENABLED' ? 'ok' : status === 'PAUSED' ? 'neutral' : 'warn';
}

export function CampaignTable({ rows, currency, hrefFor }: { rows: CampaignTableRow[]; currency: string; hrefFor: (row: CampaignTableRow) => string }) {
  return (
    <Table head={['Campaign', '狀態', '日預算', '花費', '曝光', '點擊', 'CTR', 'CPC', '轉換', 'CPA', 'ROAS', 'IS', 'Lost IS (預算)', 'Lost IS (排名)']}>
      {rows.map((r) => (
        <tr key={r.campaignId} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
          <Td first>
            <Link className="font-medium hover:underline" href={hrefFor(r)}>
              {r.name ?? r.externalId}
            </Link>
          </Td>
          <Td>
            <Badge tone={statusTone(r.status)}>{r.status ?? '—'}</Badge>
          </Td>
          <Td>{formatMoney(r.budgetMicros, currency)}</Td>
          <Td>{formatMoney(r.costMicros, currency)}</Td>
          <Td>{formatNumber(r.impressions)}</Td>
          <Td>{formatNumber(r.clicks)}</Td>
          <Td>{formatPct(r.ctr, 2)}</Td>
          <Td>{formatMoney(r.cpcMicros, currency)}</Td>
          <Td>{formatNumber(r.conversions, 1)}</Td>
          <Td>{formatMoney(r.cpaMicros, currency)}</Td>
          <Td>{r.roas === null ? '—' : formatNumber(r.roas, 2)}</Td>
          <Td>{formatPct(r.searchIs, 0)}</Td>
          <Td>{formatPct(r.lostIsBudget, 0)}</Td>
          <Td>{formatPct(r.lostIsRank, 0)}</Td>
        </tr>
      ))}
    </Table>
  );
}

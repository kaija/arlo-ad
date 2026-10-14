import { formatMoney, formatNumber, formatPct } from '@arlo/core';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { CampaignTableRow } from '../lib/dashboard';
import { Badge, DataTable } from './ui';

const STATUSES = ['ENABLED', 'PAUSED', 'REMOVED'] as const;
const isKnownStatus = (s: string | null): s is (typeof STATUSES)[number] => (STATUSES as readonly (string | null)[]).includes(s);

export function statusTone(status: string | null) {
  return status === 'ENABLED' ? 'ok' : status === 'PAUSED' || status === 'REMOVED' ? 'neutral' : 'warn';
}

const HEAD = ['budget', 'cost', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'cpa', 'roas', 'is', 'isLostBudget', 'isLostRank'] as const;

export function CampaignTable({ rows, currency, selectedId, hrefFor }: { rows: CampaignTableRow[]; currency: string; selectedId?: string; hrefFor: (row: CampaignTableRow) => string }) {
  const t = useTranslations('campaignTable');
  return (
    <DataTable minWidth={1240}>
      <thead>
        <tr>
          <th>{t('name')}</th>
          <th>{t('status')}</th>
          {HEAD.map((h) => (
            <th key={h} className="text-right">
              {t(`head.${h}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.campaignId} className={r.campaignId === selectedId ? 'bg-accent-light' : undefined}>
            <td className="font-medium whitespace-nowrap">
              <Link href={hrefFor(r)} className="hover:text-accent">
                {r.name ?? r.externalId}
              </Link>
            </td>
            <td>
              <Badge tone={statusTone(r.status)}>{isKnownStatus(r.status) ? t(`statusValue.${r.status}`) : (r.status ?? '—')}</Badge>
            </td>
            <td className="table-num">{formatMoney(r.budgetMicros, currency)}</td>
            <td className="table-num">{formatMoney(r.costMicros, currency)}</td>
            <td className="table-num">{formatNumber(r.impressions)}</td>
            <td className="table-num">{formatNumber(r.clicks)}</td>
            <td className="table-num">{formatPct(r.ctr, 2)}</td>
            <td className="table-num">{formatMoney(r.cpcMicros, currency)}</td>
            <td className="table-num">{formatNumber(r.conversions, 1)}</td>
            <td className="table-num">{formatMoney(r.cpaMicros, currency)}</td>
            <td className="table-num">{r.roas === null ? '—' : formatPct(r.roas, 0)}</td>
            <td className="table-num">{formatPct(r.searchIs, 0)}</td>
            <td className={`table-num ${r.lostIsBudget !== null && r.lostIsBudget > 0.1 ? 'text-warning' : ''}`}>{formatPct(r.lostIsBudget, 0)}</td>
            <td className="table-num">{formatPct(r.lostIsRank, 0)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

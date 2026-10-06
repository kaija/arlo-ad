import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../../components/ui';
import { availableActions, loadDetail, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE } from '../../../../lib/changesets';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { decideAction } from '../actions';

export const dynamic = 'force-dynamic';

const SUBMITTED: Record<string, string> = {
  approve: '已送出核准，執行結果會在幾秒內更新。',
  confirm: '已送出 Tier 3 核准，執行結果會在幾秒內更新。',
  reject: '已送出拒絕。',
  undo: '已送出還原，結果會在幾秒內更新。',
};

// ChangeSet detail: diff, validator results, approver, trace, op results and audit trail (Requirement 18.3).
export default async function ChangeSetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { submitted, error } = await searchParams;
  const detail = await loadDetail(getDb(), id, readableAccounts(user));
  if (!detail) notFound();
  const { cs, account, view } = detail;
  const tz = account.timezone;
  const actions = availableActions(user, cs, new Date());
  const results = new Map(detail.opResults.map((r) => [r.opIndex, r]));

  return (
    <>
      <PageTitle actions={<Badge tone={STATUS_TONE[cs.status]}>{STATUS_LABEL[cs.status]}</Badge>}>{cs.summary}</PageTitle>
      {submitted && SUBMITTED[submitted] ? <p className="mb-4 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950 dark:text-sky-200">{SUBMITTED[submitted]}</p> : null}
      {error === 'confirm' ? <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">Tier 3 變更需要勾選確認後才能核准。</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="變更內容" className="lg:col-span-2">
          <Table head={['項目', '原值', '新值', '變動', '結果']}>
            {view.ops.map((op, i) => {
              const r = results.get(i);
              return (
                <tr key={i}>
                  <Td first>{op.label}</Td>
                  <Td>{op.before}</Td>
                  <Td className="font-medium">{op.after}</Td>
                  <Td>{op.change ?? '—'}</Td>
                  <Td>{r ? r.ok ? <Badge tone="ok">成功</Badge> : <span title={r.error ?? ''}><Badge tone="bad">失敗</Badge></span> : '—'}</Td>
                </tr>
              );
            })}
          </Table>
          {detail.opResults.some((r) => !r.ok) ? (
            <ul className="mt-3 space-y-1 text-xs text-red-600">
              {detail.opResults.filter((r) => !r.ok).map((r) => (
                <li key={r.opIndex}>
                  op {r.opIndex + 1}：{r.error}
                </li>
              ))}
            </ul>
          ) : null}
          {cs.rationale ? <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">理由：{cs.rationale}</p> : null}
          {cs.statusReason ? <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">狀態說明：{cs.statusReason}</p> : null}
        </Card>

        <Card title="資訊">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-zinc-500">帳戶</dt>
            <dd>{account.name}</dd>
            <dt className="text-zinc-500">Tier</dt>
            <dd>{cs.tier === null ? '—' : `Tier ${cs.tier}`}</dd>
            <dt className="text-zinc-500">來源</dt>
            <dd>{SOURCE_LABEL[cs.source.kind] ?? cs.source.kind}</dd>
            <dt className="text-zinc-500">提出者</dt>
            <dd>{view.requestedBy ?? '—'}</dd>
            <dt className="text-zinc-500">核准者</dt>
            <dd>{detail.approver ?? '—'}</dd>
            <dt className="text-zinc-500">建立</dt>
            <dd>{formatAt(cs.createdAt, tz)}</dd>
            {cs.expiresAt && cs.status === 'PENDING_APPROVAL' ? (
              <>
                <dt className="text-zinc-500">到期</dt>
                <dd>{formatAt(cs.expiresAt, tz)}</dd>
              </>
            ) : null}
            {cs.executedAt ? (
              <>
                <dt className="text-zinc-500">執行</dt>
                <dd>{formatAt(cs.executedAt, tz)}</dd>
              </>
            ) : null}
            {detail.revertOf ? (
              <>
                <dt className="text-zinc-500">還原自</dt>
                <dd>
                  <Link href={`/changesets/${detail.revertOf.id}`} className="hover:underline">
                    {detail.revertOf.summary}
                  </Link>
                </dd>
              </>
            ) : null}
            {detail.traceUrl ? (
              <>
                <dt className="text-zinc-500">Trace</dt>
                <dd>
                  <a href={detail.traceUrl} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-400">
                    OpenAI trace
                  </a>
                </dd>
              </>
            ) : null}
          </dl>

          {actions.approve || actions.reject || actions.undo ? (
            <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              {actions.approve ? (
                <form action={decideAction.bind(null, cs.id, actions.confirm ? 'confirm' : 'approve')} className="space-y-2">
                  {actions.confirm ? (
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="confirm" className="mt-1" required />
                      <span>我已確認上方金額與比例。這是 Tier 3 變更，核准後會立即執行。</span>
                    </label>
                  ) : null}
                  <Button type="submit">核准並執行</Button>
                </form>
              ) : null}
              {actions.reject ? (
                <form action={decideAction.bind(null, cs.id, 'reject')} className="flex gap-2">
                  <input name="reason" placeholder="拒絕原因（選填）" className={`${inputClass} min-w-0 flex-1`} maxLength={500} />
                  <Button type="submit" variant="secondary">
                    拒絕
                  </Button>
                </form>
              ) : null}
              {actions.undo ? (
                <form action={decideAction.bind(null, cs.id, 'undo')}>
                  <Button type="submit" variant="danger">
                    Undo（還原）
                  </Button>
                  <p className="mt-1 text-xs text-zinc-500">執行後 24 小時內可還原；目標若已被他人修改會拒絕。</p>
                </form>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>

      {view.violations.length ? (
        <Card title="Validator 結果" className="mt-4">
          <ul className="space-y-1 text-sm">
            {view.violations.map((v, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge tone={v.severity === 'HARD_BLOCK' ? 'bad' : 'warn'}>{v.severity === 'HARD_BLOCK' ? '阻擋' : '警告'}</Badge>
                <span>{v.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="稽核紀錄" className="mt-4">
        <Table head={['時間', '動作', '狀態', '操作者', '說明']}>
          {detail.audit.map((a, i) => (
            <tr key={i}>
              <Td first className="whitespace-nowrap text-zinc-500">
                {formatAt(a.at, tz)}
              </Td>
              <Td>{a.action}</Td>
              <Td>{a.fromStatus ? `${STATUS_LABEL[a.fromStatus as keyof typeof STATUS_LABEL] ?? a.fromStatus} → ` : ''}{a.toStatus ? (STATUS_LABEL[a.toStatus as keyof typeof STATUS_LABEL] ?? a.toStatus) : '—'}</Td>
              <Td>{a.actor}</Td>
              <Td className="max-w-md truncate text-left">{a.reason ?? ''}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

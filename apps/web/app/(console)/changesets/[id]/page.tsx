import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Alert, Badge, Button, Card, Checkbox, DataTable, Icon, PageHeader, Textarea, type Tone } from '../../../../components/ui';
import { availableActions, loadDetail, SOURCE_LABEL, STATUS_LABEL, STATUS_NOTE, STATUS_TONE, tierTone, UNDO_WINDOW_MS } from '../../../../lib/changesets';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { decideAction } from '../actions';

export const dynamic = 'force-dynamic';

const SUBMITTED: Record<string, string> = {
  approve: '已送出核准，正在寫入 Google Ads。',
  confirm: '已送出 Tier 3 核准，正在寫入 Google Ads。',
  reject: '已送出拒絕，正在更新狀態。',
  undo: '已送出還原，正在建立還原變更單。',
};

const DOT: Record<Tone, string> = { info: 'bg-accent', ok: 'bg-success', bad: 'bg-danger', warn: 'bg-warning', neutral: 'bg-faint' };
const statusLabel = (s: string) => STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s;

// ChangeSet detail: diff, validator results, approver, trace, op results and audit trail (Requirement 18.3).
export default async function ChangeSetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { submitted, error } = await searchParams;
  const detail = await loadDetail(getDb(), id, readableAccounts(user));
  if (!detail) notFound();
  const { cs, account, view } = detail;
  const tz = account.timezone;
  const now = new Date();
  const actions = availableActions(user, cs, now);
  const results = new Map(detail.opResults.map((r) => [r.opIndex, r]));
  const blocks = view.violations.filter((v) => v.severity === 'HARD_BLOCK').length;
  const pending = cs.status === 'PENDING_APPROVAL';
  const canReview = actions.approve || actions.reject;
  const undoLeft = cs.executedAt ? Math.max(0, cs.executedAt.getTime() + UNDO_WINDOW_MS - now.getTime()) : 0;

  const opResult = (i: number, excluded?: boolean): { tone: Tone; label: string; error?: string | null } => {
    const r = results.get(i);
    if (excluded) return { tone: 'neutral', label: '已剔除' };
    if (r) return r.ok ? { tone: 'ok', label: '成功' } : { tone: 'bad', label: '失敗', error: r.error };
    if (cs.status === 'EXECUTING') return { tone: 'info', label: '執行中' };
    if (cs.status === 'SIMULATED') return { tone: 'info', label: '已模擬' };
    return { tone: 'neutral', label: '未執行' };
  };

  const info: [string, React.ReactNode][] = [
    ['帳戶', account.name],
    ['Tier', cs.tier === null ? '—' : `Tier ${cs.tier}`],
    ['來源', SOURCE_LABEL[cs.source.kind] ?? cs.source.kind],
    ['提出者', view.requestedBy ?? '—'],
    ['核准者', detail.approver ?? '—'],
    ['建立時間', `${formatAt(cs.createdAt, tz)} (${tz})`],
    ['到期時間', pending && cs.expiresAt ? formatAt(cs.expiresAt, tz) : '—'],
    ['執行時間', cs.executedAt ? formatAt(cs.executedAt, tz) : '—'],
  ];

  return (
    <>
      <PageHeader
        back={{ href: '/changesets', label: '審核佇列' }}
        title={cs.summary}
        meta={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-meta text-faint">{cs.id.slice(-8)}</span>
            <Badge tone={STATUS_TONE[cs.status]} dot>
              {STATUS_LABEL[cs.status]}
            </Badge>
            {cs.tier === null ? null : <Badge tone={tierTone(cs.tier)}>Tier {cs.tier}</Badge>}
          </div>
        }
      />
      {submitted && SUBMITTED[submitted] ? <Alert title="已送出，結果會在幾秒內更新">{SUBMITTED[submitted]}重新整理頁面查看最新狀態。</Alert> : null}
      {error === 'confirm' ? <Alert tone="warning" title="Tier 3 需二次確認">請先勾選「我已確認上方金額與比例」後再核准。</Alert> : null}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <Card title="變更內容">
            <DataTable minWidth={620} className="rounded-md">
              <thead>
                <tr>
                  <th>項目</th>
                  <th className="text-right">原值</th>
                  <th className="text-right">新值</th>
                  <th className="text-right">變動幅度</th>
                  <th>執行結果</th>
                </tr>
              </thead>
              <tbody>
                {view.ops.map((op, i) => {
                  const r = opResult(i, op.excluded);
                  const big = op.change ? Math.abs(parseFloat(op.change)) >= 30 : false;
                  return (
                    <tr key={i}>
                      <td className="font-medium">{op.label}</td>
                      <td className="table-num">{op.before}</td>
                      <td className="table-num font-semibold text-body">{op.after}</td>
                      <td className={`table-num ${op.change ? (big ? 'text-warning' : '') : 'text-faint'}`}>{op.change ?? '—'}</td>
                      <td>
                        <div className="flex flex-col gap-1">
                          <Badge tone={r.tone} className="self-start">
                            {r.label}
                          </Badge>
                          {r.error ? <span className="font-mono text-xs text-danger">{r.error}</span> : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
              <div className="panel">
                <span className="eyebrow">Agent 提出的理由</span>
                <p className="text-sm text-pretty whitespace-pre-line">{cs.rationale || '—'}</p>
              </div>
              <div className="panel">
                <span className="eyebrow">狀態說明</span>
                <p className="text-sm text-pretty">{cs.statusReason || STATUS_NOTE[cs.status]}</p>
              </div>
            </div>
          </Card>

          <Card
            title="Validator 結果"
            action={
              <span className="text-meta text-faint">
                {cs.status === 'PENDING_VALIDATION' ? '驗證中…' : view.violations.length ? `${blocks} 阻擋 · ${view.violations.length - blocks} 警告` : ''}
              </span>
            }
            className="gap-3.5"
          >
            {view.violations.length === 0 && cs.status !== 'PENDING_VALIDATION' ? (
              <div className="flex items-center gap-2.5 text-sm text-success">
                <Icon name="check-circle" size={16} />
                所有規則通過
              </div>
            ) : null}
            {view.violations.map((v, i) => (
              <div key={i} className="flex items-start gap-3 rounded-md border border-border px-3.5 py-3">
                <Badge tone={v.severity === 'HARD_BLOCK' ? 'bad' : 'warn'} className="flex-none">
                  {v.severity === 'HARD_BLOCK' ? '阻擋' : '警告'}
                </Badge>
                <span className="text-sm text-muted">{v.message}</span>
              </div>
            ))}
          </Card>

          <Card title="動作">
            {cs.status === 'BLOCKED' ? (
              <Alert tone="danger" title="此變更已被 Validator 阻擋">
                被阻擋的變更任何人都不能核准。請修正後由 agent 重新提出。
              </Alert>
            ) : pending && !canReview ? (
              <Alert tone="warning" title="你無法審核此變更單">
                需要具備此帳戶與 Tier {cs.tier ?? '—'} 審核權限的 Approver；Tier 3 變更也不能由提出者本人核准。
              </Alert>
            ) : !canReview && !actions.undo ? (
              <p className="text-sm text-muted">此狀態沒有可用的動作。</p>
            ) : null}
            {actions.approve ? (
              <form action={decideAction.bind(null, cs.id, actions.confirm ? 'confirm' : 'approve')} className="flex flex-col gap-3.5">
                {actions.confirm ? (
                  <div className="flex flex-col gap-1.5 rounded-md bg-warning-light px-4 py-3.5">
                    <span className="text-meta font-semibold text-warning">Tier 3 需二次確認</span>
                    <Checkbox name="confirm" label="我已確認上方金額與比例" required />
                  </div>
                ) : null}
                <div className="flex">
                  <Button variant="primary">核准並執行</Button>
                </div>
              </form>
            ) : null}
            {actions.reject ? (
              <details className="group">
                <summary className="btn btn-secondary list-none [&::-webkit-details-marker]:hidden">拒絕</summary>
                <form action={decideAction.bind(null, cs.id, 'reject')} className="mt-3 flex flex-col gap-2.5 rounded-md border border-border p-4">
                  <Textarea label="拒絕原因（選填）" name="reason" placeholder="例如：促銷檔期結束，不需要再加預算" maxLength={500} />
                  <div className="flex">
                    <Button variant="primary">確認拒絕</Button>
                  </div>
                </form>
              </details>
            ) : null}
            {actions.undo ? (
              <form action={decideAction.bind(null, cs.id, 'undo')} className="flex flex-col gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary">Undo 還原</Button>
                  <span className="text-meta text-muted">
                    還剩 {Math.floor(undoLeft / 3_600_000)} 小時 {Math.floor((undoLeft % 3_600_000) / 60_000)} 分可還原
                  </span>
                </div>
                <p className="text-meta text-faint">執行後 24 小時內可還原。還原會產生一筆新的變更單；若目標已被他人修改，還原會被拒絕。</p>
              </form>
            ) : null}
          </Card>

          <Card title="稽核紀錄" className="gap-1">
            <div className="mt-2 flex flex-col">
              {detail.audit.map((a, i) => (
                <div key={i} className="grid grid-cols-[14px_minmax(0,1fr)] gap-3.5">
                  <div className="flex flex-col items-center">
                    <span className={`mt-1.5 h-2.5 w-2.5 rounded-pill ${a.toStatus ? DOT[STATUS_TONE[a.toStatus as keyof typeof STATUS_TONE] ?? 'neutral'] : 'bg-border-strong'}`} />
                    <span className="mt-1 w-px flex-1 bg-border-strong" />
                  </div>
                  <div className="flex flex-col gap-[3px] pb-[18px]">
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <span className="text-sm font-semibold">{a.action}</span>
                      {a.toStatus ? (
                        <span className="font-mono text-xs text-muted">
                          {a.fromStatus ? statusLabel(a.fromStatus) : '—'} → {statusLabel(a.toStatus)}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-meta text-faint">
                      {formatAt(a.at, tz)} · {a.actor}
                    </span>
                    {a.reason ? <span className="text-meta text-muted">{a.reason}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="card card-sm flex flex-[1_1_300px] flex-col lg:sticky lg:top-[88px]">
          {info.map(([k, v]) => (
            <div key={k} className="kv">
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
          {detail.revertOf ? (
            <div className="kv">
              <span>還原自</span>
              <Link href={`/changesets/${detail.revertOf.id}`} className="link">
                {detail.revertOf.summary} →
              </Link>
            </div>
          ) : null}
          {detail.traceUrl ? (
            <div className="kv">
              <span>OpenAI trace</span>
              <a href={detail.traceUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center justify-end gap-1.5">
                開啟 trace
                <Icon name="external" size={14} />
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

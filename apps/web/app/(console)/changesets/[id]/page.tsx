import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Alert, Badge, Button, Card, Checkbox, DataTable, Icon, PageHeader, Textarea, type Tone } from '../../../../components/ui';
import { CHANGESET_STATUSES, type ChangeSetStatus } from '@arlo/core';
import { availableActions, isSourceKind, loadDetail, STATUS_TONE, tierTone, UNDO_WINDOW_MS } from '../../../../lib/changesets';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { decideAction } from '../actions';

export const dynamic = 'force-dynamic';

const SUBMITTED = ['approve', 'confirm', 'reject', 'undo'] as const;
const isSubmitted = (s?: string): s is (typeof SUBMITTED)[number] => (SUBMITTED as readonly (string | undefined)[]).includes(s);
const isStatus = (s: string): s is ChangeSetStatus => (CHANGESET_STATUSES as readonly string[]).includes(s);

const DOT: Record<Tone, string> = { info: 'bg-accent', ok: 'bg-success', bad: 'bg-danger', warn: 'bg-warning', neutral: 'bg-faint' };

// ChangeSet detail: diff, validator results, approver, trace, op results and audit trail (Requirement 18.3).
export default async function ChangeSetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string; error?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { submitted, error } = await searchParams;
  const detail = await loadDetail(getDb(), id, readableAccounts(user));
  if (!detail) notFound();
  const t = await getTranslations('changeset');
  const statusLabel = (s: string) => (isStatus(s) ? t(`status.${s}`) : s);
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
    if (excluded) return { tone: 'neutral', label: t('detail.result.excluded') };
    if (r) return r.ok ? { tone: 'ok', label: t('detail.result.ok') } : { tone: 'bad', label: t('detail.result.failed'), error: r.error };
    if (cs.status === 'EXECUTING') return { tone: 'info', label: t('detail.result.executing') };
    if (cs.status === 'SIMULATED') return { tone: 'info', label: t('detail.result.simulated') };
    return { tone: 'neutral', label: t('detail.result.notRun') };
  };

  const info: [string, React.ReactNode][] = [
    [t('detail.info.account'), account.name],
    ['Tier', cs.tier === null ? '—' : `Tier ${cs.tier}`],
    [t('detail.info.source'), isSourceKind(cs.source.kind) ? t(`source.${cs.source.kind}`) : cs.source.kind],
    [t('detail.info.requestedBy'), view.requestedBy ?? '—'],
    [t('detail.info.approver'), detail.approver ?? '—'],
    [t('detail.info.createdAt'), `${formatAt(cs.createdAt, tz)} (${tz})`],
    [t('detail.info.expiresAt'), pending && cs.expiresAt ? formatAt(cs.expiresAt, tz) : '—'],
    [t('detail.info.executedAt'), cs.executedAt ? formatAt(cs.executedAt, tz) : '—'],
  ];

  return (
    <>
      <PageHeader
        back={{ href: '/changesets', label: t('queue.title') }}
        title={cs.summary}
        meta={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-meta text-faint">{cs.id.slice(-8)}</span>
            <Badge tone={STATUS_TONE[cs.status]} dot>
              {t(`status.${cs.status}`)}
            </Badge>
            {cs.tier === null ? null : <Badge tone={tierTone(cs.tier)}>Tier {cs.tier}</Badge>}
          </div>
        }
      />
      {isSubmitted(submitted) ? (
        <Alert title={t('detail.submittedTitle')}>
          {t(`detail.submitted.${submitted}`)} {t('detail.submittedRefresh')}
        </Alert>
      ) : null}
      {error === 'confirm' ? (
        <Alert tone="warning" title={t('detail.confirmTitle')}>
          {t('detail.confirmBody')}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <Card title={t('detail.changes')}>
            <DataTable minWidth={620} className="rounded-md">
              <thead>
                <tr>
                  <th>{t('detail.col.item')}</th>
                  <th className="text-right">{t('detail.col.before')}</th>
                  <th className="text-right">{t('detail.col.after')}</th>
                  <th className="text-right">{t('detail.col.change')}</th>
                  <th>{t('detail.col.result')}</th>
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
                <span className="eyebrow">{t('detail.rationale')}</span>
                <p className="text-sm text-pretty whitespace-pre-line">{cs.rationale || '—'}</p>
              </div>
              <div className="panel">
                <span className="eyebrow">{t('detail.statusNote')}</span>
                <p className="text-sm text-pretty">{cs.statusReason || t(`note.${cs.status}`)}</p>
              </div>
            </div>
          </Card>

          <Card
            title={t('detail.validator')}
            action={
              <span className="text-meta text-faint">
                {cs.status === 'PENDING_VALIDATION' ? t('detail.validating') : view.violations.length ? t('detail.violationSummary', { blocks, warnings: view.violations.length - blocks }) : ''}
              </span>
            }
            className="gap-3.5"
          >
            {view.violations.length === 0 && cs.status !== 'PENDING_VALIDATION' ? (
              <div className="flex items-center gap-2.5 text-sm text-success">
                <Icon name="check-circle" size={16} />
                {t('detail.allPassed')}
              </div>
            ) : null}
            {view.violations.map((v, i) => (
              <div key={i} className="flex items-start gap-3 rounded-md border border-border px-3.5 py-3">
                <Badge tone={v.severity === 'HARD_BLOCK' ? 'bad' : 'warn'} className="flex-none">
                  {v.severity === 'HARD_BLOCK' ? t('detail.block') : t('detail.warn')}
                </Badge>
                <span className="text-sm text-muted">{v.message}</span>
              </div>
            ))}
          </Card>

          <Card title={t('detail.actions')}>
            {cs.status === 'BLOCKED' ? (
              <Alert tone="danger" title={t('detail.blockedTitle')}>
                {t('detail.blockedBody')}
              </Alert>
            ) : pending && !canReview ? (
              <Alert tone="warning" title={t('detail.cannotReviewTitle')}>
                {t('detail.cannotReviewBody', { tier: cs.tier ?? '—' })}
              </Alert>
            ) : !canReview && !actions.undo ? (
              <p className="text-sm text-muted">{t('detail.noActions')}</p>
            ) : null}
            {actions.approve ? (
              <form action={decideAction.bind(null, cs.id, actions.confirm ? 'confirm' : 'approve')} className="flex flex-col gap-3.5">
                {actions.confirm ? (
                  <div className="flex flex-col gap-1.5 rounded-md bg-warning-light px-4 py-3.5">
                    <span className="text-meta font-semibold text-warning">{t('detail.confirmTitle')}</span>
                    <Checkbox name="confirm" label={t('detail.confirmCheckbox')} required />
                  </div>
                ) : null}
                <div className="flex">
                  <Button variant="primary">{t('detail.approve')}</Button>
                </div>
              </form>
            ) : null}
            {actions.reject ? (
              <details className="group">
                <summary className="btn btn-secondary list-none [&::-webkit-details-marker]:hidden">{t('detail.reject')}</summary>
                <form action={decideAction.bind(null, cs.id, 'reject')} className="mt-3 flex flex-col gap-2.5 rounded-md border border-border p-4">
                  <Textarea label={t('detail.rejectReason')} name="reason" placeholder={t('detail.rejectPlaceholder')} maxLength={500} />
                  <div className="flex">
                    <Button variant="primary">{t('detail.confirmReject')}</Button>
                  </div>
                </form>
              </details>
            ) : null}
            {actions.undo ? (
              <form action={decideAction.bind(null, cs.id, 'undo')} className="flex flex-col gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary">{t('detail.undo')}</Button>
                  <span className="text-meta text-muted">{t('detail.undoLeft', { hours: Math.floor(undoLeft / 3_600_000), minutes: Math.floor((undoLeft % 3_600_000) / 60_000) })}</span>
                </div>
                <p className="text-meta text-faint">{t('detail.undoNote')}</p>
              </form>
            ) : null}
          </Card>

          <Card title={t('detail.audit')} className="gap-1">
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
                      {formatAt(a.at, tz)} · {a.actor ?? (a.actorKind === 'user' ? t('actor.user') : t('actor.system'))}
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
              <span>{t('detail.info.revertOf')}</span>
              <Link href={`/changesets/${detail.revertOf.id}`} className="link">
                {detail.revertOf.summary} →
              </Link>
            </div>
          ) : null}
          {detail.traceUrl ? (
            <div className="kv">
              <span>OpenAI trace</span>
              <a href={detail.traceUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center justify-end gap-1.5">
                {t('detail.info.openTrace')}
                <Icon name="external" size={14} />
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

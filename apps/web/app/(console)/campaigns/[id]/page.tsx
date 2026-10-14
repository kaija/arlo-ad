import { authorize, CHANGESET_STATUSES, DRAFT_SECTIONS, formatMoney, type ChangeSetStatus, type LintIssue } from '@arlo/core';
import { getAdAccount, getCampaignTask, latestCampaignDraft, listCampaignDraftVersions } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DraftEditor } from '../../../../components/draft-editor';
import { Alert, Badge, Button, Card, PageHeader, Radio, Textarea } from '../../../../components/ui';
import { createdCampaign } from '../../../../lib/campaign-submit';
import { TASK_STATUS_TONE } from '../../../../lib/campaigns';
import { STATUS_TONE as CS_STATUS_TONE } from '../../../../lib/changesets';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { enableCampaignAction, regenerateAction, restoreVersionAction, saveDraftAction, submitDraftAction } from './actions';

export const dynamic = 'force-dynamic';

const isCsStatus = (s: string): s is ChangeSetStatus => (CHANGESET_STATUSES as readonly string[]).includes(s);

type Policy = { adId: string; adGroupExternalId: string; approvalStatus: string | null; reviewStatus: string | null; topics: string[] };

// One campaign task: status, brief and the latest draft (Requirements 15.8, 18.5).
export default async function CampaignTaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string; regenerating?: string; submitted?: string; enabling?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = getDb();
  const task = /^[0-9a-f-]{36}$/i.test(id) ? await getCampaignTask(db, id) : undefined;
  const allowed = readableAccounts(user);
  if (!task || (allowed !== null && !allowed.includes(task.accountId))) notFound();
  const [account, draft, versions] = await Promise.all([getAdAccount(db, task.accountId), latestCampaignDraft(db, task.id), listCampaignDraftVersions(db, task.id)]);
  const query = await searchParams;
  const canPropose = authorize(user, 'propose', { accountId: task.accountId }).allowed;
  const canEdit = task.status === 'draft' && canPropose;
  const tz = account?.timezone ?? 'UTC';
  const currency = account?.currency ?? 'USD';
  const created = task.status === 'submitted' ? await createdCampaign(db, task) : null;
  const issues = (draft?.lintIssues ?? []) as LintIssue[];
  const errors = issues.filter((i) => i.severity === 'error').length;
  const policies = (draft?.policyStatus ?? null) as Policy[] | null;
  const b = task.brief;
  const t = await getTranslations('campaign');
  const tcs = await getTranslations('changeset');
  const brief: [string, string][] = [
    [t('task.brief.account'), account?.name ?? '—'],
    [t('task.brief.objective'), b.objective],
    [t('task.brief.offering'), b.offering],
    [t('task.brief.landingPage'), b.landingPageUrl],
    [t('task.brief.dailyBudget'), formatMoney(b.dailyBudget * 1_000_000, currency)],
    [t('task.brief.locations'), b.locations.join(', ')],
    [t('task.brief.languages'), b.languages.join(', ')],
    ...(b.audience ? ([[t('task.brief.audience'), b.audience]] as [string, string][]) : []),
    ...(b.notes ? ([[t('task.brief.notes'), b.notes]] as [string, string][]) : []),
  ];

  return (
    <>
      <PageHeader
        back={{ href: '/campaigns', label: t('list.title') }}
        title={b.name}
        meta={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={TASK_STATUS_TONE[task.status]} dot>
              {t(`taskStatus.${task.status}`)}
            </Badge>
            <span className="text-meta text-faint">{t('task.createdAt', { account: account?.name ?? '—', at: formatAt(task.createdAt, tz) })}</span>
          </div>
        }
      />

      {task.status === 'queued' || task.status === 'running' ? (
        <div className="card card-sm flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="spinner spinner-sm" role="status" aria-label={t('task.generating')} />
            <span className="text-ui font-semibold">{task.status === 'queued' ? t('task.queued') : t('task.running')}</span>
          </div>
          <div className="progress progress-indeterminate">
            <div className="progress-bar" />
          </div>
          <span className="text-meta text-muted">{t('task.progressHint')}</span>
        </div>
      ) : null}
      {task.status === 'failed' ? (
        <Alert tone="danger" title={t('task.failedTitle')}>
          {task.error ?? t('task.unknownError')}
        </Alert>
      ) : null}
      {query.saved ? <Alert tone="success" title={t('task.savedAs', { version: query.saved })} /> : null}
      {query.regenerating ? <Alert title={t('task.regeneratingTitle')}>{t('task.regeneratingBody')}</Alert> : null}
      {query.submitted ? <Alert title={t('task.submittedTitle')}>{t('task.submittedBody')}</Alert> : null}
      {query.enabling ? <Alert title={t('task.enablingTitle')}>{t('task.enablingBody')}</Alert> : null}
      {query.error ? (
        <Alert tone="danger" title={t('task.errorTitle')}>
          {query.error}
        </Alert>
      ) : null}

      <Card title={t('task.briefSummary')} action={<span className="text-meta text-faint">{t('task.readOnly')}</span>} className="gap-3.5">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-8 gap-y-0.5">
          {brief.map(([k, v]) => (
            <div key={k} className="flex gap-4 border-b border-border py-[9px] text-sm">
              <span className="w-24 flex-none text-faint">{k}</span>
              <span className="min-w-0 text-pretty break-words whitespace-pre-line">{v}</span>
            </div>
          ))}
        </div>
      </Card>

      {draft ? (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-6">
            <DraftEditor
              key={draft.version}
              draft={draft.draft}
              version={draft.version}
              currency={currency}
              action={saveDraftAction.bind(null, task.id)}
              disabled={!canEdit}
              readOnlyNote={canEdit ? undefined : task.status === 'draft' ? t('task.readOnlyNoPermission') : t('task.readOnlySubmitted')}
            />

            {canEdit ? (
              <Card title={t('task.regenerate')} className="gap-3.5">
                <form action={regenerateAction.bind(null, task.id)} className="flex flex-col gap-3.5">
                  <div className="flex flex-wrap gap-x-6 gap-y-2.5">
                    {DRAFT_SECTIONS.map((s) => (
                      <Radio key={s} name="section" value={s} label={t(`section.${s}`)} defaultChecked={s === 'ads'} />
                    ))}
                  </div>
                  <Textarea label={t('task.instructions')} name="instructions" placeholder={t('task.instructionsPlaceholder')} maxLength={1000} />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="secondary">{t('task.regenerateButton')}</Button>
                    <span className="text-meta text-faint">{t('task.regenerateHint')}</span>
                  </div>
                </form>
              </Card>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
            <Card
              padding="sm"
              title={t('task.checks')}
              action={<Badge tone={errors ? 'bad' : issues.length ? 'warn' : 'ok'}>{errors ? t('task.errorsCount', { count: errors }) : issues.length ? t('task.warningsCount', { count: issues.length }) : t('task.passed')}</Badge>}
              className="gap-3"
            >
              {issues.length === 0 ? <span className="text-meta text-success">{t('task.noIssues')}</span> : null}
              {issues.map((i, n) => (
                <div key={n} className="flex items-start gap-2.5 text-meta leading-normal">
                  <Badge tone={i.severity === 'error' ? 'bad' : 'warn'} className="flex-none px-2 py-0.5">
                    {i.severity === 'error' ? t('task.error') : t('task.warning')}
                  </Badge>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs font-semibold break-all">{i.path}</span>
                    <span className="text-muted">{i.message}</span>
                  </div>
                </div>
              ))}
            </Card>

            {canEdit || created ? (
              <Card padding="sm" title={t('task.create')} className="gap-3.5">
                {canEdit ? (
                  <form action={submitDraftAction.bind(null, task.id)} className="flex flex-col gap-3.5">
                    <p className="text-meta text-muted">{t('task.createHint')}</p>
                    <div className="flex">
                      <Button variant="primary" disabled={errors > 0}>
                        {t('task.submitCreate')}
                      </Button>
                    </div>
                    {errors ? <span className="text-meta text-danger">{t('task.fixErrorsFirst')}</span> : null}
                  </form>
                ) : null}
                {created ? (
                  <>
                    <div className="flex flex-col text-sm">
                      <div className="kv py-[9px]">
                        <span>{t('task.createChangeset')}</span>
                        <Link href={`/changesets/${created.changesetId}`} className="link flex items-center justify-end gap-1.5">
                          <span className="font-mono">{created.changesetId.slice(-8)}</span>
                          <Badge tone={CS_STATUS_TONE[created.changesetStatus as keyof typeof CS_STATUS_TONE] ?? 'neutral'}>
                            {isCsStatus(created.changesetStatus) ? tcs(`status.${created.changesetStatus}`) : created.changesetStatus}
                          </Badge>
                        </Link>
                      </div>
                      <div className="kv py-[9px]">
                        <span>Campaign ID</span>
                        <span className="font-mono">{created.campaignExternalId ?? '—'}</span>
                      </div>
                      <div className="kv py-[9px]">
                        <span>{t('task.enableChangeset')}</span>
                        {created.enableChangesetId ? (
                          <Link href={`/changesets/${created.enableChangesetId}`} className="link font-mono">
                            {created.enableChangesetId.slice(-8)} →
                          </Link>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </div>
                    </div>
                    {!created.enableChangesetId && created.campaignExternalId && created.changesetStatus === 'EXECUTED' && canPropose ? (
                      <form action={enableCampaignAction.bind(null, task.id)} className="flex flex-col gap-2">
                        <div className="flex">
                          <Button variant="primary" size="sm">
                            {t('task.enableCampaign')}
                          </Button>
                        </div>
                        <span className="text-xs text-faint">{t('task.enableHint')}</span>
                      </form>
                    ) : null}
                  </>
                ) : null}
              </Card>
            ) : null}

            <Card padding="sm" title={t('task.policy')} className="gap-2.5">
              {policies?.length ? (
                policies.map((p) => (
                  <div key={p.adId} className="flex flex-col gap-1.5 border-t border-border py-2.5 text-meta">
                    <span className="font-semibold">{t('task.ad', { id: p.adId })}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={p.approvalStatus === 'APPROVED' ? 'ok' : p.approvalStatus === 'DISAPPROVED' ? 'bad' : 'warn'}>{p.approvalStatus ?? '—'}</Badge>
                      <Badge>{p.reviewStatus ?? '—'}</Badge>
                    </div>
                    {p.topics.length ? <span className="text-muted">{p.topics.join(', ')}</span> : null}
                  </div>
                ))
              ) : (
                <span className="text-meta text-muted">{t('task.policyEmpty')}</span>
              )}
            </Card>

            <Card padding="sm" title={t('task.versions')} className="gap-1">
              {versions.map((v) => (
                <div key={v.version} className="flex items-center gap-2.5 border-t border-border py-[9px] text-meta">
                  <span className="w-7 font-mono font-semibold">v{v.version}</span>
                  <div className="flex flex-1 flex-col">
                    <span>{v.origin}</span>
                    <span className="text-faint">{formatAt(v.createdAt, tz)}</span>
                  </div>
                  {v.version === draft.version ? (
                    <Badge tone="info">{t('task.current')}</Badge>
                  ) : canEdit ? (
                    <form action={restoreVersionAction.bind(null, task.id, v.version)}>
                      <Button size="sm">{t('task.restore')}</Button>
                    </form>
                  ) : null}
                </div>
              ))}
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}

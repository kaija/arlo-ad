import { authorize, DRAFT_SECTIONS, formatMoney, SECTION_LABEL, type LintIssue } from '@arlo/core';
import { getAdAccount, getCampaignTask, latestCampaignDraft, listCampaignDraftVersions } from '@arlo/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DraftEditor } from '../../../../components/draft-editor';
import { Alert, Badge, Button, Card, PageHeader, Radio, Textarea } from '../../../../components/ui';
import { createdCampaign } from '../../../../lib/campaign-submit';
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from '../../../../lib/campaigns';
import { STATUS_LABEL as CS_STATUS_LABEL, STATUS_TONE as CS_STATUS_TONE } from '../../../../lib/changesets';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { enableCampaignAction, regenerateAction, restoreVersionAction, saveDraftAction, submitDraftAction } from './actions';

export const dynamic = 'force-dynamic';

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
  const brief: [string, string][] = [
    ['帳戶', account?.name ?? '—'],
    ['目標', b.objective],
    ['產品 / 賣點', b.offering],
    ['到達網頁', b.landingPageUrl],
    ['每日預算', formatMoney(b.dailyBudget * 1_000_000, currency)],
    ['地區', b.locations.join('、')],
    ['語言', b.languages.join('、')],
    ...(b.audience ? ([['受眾', b.audience]] as [string, string][]) : []),
    ...(b.notes ? ([['備註', b.notes]] as [string, string][]) : []),
  ];

  return (
    <>
      <PageHeader
        back={{ href: '/campaigns', label: 'Campaign 工作區' }}
        title={b.name}
        meta={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone={TASK_STATUS_TONE[task.status]} dot>
              {TASK_STATUS_LABEL[task.status]}
            </Badge>
            <span className="text-meta text-faint">
              {account?.name} · 建立於 {formatAt(task.createdAt, tz)}
            </span>
          </div>
        }
      />

      {task.status === 'queued' || task.status === 'running' ? (
        <div className="card card-sm flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="spinner spinner-sm" role="status" aria-label="產生中" />
            <span className="text-ui font-semibold">{task.status === 'queued' ? '排隊中，即將開始產生草稿' : 'AI 正在產生草稿'}</span>
          </div>
          <div className="progress progress-indeterminate">
            <div className="progress-bar" />
          </div>
          <span className="text-meta text-muted">通常需要一兩分鐘；重新整理頁面查看進度。</span>
        </div>
      ) : null}
      {task.status === 'failed' ? (
        <Alert tone="danger" title="草稿產生失敗">
          {task.error ?? '未知錯誤'}
        </Alert>
      ) : null}
      {query.saved ? <Alert tone="success" title={`已儲存為 v${query.saved}`} /> : null}
      {query.regenerating ? <Alert title="正在重新產生指定區段">完成後會成為新版本；稍後重新整理。</Alert> : null}
      {query.submitted ? <Alert title="已送出">Campaign 會在變更單核准後以暫停狀態建立。</Alert> : null}
      {query.enabling ? <Alert title="已送出啟用變更單">核准後 campaign 才會開始投放。</Alert> : null}
      {query.error ? <Alert tone="danger" title="無法完成">{query.error}</Alert> : null}

      <Card title="Brief 摘要" action={<span className="text-meta text-faint">唯讀</span>} className="gap-3.5">
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
              readOnlyNote={canEdit ? undefined : task.status === 'draft' ? '你沒有此帳戶的提案權限，草稿為唯讀。' : '草稿已送出，內容為唯讀。'}
            />

            {canEdit ? (
              <Card title="重新產生區段" className="gap-3.5">
                <form action={regenerateAction.bind(null, task.id)} className="flex flex-col gap-3.5">
                  <div className="flex flex-wrap gap-x-6 gap-y-2.5">
                    {DRAFT_SECTIONS.map((s) => (
                      <Radio key={s} name="section" value={s} label={SECTION_LABEL[s]} defaultChecked={s === 'ads'} />
                    ))}
                  </div>
                  <Textarea label="要求（選填）" name="instructions" placeholder="例如：標題多強調私有部署與資安，少用「最」" maxLength={1000} />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="secondary">重新產生</Button>
                    <span className="text-meta text-faint">重新產生後會成為新版本，其他區段不變。</span>
                  </div>
                </form>
              </Card>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
            <Card padding="sm" title="檢查結果" action={<Badge tone={errors ? 'bad' : issues.length ? 'warn' : 'ok'}>{errors ? `${errors} 個錯誤` : issues.length ? `${issues.length} 個提醒` : '通過'}</Badge>} className="gap-3">
              {issues.length === 0 ? <span className="text-meta text-success">沒有錯誤或提醒。</span> : null}
              {issues.map((i, n) => (
                <div key={n} className="flex items-start gap-2.5 text-meta leading-normal">
                  <Badge tone={i.severity === 'error' ? 'bad' : 'warn'} className="flex-none px-2 py-0.5">
                    {i.severity === 'error' ? '錯誤' : '提醒'}
                  </Badge>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs font-semibold break-all">{i.path}</span>
                    <span className="text-muted">{i.message}</span>
                  </div>
                </div>
              ))}
            </Card>

            {canEdit || created ? (
              <Card padding="sm" title="建立" className="gap-3.5">
                {canEdit ? (
                  <form action={submitDraftAction.bind(null, task.id)} className="flex flex-col gap-3.5">
                    <p className="text-meta text-muted">送出後會產生一筆待審核的變更單，核准後以「暫停」狀態建立 campaign。</p>
                    <div className="flex">
                      <Button variant="primary" disabled={errors > 0}>
                        送出建立（暫停狀態）
                      </Button>
                    </div>
                    {errors ? <span className="text-meta text-danger">修正檢查結果中的錯誤後才能送出。</span> : null}
                  </form>
                ) : null}
                {created ? (
                  <>
                    <div className="flex flex-col text-sm">
                      <div className="kv py-[9px]">
                        <span>建立用變更單</span>
                        <Link href={`/changesets/${created.changesetId}`} className="link flex items-center justify-end gap-1.5">
                          <span className="font-mono">{created.changesetId.slice(-8)}</span>
                          <Badge tone={CS_STATUS_TONE[created.changesetStatus as keyof typeof CS_STATUS_TONE] ?? 'neutral'}>
                            {CS_STATUS_LABEL[created.changesetStatus as keyof typeof CS_STATUS_LABEL] ?? created.changesetStatus}
                          </Badge>
                        </Link>
                      </div>
                      <div className="kv py-[9px]">
                        <span>Campaign ID</span>
                        <span className="font-mono">{created.campaignExternalId ?? '—'}</span>
                      </div>
                      <div className="kv py-[9px]">
                        <span>啟用變更單</span>
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
                            啟用 campaign
                          </Button>
                        </div>
                        <span className="text-xs text-faint">會產生一筆需審核的啟用變更單。</span>
                      </form>
                    ) : null}
                  </>
                ) : null}
              </Card>
            ) : null}

            <Card padding="sm" title="政策審核" className="gap-2.5">
              {policies?.length ? (
                policies.map((p) => (
                  <div key={p.adId} className="flex flex-col gap-1.5 border-t border-border py-2.5 text-meta">
                    <span className="font-semibold">廣告 {p.adId}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={p.approvalStatus === 'APPROVED' ? 'ok' : p.approvalStatus === 'DISAPPROVED' ? 'bad' : 'warn'}>{p.approvalStatus ?? '—'}</Badge>
                      <Badge>{p.reviewStatus ?? '—'}</Badge>
                    </div>
                    {p.topics.length ? <span className="text-muted">{p.topics.join('、')}</span> : null}
                  </div>
                ))
              ) : (
                <span className="text-meta text-muted">Campaign 建立後才會有政策審核結果。</span>
              )}
            </Card>

            <Card padding="sm" title="版本" className="gap-1">
              {versions.map((v) => (
                <div key={v.version} className="flex items-center gap-2.5 border-t border-border py-[9px] text-meta">
                  <span className="w-7 font-mono font-semibold">v{v.version}</span>
                  <div className="flex flex-1 flex-col">
                    <span>{v.origin}</span>
                    <span className="text-faint">{formatAt(v.createdAt, tz)}</span>
                  </div>
                  {v.version === draft.version ? (
                    <Badge tone="info">目前</Badge>
                  ) : canEdit ? (
                    <form action={restoreVersionAction.bind(null, task.id, v.version)}>
                      <Button size="sm">還原</Button>
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

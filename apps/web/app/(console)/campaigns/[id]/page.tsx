import { authorize, DRAFT_SECTIONS, formatMoney, SECTION_LABEL, type LintIssue } from '@arlo/core';
import { getAdAccount, getCampaignTask, latestCampaignDraft, listCampaignDraftVersions } from '@arlo/db';
import { notFound } from 'next/navigation';
import { DraftEditor, LintList } from '../../../../components/draft-editor';
import { Badge, Button, Card, inputClass, PageTitle } from '../../../../components/ui';
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from '../../../../lib/campaigns';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { createdCampaign } from '../../../../lib/campaign-submit';
import { STATUS_LABEL as CS_STATUS_LABEL } from '../../../../lib/changesets';
import Link from 'next/link';
import { enableCampaignAction, regenerateAction, restoreVersionAction, saveDraftAction, submitDraftAction } from './actions';

export const dynamic = 'force-dynamic';

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
  const canEdit = task.status === 'draft' && authorize(user, 'propose', { accountId: task.accountId }).allowed;
  const tz = account?.timezone ?? 'UTC';
  const created = task.status === 'submitted' ? await createdCampaign(db, task) : null;
  const canPropose = authorize(user, 'propose', { accountId: task.accountId }).allowed;
  const lintErrors = (draft?.lintIssues as LintIssue[] | undefined)?.some((i) => i.severity === 'error') ?? true;
  const policies = (draft?.policyStatus ?? null) as { adId: string; adGroupExternalId: string; approvalStatus: string | null; reviewStatus: string | null; topics: string[] }[] | null;
  const b = task.brief;
  return (
    <>
      <PageTitle actions={<Badge tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge>}>{b.name}</PageTitle>
      {task.status === 'queued' || task.status === 'running' ? <p className="mb-4 text-sm text-zinc-500">Campaign agent 正在背景產生草稿，通常需要一兩分鐘；重新整理頁面查看進度。</p> : null}
      {query.saved ? <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">已儲存為第 {query.saved} 版。</p> : null}
      {query.regenerating ? <p className="mb-4 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950 dark:text-sky-200">正在重新產生指定區段，完成後會成為新版本；稍後重新整理。</p> : null}
      {query.submitted ? <p className="mb-4 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950 dark:text-sky-200">已送出：campaign 會在核准後以暫停狀態建立。</p> : null}
      {query.enabling ? <p className="mb-4 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-950 dark:text-sky-200">已送出啟用變更，核准後 campaign 才會開始投放。</p> : null}
      {query.error ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{query.error}</p> : null}
      {task.status === 'failed' ? <p className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">產生失敗：{task.error ?? '未知錯誤'}</p> : null}
      <Card title="Brief">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-zinc-500">帳戶</dt>
          <dd>{account?.name}</dd>
          <dt className="text-zinc-500">目標</dt>
          <dd className="whitespace-pre-line">{b.objective}</dd>
          <dt className="text-zinc-500">產品 / 賣點</dt>
          <dd className="whitespace-pre-line">{b.offering}</dd>
          <dt className="text-zinc-500">到達網頁</dt>
          <dd>{b.landingPageUrl}</dd>
          <dt className="text-zinc-500">預算</dt>
          <dd>{formatMoney(b.dailyBudget * 1_000_000, account?.currency ?? 'USD')} / 日</dd>
          <dt className="text-zinc-500">地區 / 語言</dt>
          <dd>
            {b.locations.join('、')} · {b.languages.join('、')}
          </dd>
          {b.audience ? (
            <>
              <dt className="text-zinc-500">受眾</dt>
              <dd>{b.audience}</dd>
            </>
          ) : null}
          {b.notes ? (
            <>
              <dt className="text-zinc-500">備註</dt>
              <dd className="whitespace-pre-line">{b.notes}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      {draft ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
          <Card title={`草稿 第 ${draft.version} 版`}>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              {draft.draft.adGroups.length} 個廣告群組 · {draft.draft.adGroups.reduce((s, g) => s + g.keywords.length, 0)} 個關鍵字 · {draft.draft.negativeKeywords.length} 個否定關鍵字
            </p>
            <DraftEditor draft={draft.draft} action={saveDraftAction.bind(null, task.id)} disabled={!canEdit} />
          </Card>
          <div className="space-y-4">
            <Card title="檢查結果">
              <LintList issues={draft.lintIssues as LintIssue[]} />
              {canEdit ? (
                <form action={submitDraftAction.bind(null, task.id)} className="mt-3">
                  <Button type="submit" disabled={lintErrors}>
                    送出建立（暫停狀態）
                  </Button>
                  <p className="mt-1 text-xs text-zinc-500">{lintErrors ? '修正錯誤後才能送出。' : '會建立待審核的變更，核准後以暫停狀態建立 campaign；啟用是另一個變更。'}</p>
                </form>
              ) : null}
            </Card>
            {created ? (
              <Card title="建立狀態">
                <p className="text-sm">
                  建立變更：
                  <Link href={`/changesets/${created.changesetId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                    {CS_STATUS_LABEL[created.changesetStatus as keyof typeof CS_STATUS_LABEL] ?? created.changesetStatus}
                  </Link>
                </p>
                {created.campaignExternalId ? <p className="mt-1 text-sm">Campaign ID：<code>{created.campaignExternalId}</code>（暫停）</p> : null}
                {created.enableChangesetId ? (
                  <p className="mt-1 text-sm">
                    <Link href={`/changesets/${created.enableChangesetId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                      啟用變更
                    </Link>
                  </p>
                ) : created.campaignExternalId && created.changesetStatus === 'EXECUTED' && canPropose ? (
                  <form action={enableCampaignAction.bind(null, task.id)} className="mt-2">
                    <Button type="submit">啟用 campaign</Button>
                  </form>
                ) : null}
              </Card>
            ) : null}
            {policies?.length ? (
              <Card title="政策審核">
                <ul className="space-y-1 text-xs">
                  {policies.map((p) => (
                    <li key={p.adId}>
                      廣告 {p.adId}：{p.approvalStatus ?? '—'}（{p.reviewStatus ?? '—'}）{p.topics.length ? ` · ${p.topics.join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            {canEdit ? (
              <Card title="重新產生區段">
                <form action={regenerateAction.bind(null, task.id)} className="space-y-2">
                  <select name="section" className={`${inputClass} w-full`} defaultValue="ads">
                    {DRAFT_SECTIONS.map((s) => (
                      <option key={s} value={s}>
                        {SECTION_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  <textarea name="instructions" rows={3} placeholder="要求（選填），例如：標題更強調免佈線" className={`${inputClass} w-full`} maxLength={1000} />
                  <Button type="submit" variant="secondary">
                    重新產生
                  </Button>
                </form>
              </Card>
            ) : null}
            <Card title="版本">
              <ul className="space-y-1 text-sm">
                {versions.map((v) => (
                  <li key={v.version} className="flex items-center justify-between gap-2">
                    <span>
                      第 {v.version} 版 · {v.origin} <span className="text-xs text-zinc-500">{formatAt(v.createdAt, tz)}</span>
                    </span>
                    {canEdit && v.version !== draft.version ? (
                      <form action={restoreVersionAction.bind(null, task.id, v.version)}>
                        <button type="submit" className="text-xs text-sky-700 hover:underline dark:text-sky-400">
                          還原
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}

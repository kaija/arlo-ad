// Campaign draft editor (Requirements 15.4, 18.5). A plain form: every field is posted and the
// server rebuilds the draft, so it works without client JavaScript.
import { BIDDING_STRATEGIES, type CampaignDraft, type LintIssue } from '@arlo/core';
import { keywordsToText } from '../lib/campaign-draft';
import { Button, inputClass } from './ui';

function Area({ label, name, value, rows = 3, hint, mono }: { label: string; name: string; value: string; rows?: number; hint?: string; mono?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      <textarea name={name} defaultValue={value} rows={rows} className={`${inputClass} w-full ${mono ? 'font-mono text-xs' : ''}`} />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

function Input({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      <input name={name} defaultValue={value} className={`${inputClass} w-full`} />
    </label>
  );
}

export function LintList({ issues }: { issues: readonly LintIssue[] }) {
  if (issues.length === 0) return <p className="text-sm text-emerald-600">通過檢查。</p>;
  return (
    <ul className="space-y-1 text-xs">
      {issues.map((i, n) => (
        <li key={n} className={i.severity === 'error' ? 'text-red-600' : 'text-amber-600'}>
          {i.severity === 'error' ? '錯誤' : '提醒'} · <code>{i.path}</code>：{i.message}
        </li>
      ))}
    </ul>
  );
}

export function DraftEditor({ draft, action, disabled }: { draft: CampaignDraft; action: (form: FormData) => Promise<void>; disabled: boolean }) {
  const c = draft.campaign;
  return (
    <form action={action} className="space-y-6">
      <fieldset disabled={disabled} className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <Input label="Campaign 名稱" name="c_name" value={c.name} />
          <Input label="每日預算" name="c_budget" value={String(c.dailyBudget)} />
          <label className="block space-y-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">出價策略</span>
            <select name="c_strategy" defaultValue={c.biddingStrategy} className={`${inputClass} w-full`}>
              {BIDDING_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <Input label="目標 CPA（TARGET_CPA 時）" name="c_targetCpa" value={c.targetCpa === null ? '' : String(c.targetCpa)} />
          <Input label="地區" name="c_locations" value={c.locations.join(', ')} />
          <Input label="語言" name="c_languages" value={c.languages.join(', ')} />
        </section>
        <input type="hidden" name="g_count" value={draft.adGroups.length} />
        {draft.adGroups.map((g, i) => (
          <section key={i} className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Input label={`廣告群組 ${i + 1}`} name={`g${i}_name`} value={g.name} />
              </div>
              <label className="flex items-center gap-1 pb-2 text-xs text-red-600">
                <input type="checkbox" name={`g${i}_remove`} /> 移除
              </label>
            </div>
            <Area label="關鍵字（每行「字詞 | EXACT/PHRASE/BROAD」）" name={`g${i}_keywords`} value={keywordsToText(g.keywords)} rows={Math.min(10, g.keywords.length + 1)} mono />
            <input type="hidden" name={`g${i}_adCount`} value={g.ads.length} />
            {g.ads.map((ad, j) => (
              <div key={j} className="grid gap-3 md:grid-cols-2">
                <Area label={`廣告 ${j + 1} 標題（每行一個，≤ 30，中文算 2）`} name={`g${i}_ad${j}_headlines`} value={ad.headlines.join('\n')} rows={8} />
                <div className="space-y-3">
                  <Area label="說明（每行一個，≤ 90）" name={`g${i}_ad${j}_descriptions`} value={ad.descriptions.join('\n')} rows={4} />
                  <Input label="最終網址" name={`g${i}_ad${j}_finalUrl`} value={ad.finalUrl} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="path1" name={`g${i}_ad${j}_path1`} value={ad.path1 ?? ''} />
                    <Input label="path2" name={`g${i}_ad${j}_path2`} value={ad.path2 ?? ''} />
                  </div>
                </div>
              </div>
            ))}
          </section>
        ))}
        <Area label="否定關鍵字（每行「字詞 | MATCH」）" name="negatives" value={keywordsToText(draft.negativeKeywords)} rows={5} mono />
        <Area label="說明（rationale）" name="rationale" value={draft.rationale} rows={3} />
        {disabled ? null : <Button type="submit">儲存為新版本</Button>}
      </fieldset>
    </form>
  );
}

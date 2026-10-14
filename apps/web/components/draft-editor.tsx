'use client';

// Campaign draft editor (Requirements 15.4, 18.5). Edits happen in client state and are posted
// in the line-based format `draftFromForm` parses: lists one item per line, keywords "text | MATCH".
import { adTextWidth, BIDDING_STRATEGIES, DESCRIPTION_MAX, HEADLINE_MAX, MATCH_TYPES, type CampaignDraft } from '@arlo/core';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Icon } from './icons';
import { Button, Checkbox, Input, Select, Textarea } from './ui';

type Keyword = CampaignDraft['negativeKeywords'][number];
type Group = CampaignDraft['adGroups'][number] & { removed?: boolean };
type Ad = Group['ads'][number];

const HEADLINE_LIMIT = 15;
const DESCRIPTION_LIMIT = 4;

// Rows left blank are not posted.
const keywordsToText = (ks: readonly Keyword[]) =>
  ks
    .filter((k) => k.text.trim())
    .map((k) => `${k.text} | ${k.matchType}`)
    .join('\n');
const replaceAt = <T,>(list: readonly T[], i: number, value: T) => list.map((x, n) => (n === i ? value : x));

function KeywordRows({ keywords, onChange, disabled, addLabel }: { keywords: readonly Keyword[]; onChange: (next: Keyword[]) => void; disabled: boolean; addLabel: string }) {
  const t = useTranslations('draft');
  return (
    <>
      {keywords.map((k, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_130px_32px] items-center gap-2">
          <Input size="sm" aria-label={t('keyword')} value={k.text} onChange={(e) => onChange(replaceAt(keywords, i, { ...k, text: e.target.value }))} disabled={disabled} />
          <Select size="sm" aria-label={t('matchType')} value={k.matchType} onChange={(e) => onChange(replaceAt(keywords, i, { ...k, matchType: e.target.value as Keyword['matchType'] }))} disabled={disabled}>
            {MATCH_TYPES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          {disabled ? null : (
            <button type="button" className="icon-btn" aria-label={t('removeKeyword')} onClick={() => onChange(keywords.filter((_, n) => n !== i))}>
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
      ))}
      {disabled ? null : (
        <div className="flex">
          <Button type="button" size="sm" onClick={() => onChange([...keywords, { text: '', matchType: 'PHRASE' }])}>
            {addLabel}
          </Button>
        </div>
      )}
    </>
  );
}

function AdTexts({ label, addLabel, texts, max, limit, onChange, disabled, wide }: { label: string; addLabel: string; texts: readonly string[]; max: number; limit: number; onChange: (next: string[]) => void; disabled: boolean; wide?: boolean }) {
  const tr = useTranslations('draft');
  return (
    <div className={`grid gap-2.5 ${wide ? 'grid-cols-[repeat(auto-fit,minmax(300px,1fr))]' : 'grid-cols-[repeat(auto-fit,minmax(220px,1fr))]'}`}>
      {texts.map((t, i) => {
        const width = adTextWidth(t);
        return (
          <Input
            key={i}
            label={`${label} ${i + 1}`}
            size="sm"
            value={t}
            onChange={(e) => onChange(replaceAt(texts, i, e.target.value))}
            hint={`${width} / ${max}`}
            error={width > max ? tr('tooLong', { width, max }) : undefined}
            disabled={disabled}
          />
        );
      })}
      {disabled || texts.length >= limit ? null : (
        <div className="flex items-start pt-[25px]">
          <Button type="button" size="sm" onClick={() => onChange([...texts, ''])}>
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DraftEditor({ draft, version, currency, action, disabled, readOnlyNote }: { draft: CampaignDraft; version: number; currency: string; action: (form: FormData) => Promise<void>; disabled: boolean; readOnlyNote?: string }) {
  const [campaign, setCampaign] = useState(draft.campaign);
  const [targetCpa, setTargetCpa] = useState(draft.campaign.targetCpa === null ? '' : String(draft.campaign.targetCpa));
  const [budget, setBudget] = useState(String(draft.campaign.dailyBudget));
  const [locations, setLocations] = useState(draft.campaign.locations.join(', '));
  const [languages, setLanguages] = useState(draft.campaign.languages.join(', '));
  const [groups, setGroups] = useState<Group[]>(draft.adGroups);
  const [negatives, setNegatives] = useState<Keyword[]>(draft.negativeKeywords);
  const [rationale, setRationale] = useState(draft.rationale);
  const [dirty, setDirty] = useState(false);
  // Every setter below goes through `edit` so the header can tell saved from unsaved state.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const setGroup = (i: number, patch: Partial<Group>) => edit(setGroups)(replaceAt(groups, i, { ...groups[i]!, ...patch }));
  const setAd = (i: number, j: number, patch: Partial<Ad>) => setGroup(i, { ads: replaceAt(groups[i]!.ads, j, { ...groups[i]!.ads[j]!, ...patch }) });
  const kept = groups.filter((g) => !g.removed);
  const t = useTranslations('draft');

  return (
    <form action={action} className="card flex flex-col gap-[22px] px-7 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="section-title">
            {t('version', { version })}
            {dirty ? <span className="text-meta font-medium text-warning"> · {t('unsaved')}</span> : null}
          </h2>
          <span className="text-meta text-faint">{t('counts', { groups: kept.length, keywords: kept.reduce((s, g) => s + g.keywords.length, 0), negatives: negatives.length })}</span>
        </div>
        {disabled ? null : (
          <Button variant="secondary" size="sm" disabled={!dirty}>
            {t('saveVersion')}
          </Button>
        )}
      </div>
      {readOnlyNote ? <p className="text-meta text-faint">{readOnlyNote}</p> : null}

      <div className="flex flex-col gap-3.5">
        <span className="eyebrow">{t('campaignLevel')}</span>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          <Input label={t('name')} size="sm" name="c_name" value={campaign.name} onChange={(e) => edit(setCampaign)({ ...campaign, name: e.target.value })} disabled={disabled} />
          <Input label={t('dailyBudget', { currency })} size="sm" name="c_budget" inputMode="decimal" value={budget} onChange={(e) => edit(setBudget)(e.target.value)} disabled={disabled} />
          <Select label={t('biddingStrategy')} size="sm" name="c_strategy" value={campaign.biddingStrategy} onChange={(e) => edit(setCampaign)({ ...campaign, biddingStrategy: e.target.value as CampaignDraft['campaign']['biddingStrategy'] })} disabled={disabled}>
            {BIDDING_STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {t(`strategy.${s}`)}
              </option>
            ))}
          </Select>
          <Input
            label={t('targetCpa', { currency })}
            size="sm"
            name="c_targetCpa"
            inputMode="decimal"
            value={campaign.biddingStrategy === 'TARGET_CPA' ? targetCpa : ''}
            onChange={(e) => edit(setTargetCpa)(e.target.value)}
            disabled={disabled || campaign.biddingStrategy !== 'TARGET_CPA'}
          />
          <Input label={t('locations')} size="sm" name="c_locations" value={locations} onChange={(e) => edit(setLocations)(e.target.value)} disabled={disabled} />
          <Input label={t('languages')} size="sm" name="c_languages" value={languages} onChange={(e) => edit(setLanguages)(e.target.value)} disabled={disabled} />
        </div>
      </div>

      <input type="hidden" name="g_count" value={groups.length} />
      {groups.map((g, i) => (
        <div key={i} className={`flex flex-col gap-4 rounded-md border border-border-strong p-5 ${g.removed ? 'opacity-50' : ''}`}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-[1_1_240px]">
              <Input label={t('adGroup', { n: i + 1 })} size="sm" name={`g${i}_name`} value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} disabled={disabled} />
            </div>
            <div className="pb-2">
              <Checkbox label={t('markRemoved')} name={`g${i}_remove`} checked={!!g.removed} onChange={(e) => setGroup(i, { removed: e.target.checked })} disabled={disabled} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t('keywords', { count: g.keywords.length })}</span>
            <KeywordRows keywords={g.keywords} onChange={(keywords) => setGroup(i, { keywords })} disabled={disabled} addLabel={t('addKeyword')} />
            <input type="hidden" name={`g${i}_keywords`} value={keywordsToText(g.keywords)} />
          </div>
          <input type="hidden" name={`g${i}_adCount`} value={g.ads.length} />
          {g.ads.map((ad, j) => (
            <div key={j} className="flex flex-col gap-3 rounded-md bg-bg-secondary p-4">
              <span className="eyebrow">{t('ad', { n: j + 1 })}</span>
              <AdTexts label={t('headline')} addLabel={t('addHeadline')} texts={ad.headlines} max={HEADLINE_MAX} limit={HEADLINE_LIMIT} onChange={(headlines) => setAd(i, j, { headlines })} disabled={disabled} />
              <AdTexts label={t('description')} addLabel={t('addDescription')} texts={ad.descriptions} max={DESCRIPTION_MAX} limit={DESCRIPTION_LIMIT} onChange={(descriptions) => setAd(i, j, { descriptions })} disabled={disabled} wide />
              <input type="hidden" name={`g${i}_ad${j}_headlines`} value={ad.headlines.join('\n')} />
              <input type="hidden" name={`g${i}_ad${j}_descriptions`} value={ad.descriptions.join('\n')} />
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2.5">
                <Input label={t('finalUrl')} size="sm" name={`g${i}_ad${j}_finalUrl`} value={ad.finalUrl} onChange={(e) => setAd(i, j, { finalUrl: e.target.value })} disabled={disabled} />
                <Input label={t('path1')} size="sm" name={`g${i}_ad${j}_path1`} value={ad.path1 ?? ''} onChange={(e) => setAd(i, j, { path1: e.target.value })} disabled={disabled} />
                <Input label={t('path2')} size="sm" name={`g${i}_ad${j}_path2`} value={ad.path2 ?? ''} onChange={(e) => setAd(i, j, { path2: e.target.value })} disabled={disabled} />
              </div>
            </div>
          ))}
        </div>
      ))}

      <div className="flex flex-col gap-2">
        <span className="eyebrow">{t('negatives', { count: negatives.length })}</span>
        <KeywordRows keywords={negatives} onChange={edit(setNegatives)} disabled={disabled} addLabel={t('addNegative')} />
        <input type="hidden" name="negatives" value={keywordsToText(negatives)} />
      </div>
      <Textarea label={t('rationale')} name="rationale" value={rationale} onChange={(e) => edit(setRationale)(e.target.value)} disabled={disabled} />
    </form>
  );
}

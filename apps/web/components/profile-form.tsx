'use client';

// Business Profile editor. Lists are edited as tags and examples as rows, then posted in the
// line-based format `parseProfileForm` reads: one item per line, examples "字詞 | 相關 | 備註".
import { COMPETITOR_POLICIES } from '@arlo/core';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import type { ProfileFormState } from '../app/(console)/settings/business-profile/actions';
import type { ProfileFormValues } from '../lib/business-profile';
import { Icon } from './icons';
import { Alert, Badge, Button, DataTable, Input, Radio, Select } from './ui';

type ListKey = 'offerings' | 'targetIntents' | 'excludedIntents' | 'brandTerms';
interface Example {
  term: string;
  relevant: boolean;
  note: string;
}

const LISTS: readonly ListKey[] = ['offerings', 'targetIntents', 'excludedIntents', 'brandTerms'];

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function parseExamples(text: string): Example[] {
  return lines(text).map((line) => {
    const [term, label, ...note] = line.split('|').map((x) => x.trim());
    return { term: term ?? '', relevant: label !== '不相關', note: note.join('|') };
  });
}

const examplesToText = (rows: Example[]) =>
  rows
    .filter((r) => r.term.trim())
    .map((r) => [r.term.trim(), r.relevant ? '相關' : '不相關', r.note.trim()].join(' | ').replace(/ \| $/, ''))
    .join('\n');

function TagList({ label, hint, placeholder, items, onChange, error, disabled }: { label: string; hint: string; placeholder: string; items: string[]; onChange: (next: string[]) => void; error?: string; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const t = useTranslations('profile');
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!items.includes(v)) onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="card card-sm flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        <span className={`text-meta ${error ? 'text-danger' : 'text-faint'}`}>{error ?? hint}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map((v) => (
          <span key={v} className="tag">
            {v}
            {disabled ? null : (
              <button type="button" className="tag-remove" aria-label={t('remove', { item: v })} onClick={() => onChange(items.filter((x) => x !== v))}>
                <Icon name="close" size={13} strokeWidth={2.25} />
              </button>
            )}
          </span>
        ))}
        {items.length === 0 ? <span className="text-meta text-faint">{t('none')}</span> : null}
      </div>
      {disabled ? null : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Input
            size="sm"
            aria-label={placeholder}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Enter adds the tag instead of submitting the whole profile.
              e.preventDefault();
              add();
            }}
          />
          <Button type="button" size="sm" onClick={add}>
            {t('add')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function ProfileForm({
  action,
  initial: defaults,
  version,
  updated,
  accountName,
  disabled,
}: {
  action: (prev: ProfileFormState, form: FormData) => Promise<ProfileFormState>;
  initial: ProfileFormValues;
  version: number | null;
  /** "Last updated …" line for the stored version. */
  updated?: string;
  accountName: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const e = state.errors ?? {};
  const initial = state.values ?? defaults;
  const [lists, setLists] = useState<Record<ListKey, string[]>>({
    offerings: lines(initial.offerings),
    targetIntents: lines(initial.targetIntents),
    excludedIntents: lines(initial.excludedIntents),
    brandTerms: lines(initial.brandTerms),
  });
  const [policy, setPolicy] = useState(initial.competitorPolicy);
  const [examples, setExamples] = useState(() => parseExamples(initial.examples));
  const [started, setStarted] = useState(version !== null);
  const posted: ProfileFormValues = {
    offerings: lists.offerings.join('\n'),
    targetIntents: lists.targetIntents.join('\n'),
    excludedIntents: lists.excludedIntents.join('\n'),
    brandTerms: lists.brandTerms.join('\n'),
    competitorPolicy: policy,
    examples: examplesToText(examples),
  };
  // Unsaved = differs from what was last stored: the loaded profile, or the values of a successful save.
  const [loaded] = useState(posted);
  const baseline = state.savedVersion !== undefined && state.values ? state.values : loaded;
  // Multipart encoding turns the line breaks of the echoed values into CRLF.
  const dirty = (Object.keys(posted) as (keyof ProfileFormValues)[]).some((k) => posted[k] !== baseline[k].replace(/\r\n/g, '\n'));
  const current = state.savedVersion ?? version;
  const setExample = (i: number, patch: Partial<Example>) => setExamples(examples.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const t = useTranslations('profile');
  const tc = useTranslations('common');

  if (!started) {
    return (
      <div className="card flex flex-col items-center gap-3 px-7 py-14 text-center">
        <h2 className="section-title">{t('notSetTitle', { account: accountName })}</h2>
        <p className="max-w-[460px] text-sm text-muted">{t('notSetBody')}</p>
        {disabled ? null : (
          <Button type="button" variant="primary" onClick={() => setStarted(true)}>
            {t('create')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {LISTS.map((l) => (
        <input key={l} type="hidden" name={l} value={posted[l]} />
      ))}
      <input type="hidden" name="examples" value={posted.examples} />

      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="info">{current === null ? t('unsaved') : `v${current}`}</Badge>
        {state.savedVersion !== undefined && !dirty ? (
          <span className="text-meta text-success">{t('savedAs', { version: state.savedVersion })}</span>
        ) : updated && state.savedVersion === undefined ? (
          <span className="text-meta text-faint">{updated}</span>
        ) : null}
        {dirty ? <span className="text-meta text-warning">{t('dirty')}</span> : null}
        {disabled ? null : (
          <div className="ml-auto">
            <Button variant="primary" disabled={pending || (!dirty && current !== null)}>
              {pending ? tc('saving') : t('saveAs', { version: (current ?? 0) + 1 })}
            </Button>
          </div>
        )}
      </div>
      {Object.keys(e).length ? (
        <Alert tone="danger" title={t('cannotSave')}>
          {e.examples ?? e.competitorPolicy ?? t('checkFields')}
        </Alert>
      ) : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-5">
        {LISTS.map((l) => (
          <TagList
            key={l}
            label={t(`list.${l}.label`)}
            hint={t(`list.${l}.hint`)}
            placeholder={t(`list.${l}.placeholder`)}
            items={lists[l]}
            onChange={(next) => setLists({ ...lists, [l]: next })}
            error={e[l]}
            disabled={disabled}
          />
        ))}
      </div>

      <div className="card card-sm flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold">{t('competitorPolicy')}</span>
          <span className="text-meta text-faint">{t('competitorPolicyHint')}</span>
        </div>
        <div className="flex flex-wrap gap-6">
          {COMPETITOR_POLICIES.map((value) => (
            <Radio
              key={value}
              name="competitorPolicy"
              value={value}
              label={t(`policy.${value}`)}
              checked={policy === value}
              onChange={() => setPolicy(value)}
              disabled={disabled}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold">{t('examples')}</span>
            <span className="text-meta text-faint">{t('examplesHint')}</span>
          </div>
          {disabled ? null : (
            <Button type="button" size="sm" onClick={() => setExamples([...examples, { term: '', relevant: true, note: '' }])}>
              {t('addExample')}
            </Button>
          )}
        </div>
        {examples.length === 0 ? (
          <div className="card card-sm p-8 text-center text-sm text-muted">{t('noExamples')}</div>
        ) : (
          <DataTable minWidth={640}>
            <thead>
              <tr>
                <th className="w-[32%]">{t('term')}</th>
                <th className="w-[150px]">{t('judgement')}</th>
                <th>{t('note')}</th>
                {disabled ? null : <th className="w-12" />}
              </tr>
            </thead>
            <tbody>
              {examples.map((x, i) => (
                <tr key={i}>
                  <td>
                    <Input size="sm" aria-label={t('term')} value={x.term} onChange={(ev) => setExample(i, { term: ev.target.value })} disabled={disabled} />
                  </td>
                  <td>
                    <Select size="sm" aria-label={t('judgement')} value={x.relevant ? 'yes' : 'no'} onChange={(ev) => setExample(i, { relevant: ev.target.value === 'yes' })} disabled={disabled}>
                      <option value="yes">{t('relevant')}</option>
                      <option value="no">{t('irrelevant')}</option>
                    </Select>
                  </td>
                  <td>
                    <Input size="sm" aria-label={t('note')} value={x.note} onChange={(ev) => setExample(i, { note: ev.target.value })} disabled={disabled} />
                  </td>
                  {disabled ? null : (
                    <td>
                      <button type="button" className="icon-btn" aria-label={t('removeExample')} onClick={() => setExamples(examples.filter((_, n) => n !== i))}>
                        <Icon name="trash" size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </form>
  );
}

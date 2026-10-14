import { authorize } from '@arlo/core';
import { getRule, toRuleInstance } from '@arlo/db';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { RuleForm } from '../../../../../components/rule-form';
import { PageHeader } from '../../../../../components/ui';
import { ruleToFormValues } from '../../../../../lib/rules';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { ruleFormOptions } from '../../../../../lib/settings-page-data';
import { saveRuleAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/settings/rules');
  const { id } = await params;
  const db = getDb();
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await getRule(db, id) : undefined;
  if (!row) notFound();
  const rule = toRuleInstance(row);
  const t = await getTranslations('rules');
  return (
    <>
      <PageHeader back={{ href: '/settings/rules', label: t('title') }} title={t('edit')} />
      <RuleForm
        action={saveRuleAction.bind(null, row.id)}
        initial={ruleToFormValues({ scopeKind: row.scopeKind, accountId: row.accountId, campaignEntityId: row.campaignEntityId, spec: rule.spec, severity: row.severity, enabled: row.enabled })}
        {...await ruleFormOptions(db)}
      />
    </>
  );
}

import { authorize } from '@arlo/core';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { RuleForm } from '../../../../../components/rule-form';
import { PageHeader } from '../../../../../components/ui';
import { getDb } from '../../../../../lib/server';
import { requireUser } from '../../../../../lib/session';
import { ruleFormOptions } from '../../../../../lib/settings-page-data';
import { saveRuleAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewRulePage() {
  const user = await requireUser();
  if (!authorize(user, 'admin').allowed) redirect('/settings/rules');
  const t = await getTranslations('rules');
  return (
    <>
      <PageHeader back={{ href: '/settings/rules', label: t('title') }} title={t('new')} />
      <RuleForm
        action={saveRuleAction.bind(null, null)}
        initial={{ type: 'DailyBudgetCap', scopeKind: 'org', accountId: '', campaignEntityId: '', severity: 'HARD_BLOCK', enabled: true, fields: {} }}
        {...await ruleFormOptions(getDb())}
      />
    </>
  );
}

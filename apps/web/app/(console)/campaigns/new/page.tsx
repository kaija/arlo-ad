import { authorize } from '@arlo/core';
import { resolveAccounts } from '@arlo/db';
import { redirect } from 'next/navigation';
import { BriefForm } from '../../../../components/brief-form';
import { Card, PageTitle } from '../../../../components/ui';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { submitBriefAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  const user = await requireUser();
  const accounts = (await resolveAccounts(getDb(), { allowed: readableAccounts(user) })).filter((a) => authorize(user, 'propose', { accountId: a.id }).allowed);
  if (accounts.length === 0) redirect('/campaigns');
  return (
    <>
      <PageTitle>新增 Campaign brief</PageTitle>
      <Card>
        <BriefForm
          action={submitBriefAction}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))}
          initial={{ accountId: accounts[0]!.id, name: '', objective: '', offering: '', landingPageUrl: '', audience: '', locations: '台灣', languages: 'zh-TW', dailyBudget: '', notes: '' }}
        />
      </Card>
    </>
  );
}

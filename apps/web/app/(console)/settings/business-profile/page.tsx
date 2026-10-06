import { authorize, EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { getBusinessProfile, listProfileVersions, resolveAccounts } from '@arlo/db';
import { ProfileForm } from '../../../../components/profile-form';
import { Button, Card, inputClass, PageTitle } from '../../../../components/ui';
import { profileToForm } from '../../../../lib/business-profile';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { saveProfileAction } from './actions';

export const dynamic = 'force-dynamic';

// Business Profile per account (ADR-0019, Requirement 14.1): the search term classifier's context.
export default async function BusinessProfilePage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const db = getDb();
  const accounts = await resolveAccounts(db, { allowed: readableAccounts(user) });
  const { account: wanted } = await searchParams;
  const account = accounts.find((a) => a.id === wanted) ?? accounts[0];
  if (!account) {
    return (
      <Card title="Business Profile">
        <p className="text-sm text-zinc-500">沒有可設定的帳戶。</p>
      </Card>
    );
  }
  const [stored, versions] = await Promise.all([getBusinessProfile(db, account.id), listProfileVersions(db, account.id, 10)]);

  return (
    <>
      <PageTitle
        actions={
          <form method="get" className="flex gap-2">
            <select name="account" defaultValue={account.id} className={inputClass} aria-label="帳戶">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" type="submit">
              切換
            </Button>
          </form>
        }
      >
        Business Profile · {account.name}
      </PageTitle>
      <Card title={stored ? `第 ${stored.version} 版` : '尚未設定'}>
        <ProfileForm action={saveProfileAction.bind(null, account.id)} initial={profileToForm(stored?.profile ?? EMPTY_BUSINESS_PROFILE)} disabled={!isAdmin} />
      </Card>
      {versions.length ? (
        <Card title="版本紀錄" className="mt-4">
          <ul className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {versions.map((v) => (
              <li key={v.version}>
                第 {v.version} 版 · {formatAt(v.createdAt, account.timezone)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

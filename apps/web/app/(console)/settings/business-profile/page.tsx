import { authorize, EMPTY_BUSINESS_PROFILE } from '@arlo/core';
import { getBusinessProfile, listProfileVersions, resolveAccounts } from '@arlo/db';
import { ProfileForm } from '../../../../components/profile-form';
import { Alert, Card, PageHeader } from '../../../../components/ui';
import { profileToForm } from '../../../../lib/business-profile';
import { getDb } from '../../../../lib/server';
import { readableAccounts, requireUser } from '../../../../lib/session';
import { formatAt } from '../../../../lib/time';
import { saveProfileAction } from './actions';

export const dynamic = 'force-dynamic';

const SUBTITLE = '搜尋字詞分類與否定關鍵字的判斷依據。每個帳戶一份，每次儲存產生新版本。';

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
      <>
        <PageHeader back={{ href: '/settings', label: '設定' }} title="Business Profile" subtitle={SUBTITLE} />
        <div className="card card-sm p-10 text-center text-sm text-muted">沒有可設定的帳戶。</div>
      </>
    );
  }
  const [stored, versions] = await Promise.all([getBusinessProfile(db, account.id), listProfileVersions(db, account.id, 10)]);

  return (
    <>
      <PageHeader back={{ href: '/settings', label: '設定' }} title="Business Profile" subtitle={`${account.name} · ${SUBTITLE}`} />
      {isAdmin ? null : <Alert title="唯讀">所有設定只有 Admin 能修改，你目前可以檢視。</Alert>}
      <ProfileForm
        // A different account is a different form: drop any unsaved edits.
        key={account.id}
        action={saveProfileAction.bind(null, account.id)}
        initial={profileToForm(stored?.profile ?? EMPTY_BUSINESS_PROFILE)}
        version={stored?.version ?? null}
        updated={versions[0] ? `最後更新 ${formatAt(versions[0].createdAt, account.timezone)}` : undefined}
        accountName={account.name}
        disabled={!isAdmin}
      />
      {versions.length ? (
        <Card padding="sm" title="版本紀錄" className="gap-1">
          {versions.map((v) => (
            <div key={v.version} className="flex items-center gap-2.5 border-t border-border py-[9px] text-meta">
              <span className="w-9 font-mono font-semibold">v{v.version}</span>
              <span className="text-faint">{formatAt(v.createdAt, account.timezone)}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

import Link from 'next/link';
import { Card, PageTitle } from '../../../components/ui';
import { requireUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  { href: '/settings/rules', title: 'Validator 規則', text: '預算上限、月花費上限、變動幅度、出價範圍、每日變更次數（ADR-0008）。' },
  { href: '/settings/thresholds', title: 'Tier 門檻', text: '哪些變更可自動執行、哪些需要 Tier 3 確認（ADR-0007）。' },
  { href: '/settings/users', title: '使用者與權限', text: '角色、帳戶範圍、可審核的 Tier 上限、Slack 綁定（ADR-0010）。' },
  { href: '/schedules', title: '排程', text: '定期報告與自動化任務（ADR-0016）。' },
];

// Settings hub (Requirement 18.4).
export default async function SettingsPage() {
  await requireUser();
  return (
    <>
      <PageTitle>設定</PageTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="block">
            <Card title={s.title} className="h-full transition hover:border-zinc-400">
              <p className="text-sm text-zinc-500">{s.text}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

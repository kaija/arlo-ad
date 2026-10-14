import { authorize } from '@arlo/core';
import Link from 'next/link';
import { Alert, Icon, PageHeader, type IconName } from '../../../components/ui';
import { requireUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const SECTIONS: { href: string; title: string; text: string; icon: IconName }[] = [
  { href: '/settings/rules', title: 'Validator 規則', text: '每筆變更單送審前檢查的規則，例如預算上限、變動幅度。', icon: 'check-circle' },
  { href: '/settings/monitor', title: 'Monitor 熔斷規則', text: '花費超速、CPA 暴增時自動暫停或降預算。', icon: 'zap' },
  { href: '/settings/thresholds', title: 'Tier 門檻', text: '決定變更單屬於哪個風險分級。', icon: 'filter' },
  { href: '/settings/business-profile', title: 'Business Profile', text: '告訴 AI 你賣什麼、要哪些搜尋意圖。', icon: 'file' },
  { href: '/settings/users', title: '使用者與權限', text: '角色、可審核的 Tier、帳戶範圍與 Slack 綁定。', icon: 'user' },
  { href: '/schedules', title: '排程', text: '定時報告、否定關鍵字掃描等排程任務。', icon: 'calendar' },
];

// Settings hub (Requirement 18.4).
export default async function SettingsPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  return (
    <>
      <PageHeader title="設定" subtitle="管理 Arlo 的規則、門檻與權限。所有設定只有 Admin 能修改。" />
      {isAdmin ? null : <Alert title="唯讀">所有設定只有 Admin 能修改，你目前可以檢視。</Alert>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="card card-sm card-interactive flex flex-col gap-3">
            <span className="icon-tile">
              <Icon name={s.icon} size={20} />
            </span>
            <span className="text-base font-semibold tracking-[-0.01em]">{s.title}</span>
            <span className="text-sm text-muted">{s.text}</span>
            <span className="mt-auto text-meta text-accent">{isAdmin ? '管理' : '檢視'} →</span>
          </Link>
        ))}
      </div>
    </>
  );
}

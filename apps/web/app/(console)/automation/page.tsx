import { authorize, AUTOMATION_FEATURES, AUTOMATION_MODES, formatPct } from '@arlo/core';
import { Badge, Button, Card, inputClass, PageTitle, Table, Td } from '../../../components/ui';
import { FEATURE_LABEL, loadAutomation, MODE_LABEL } from '../../../lib/automation';
import { getDb } from '../../../lib/server';
import { readableAccounts, requireUser } from '../../../lib/session';
import { setModeAction } from './actions';

export const dynamic = 'force-dynamic';

const MODE_TONE = { off: 'neutral', shadow: 'info', live: 'ok' } as const;

function accuracyText(c: { judged: number; correct: number; accuracy: number | null; simulated: number }) {
  return c.accuracy === null ? `${c.simulated} 次模擬 · 尚無回饋` : `${formatPct(c.accuracy, 0)}（${c.correct}/${c.judged}）· ${c.simulated} 次模擬`;
}

// Automation modes and shadow accuracy (ADR-0013, Requirements 9.1, 9.5).
export default async function AutomationPage() {
  const user = await requireUser();
  const isAdmin = authorize(user, 'admin').allowed;
  const { rows, totals } = await loadAutomation(getDb(), readableAccounts(user));

  return (
    <>
      <PageTitle>自動化</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-zinc-500">
        每個帳戶的每項自動化都有模式：Shadow 會完整驗證與分級但不寫入，並在 Slack 發「若為 live 會執行」卡片收集 👍/👎；準確率足夠再切到 Live。新帳戶預設 Shadow。
      </p>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AUTOMATION_FEATURES.map((f) => (
          <Card key={f} title={FEATURE_LABEL[f]}>
            <div className="text-2xl font-semibold tabular-nums">{totals[f].accuracy === null ? '—' : formatPct(totals[f].accuracy, 0)}</div>
            <div className="text-xs text-zinc-500">{accuracyText(totals[f])}</div>
          </Card>
        ))}
      </div>
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">沒有可檢視的帳戶。</p>
        ) : (
          <Table head={['帳戶', ...AUTOMATION_FEATURES.map((f) => FEATURE_LABEL[f])]}>
            {rows.map(({ account, features }) => (
              <tr key={account.id}>
                <Td first className="font-medium">
                  {account.name}
                </Td>
                {AUTOMATION_FEATURES.map((f) => {
                  const cell = features[f];
                  return (
                    <Td key={f}>
                      <div className="flex flex-col items-end gap-1">
                        {isAdmin ? (
                          <form action={setModeAction.bind(null, account.id, f)} className="flex gap-1">
                            <select name="mode" defaultValue={cell.mode} className={inputClass} aria-label={`${account.name} ${FEATURE_LABEL[f]}`}>
                              {AUTOMATION_MODES.map((m) => (
                                <option key={m} value={m}>
                                  {MODE_LABEL[m]}
                                </option>
                              ))}
                            </select>
                            <Button type="submit" variant="secondary">
                              套用
                            </Button>
                          </form>
                        ) : (
                          <Badge tone={MODE_TONE[cell.mode]}>{MODE_LABEL[cell.mode]}</Badge>
                        )}
                        <span className="text-xs text-zinc-500">{accuracyText(cell)}</span>
                      </div>
                    </Td>
                  );
                })}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

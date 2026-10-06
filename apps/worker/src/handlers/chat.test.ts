import { FakeChatAdapter } from '@arlo/adapters/chat';
import { createAnalystAgent, createOrchestrator, PgSession, slackSessionId } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { DEFAULT_ORG_ID, schema, setSlackBinding, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled, type AgentInputItem, type ModelRequest } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleMention, PROGRESS_EMOJI, stripMentions, type ChatJobDeps } from './chat';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });

const textOf = (item: AgentInputItem) => {
  const c = (item as { content?: unknown }).content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : '';
};
const inputTexts = (req: ModelRequest) => (typeof req.input === 'string' ? [req.input] : req.input.map(textOf));

describe('chat.mention handler', () => {
  const t = useTestDatabase();
  let chat: FakeChatAdapter;
  let model: ScriptedModel;
  let deps: ChatJobDeps;
  let answers = 0;

  beforeAll(async () => {
    const pat = await upsertUserOnSignIn(t.db, { email: 'pat@example.com', displayName: 'Pat' });
    await setSlackBinding(t.db, pat.id, 'UPAT');
    await t.db.insert(schema.roleBindings).values({ orgId: DEFAULT_ORG_ID, userId: pat.id, role: 'viewer' });
    // Bound but without any role binding.
    const noRole = await upsertUserOnSignIn(t.db, { email: 'norole@example.com' });
    await setSlackBinding(t.db, noRole.id, 'UNOROLE');

    chat = new FakeChatAdapter().addUser('UKAI', { displayName: 'Kai' }).addUser('UPAT', { displayName: 'Pat' });
    model = new ScriptedModel(() => [say(`回答 ${++answers}`)]);
    deps = {
      db: t.db,
      chat,
      logger,
      now: () => new Date('2026-10-06T04:00:00Z'),
      orchestrator: () => createOrchestrator({ model, specialists: { analyst: createAnalystAgent({ model }) } }),
    };
  });

  const mention = (channelId: string, text: string, messageTs: string, threadTs?: string, userId = 'UPAT') =>
    handleMention(deps, { eventId: `ev-${messageTs}`, channelId, userId, text, messageTs, threadTs }, logger);

  it('in a thread: reads the root and replies, replies in the thread and clears the progress reaction', async () => {
    const root = chat.say('C1', 'UKAI', 'Brand 的 CPA 好像變高了');
    chat.say('C1', 'UKAI', '從週二開始', root);
    const ts = chat.say('C1', 'UPAT', '<@UBOT> 幫我看一下原因', root);
    await mention('C1', '<@UBOT> 幫我看一下原因', ts, root);

    const [request] = model.requests.slice(-1);
    expect(inputTexts(request!)).toEqual(['[其他參與者 Kai]\nBrand 的 CPA 好像變高了', '[其他參與者 Kai]\n從週二開始', '[發問者 Pat]\n幫我看一下原因']);
    const replies = chat.postedTo('C1', root);
    expect(replies.map((r) => r.message)).toEqual([{ type: 'reply', text: '回答 1' }]);
    expect(chat.reactionLog).toEqual([`+${PROGRESS_EMOJI}@C1:${ts}`, `-${PROGRESS_EMOJI}@C1:${ts}`]);
  });

  it('on the main line: reads the 10 messages before and opens a thread under the mention', async () => {
    for (let i = 0; i < 12; i++) chat.say('C2', 'UKAI', `主線訊息 ${i}`);
    const ts = chat.say('C2', 'UPAT', '<@UBOT> 這個月 pacing 如何？');
    await handleMention(deps, { eventId: 'ev-main', channelId: 'C2', userId: 'UPAT', text: '<@UBOT> 這個月 pacing 如何？', messageTs: ts }, logger);

    const input = inputTexts(model.requests.at(-1)!);
    expect(input).toHaveLength(11);
    expect(input[0]).toBe('[其他參與者 Kai]\n主線訊息 2');
    expect(input.at(-1)).toBe('[發問者 Pat]\n這個月 pacing 如何？');
    expect(chat.postedTo('C2', ts)).toHaveLength(1);
    const session = new PgSession({ db: t.db, sessionId: slackSessionId('C2', ts) });
    expect(await session.getLastSlackTs()).toBe(chat.postedTo('C2', ts)[0]!.ref.messageId);
  });

  it('on a second mention: adds only the messages since the last reply to the session', async () => {
    const root = chat.say('C3', 'UKAI', '第一個問題的背景');
    const first = chat.say('C3', 'UPAT', '<@UBOT> 第一題', root);
    await mention('C3', '<@UBOT> 第一題', first, root);
    chat.say('C3', 'UKAI', '補充：只看 Brand', root);
    const second = chat.say('C3', 'UPAT', '<@UBOT> 那第二題呢', root);
    await mention('C3', '<@UBOT> 那第二題呢', second, root);

    const texts = inputTexts(model.requests.at(-1)!);
    // History from the first run, then only the new message, then the question.
    expect(texts.filter((x) => x.includes('第一個問題的背景'))).toHaveLength(1);
    expect(texts.slice(-2)).toEqual(['[其他參與者 Kai]\n補充：只看 Brand', '[發問者 Pat]\n那第二題呢']);
    expect(texts.some((x) => x.includes('回答'))).toBe(true);
    expect(chat.postedTo('C3', root)).toHaveLength(2);
  });

  it.each([
    ['an unbound Slack user', 'USTRANGER', '尚未對應'],
    ['a user without a role', 'UNOROLE', '沒有使用 Arlo Ads Bot 的權限'],
  ])('rejects %s with an ephemeral message and no run', async (_, userId, message) => {
    const before = model.requests.length;
    const ts = chat.say('C4', userId, '<@UBOT> hi');
    await mention('C4', '<@UBOT> hi', ts, undefined, userId);
    expect(model.requests.length).toBe(before);
    expect(chat.ephemerals.at(-1)).toMatchObject({ userId, text: expect.stringContaining(message) });
    expect(chat.reactions.get(`C4:${ts}`)?.size ?? 0).toBe(0);
  });

  it('replies with a friendly error when the run fails', async () => {
    const failing: ChatJobDeps = {
      ...deps,
      orchestrator: () =>
        createOrchestrator({
          model: new ScriptedModel(() => {
            throw new Error('model down');
          }),
          specialists: { analyst: createAnalystAgent({ model }) },
        }),
    };
    const ts = chat.say('C5', 'UPAT', '<@UBOT> 還好嗎');
    await handleMention(failing, { eventId: 'ev-fail', channelId: 'C5', userId: 'UPAT', text: '<@UBOT> 還好嗎', messageTs: ts }, logger);
    expect(chat.postedTo('C5', ts)[0]?.message).toEqual({ type: 'reply', text: expect.stringContaining('發生錯誤') });
  });

  it('strips leading bot mentions only', () => {
    expect(stripMentions('<@UBOT>  <@UBOT2> 問 <@UKAI> 的帳戶')).toBe('問 <@UKAI> 的帳戶');
  });
});

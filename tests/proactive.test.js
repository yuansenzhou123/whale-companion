'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/config');
const { Store } = require('../src/memory');
const { Bot } = require('../src/bot');
const { ProactiveChat, beijingTime } = require('../src/proactive');
const personaStore = require('../src/personaStore');
const persona = require('../src/persona');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-proactive-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.paths = { root: dir, dataDir: dir, storeFile: path.join(dir, 'store.json') };
  Object.assign(config.persona, { stylePreset: '可爱', proactive: true, emojiLevel: '少', master: { names: ['主人甲'], wxids: ['wxid_owner'] } });
  config.gateway.wechat.enabled = true;
  config.proactiveChat.enabled = true;
  let clock = new Date('2026-10-24T10:00:00+08:00');
  const now = () => new Date(clock);
  const store = new Store({ file: config.paths.storeFile, limits: config.memory });
  const calls = [];
  const llm = { isMock: false, model: 'test', reload() {}, async complete(input) { calls.push(input); return '想找你聊两句啦，最近有没有喜欢的歌呀'; } };
  const bot = new Bot({ config, store, llm, now, logger: null, rng: () => 0.99, mockChunkDelayMs: 0 });
  const service = new ProactiveChat({ config, store, bot, llm, now });
  const key = 'wechat:u:wxid_owner';
  const session = store.ensureSession(key, { platform: 'wechat', chatId: 'wxid_owner', chatType: 'private' });
  store.appendMessage(key, { role: 'user', uid: 'wxid_owner', name: '主人甲', text: '今天在找好听的歌', ts: clock.getTime() - 65 * 60000 });
  store.appendMessage(key, { role: 'assistant', text: '想听哪种风格呀', ts: clock.getTime() - 64 * 60000 });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { config, store, session, service, bot, llm, calls, key, now, advance(minutes) { clock = new Date(clock.getTime() + minutes * 60000); } };
}

test('主动开聊使用真实上下文，领取时不伪造已发送消息，成功确认才记入历史', async (t) => {
  const f = setup(t);
  const result = await f.service.next();
  assert.equal(result.message.chatId, 'wxid_owner');
  assert.equal(result.message.chatType, 'private');
  assert.equal(f.session.messages.length, 2);
  assert.match(f.calls[0].system, /主动找主人聊天/);
  assert.match(f.calls[0].system, /不催回复/);
  assert.match(f.calls[0].turns.map((entry) => entry.content).join(''), /今天在找好听的歌/);
  assert.equal(f.service.ack(result.message.id, true).ok, true);
  assert.equal(f.session.messages.at(-1).text, result.message.text);
  assert.equal(f.session.messages.at(-1).proactive, true);
  assert.equal(f.service.ack(result.message.id, true).duplicate, true);
  assert.equal(f.session.messages.length, 3);
});

test('空闲不足一小时不触发，超过后才生成', async (t) => {
  const f = setup(t);
  f.session.lastActiveAt = f.now().getTime() - 59 * 60000;
  assert.equal((await f.service.next()).message, null);
  assert.equal(f.calls.length, 0);
  f.advance(2);
  assert.ok((await f.service.next()).message);
});

test('未回复时跨天和重启都不连续追问，领取确认丢失也不重发', async (t) => {
  const f = setup(t);
  const first = await f.service.next();
  f.advance(24 * 60);
  assert.equal((await f.service.next()).message, null);
  const reloaded = new Store({ file: f.config.paths.storeFile, limits: f.config.memory });
  t.after(() => reloaded.close());
  const service = new ProactiveChat({ config: f.config, store: reloaded, bot: f.bot, llm: f.llm, now: f.now });
  assert.equal((await service.next()).message, null);
  assert.equal(service.ack(first.message.id, true).ok, true);
  assert.equal(service.ack(first.message.id, true).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('回复后可再次主动开聊，但每天最多三次，次日北京时间重新计数', async (t) => {
  const f = setup(t);
  f.llm.complete = async () => `新话题 ${f.now().getTime()}，最近有什么想聊的呀`;
  for (let i = 0; i < 3; i++) {
    const { message } = await f.service.next();
    assert.ok(message, '第 ' + (i + 1) + ' 次应该可以触发');
    f.service.ack(message.id, true);
    f.advance(1);
    f.store.appendMessage(f.key, { role: 'user', uid: 'wxid_owner', name: '主人甲', text: '可以继续聊呀', ts: f.now().getTime() });
    f.advance(61);
  }
  assert.equal((await f.service.next()).message, null);
  f.advance(24 * 60 - 186);
  assert.ok((await f.service.next()).message);
});

test('只允许微信主人已有私聊，不给群聊、冒名者和不匹配的会话主动发消息', async (t) => {
  for (const change of [
    (f) => { f.session.chatType = 'group'; },
    (f) => { f.session.platform = 'web'; },
    (f) => { f.session.messages[0].uid = 'wxid_impostor'; },
    (f) => { f.config.persona.master.wxids = []; },
    (f) => { f.session.messages = []; },
  ]) {
    const f = setup(t);
    change(f);
    assert.equal((await f.service.next()).message, null);
    assert.equal(f.calls.length, 0);
  }
});

test('夜间、关闭开关、闭麦、休息和暂停标记都会阻止主动生成', async (t) => {
  const changes = [
    (f) => { f.advance(12 * 60); },
    (f) => { f.config.proactiveChat.enabled = false; },
    (f) => { f.config.persona.proactive = false; },
    (f) => { f.config.gateway.wechat.enabled = false; },
    (f) => { f.session.state.mutedUntil = f.now().getTime() + 60000; },
    (f) => { f.session.state.silentUntil = f.now().getTime() + 60000; },
    (f) => { fs.writeFileSync(path.join(f.config.paths.dataDir, 'PAUSED'), ''); },
    (f) => { fs.writeFileSync(path.join(f.config.paths.dataDir, 'away.json'), JSON.stringify({ until: f.now().getTime() + 60000 })); },
  ];
  for (const change of changes) {
    const f = setup(t);
    change(f);
    assert.equal((await f.service.next()).message, null);
    assert.equal(f.calls.length, 0);
  }
  assert.deepEqual(beijingTime(new Date('2026-10-24T16:30:00Z')), { day: '2026-10-25', hour: 0 });
});

test('模型生成期间主人回复或关掉开关就丢弃开场，并发领取不重复生成', async (t) => {
  const f = setup(t);
  let finish;
  f.llm.complete = () => new Promise((resolve) => { finish = resolve; });
  const first = f.service.next();
  assert.equal((await f.service.next()).message, null);
  f.store.appendMessage(f.key, { role: 'user', uid: 'wxid_owner', name: '主人甲', text: '我回来啦', ts: f.now().getTime() });
  finish('刚好想找你啦');
  assert.equal((await first).message, null);
  assert.equal(f.session.state.proactiveChat.awaiting, undefined);
  f.advance(65);
  const second = f.service.next();
  f.config.proactiveChat.enabled = false;
  finish('又来找你啦');
  assert.equal((await second).message, null);
});

test('发送失败不写入聊天记录，也不会每次轮询都重试', async (t) => {
  const f = setup(t);
  const result = await f.service.next();
  f.service.ack(result.message.id, false);
  assert.equal(f.session.messages.length, 2);
  assert.equal((await f.service.next()).message, null);
  assert.equal(f.service.ack('unknown-id', true).ok, false);
});

test('模型失败会保留冷却，不连续消耗模型调用', async (t) => {
  const f = setup(t);
  f.llm.complete = async () => { throw new Error('network'); };
  await assert.rejects(f.service.next(), /network/);
  assert.equal((await f.service.next()).message, null);
});

test('状态无法持久化时不向桥接交付消息', async (t) => {
  const f = setup(t);
  f.store.flush = () => {};
  await assert.rejects(f.service.next(), /状态未能保存/);
  assert.equal(f.calls.length, 0);
});

test('主动配置保存后可恢复，微信命令支持开关、间隔和上限', async (t) => {
  const f = setup(t);
  for (const text of ['主动聊天 开', '主动聊天 间隔 75', '主动聊天 上限 4']) {
    const result = await f.bot.handle({ platform: 'wechat', chatType: 'private', chatId: 'wxid_owner', senderId: 'wxid_owner', senderName: '主人甲', text });
    assert.equal(result.reason, 'command');
  }
  const saved = personaStore.load(f.config);
  assert.equal(saved.proactiveChat, true);
  assert.equal(saved.proactiveIdleMinutes, 75);
  assert.equal(saved.proactiveDailyLimit, 4);
  const copy = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  personaStore.apply(copy, saved);
  assert.deepEqual(copy.proactiveChat, { enabled: true, idleMinutes: 75, dailyLimit: 4, startHour: 9, endHour: 22 });
  await f.bot.handle({ platform: 'wechat', chatType: 'private', chatId: 'wxid_owner', senderId: 'wxid_owner', senderName: '主人甲', text: '主动聊天 关' });
  assert.equal(f.config.proactiveChat.enabled, false);
});

test('默认与自定义人设都会主动延伸话题，关闭后都停止', () => {
  for (const customPrompt of ['', '你是鲸鲸。']) {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.persona.customPrompt = customPrompt;
    const msg = { chatType: 'private', senderName: '小海', text: '你好' };
    assert.match(persona.buildSystem({ config, msg }), /主动关心与延伸话题/);
    config.persona.proactive = false;
    assert.match(persona.buildSystem({ config, msg }), /别主动找话题/);
    assert.doesNotMatch(persona.buildSystem({ config, msg }), /主动关心与延伸话题/);
  }
});

test('主动私信沿用当前已学表达偏好，不另外学习或生成虚假用户反馈',async t=>{
 const f=setup(t),seen=[];f.bot.styleLearning={contextFor:msg=>{seen.push(msg);return '\nSTYLE_PREFERENCE_PROACTIVE_MARKER';}};
 await f.service.next();assert.equal(seen.length,1);assert.equal(seen[0].senderId,'wxid_owner');assert.equal(seen[0].chatId,'wxid_owner');assert.match(f.calls[0].system,/STYLE_PREFERENCE_PROACTIVE_MARKER/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/config');
const persona = require('../src/persona');
const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');

function cuteConfig() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config.persona, { stylePreset: '可爱', styleText: '被夸时有点小得意', emojiLevel: '少' });
  return config;
}

function makeBot(t, { reply = '在呢～今天也想听你说话！🐋', mock = false } = {}) {
  const config = cuteConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cute-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, logger: null, rng: () => 0.99, mockChunkDelayMs: 0,
    llm: { isMock: mock, model: 'test', reload() {}, async complete() { return reply; } } });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { bot, config, store };
}

const msg = (text, extra = {}) => ({
  platform: 'web', chatId: 'cute', chatType: 'private', senderId: 'friend', senderName: '小海', text, ...extra,
});

for (const customPrompt of ['', '你是鲸鲸，喜欢小蓝鲸玩偶。']) {
  test(`${customPrompt ? '自定义' : '默认'}可爱人设使用相同语气设置，并保留准确回答与关系边界`, () => {
    const config = cuteConfig();
    config.persona.customPrompt = customPrompt;
    const system = persona.buildSystem({ config, msg: msg('在吗') });
    if (customPrompt) assert.ok(system.startsWith(customPrompt));
    assert.match(system, /整体语气：可爱/);
    assert.match(system, /被夸时有点小得意/);
    assert.match(system, /可爱说话示例/);
    assert.match(system, /很少用颜文字或 emoji/);
    assert.match(system, /正经问题认真答/);
    assert.match(system, /只对已认证的主人/);
    assert.match(system, /对话理解与回答质量（最高优先级）/);
    assert.doesNotMatch(system, /直接最大档火力回骂|第二条人格：贴吧老哥|你：在，咋啦/);
  });

  test(`${customPrompt ? '自定义' : '默认'}可爱人设被挑衅或维护主人时仍保持分寸`, () => {
    const config = cuteConfig();
    config.persona.customPrompt = customPrompt;
    const system = persona.buildSystem({ config, msg: msg('有人骂我', {
      isMaster: true, fight: true, fightOnMaster: true, fightTarget: { name: '群友甲', text: '你是废物' },
    }) });
    assert.match(system, /有分寸的小脾气/);
    assert.match(system, /群友甲/);
    assert.match(system, /制止辱骂/);
    assert.doesNotMatch(system, /直接开到最大档|第二条人格：贴吧老哥|往死里骂|直接冲这个人大骂/);
  });
}

test('完整自定义提示词也能读取非可爱语气和表情开关', () => {
  const config = cuteConfig();
  Object.assign(config.persona, { customPrompt: '你是鲸鲸。', stylePreset: '温柔', emojiLevel: '关' });
  const system = persona.buildSystem({ config, msg: msg('你好') });
  assert.match(system, /整体语气：温柔/);
  assert.match(system, /被夸时有点小得意/);
  assert.match(system, /完全不用颜文字和 emoji/);
});

for (const chatType of ['private', 'group']) {
  test(`可爱风格${chatType}实际发送保留标点和表情，不额外拆出表情气泡`, async (t) => {
    const { bot, store } = makeBot(t);
    const result = await bot.handle(msg('早上好', { chatType, atMe: true }));
    assert.equal(result.action, 'reply');
    assert.equal(result.reply, '在呢～今天也想听你说话！🐋');
    assert.deepEqual(result.bubbles, [result.reply]);
    const saved = store.messages(bot.sessionKey(msg('早上好', { chatType })), 10);
    assert.equal(saved.at(-1).role, 'assistant');
    assert.equal(saved.at(-1).text, result.reply);
  });
}

test('可爱风格保留组合表情，关闭表情后不残留连接符、肤色或旗帜碎片', (t) => {
  const { bot, config } = makeBot(t);
  const text = '收到啦～👩🏽‍💻🇨🇳🐋';
  const decision = { key: 'test', action: 'reply', msg: msg('请帮我看看') };
  assert.deepEqual(bot.finalize(decision, text), [text]);
  config.persona.emojiLevel = '关';
  config.chat.emojiChance = 1;
  assert.deepEqual(bot.finalize({ ...decision }, text), ['收到啦～']);
});

test('可爱风格限制连续标点，长回复仍遵守气泡数量设置', (t) => {
  const { bot, config } = makeBot(t);
  const decision = { key: 'test', action: 'reply', msg: msg('请详细说说') };
  assert.deepEqual(bot.finalize(decision, '来啦～～～收到！！！'), ['来啦～收到！']);
  config.chat.maxBubbles = 1;
  config.chat.privateMaxChars = 30;
  const bubbles = bot.finalize({ ...decision }, '这是一段需要分开发送的长消息呀。'.repeat(10));
  assert.equal(bubbles.length, 1);
  assert.ok(bubbles[0].length <= 30);
});

test('可爱风格的温和边界回复不会被替换成狠话', async (t) => {
  const reply = '我不想吵，不过这样骂人不好啦';
  const { bot } = makeBot(t, { reply });
  const result = await bot.handle(msg('你就是个废物'));
  assert.equal(result.reply, reply);
  assert.deepEqual(result.bubbles, [reply]);
});

test('可爱风格演示模式也不会抽取重火力台词', async (t) => {
  const { bot } = makeBot(t, { mock: true });
  const result = await bot.handle(msg('你就是个废物'));
  assert.equal(result.reply, '逗我可以，骂人就不好啦');
});

test('可爱风格被要求安静时柔和退场', async (t) => {
  const { bot } = makeBot(t);
  const result = await bot.handle(msg('闭嘴'));
  assert.equal(result.reply, '好啦，我先安静一会儿，想聊再叫我呀');
  assert.equal(result.reason, 'dismissed');
});

test('可爱风格维护主人时点名制止辱骂，兜底不再加入攻击台词', (t) => {
  const { bot } = makeBot(t);
  const decision = { key: 'test', action: 'reply', msg: msg('有人骂我', {
    isMaster: true, fight: true, fightOnMaster: true, fightTarget: { name: '群友甲', text: '废物' },
  }) };
  const bubbles = bot.finalize(decision, '这样说可不好');
  assert.deepEqual(bubbles, ['群友甲，有话好好说嘛，不要骂人啦']);
});

test('可爱风格重写仍复读时，用柔和的兜底回应', (t) => {
  const { bot } = makeBot(t);
  const decision = { key: 'test', action: 'reply', msg: msg('今天好累'), heardList: ['今天好累'] };
  const bubbles = bot.finalize(decision, '今天好累');
  assert.doesNotMatch(bubbles.join(''), /尴尬|你说呢/);
  assert.notEqual(decision.finalText, '今天好累');
});

test('非可爱风格在随机表情概率为零时仍发送模型表情，关闭后不发送', (t) => {
  const { bot, config } = makeBot(t);
  config.persona.stylePreset = '温柔';
  const decision = { key: 'test', action: 'reply', msg: msg('早上好') };
  assert.deepEqual(bot.finalize(decision, '收到啦🐋'), ['收到啦', '🐋']);
  config.persona.emojiLevel = '关';
  config.chat.emojiChance = 1;
  assert.deepEqual(bot.finalize({ ...decision }, '明白啦🐋'), ['明白啦']);
});

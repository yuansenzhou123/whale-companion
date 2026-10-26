'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {DEFAULT_CONFIG} = require('../src/config');
const persona = require('../src/persona');
const {Bot} = require('../src/bot');
const {Store} = require('../src/memory');
const presets = require('../src/presets');
const personaStore = require('../src/personaStore');

function cuteConfig(customPrompt = '') {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.persona, {stylePreset: '可爱', customPrompt});
  return config;
}

for (const customPrompt of ['', '你是蓝色大肥鱼。']) {
  test(`${customPrompt ? '自定义' : '默认'}可爱路径没有强制扩写冲突，并提供闲聊节奏`, () => {
    const system = persona.buildSystem({config: cuteConfig(customPrompt), msg: {chatType: 'private', text: '在干嘛'}});
    if (customPrompt) assert.ok(system.startsWith(customPrompt));
    assert.match(system, /日常接话允许只给一个短短的反应/);
    assert.match(system, /没有最低字数/);
    assert.match(system, /日常闲聊通常只说一小句/);
    assert.match(system, /不声称已替对方烧水做饭/);
    assert.doesNotMatch(system, /不用一个字、敷衍、卖萌或套话代替答案|至少再补一句自己的话|要么给新信息，要么给明确态度/);
    assert.doesNotMatch(system, /那就定面啦|敢选一样|我投番茄鸡蛋面一票/);
    assert.match(system, /正经问题认真答/);
  });
}

test('简短反应按原句而非长度判断，不把短问题误当应声', () => {
  const config = cuteConfig('你是蓝色大肥鱼。');
  for (const text of ['呃', '嗯？', '哦……', '好吧', '哈哈哈']) {
    const system = persona.buildSystem({config, msg: {chatType: 'private', text}});
    assert.match(system, /【本条是简短反应】/, text);
  }
  for (const text of ['解释熵', '吃什么', '几点了', '我很难受', '帮我写代码', '我讨厌你']) {
    const system = persona.buildSystem({config, msg: {chatType: 'private', text}});
    assert.doesNotMatch(system, /【本条是简短反应】/, text);
    assert.match(system, /认真提问、求助、要求详细说明时按需要说清楚/);
  }
});

test('其他语气保留原有回答规则，不套用可爱闲聊规则', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.persona.stylePreset = '温柔';
  const system = persona.buildSystem({config, msg: {chatType: 'private', text: '呃'}});
  assert.match(system, /不用一个字、敷衍、卖萌或套话代替答案/);
  assert.doesNotMatch(system, /【可爱聊天的节奏】|【本条是简短反应】/);
});

function makeBot(t, reply) {
  const config = cuteConfig('你是蓝色大肥鱼。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cute-rhythm-'));
  const store = new Store({file: path.join(dir, 'store.json'), limits: config.memory});
  const captured = [];
  const llm = {isMock: false, model: 'test', reload() {}, async complete(payload) {captured.push(payload); return reply;}};
  const bot = new Bot({config, store, llm, logger: null, rng: () => 0.99, mockChunkDelayMs: 0});
  t.after(() => {store.close(); fs.rmSync(dir, {recursive: true, force: true});});
  const msg = (text) => ({platform: 'wechat', chatId: 'rhythm', chatType: 'private', senderId: 'friend', senderName: '朋友', text});
  return {config, store, bot, captured, msg};
}

for (const [input, reply] of [['呃', '……干嘛呀'], ['嗯', '嗯？'], ['哦', '好呀～']]) {
  test(`微信链路保留 ${input} 的短反应，不强制扩写或另补气泡`, async (t) => {
    const {store, bot, captured, msg} = makeBot(t, reply);
    const result = await bot.handle(msg(input));
    assert.equal(captured.length, 1);
    assert.match(captured[0].system, /【本条是简短反应】/);
    assert.equal(result.reply, reply);
    assert.deepEqual(result.bubbles, [reply]);
    assert.equal(store.messages(bot.sessionKey(msg(input)), 10).at(-1).text, reply);
  });
}

test('可爱语气不截掉认真问题的完整答案', async (t) => {
  const reply = '先把问题分成两步看。第一步确认输入是什么，第二步检查计算结果。这里的例子是三加四等于七；如果换成三乘四，结果就是十二。';
  const {bot, captured, msg} = makeBot(t, reply);
  const result = await bot.handle(msg('请详细解释怎么检查计算结果'));
  assert.doesNotMatch(captured[0].system, /【本条是简短反应】/);
  assert.equal(result.reply, reply);
});

test('v5 单独保存并可导入，旧 v4 与主动聊天设置保留', (t) => {
  const config = cuteConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cute-v5-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  config.paths = {dataDir: dir, root: path.resolve(__dirname, '..')};
  config.proactiveChat = {enabled: true, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22};
  const old = presets.load(config, 'persona-v4');
  const next = presets.load(config, 'persona-v5');
  assert.ok(old && next);
  assert.notEqual(old.customPrompt, next.customPrompt);
  personaStore.save(config, presets.toPatch(next));
  assert.equal(config.persona.customPrompt, next.customPrompt);
  assert.ok(config.persona.historyStyleChangedAt > 0);
  assert.deepEqual(config.proactiveChat, {enabled: true, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22});
  const system = persona.buildSystem({config, msg: {chatType: 'private', text: '呃'}});
  assert.ok(system.startsWith(next.customPrompt));
  assert.match(system, /【本条是简短反应】/);
});

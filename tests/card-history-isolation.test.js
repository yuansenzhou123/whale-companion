'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {DEFAULT_CONFIG} = require('../src/config');
const {Bot} = require('../src/bot');
const {DeepSeekClient} = require('../src/llm');

test('精简私聊不把旧机器人原文换成 user 再传入；用户事实和新回复保留', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.persona, {promptMode: 'compact', historyStyleChangedAt: 1000});
  const history = [
    {role: 'user', text: '我明天有面试', ts: 800},
    {role: 'assistant', text: '我先替你把水烧上，随时给你换菜单。', ts: 900},
    {role: 'user', text: '不想说', ts: 1100},
    {role: 'assistant', text: '嗯，那就不说。', ts: 1200},
  ];
  const snapshot = structuredClone(history);
  const bot = new Bot({config, store: {messages: () => history}, llm: {}, logger: null});
  const turns = bot.buildTurns({chatType: 'private', text: '陪我待会儿'}, history);
  const all = JSON.stringify(turns);
  assert.doesNotMatch(all, /烧上|换菜单|旧人设历史回复/);
  assert.match(all, /我明天有面试/);
  assert.ok(turns.some((turn) => turn.role === 'assistant' && turn.content === '嗯，那就不说。'));
  assert.equal(turns.at(-1).content, '陪我待会儿');
  assert.deepEqual(history, snapshot);
  assert.deepEqual(bot.recentOwn({key: 'test'}), ['嗯，那就不说。']);
  config.persona.promptMode = 'legacy';
  const legacy = bot.buildTurns({chatType: 'private', text: '陪我待会儿'}, history);
  assert.match(JSON.stringify(legacy), /换菜单/);
});

test('切换前没有时间戳的机器人回复也不进入精简私聊请求', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.persona, {promptMode: 'compact', historyStyleChangedAt: 1000});
  const bot = new Bot({config, store: {}, llm: {}, logger: null});
  const turns = bot.buildTurns({chatType: 'private', text: '在吗'}, [{role: 'assistant', text: '旧角色的说法'}, {role: 'user', text: '用户提供的事实'}]);
  assert.doesNotMatch(JSON.stringify(turns), /旧角色的说法/);
  assert.match(JSON.stringify(turns), /用户提供的事实/);
});

test('实际 HTTP 请求有可核对的提示词摘要，日志不包含原文和 Key', async (t) => {
  const logs = [];
  let received;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => {
      received = JSON.parse(raw);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: '收到啦'}}]}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = {settingsFile: path.join(os.tmpdir(), 'whale-no-settings-' + Math.random() + '.json')};
  config.env = {};
  Object.assign(config.deepseek, {baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-secret-not-logged', maxTokens: 50});
  Object.assign(config.persona, {promptMode: 'compact', historyStyleChangedAt: 1000});
  const client = new DeepSeekClient({config, logger: {info: (message) => logs.push(message), debug() {}, warn() {}}});
  const text = await client.complete({system: '私密角色正文不应记录', turns: [{role: 'user', content: '私密用户原文'}, {role: 'assistant', content: '前次回复'}, {role: 'user', content: '新输入'}]});
  assert.equal(text, '收到啦');
  const line = logs.find((message) => message.startsWith('模型请求提示词核对：'));
  assert.ok(line);
  const metadata = JSON.parse(line.split('：')[1]);
  assert.equal(metadata.mode, 'compact');
  assert.equal(metadata.systemChars, received.messages[0].content.length);
  assert.equal(metadata.assistantMessages, 1);
  assert.equal(metadata.historyMessages, 3);
  assert.equal(metadata.styleBoundary, 1000);
  assert.match(metadata.systemHash, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(line, /私密角色正文|私密用户原文|test-secret-not-logged|前次回复/);
});

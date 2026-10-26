'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {DEFAULT_CONFIG} = require('../src/config');
const personaStore = require('../src/personaStore');
const {Bot} = require('../src/bot');
const {startServer} = require('../server');

function configFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-persona-activation-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = {dataDir: dir};
  return config;
}

test('人设页面回填、提交并清空完整提示词，导入后再次保存不丢失', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/persona.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fields = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, {value: '', checked: false, textContent: '', classList: {add() {}, remove() {}}, addEventListener() {}, appendChild() {}});
    return fields.get(id);
  };
  let submitted;
  const sandbox = vm.createContext({
    document: {getElementById: element, createElement: () => ({})},
    setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
    async fetch(url, options) {
      if (options?.method === 'POST') {
        submitted = JSON.parse(options.body);
        return {json: async () => ({ok: true, persona: submitted})};
      }
      return {json: async () => url.endsWith('/presets')
        ? {ok: true, presets: []}
        : {ok: true, persona: {customPrompt: '已导入的完整 v4 人设', promptMode: 'compact'}}};
    },
  });
  vm.runInContext(script, sandbox);
  await new Promise(setImmediate);
  assert.equal(element('customPrompt').value, '已导入的完整 v4 人设');
  assert.equal(element('promptMode').value, 'compact');
  await vm.runInContext('save()', sandbox);
  assert.equal(submitted.customPrompt, '已导入的完整 v4 人设');
  assert.equal(submitted.promptMode, 'compact');
  element('customPrompt').value = '修改后的完整人设';
  await vm.runInContext('save()', sandbox);
  assert.equal(submitted.customPrompt, '修改后的完整人设');
  element('customPrompt').value = '';
  await vm.runInContext('save()', sandbox);
  assert.equal(submitted.customPrompt, '');
});

test('仅改变角色才更新风格边界；普通保存和聊天频率不会重复切换', (t) => {
  const config = configFor(t);
  t.mock.method(Date, 'now', () => 1000);
  personaStore.save(config, {preset: '可爱', customPrompt: '新角色'});
  assert.equal(config.persona.historyStyleChangedAt, 1000);
  t.mock.method(Date, 'now', () => 2000);
  personaStore.save(config, {preset: '可爱', customPrompt: '新角色', historyTurns: 80, proactiveIdleMinutes: 90});
  assert.equal(config.persona.historyStyleChangedAt, 1000);
  personaStore.save(config, {text: '说话更有主意'});
  assert.equal(config.persona.historyStyleChangedAt, 2000);
  const restarted = structuredClone(DEFAULT_CONFIG);
  restarted.paths = config.paths;
  personaStore.apply(restarted, personaStore.load(restarted));
  assert.equal(restarted.persona.historyStyleChangedAt, 2000);
  assert.equal(restarted.persona.customPrompt, '新角色');
});

test('清空完整提示词立即生效，恢复默认及重启后不复活旧提示词', (t) => {
  const config = configFor(t);
  personaStore.save(config, {customPrompt: '旧的完整人设'});
  personaStore.save(config, {customPrompt: ''});
  assert.equal(config.persona.customPrompt, '');
  assert.equal(personaStore.load(config).customPrompt, '');
  personaStore.save(config, {customPrompt: '另一个人设'});
  personaStore.clear(config);
  assert.equal(config.persona.customPrompt, '');
  const restarted = structuredClone(DEFAULT_CONFIG);
  restarted.paths = config.paths;
  personaStore.apply(restarted, personaStore.load(restarted));
  assert.equal(restarted.persona.customPrompt, '');
  assert.ok(restarted.persona.historyStyleChangedAt > 0);
});

test('私聊保留旧回复中的事情但移出 assistant 示范，新风格回复继续正常传入', (t) => {
  const config = configFor(t);
  config.persona.historyStyleChangedAt = 1000;
  const bot = new Bot({config, store: {}, llm: {}, logger: null});
  const history = [
    {role: 'user', text: '明天七点吃饭', ts: 800},
    {role: 'assistant', text: '好，七点在楼下等你。', ts: 900},
    {role: 'user', text: '你真聪明', ts: 1100},
    {role: 'assistant', text: '哼，现在才发现？', ts: 1200},
  ];
  const before = structuredClone(history);
  const turns = bot.buildTurns({chatType: 'private', text: '刚才说几点来着？'}, history);
  const assistant = turns.filter((turn) => turn.role === 'assistant');
  assert.deepEqual(assistant, [{role: 'assistant', content: '哼，现在才发现？'}]);
  assert.match(turns.map((turn) => turn.content).join('\n'), /七点在楼下等你/);
  assert.match(turns.map((turn) => turn.content).join('\n'), /旧人设历史回复/);
  assert.equal(turns.at(-1).content, '刚才说几点来着？');
  assert.deepEqual(history, before, '原始聊天存档不改写');
});

test('没有换人设时不改变正常历史，缺时间戳的旧回复也可隔离', (t) => {
  const config = configFor(t);
  const bot = new Bot({config, store: {}, llm: {}, logger: null});
  const history = [{role: 'user', text: '你好'}, {role: 'assistant', text: '你好呀'}];
  const msg = {chatType: 'private', text: '在吗'};
  assert.equal(bot.buildTurns(msg, history).filter((turn) => turn.role === 'assistant').length, 1);
  config.persona.historyStyleChangedAt = 1000;
  const turns = bot.buildTurns(msg, history);
  assert.equal(turns.filter((turn) => turn.role === 'assistant').length, 0);
  assert.match(turns.map((turn) => turn.content).join('\n'), /你好呀/);
});

test('群聊旧角色回复保留说话人和内容，明确不作为新角色语气范例', (t) => {
  const config = configFor(t);
  config.persona.historyStyleChangedAt = 1000;
  const bot = new Bot({config, store: {}, llm: {}, logger: null});
  const turns = bot.buildTurns({chatType: 'group', chatId: 'test', senderName: '甲', text: '接着说'}, [
    {role: 'user', uid: 'a', name: '甲', text: '七点见', ts: 800},
    {role: 'assistant', text: '在楼下等', ts: 900},
  ]);
  assert.match(turns[0].content, /旧人设回复.*只供事实参考/);
  assert.match(turns[0].content, /"旧人设回复":true/);
  assert.match(turns[0].content, /七点见/);
  assert.match(turns[0].content, /在楼下等/);
});

test('真实本地接口导入 v4、再次保存、配置重载及服务重启都保留完整人设', async (t) => {
  const config = configFor(t);
  const root = path.join(config.paths.dataDir, 'app');
  fs.mkdirSync(path.join(root, 'personas'), {recursive: true});
  fs.copyFileSync(path.join(__dirname, '../personas/persona-v4.json'), path.join(root, 'personas/persona-v4.json'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({server: {port: 0, openBrowser: false}, llm: {mock: true}}));
  let app = await startServer({root, env: {}, port: 0, openBrowser: false});
  const post = async (route, body) => (await fetch(app.url + route, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  })).json();
  try {
    const imported = await post('/api/persona/preset', {id: 'persona-v4'});
    assert.equal(imported.ok, true);
    assert.ok(imported.persona.customPrompt.length > 100);
    const prompt = imported.persona.customPrompt;
    const boundary = app.runtime.config.persona.historyStyleChangedAt;
    await post('/api/persona', {...imported.persona});
    assert.equal(app.runtime.config.persona.historyStyleChangedAt, boundary);
    await post('/api/config', {patch: {'llm.temperature': 0.9}});
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(app.runtime.config.persona.customPrompt, prompt);
    assert.equal(app.runtime.config.persona.historyStyleChangedAt, boundary);
    const preview = await post('/api/debug/prompt', {text: '晚上吃什么', chatType: 'private'});
    assert.ok(preview.system.startsWith(prompt));
    assert.match(preview.system, /日常闲聊有自己的小主意/);
    await app.close();
    app = await startServer({root, env: {}, port: 0, openBrowser: false});
    const loaded = await (await fetch(app.url + '/api/persona')).json();
    assert.equal(loaded.persona.customPrompt, prompt);
    assert.equal(app.runtime.config.persona.historyStyleChangedAt, boundary);
    const cleared = await post('/api/persona', {customPrompt: ''});
    assert.equal(cleared.persona.customPrompt, '');
  } finally {
    await app.close();
  }
});

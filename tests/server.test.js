'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

/** 起一个临时目录 + 临时端口的服务 */
async function boot(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-srv-'));
  const cfg = { server: { port: 0, openBrowser: false }, ...configPatch };
  // 测试固定主人和魔咒，不依赖开源默认值
  cfg.persona = { ...(cfg.persona || {}), master: (cfg.persona && cfg.persona.master) || { names: ['Master'], wxids: ['wxid_test_master'] } };
  cfg.admin = { minutes: 30, ...(cfg.admin || {}), spell: (cfg.admin && cfg.admin.spell) || 'test-spell' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  const instance = await startServer({ root, env: {}, port: 0, openBrowser: false });
  instance.runtime.bot.mockChunkDelayMs = 0;
  return instance;
}

async function collectSse(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  const events = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    const line = chunk.split('\n').find((l) => l.startsWith('data:'));
    if (line) events.push(JSON.parse(line.slice(5).trim()));
  }
  return events;
}

test('主动私聊接口校验桥接 token，发送确认幂等且未回复不重复领取', async (t) => {
  const app = await boot({
    persona: { stylePreset: '可爱' },
    proactiveChat: { enabled: true, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22 },
    gateway: { wechat: { enabled: true, inboundToken: 'proactive-test-token' } },
  });
  t.after(() => app.close());
  const now = new Date('2026-10-24T10:00:00+08:00');
  app.runtime.proactiveChat.now = () => now;
  const key = 'wechat:u:wxid_test_master';
  const session = app.runtime.store.ensureSession(key, { platform: 'wechat', chatId: 'wxid_test_master', chatType: 'private' });
  app.runtime.store.appendMessage(key, { role: 'user', uid: 'wxid_test_master', name: 'Master', text: '今天想听歌', ts: now.getTime() - 70 * 60000 });
  app.runtime.store.appendMessage(key, { role: 'assistant', text: '想听哪种呀', ts: now.getTime() - 69 * 60000 });
  const post = (endpoint, body, token = 'proactive-test-token') => fetch(app.url + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': token }, body: JSON.stringify(body),
  });
  assert.equal((await post('/api/proactive/next', {}, 'wrong')).status, 403);
  const result = await (await post('/api/proactive/next', {})).json();
  assert.equal(result.message.chatId, 'wxid_test_master');
  assert.equal(session.messages.length, 2);
  assert.equal((await post('/api/proactive/ack', { id: result.message.id, sent: true }, 'wrong')).status, 403);
  const first = await (await post('/api/proactive/ack', { id: result.message.id, sent: true })).json();
  assert.equal(first.ok, true);
  assert.equal(session.messages.length, 3);
  assert.equal((await (await post('/api/proactive/ack', { id: result.message.id, sent: true })).json()).duplicate, true);
  assert.equal(session.messages.length, 3);
  assert.equal((await (await post('/api/proactive/next', {})).json()).message, null);
  assert.equal((await fetch(app.url + '/api/proactive/next')).status, 405);
});

test('人设面板能保存主动私聊的开关、频率、时段，恢复默认后关闭', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const post = (body) => fetch(app.url + '/api/persona', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const saved = await (await post({ proactive: true, proactiveChat: true, proactiveIdleMinutes: 60,
    proactiveDailyLimit: 3, proactiveStartHour: 0, proactiveEndHour: 21 })).json();
  assert.equal(saved.persona.proactiveChat, true);
  assert.equal(saved.persona.proactiveIdleMinutes, 60);
  assert.equal(saved.persona.proactiveDailyLimit, 3);
  assert.equal(saved.persona.proactiveStartHour, 0);
  assert.equal(saved.persona.proactiveEndHour, 21);
  const loaded = await (await fetch(app.url + '/api/persona')).json();
  assert.equal(loaded.persona.proactiveChat, true);
  const reset = await (await post({ reset: true })).json();
  assert.equal(reset.persona.proactiveChat, false);
});

test('状态接口：默认是演示模式，两个网关都在', async () => {
  const app = await boot();
  const res = await fetch(app.url + '/api/status');
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.mock, true);
  assert.equal(data.name, '鲸鲸');
  assert.ok(Array.isArray(data.gateways) && data.gateways.length === 2);
  assert.ok(data.webhookPaths.includes('/webhook/wechat'));
  await app.close();
});

test('网页私聊：SSE 流式返回完整回复', async () => {
  const app = await boot();
  const events = await collectSse(app.url + '/api/chat', {
    text: '你好呀',
    mode: 'private',
    sessionId: 'test1',
    senderName: '小海',
  });
  const meta = events.find((e) => e.type === 'meta');
  const done = events.find((e) => e.type === 'done');
  assert.ok(meta, '应有 meta 事件');
  assert.ok(done, '应有 done 事件');
  assert.ok(done.text.length > 0);
  assert.ok(Array.isArray(done.bubbles));
  const deltas = events.filter((e) => e.type === 'delta');
  assert.ok(deltas.length > 0);
  await app.close();
});

test('网页群聊：没被 @ 返回 ignore，被 @ 才回复', async () => {
  const app = await boot();
  const res = await fetch(app.url + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '今天加班好累', mode: 'group', sessionId: 'test2', senderName: '阿螈' }),
  });
  const data = await res.json();
  assert.equal(data.action, 'ignore');
  assert.equal(data.reason, 'not_addressed');

  const events = await collectSse(app.url + '/api/chat', {
    text: '@鲸鲸 你说呢',
    mode: 'group',
    sessionId: 'test2',
    senderName: '海胆酱',
  });
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.text.length > 0);
  await app.close();
});

test('记忆接口：记住的事能从网页查到', async () => {
  const app = await boot();
  await collectSse(app.url + '/api/chat', { text: '记住：我怕黑', mode: 'private', sessionId: 's3', senderName: '小海' });
  const res = await fetch(app.url + '/api/memory?sessionId=s3&mode=private');
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.notes.length, 1);
  assert.equal(data.notes[0].notes[0], '我怕黑');
  await app.close();
});

test('微信网关：token 校验 + 收到消息 + 回复发回中转服务', async () => {
  // 假中转服务
  const received = [];
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const sinkUrl = `http://127.0.0.1:${sink.address().port}/send`;

  const app = await boot({
    gateway: {
      wechat: { enabled: true, inboundToken: 'secret-token', outboundUrl: sinkUrl, outboundHeaders: {} },
      douyin: { enabled: false, inboundToken: 'dy-token', outboundUrl: '', outboundHeaders: {} },
    },
  });

  const payload = {
    chat_id: 'room_1',
    chat_type: 'group',
    user_id: 'wxid_abc',
    nickname: '阿螈',
    text: '@鲸鲸 在吗',
    msg_id: 'm1',
  };

  const bad = await fetch(app.url + '/webhook/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(bad.status, 403);

  const res = await fetch(app.url + '/webhook/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 'secret-token' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.action, 'reply');
  assert.ok(data.reply.length > 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].platform, 'wechat');
  assert.equal(received[0].chat_id, 'room_1');
  assert.equal(received[0].chat_type, 'group');
  assert.ok(received[0].text.length > 0);

  // 重复 msg_id 不应重复回复
  const again = await fetch(app.url + '/webhook/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 'secret-token' },
    body: JSON.stringify(payload),
  });
  const againData = await again.json();
  assert.equal(againData.action, 'ignore');
  assert.equal(received.length, 1);

  await app.close();
  try { sink.closeAllConnections(); } catch { /* ignore */ }
  await new Promise((r) => sink.close(r));
});

test('抖音网关：token 可以用 query 传，群消息按群聊规则处理', async () => {
  const app = await boot({
    gateway: {
      wechat: { enabled: false, inboundToken: 'w', outboundUrl: '', outboundHeaders: {} },
      douyin: { enabled: true, inboundToken: 'dy-token', outboundUrl: '', outboundHeaders: {} },
    },
  });
  const res = await fetch(app.url + '/webhook/douyin?token=dy-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room_id: 'live_1', chat_type: 'group', nickname: '小丑鱼', content: '鲸娘你在吗', msg_id: 'd1' }),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.action, 'reply');
  await app.close();
});

test('回调地址校验：GET 带 challenge 原样返回（抖音/微信都有这种校验）', async () => {
  const app = await boot({
    gateway: {
      wechat: { enabled: true, inboundToken: 'sec', outboundUrl: '', outboundHeaders: {} },
      douyin: { enabled: false, inboundToken: 'd', outboundUrl: '', outboundHeaders: {} },
    },
  });
  const res = await fetch(app.url + '/webhook/wechat?token=sec&challenge=12345');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '12345');
  await app.close();
});

test('设置接口：能改模型和演示开关；非法 Key 会被拒绝', async () => {
  const app = await boot();
  const bad = await fetch(app.url + '/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: 'bad key with spaces' }),
  });
  assert.equal(bad.status, 400);

  const ok = await fetch(app.url + '/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mock: true, model: 'deepseek-chat', group: { requireAt: true, freeChat: false } }),
  });
  const data = await ok.json();
  assert.equal(data.ok, true);

  const settings = await (await fetch(app.url + '/api/settings')).json();
  assert.equal(settings.model, 'deepseek-chat');
  assert.equal(settings.mock, true);

  const reset = await fetch(app.url + '/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', mode: 'private' }),
  });
  assert.equal((await reset.json()).ok, true);
  await app.close();
});

test('设置接口：能切换到本地 Ollama，不需要 Key', async () => {
  const app = await boot();
  const res = await fetch(app.url + '/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama' }),
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.settings.provider, 'ollama');
  assert.equal(data.settings.needsKey, false);
  assert.equal(data.settings.model, 'qwen2.5:7b');
  assert.equal(data.settings.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(data.settings.mock, false);

  const settings = await (await fetch(app.url + '/api/settings')).json();
  assert.equal(settings.provider, 'ollama');
  assert.equal(settings.needsKey, false);
  assert.ok(settings.providers && settings.providers.ollama);

  const status = await (await fetch(app.url + '/api/status')).json();
  assert.equal(status.provider, 'ollama');
  assert.equal(status.needsKey, false);
  await app.close();
});

test('连接测试接口：模型连不上时返回可读的错误（不崩）', async () => {
  const app = await boot();
  // 切到本地 Ollama（测试机上没有这个服务），请求会失败但应该返回结构化结果
  const res = await fetch(app.url + '/api/settings/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen2.5:7b' }),
  });
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.probe.ok, false);
  assert.ok(data.probe.message && data.probe.message.length > 0);
  await app.close();
});

test('健康检查与 404', async () => {
  const app = await boot();
  const health = await fetch(app.url + '/healthz');
  assert.equal((await health.json()).ok, true);
  const missing = await fetch(app.url + '/api/nothing');
  assert.equal(missing.status, 404);
  await app.close();
});

test('调试台：状态接口能看到主人和模型信息', async () => {
  const app = await boot();
  try {
  const s = await (await fetch(app.url + '/api/debug/state')).json();
  assert.equal(s.ok, true);
  assert.equal(s.persona.name, '鲸鲸');
  assert.ok(s.persona.master.names.includes('Master'));
  assert.ok(s.persona.master.wxids.includes('wxid_test_master'));
  assert.equal(typeof s.llm.mock, 'boolean');
  assert.ok(s.chat.privateMaxChars > 0);
  assert.ok(Array.isArray(s.gateways));
  } finally { await app.close(); }
});

test('调试台：提示词预览能区分主人 / 普通人 / 群聊', async () => {
  const app = await boot();
  try {
  const post = (body) => fetch(app.url + '/api/debug/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const master = await (await post({ senderName: 'Master', senderId: 'wxid_test_master', chatType: 'private', text: '在吗' })).json();
  assert.equal(master.isMaster, true);
  assert.match(master.system, /【主人】/);
  assert.match(master.system, /父母|养大/);

  // 只把昵称改成主人的名字、id 对不上：配了真 wxid 就不认（和微信里真正跑消息时一致），
  // 以前调试台这里会显示「识别为主人」，害人以为改好了
  const impostor = await (await post({ senderName: 'Master', senderId: 'wxid_fake', chatType: 'private', text: '在吗' })).json();
  assert.equal(impostor.isMaster, false);
  assert.equal(impostor.master.reason, 'name_blocked');

  const normal = await (await post({ senderName: '路人甲', chatType: 'private', text: '在吗' })).json();
  assert.equal(normal.isMaster, false);
  assert.match(normal.system, /关系边界/);
  assert.doesNotMatch(normal.system, /【主人】/);

  const byWxid = await (await post({ senderName: '随便改的昵称', senderId: 'wxid_test_master', chatType: 'group', chatTitle: '深海鱼塘', text: '在吗' })).json();
  assert.equal(byWxid.isMaster, true);
  assert.match(byWxid.system, /微信群「深海鱼塘」/);
  } finally { await app.close(); }
});

test('调试台：会话列表 + 清空单个会话', async () => {
  const app = await boot();
  try {
  await collectSse(app.url + '/api/chat', { text: '在吗', mode: 'private', sessionId: 'dbg', senderName: '小海' });
  let d = await (await fetch(app.url + '/api/debug/sessions')).json();
  assert.equal(d.ok, true);
  assert.ok(d.sessions.length >= 1);
  const key = d.sessions[0].key;
  const r = await (await fetch(app.url + '/api/debug/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
  })).json();
  assert.equal(r.ok, true);
  d = await (await fetch(app.url + '/api/debug/sessions')).json();
  assert.ok(d.sessions.every((s) => s.messageCount === 0));
  } finally { await app.close(); }
});

test('调试台：魔咒配置 + 网页聊天触发管理员权限', async () => {
  const app = await boot();
  try {
    const s = await (await fetch(app.url + '/api/debug/state')).json();
    assert.equal(s.admin.configured, true);
    assert.equal(s.admin.minutes, 30);
    assert.match(s.admin.spellMasked, /\*\*\*\*/);
    assert.doesNotMatch(s.admin.spellMasked, /test-spell/);

    await collectSse(app.url + '/api/chat', { text: 'test-spell', mode: 'private', sessionId: 'adm', senderName: 'Master' });
    const d = await (await fetch(app.url + '/api/debug/sessions')).json();
    const sess = d.sessions.find((x) => x.key.includes('adm'));
    assert.ok(sess, '应能找到这个会话');
    assert.ok(sess.adminUntil > Date.now(), '管理员权限应已激活');
  } finally {
    await app.close();
  }
});

test('人设调教接口：读、改、恢复默认', async () => {
  const app = await boot();
  try {
    const get1 = await (await fetch(app.url + '/api/persona')).json();
    assert.equal(get1.ok, true);
    assert.equal(get1.persona.name, '鲸鲸');
    assert.equal(typeof get1.persona.historyTurns, 'number');
    assert.ok(get1.persona.historyTurns >= 200, '私聊上下文默认应该够大');
    assert.ok(get1.persona.groupHistoryTurns >= 150, '群聊上下文默认应该够大');

    const post = (body) => fetch(app.url + '/api/persona', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const r = await (await post({
      name: '小鲸',
      age: 20,
      job: '咖啡店店员',
      personality: '话少、冷静、偶尔毒舌',
      preset: '高冷',
      text: '别用省略号',
      historyTurns: 12,
      emotions: false,
      proactive: false,
      opinions: true,
      links: false,
      freeChat: true,
      mutedGroups: ['测试群'],
    })).json();
    assert.equal(r.ok, true);
    assert.equal(r.persona.name, '小鲸');
    assert.equal(r.persona.job, '咖啡店店员');
    assert.equal(r.persona.historyTurns, 12);
    assert.equal(r.persona.emotions, false);
    assert.equal(r.persona.links, false);
    assert.deepEqual(r.persona.mutedGroups, ['测试群']);

    const sys = await (await fetch(app.url + '/api/debug/prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ senderName: '路人', chatType: 'private', text: '在吗' }),
    })).json();
    assert.match(sys.system, /小鲸/);
    assert.match(sys.system, /咖啡店店员/);
    assert.match(sys.system, /话少、冷静/);

    const reset = await (await post({ reset: true })).json();
    assert.equal(reset.ok, true);
    assert.equal(reset.persona.name, '鲸鲸');
    assert.equal(reset.persona.historyTurns, 200);
    assert.equal(reset.persona.groupHistoryTurns, 150);
  } finally {
    await app.close();
  }
});

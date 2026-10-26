'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {DEFAULT_CONFIG} = require('../src/config');
const {WatchCompanion, videoIdentity} = require('../src/watchCompanion');
const {Store} = require('../src/memory');
const {Bot} = require('../src/bot');
const {ProactiveChat} = require('../src/proactive');
const {startServer} = require('../server');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-watch-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = {root: dir, dataDir: dir, storeFile: path.join(dir, 'store.json')};
  config.persona.master = {names: ['主人甲'], wxids: ['wxid_owner']};
  Object.assign(config.persona, {stylePreset: '可爱', promptMode: 'compact', customPrompt: '你是鲸鲸，和对方自然聊天。'});
  config.proactiveChat.enabled = true; config.gateway.wechat.enabled = true;
  let time = Date.parse('2026-10-25T10:00:00+08:00');
  const store = new Store({file: config.paths.storeFile, limits: config.memory});
  const calls = [];
  const llm = {isMock: false, model: 'test', complete: options.complete || (async (request) => {calls.push(request); return request.system.includes('本轮输出格式') ? '{"emotion":"happy","comment":"这只猫还装无辜，学到了。"}' : '刚才那只猫偷吃还装无辜，笑死我啦。';})};
  const vision = options.vision || {describe: async () => '一只猫偷吃后转头装作没事。'};
  const service = new WatchCompanion({config, store, llm, vision, now: () => time});
  service.updateSettings({enabled: true, captureRegion: {x: 0.1, y: 0.1, width: 0.8, height: 0.7}});
  const event = (extra = {}) => ({source: 'desktop', url: 'desktop://bilibili/1234567890abcdef', clientId: 'desktop-test', title: '猫咪的一天', position: 0, positionKind: 'media', playing: true, visible: true, ...extra});
  t.after(() => {service.close(); store.close(); fs.rmSync(dir, {recursive: true, force: true});});
  return {config, store, service, calls, llm, event, now: () => new Date(time), advance(seconds) {time += seconds*1000;}};
}

test('原生采集仅允许 B站客户端标识或正式 B站视频 URL', () => {
  assert.equal(videoIdentity('desktop://bilibili/1234567890abcdef', 'desktop').key, 'desktop:/1234567890abcdef');
  assert.equal(videoIdentity('https://www.bilibili.com/video/BV123456?p=2').key, '/video/BV123456?p=2');
  for (const url of ['https://example.com/video/BV123456', 'file:///c:/secret', 'http://www.bilibili.com/video/BV123456', 'https://www.bilibili.com/account']) assert.throws(() => videoIdentity(url));
  assert.throws(() => videoIdentity('desktop://bilibili/1234567890abcdef'));
});

test('播放计时不会把拖进度、暂停、隐藏或长时间断线算作观看', async (t) => {
  const f = fixture(t);
  f.service.ingest(f.event()); await f.service.work;
  f.advance(4); f.service.ingest(f.event({position: 4}));
  assert.equal(f.service.memories[0].watchedSeconds, 4);
  f.advance(4); f.service.ingest(f.event({position: 400}));
  assert.equal(f.service.memories[0].watchedSeconds, 4);
  f.advance(4); f.service.ingest(f.event({position: 400, playing: false, paused: true}));
  f.advance(4); f.service.ingest(f.event({position: 404, visible: false}));
  f.advance(300); f.service.ingest(f.event({position: 704}));
  assert.equal(f.service.memories[0].watchedSeconds, 4);
});

test('画面与已播字幕驱动表情短评，原始截图不会写入存档', async (t) => {
  const f = fixture(t);
  f.service.ingest(f.event({position: 5, caption: '猫咪正在偷吃', frame: 'data:image/jpeg;base64,YQ=='}));
  await f.service.work;
  assert.equal(f.service.state().expression, 'happy');
  assert.match(f.service.state().comment, /猫/);
  assert.match(f.calls[0].turns[0].content, /猫咪正在偷吃/);
  assert.match(f.calls[0].turns[0].content, /装作没事/);
  assert.equal(f.calls[0].thinking, false);
  const saved = fs.readFileSync(f.service.file, 'utf8');
  assert.doesNotMatch(saved, /data:image|base64|YQ==/);
  assert.match(saved, /猫咪正在偷吃/);
});

test('拖回进度不会把刚刚看过的未来字幕再次作为当前位置字幕', async (t) => {
  const f = fixture(t);
  f.service.ingest(f.event({position: 90, caption: '后面的结局'})); await f.service.work;
  f.advance(40); f.service.ingest(f.event({position: 10, caption: '片头开场'})); await f.service.work;
  assert.doesNotMatch(f.calls.at(-1).turns[0].content, /后面的结局/);
  assert.match(f.calls.at(-1).turns[0].content, /片头开场/);
});

test('停止陪看或换视频后，在途模型结果不能写回新场景', async (t) => {
  let release;
  const f = fixture(t, {vision: {describe: () => new Promise((resolve) => {release = resolve;})}});
  f.service.ingest(f.event({frame: 'data:image/jpeg;base64,YQ=='}));
  const work = f.service.work;
  f.service.updateSettings({enabled: false});
  release('旧场景'); await work;
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.comment, '');
  assert.equal(f.service.current, null);
});

test('只给关联主人的微信私聊共享观看记忆，不流入群聊或其他会话', async (t) => {
  const f = fixture(t);
  f.service.ingest(f.event({caption: '猫咪正在偷吃'})); await f.service.work;
  const msg = {platform: 'wechat', chatType: 'private', senderId: 'wxid_owner', isMaster: true};
  assert.match(f.service.contextFor(msg), /猫咪正在偷吃/);
  for (const patch of [{chatType: 'group'}, {senderId: 'wxid_other'}, {isMaster: false}, {platform: 'web'}]) assert.equal(f.service.contextFor({...msg, ...patch}), '');
  assert.throws(() => f.service.updateSettings({ownerId: 'wxid_other'}));
});

test('微信回访复用原来的主人认证、空闲一小时、未回复不追问和成功确认机制', async (t) => {
  const f = fixture(t);
  const key = 'wechat:u:wxid_owner';
  const session = f.store.ensureSession(key, {platform: 'wechat', chatType: 'private', chatId: 'wxid_owner'});
  f.store.appendMessage(key, {role: 'user', uid: 'wxid_owner', name: '主人甲', text: '先看会视频', ts: f.now().getTime() - 65*60000});
  f.service.updateSettings({minimumWatchMinutes: 1});
  f.service.ingest(f.event({caption: '猫咪偷吃'})); await f.service.work;
  for (let i = 1; i <= 7; i++) {f.advance(10); f.service.ingest(f.event({position: i*10})); await f.service.work;}
  f.service.ingest(f.event({position: 70, playing: false, ended: true}));
  const bot = new Bot({config: f.config, store: f.store, llm: f.llm, logger: null});
  const proactive = new ProactiveChat({config: f.config, store: f.store, bot, llm: f.llm, companion: f.service, now: f.now});
  const result = await proactive.next();
  assert.ok(result.message);
  assert.match(f.calls.at(-1).system, /共同观看|猫咪偷吃/);
  assert.equal(f.service.memories[0].followupClaimed, true);
  assert.equal(session.messages.length, 1, '领取不能伪造已发送记录');
  proactive.ack(result.message.id, true);
  assert.equal(session.messages.at(-1).proactive, true);
  assert.equal((await proactive.next()).message, null);
  assert.equal(f.service.followUpFor(session), null);
});

test('框选区域校验、表情与评论开关和持久化配对码正确', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.service.updateSettings({captureRegion: {x: 0.8, y: 0, width: 0.8, height: 1}}));
  f.service.updateSettings({automaticComments: false});
  f.service.ingest(f.event({caption: '猫咪偷吃'})); await f.service.work;
  assert.equal(f.service.comment, '');
  assert.equal(f.service.expression, 'happy');
  const token = f.service.token;
  const restarted = new WatchCompanion({config: f.config, store: f.store, llm: f.llm, vision: {}, now: () => f.now().getTime()});
  assert.equal(restarted.token, token);
  assert.equal(restarted.current, null);
  restarted.close();
});

test('陪看 HTTP 接口拒绝外站 Origin、伪造 Host 和未配对调用，页面可独立打开', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-watch-api-'));
  const web = path.join(dir, 'web'); fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'companion.html'), '<html>companion desktop setup</html>');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({server: {port: 0, openBrowser: false}}));
  const app = await startServer({root: dir, env: {}, port: 0, openBrowser: false});
  t.after(async () => {await app.close(); fs.rmSync(dir, {recursive: true, force: true});});
  const evil = await fetch(app.url + '/api/companion/bootstrap', {headers: {Origin: 'https://evil.example'}});
  assert.equal(evil.status, 403);
  const forgedStatus = await new Promise((resolve, reject) => {
    http.get(app.url + '/api/companion/bootstrap', {headers: {Host: 'evil.example'}}, (res) => {res.resume(); resolve(res.statusCode);}).on('error', reject);
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await fetch(app.url + '/api/companion/state')).status, 403);
  const paired = await (await fetch(app.url + '/api/companion/bootstrap', {headers: {Origin: 'chrome-extension://' + 'a'.repeat(32)}})).json();
  assert.match(paired.token, /^[a-f0-9]{64}$/);
  const response = await fetch(app.url + '/api/companion/state', {headers: {Authorization: 'Bearer ' + paired.token}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token, undefined);
  assert.match(await (await fetch(app.url + '/companion')).text(), /companion desktop setup/);
});

test('自动截取客户端时，没有播放画面便不拿推荐页或按钮编评论', async (t) => {
  const f = fixture(t, {vision: {describe: async () => '未见播放画面'}});
  f.service.ingest(f.event({frame: 'data:image/jpeg;base64,YQ=='}));
  await f.service.work;
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.comment, '');
  assert.equal(f.service.memories[0].observations.length, 0);
  assert.match(f.service.lastError, /未见播放画面/);
});

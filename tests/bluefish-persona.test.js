'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/config');
const persona = require('../src/persona');
const personaStore = require('../src/personaStore');
const presets = require('../src/presets');

for (const customPrompt of ['', '你是蓝色大肥鱼，喜欢在桌边晃尾巴。']) {
  test(`${customPrompt ? '自定义' : '默认'}可爱人设包含鲸鱼娘的具体互动与认真回答边界`, () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    Object.assign(config.persona, { stylePreset: '可爱', customPrompt });
    const system = persona.buildSystem({config, msg: {chatType: 'private', senderName: '朋友', text: '你又胖了'}});
    if (customPrompt) assert.ok(system.startsWith(customPrompt));
    assert.match(system, /聪明嘴硬的小馋鲸/);
    assert.match(system, /被夸会开心又想绷住/);
    assert.match(system, /昵称和善意玩笑不是恶意辱骂/);
    assert.match(system, /不装傻、不故意答错，不谎报完成/);
    assert.match(system, /不把所有话题都变成讨饭/);
    assert.match(system, /正经问题认真答/);
    assert.match(system, /只对已认证的主人/);
    assert.match(system, /对话理解与回答质量（最高优先级）/);
    assert.match(system, /对方：你又胖了 → 你：鲸！是鲸！这叫有分量/);
    assert.doesNotMatch(system, /脑袋里的小鲸鱼游慢了一点/);
  });
}

test('可爱风格明确鲸鱼娘身份，其他语气保持原来的角色入口', () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.stylePreset = '可爱';
  const msg = {chatType: 'private', senderName: '朋友', text: '在吗'};
  assert.match(persona.buildSystem({config, msg}), /蓝发、长着鲸鳍和鲸尾的鲸鱼娘/);
  config.persona.stylePreset = '温柔';
  const normal = persona.buildSystem({config, msg});
  assert.match(normal, /一个普通女生/);
  assert.doesNotMatch(normal, /社区二创式蓝色大肥鱼/);
});

test('v4 预设可导入，保留旧版和主动聊天频率', (t) => {
  const root = path.resolve(__dirname, '..');
  const preset = presets.load({paths: {root}}, 'persona-v4');
  assert.ok(preset);
  assert.equal(preset.preset, '可爱');
  assert.ok(preset.customPrompt.length > 100);
  for (const id of ['persona-v1', 'persona-v2', 'persona-v3']) assert.ok(presets.load({paths: {root}}, id));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bluefish-v4-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  config.paths = {dataDir: dir};
  config.proactiveChat = {enabled: true, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22};
  personaStore.save(config, presets.toPatch(preset));
  assert.equal(config.persona.name, '蓝色大肥鱼');
  assert.match(config.persona.appearance, /鲸尾/);
  assert.match(config.persona.personality, /嘴硬心软/);
  assert.deepEqual(config.proactiveChat, {enabled: true, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22});
  const system = persona.buildSystem({config, msg: {chatType: 'private', senderName: '朋友', text: '你好'}});
  assert.ok(system.startsWith(preset.customPrompt));
  assert.match(system, /可爱说话示例/);
});

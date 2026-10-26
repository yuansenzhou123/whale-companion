'use strict';

/**
 * 图片识别：提示词要够细，桥接要拿完整图而不是缩略图。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const visionSrc = fs.readFileSync(path.join(root, 'src', 'vision.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
const mediaSrc = fs.readFileSync(path.join(root, 'examples', 'bridge_media.py'), 'utf8');

test('视觉提示词要求逐条转写，并且分清左右气泡', () => {
  assert.match(visionSrc, /对方：/, '要教它标「对方：」');
  assert.match(visionSrc, /本人：/, '要教它标「本人：」');
  assert.match(visionSrc, /左边气泡|左边/, '要按气泡位置判断说话人');
  assert.match(visionSrc, /逐条转写|从上到下/);
  assert.match(visionSrc, /不要编造|不要编/);
});

test('视觉模型输出上限够长，不会被截断', () => {
  const m = visionSrc.match(/max_tokens:\s*(\d+)/);
  assert.ok(m, '找不到 max_tokens');
  assert.ok(Number(m[1]) >= 600, 'max_tokens 太小，长截图会说不清：' + m[1]);
});

test('桥接优先拿完整图，不拿缩略图', () => {
  assert.match(mediaSrc, /for _tier in \("full", "best"\)/, '要按 full → best 顺序取图');
  assert.match(mediaSrc, /tier=_tier/);
  assert.match(mediaSrc, /图片档位/, '要记日志，方便排查');
});

test('桥接用 BOM 安全的方式读配置（否则 token 读不到，她就不理人）', () => {
  assert.match(bridgeSrc, /utf-8-sig/, 'config.json 带 BOM 时 json.load 会失败');
  assert.match(bridgeSrc, /webhook token/, '启动时要打印 token 状态');
});

test('图片描述长度有上限，不会把上下文塞爆', () => {
  assert.match(mediaSrc, /if len\(text\) > 600:/);
});

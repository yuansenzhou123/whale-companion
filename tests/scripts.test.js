'use strict';

/**
 * 启动脚本检查：.bat 必须是 CRLF，否则 cmd 会报「命令语法不正确」。
 * 这个坑踩过一次：一键终止.bat 用 LF 存盘，双击直接失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function listBat(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (['node_modules', 'release', 'data', 'vendor'].includes(name.name)) continue;
      out.push(...listBat(full));
      continue;
    }
    if (name.name.toLowerCase().endsWith('.bat')) out.push(full);
  }
  return out;
}

test('所有 .bat 都用 CRLF 换行', () => {
  const files = listBat(root);
  assert.ok(files.length >= 5, '应该找到启动脚本，实际 ' + files.length);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const bareLf = text.split('\n').filter((line, i, all) => i < all.length - 1 && !line.endsWith('\r'));
    assert.equal(bareLf.length, 0, path.basename(file) + ' 有 ' + bareLf.length + ' 行是 LF 换行，cmd 会报语法错误');
  }
});

test('一键终止.bat 存在，并且调用 stop-all.ps1', () => {
  const bat = path.join(root, '一键终止.bat');
  assert.ok(fs.existsSync(bat), '缺少 一键终止.bat');
  const text = fs.readFileSync(bat, 'utf8');
  assert.match(text, /stop-all\.ps1/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'stop-all.ps1')), '缺少 scripts\\stop-all.ps1');
});

test('启动脚本会清掉失效的本机代理（否则所有模型请求都连不上）', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.match(ps1, /HTTPS_PROXY/, 'start.ps1 要处理 HTTPS_PROXY');
  assert.match(ps1, /Remove-Item "env:/, '要真的删掉代理环境变量');
  assert.match(ps1, /NO_PROXY/);
  const bat = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(bat, /set "HTTPS_PROXY="/, '桥接启动时也要清代理');
});

test('start.ps1 必须是带 BOM 的 UTF-8（否则中文会让 PowerShell 解析失败）', () => {
  const p = path.join(root, 'scripts', 'start.ps1');
  const buf = fs.readFileSync(p);
  assert.equal(buf[0], 0xef, 'start.ps1 缺 BOM，PowerShell 5.1 会解析中文失败');
  assert.equal(buf[1], 0xbb);
  assert.equal(buf[2], 0xbf);
});

test('优先用包里自带的 runtime\\node.exe（用户不用装 Node）', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.match(ps1, /runtime\\node\.exe/, '要支持包内运行时');
  assert.match(ps1, /包内 runtime/, '要标明来源');
  // 包内运行时必须排在 PATH 检测之前
  const bundledAt = ps1.indexOf('runtime\\node.exe');
  const pathAt = ps1.indexOf("From = 'PATH'");
  assert.ok(bundledAt > 0 && pathAt > bundledAt, '包内运行时应该先于 PATH 被选中');
});

test('桥接启动脚本在缺 Python 时给提示，而不是一闪而过', () => {
  const bat = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(bat, /没找到 Python/);
  assert.match(bat, /python\.org/);
});

test('stop-all.ps1 会写暂停标记，并覆盖服务/桥接/守护/热键', () => {
  const ps1 = fs.readFileSync(path.join(root, 'scripts', 'stop-all.ps1'), 'utf8');
  assert.match(ps1, /PAUSED/, '必须写 data\\PAUSED，否则 bridge_loop 会重新拉起桥接');
  assert.match(ps1, /wechatauto_bridge\.py/);
  assert.match(ps1, /server\.js/);
  assert.match(ps1, /bridge_loop\.bat/);
  assert.match(ps1, /hotkey_daemon\.py/);
  assert.match(ps1, /8787/, '要有按端口兜底');
});

test('桥接启动脚本会清掉 PAUSED，避免手动启动被挡住', () => {
  const text = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
  assert.match(text, /del \/q "data\\PAUSED"/);
});

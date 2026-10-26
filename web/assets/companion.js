const $ = (id) => document.getElementById(id);
let token = '', state = null, initialized = false, saving = false;
const booleanFields = ['automaticComments', 'framesEnabled', 'wechatFollowup'];
const numberFields = ['commentIntervalSeconds', 'analysisIntervalSeconds', 'minimumWatchMinutes'];
const labels = {paused: '暂时歇一会儿', watching: '正在一起看', waiting: '视频已暂停', disconnected: '等待 B站客户端'};
const emotions = {neutral: '认真看着', happy: '开心', surprised: '有点惊讶', sad: '有点难过', curious: '好奇', thinking: '正在理解画面', sleepy: '安静等你'};
async function api(route, body) {
  if (!token) token = (await (await fetch('/api/companion/bootstrap')).json()).token;
  const response = await fetch('/api/companion/' + route, {method: body === undefined ? 'GET' : 'POST', headers: {Authorization: 'Bearer ' + token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const data = await response.json();
  if (!response.ok || !data.ok) {if (response.status === 403) token = ''; throw new Error(data.error || '暂时连接不上');}
  return data;
}
function toast(message) {$('toast').textContent = message; $('toast').style.display = 'block'; setTimeout(() => $('toast').style.display = 'none', 2400);}
function render(data) {
  state = data;
  $('status').textContent = labels[data.status] || data.status;
  $('toggle').textContent = data.settings.enabled ? '暂停陪看' : '开始陪看';
  $('video').textContent = data.video?.title || '等你打开 B站客户端';
  $('progress').textContent = data.video ? '已一起看 ' + Math.floor(data.video.watchedSeconds / 60) + ' 分钟 · ' + (data.video.positionKind === 'observed' ? '仅记录可见片段' : '播放至 ' + Math.floor(data.video.position / 60) + ':' + String(Math.floor(data.video.position % 60)).padStart(2, '0')) : '自动锁定前台 B站客户端窗口';
  $('comment').textContent = data.comment || (data.busy ? '唔，让我看看这一段……' : '我在这儿，选一段想看的吧。');
  $('expression').textContent = '表情：' + (emotions[data.expression] || '认真看着') + (data.mock ? ' · 当前为演示模式' : '');
  $('error').textContent = data.error || (data.settings.enabled && data.status === 'disconnected' ? '把 B站客户端切到前台播放，桌宠会自动跟随窗口。' : '');
  if (!initialized) {
    for (const field of booleanFields) $(field).checked = data.settings[field];
    for (const field of numberFields) $(field).value = data.settings[field];
    $('ownerId').replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '暂不关联微信'; $('ownerId').append(empty);
    for (const owner of data.owners) {const option = document.createElement('option'); option.value = owner.id; option.textContent = owner.name + (owner.hasConversation ? '' : '（需要先私聊一次）'); $('ownerId').append(option);}
    $('ownerId').value = data.settings.ownerId;
    initialized = true;
  }
  const owner = data.owners.find((item) => item.id === data.settings.ownerId);
  $('ownerHint').textContent = owner?.hasConversation ? '已关联：' + owner.name : '尚未具备微信回访条件：在调试台配置主人微信 ID，并用这个账号私聊鲸鲸一次。';
  $('memories').replaceChildren();
  if (!data.memories.length) $('memories').textContent = '还没有观看记录';
  for (const memory of data.memories) {
    const card = document.createElement('div'); card.className = 'memory';
    const title = document.createElement('b'); title.textContent = memory.title;
    const time = document.createElement('div'); time.textContent = Math.floor(memory.watchedSeconds / 60) + ' 分钟 · ' + new Date(memory.lastAt).toLocaleString('zh-CN') + (memory.followupClaimed ? ' · 已安排回访' : '');
    card.append(title, time);
    for (const row of memory.observations) {const line = document.createElement('div'); line.textContent = row.kind + '：' + row.text; card.append(line);}
    $('memories').append(card);
  }
}
async function refresh() {try {render(await api('state'));} catch (error) {$('status').textContent = '服务暂时断开'; $('error').textContent = error.message;}}
$('toggle').onclick = async () => {try {render(await api('settings', {enabled: !state?.settings.enabled}));} catch (error) {toast(error.message);}};
$('speak').onclick = async () => {try {await api('comment', {}); toast('让我看看这一段～');} catch (error) {toast(error.message);}};
$('save').onclick = async () => {
  if (saving) return; saving = true;
  try {
    const patch = {ownerId: $('ownerId').value};
    for (const field of booleanFields) patch[field] = $(field).checked;
    for (const field of numberFields) patch[field] = Number($(field).value);
    render(await api('settings', patch)); toast('设置已保存，立即生效');
  } catch (error) {toast(error.message);} finally {saving = false;}
};
refresh(); setInterval(refresh, 2500);

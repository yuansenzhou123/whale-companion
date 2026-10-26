const $ = (id) => document.getElementById(id);
async function show() {
  const state = await chrome.runtime.sendMessage({type: 'watch-status'});
  if (state.endpoint) $('endpoint').value = state.endpoint;
  $('status').textContent = state.error || (state.watching ? '已连接。回到视频页继续播放吧～' : '在 B 站播放页点“开始陪看”。');
}
for (const [id, type] of [['start', 'watch-start'], ['stop', 'watch-stop']]) $(id).onclick = async () => {
  $(id).disabled = true;
  $('status').textContent = '正在连接……';
  try {
    const result = await chrome.runtime.sendMessage({type, endpoint: $('endpoint').value});
    if (!result.ok) throw new Error(result.error);
    await show();
  } catch (error) {$('status').textContent = error.message;}
  finally {$(id).disabled = false;}
};
show().catch(() => {$('status').textContent = '连接未完成，请检查鲸鲸服务。';});

function endpoint(value) {
  const url = new URL(value || 'http://127.0.0.1:8787');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('服务地址必须是本机 http 地址');
  return url.origin;
}
async function call(settings, route, data) {
  const response = await fetch(endpoint(settings.endpoint) + '/api/companion/' + route, {method: data === undefined ? 'GET' : 'POST', headers: {'Authorization': 'Bearer ' + settings.token, ...(data === undefined ? {} : {'Content-Type': 'application/json'})}, ...(data === undefined ? {} : {body: JSON.stringify(data)}), signal: AbortSignal.timeout(5000)});
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || '本机服务暂时不可用');
  return result;
}
async function pair(base) {
  const host = endpoint(base);
  const response = await fetch(host + '/api/companion/bootstrap', {signal: AbortSignal.timeout(5000)});
  const result = await response.json();
  if (!response.ok || !result.token) throw new Error('请先启动新版鲸鲸服务');
  return {endpoint: host, token: result.token};
}
async function cropVideo(tab, event) {
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 70});
  const active = await chrome.tabs.query({active: true, windowId: tab.windowId});
  if (active[0]?.id !== tab.id) return '';
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const sx = bitmap.width / event.viewport.width;
    const sy = bitmap.height / event.viewport.height;
    const x = Math.max(0, event.rect.x * sx), y = Math.max(0, event.rect.y * sy);
    const right = Math.min(bitmap.width, (event.rect.x + event.rect.width) * sx);
    const bottom = Math.min(bitmap.height, (event.rect.y + event.rect.height) * sy);
    const width = right - x, height = bottom - y;
    if (width < 60 || height < 60 || width * height < event.rect.width * event.rect.height * sx * sy * 0.6) return '';
    const scale = Math.min(1, 768 / width, 500 / height);
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.75});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return 'data:image/jpeg;base64,' + btoa(binary);
  } finally {bitmap.close();}
}
let sending = false;
let lastFrameAt = 0;
async function deliver(event, tab, saved) {
  if (sending) return;
  sending = true;
  try {
    const window = await chrome.windows.get(tab.windowId);
    const active = tab.active && window.focused && event.visible;
    const frameDue = Date.now() - lastFrameAt >= 35000;
    if (active && event.playing && frameDue) {
      const state = await call(saved, 'state');
      if (state.settings.framesEnabled) {
        try {event.frame = await cropVideo(tab, event);} catch {event.captureUnavailable = true;}
      }
      lastFrameAt = Date.now();
    }
    event.visible = Boolean(active);
    event.playing = Boolean(active && event.playing);
    const {rect, viewport, ...safeEvent} = event;
    await call(saved, 'event', safeEvent);
    await chrome.storage.local.set({lastError: '', lastSeen: Date.now()});
  } catch (error) {
    await chrome.storage.local.set({lastError: String(error.message).slice(0, 200)});
  } finally {sending = false;}
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    const saved = await chrome.storage.local.get(['endpoint', 'token', 'watchTabId', 'lastError', 'lastSeen']);
    if (message.type === 'watch-event') {
      if (!sender.tab || sender.tab.id !== saved.watchTabId || !/^https:\/\/www\.bilibili\.com\//.test(sender.tab.url || '')) return {ok: true};
      await deliver(message.event, sender.tab, saved);
      return {ok: true};
    }
    if (sender.tab) throw new Error('此操作仅允许从扩展面板发起');
    if (message.type === 'watch-start') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!/^https:\/\/www\.bilibili\.com\/(video\/|bangumi\/play\/)/.test(tab?.url || '')) throw new Error('请先打开一个 B 站视频播放页，再点开始陪看');
      const paired = await pair(message.endpoint);
      await call(paired, 'settings', {enabled: false});
      await call(paired, 'settings', {enabled: true});
      const event = await chrome.tabs.sendMessage(tab.id, {type: 'read-watch-state'});
      if (!event) throw new Error('还没找到视频，请刷新播放页后再试');
      await chrome.storage.local.set({...paired, watchTabId: tab.id, lastError: ''});
      lastFrameAt = 0;
      await deliver(event, tab, paired);
      return {ok: true};
    }
    if (message.type === 'watch-stop') {
      if (saved.token) await call(saved, 'settings', {enabled: false});
      await chrome.storage.local.remove('watchTabId');
      return {ok: true};
    }
    if (message.type === 'watch-status') return {ok: true, endpoint: saved.endpoint, watching: Boolean(saved.watchTabId), error: saved.lastError || '', lastSeen: saved.lastSeen || 0};
    throw new Error('未知操作');
  })().then(respond, (error) => respond({ok: false, error: error.message || '操作未完成'}));
  return true;
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const saved = await chrome.storage.local.get('watchTabId');
  if (saved.watchTabId === tabId) await chrome.storage.local.remove('watchTabId');
});

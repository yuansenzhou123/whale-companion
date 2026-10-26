(() => {
  if (window.__whaleWatchCollector) return;
  window.__whaleWatchCollector = true;
  const clientId = crypto.randomUUID();
  let sequence = 0;
  function currentCaption(video) {
    const lines = [];
    for (const track of Array.from(video.textTracks || [])) {
      for (const cue of Array.from(track.activeCues || [])) if (cue.startTime <= video.currentTime && cue.endTime >= video.currentTime) lines.push(cue.text);
    }
    if (!lines.length) for (const node of document.querySelectorAll('.bpx-player-subtitle-panel-text,.bilibili-player-video-subtitle span')) {
      if (node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden') lines.push(node.textContent);
    }
    return [...new Set(lines.map((line) => String(line).replace(/<[^>]*>/g, '').trim()).filter(Boolean))].join(' ').slice(0, 600);
  }
  function read() {
    const video = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!video || !Number.isFinite(video.currentTime)) return null;
    const rect = video.getBoundingClientRect();
    const visible = document.visibilityState === 'visible' && rect.width > 50 && rect.height > 50 && rect.bottom > 0 && rect.top < innerHeight;
    const titleNode = document.querySelector('h1.video-title,.video-info-title,.media-title');
    return {clientId, sequence: ++sequence, url: location.href, title: titleNode?.getAttribute('title') || titleNode?.textContent || document.title.replace(/[_-]哔哩哔哩.*$/, ''), position: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0, playing: !video.paused && !video.ended && video.readyState >= 2, paused: video.paused, ended: video.ended, visible, caption: currentCaption(video), rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}, viewport: {width: innerWidth, height: innerHeight}};
  }
  function emit() {
    const event = read();
    if (event) chrome.runtime.sendMessage({type: 'watch-event', event}).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'read-watch-state') {respond(read()); return false;}
  });
  setInterval(emit, 4000);
  document.addEventListener('visibilitychange', emit);
  document.addEventListener('pause', emit, true);
  document.addEventListener('ended', emit, true);
})();

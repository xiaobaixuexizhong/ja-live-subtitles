(() => {
  if (globalThis.__jaLiveSubtitles) return globalThis.__jaLiveSubtitles.toggle();

  let enabled = false;
  let clearTimer = null;
  let positionTimer = null;
  let host = null;
  let caption = null;

  function ensureOverlay() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;';
    const shadow = host.attachShadow({mode: 'closed'});
    caption = document.createElement('div');
    caption.style.cssText = [
      'position:absolute', 'left:5%', 'right:5%', 'bottom:8%',
      'text-align:center', 'color:white', 'font:700 clamp(22px,2.4vw,38px)/1.5 sans-serif',
      'text-shadow:-2px -2px 2px black,2px -2px 2px black,-2px 2px 2px black,2px 2px 2px black,0 3px 8px black',
      'overflow-wrap:anywhere', 'white-space:pre-wrap',
    ].join(';');
    shadow.append(caption);
  }

  function placeOverlay() {
    if (!host || !enabled) return;
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (host.parentElement !== parent) parent.append(host);
    const videos = [...document.querySelectorAll('video')];
    const video = videos
      .map(node => ({node, rect: node.getBoundingClientRect()}))
      .filter(item => item.rect.width > 150 && item.rect.height > 100)
      .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
    if (!video || fullscreen) {
      caption.style.left = '5%';
      caption.style.right = '5%';
      caption.style.bottom = '8%';
      return;
    }
    caption.style.left = `${Math.max(8, video.rect.left + video.rect.width * 0.04)}px`;
    caption.style.right = `${Math.max(8, innerWidth - video.rect.right + video.rect.width * 0.04)}px`;
    caption.style.bottom = `${Math.max(8, innerHeight - video.rect.bottom + video.rect.height * 0.08)}px`;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!enabled) return;
    if (message.type === 'clear') {
      caption.textContent = '';
      return;
    }
    if (message.type !== 'subtitle') return;
    caption.textContent = message.zh;
    placeOverlay();
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { caption.textContent = ''; }, 6500);
  });

  function toggle() {
    enabled = !enabled;
    if (enabled) {
      ensureOverlay();
      placeOverlay();
      positionTimer = setInterval(placeOverlay, 500);
      document.addEventListener('fullscreenchange', placeOverlay);
    } else {
      clearTimeout(clearTimer);
      clearInterval(positionTimer);
      document.removeEventListener('fullscreenchange', placeOverlay);
      if (host) host.remove();
      host = caption = null;
    }
    return enabled;
  }

  globalThis.__jaLiveSubtitles = {toggle};
  return toggle();
})()

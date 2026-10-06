const enabledTabs = new Set();
let socket = null;
let keepaliveTimer = null;
let reconnectTimer = null;

function disconnectIfIdle() {
  if (enabledTabs.size) return;
  clearTimeout(reconnectTimer);
  clearInterval(keepaliveTimer);
  if (socket) socket.close();
  socket = null;
}

function connect() {
  if (!enabledTabs.size || socket) return;
  const connection = new WebSocket('ws://127.0.0.1:8765/subtitles');
  socket = connection;
  connection.onopen = () => {
    keepaliveTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send('keepalive');
    }, 20000);
  };
  connection.onmessage = ({data}) => {
    const message = JSON.parse(data);
    for (const tabId of enabledTabs) {
      chrome.tabs.sendMessage(tabId, message).catch(() => {
        enabledTabs.delete(tabId);
        chrome.action.setBadgeText({tabId, text: ''}).catch(() => {});
        disconnectIfIdle();
      });
    }
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = null;
    clearInterval(keepaliveTimer);
    if (enabledTabs.size) reconnectTimer = setTimeout(connect, 2000);
  };
}

async function toggleTab(tab) {
  if (!tab.id) return;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['overlay.js'],
      world: 'ISOLATED',
    });
    if (injection.result) {
      enabledTabs.add(tab.id);
      connect();
    } else {
      enabledTabs.delete(tab.id);
      disconnectIfIdle();
    }
    await chrome.action.setBadgeText({tabId: tab.id, text: injection.result ? 'ON' : ''});
    await chrome.action.setBadgeBackgroundColor({tabId: tab.id, color: '#247c54'});
  } catch (error) {
    console.error('Cannot show subtitles on this tab:', error);
  }
}

chrome.action.onClicked.addListener(toggleTab);

chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
  disconnectIfIdle();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  enabledTabs.delete(tabId);
  disconnectIfIdle();
  chrome.action.setBadgeText({tabId, text: ''}).catch(() => {});
});

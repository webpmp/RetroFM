import JSZip from 'jszip';

export const EXTENSION_FILES: Record<string, string> = {
  'manifest.json': `{
  "manifest_version": 3,
  "name": "Retro FM YouTube Bridge",
  "version": "1.0.2",
  "description": "Permitted browser bridge for Retro FM Proof of Concept to detect and control YouTube music playback and audio ducking.",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwttdlZxh2jTkC4UaWVDwegBWNq3/xD3JHg7goyHrJ72AybEcX5HDYyz/DCNWJBaMCaqfqBs6+vXpc/7/P15AO0v4adpDOvgzOBpQ5RUCTk0L7V1TR09DrTxk72ivdDOQmdrNiHM1CMz3r8K/yhsZ7gmpEApRt/nvY2vXgBMvWHehkewC/RE9j7+09SqRoSyIAvaas8/5DgQkg2pMITNdttYxLfEnE+jqpvQtsS1BkmTEOmkRV20BEaSnW0vk2PXbjhTKnbKC2AVkjKzHwBd1pnG3/qvlT4D2rgO5UVzy+zwC9ikTFyNrz2ZZpRFO75LSJ/NI0STq3Xsh9Rdn63kAIwIDAQAB",
  "permissions": [
    "tabs",
    "scripting"
  ],
  "host_permissions": [
    "*://*.youtube.com/*",
    "<all_urls>"
  ],
  "externally_connectable": {
    "matches": [
      "*://localhost/*",
      "*://127.0.0.1/*",
      "*://*.run.app/*",
      "https://*.google.com/*"
    ]
  },
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": [
        "*://*.youtube.com/*"
      ],
      "js": [
        "content_youtube.js"
      ],
      "run_at": "document_idle"
    },
    {
      "matches": [
        "<all_urls>"
      ],
      "js": [
        "content_retrofm.js"
      ],
      "all_frames": true,
      "match_about_blank": true,
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Retro FM YouTube Bridge"
  }
}
`,

  'background.js': `// Retro FM Extension Background Service Worker (v1.0.2)

let activeConnectedTabId = null;

// Query for available YouTube tabs
async function listYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  return tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active
  }));
}

// Ensure the content_youtube script is injected into the target tab
async function ensureYouTubeScriptInjected(tabId) {
  try {
    // Ping tab to see if content script is active
    await chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' });
    return true;
  } catch (err) {
    // If receiving end does not exist, inject it dynamically via chrome.scripting
    try {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content_youtube.js']
        });
        // Brief pause to allow content script listeners to initialize
        await new Promise(r => setTimeout(r, 150));
        return true;
      }
    } catch (injectErr) {
      console.warn('[Retro FM] Script injection failed for tab', tabId, injectErr);
    }
    return false;
  }
}

// Find best YouTube tab (connected tab, active tab, or first found)
async function resolveYouTubeTab(requestedTabId) {
  if (requestedTabId) {
    try {
      const tab = await chrome.tabs.get(requestedTabId);
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        await ensureYouTubeScriptInjected(tab.id);
        return tab.id;
      }
    } catch (e) {
      // Tab might have closed
    }
  }

  if (activeConnectedTabId) {
    try {
      const tab = await chrome.tabs.get(activeConnectedTabId);
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        await ensureYouTubeScriptInjected(tab.id);
        return tab.id;
      }
    } catch (e) {
      activeConnectedTabId = null;
    }
  }

  const tabs = await listYouTubeTabs();
  const activeTab = tabs.find(t => t.active) || tabs[0];
  if (activeTab) {
    activeConnectedTabId = activeTab.id;
    await ensureYouTubeScriptInjected(activeTab.id);
    return activeTab.id;
  }
  return null;
}

// Central dispatcher for handling requests from webpage or content script
function handleIncomingRequest(request, sendResponse) {
  const { type, payload } = request;

  (async () => {
    try {
      if (type === 'PING') {
        sendResponse({ success: true, type: 'PONG', version: '1.0.2' });
        return;
      }

      if (type === 'LIST_YOUTUBE_TABS') {
        const tabs = await listYouTubeTabs();
        sendResponse({ success: true, data: { tabs, connectedTabId: activeConnectedTabId } });
        return;
      }

      if (type === 'CONNECT_YOUTUBE_TAB') {
        const targetId = payload?.tabId;
        const resolvedId = await resolveYouTubeTab(targetId);
        if (!resolvedId) {
          sendResponse({
            success: false,
            error: 'No YouTube tab found. Please make sure a tab with youtube.com is open.'
          });
          return;
        }
        activeConnectedTabId = resolvedId;

        // Query status of connected tab
        try {
          const status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
          sendResponse({ success: true, data: { tabId: resolvedId, status } });
        } catch (err) {
          // If first message failed, retry once after script injection
          await ensureYouTubeScriptInjected(resolvedId);
          try {
            const status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
            sendResponse({ success: true, data: { tabId: resolvedId, status } });
          } catch (retryErr) {
            sendResponse({ success: true, data: { tabId: resolvedId, status: { available: true } } });
          }
        }
        return;
      }

      if (type === 'COMMAND_YOUTUBE') {
        const tabId = await resolveYouTubeTab(payload?.tabId);
        if (!tabId) {
          sendResponse({ success: false, error: 'No YouTube tab connected.' });
          return;
        }

        try {
          const result = await chrome.tabs.sendMessage(tabId, payload.command);
          sendResponse({ success: true, data: result });
        } catch (err) {
          // Retry once after ensuring content script is injected
          await ensureYouTubeScriptInjected(tabId);
          try {
            const result = await chrome.tabs.sendMessage(tabId, payload.command);
            sendResponse({ success: true, data: result });
          } catch (retryErr) {
            sendResponse({ success: false, error: 'Failed communicating with YouTube tab: ' + retryErr.message });
          }
        }
        return;
      }

      sendResponse({ success: false, error: 'Unknown extension request type: ' + type });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep channel open for async response
}

// 1. Listen for external messages directly from web pages (via externally_connectable)
if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    return handleIncomingRequest(request, sendResponse);
  });
}

// 2. Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  return handleIncomingRequest(request, sendResponse);
});
`,

  'content_youtube.js': `// Retro FM YouTube Content Script
// Interacts with standard HTML5 video player on YouTube tabs

let rampInterval = null;

function getVideoElement() {
  return document.querySelector('video.video-stream.html5-main-video') || document.querySelector('video');
}

function getTitle() {
  const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
             document.querySelector('h1.title yt-formatted-string');
  if (h1 && h1.textContent && h1.textContent.trim()) {
    return h1.textContent.trim();
  }
  return document.title.replace(' - YouTube', '').trim() || 'Unknown Video';
}

function getPlaybackStatus() {
  const video = getVideoElement();
  if (!video) {
    return {
      available: false,
      title: getTitle(),
      url: window.location.href,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 1,
      muted: false
    };
  }

  return {
    available: true,
    title: getTitle(),
    url: window.location.href,
    isPlaying: !video.paused && !video.ended && video.readyState > 2,
    currentTime: Math.floor(video.currentTime),
    duration: Math.floor(video.duration || 0),
    volume: Number(video.volume.toFixed(2)),
    muted: video.muted
  };
}

function smoothRampVolume(targetVolume, durationMs) {
  const video = getVideoElement();
  if (!video) return;

  if (rampInterval) {
    clearInterval(rampInterval);
    rampInterval = null;
  }

  const startVolume = video.volume;
  const startTime = performance.now();
  const stepMs = 25;

  rampInterval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(1, elapsed / durationMs);
    // sinusoidal ease in-out
    const eased = 0.5 * (1 - Math.cos(Math.PI * progress));
    const current = startVolume + (targetVolume - startVolume) * eased;
    video.volume = Math.max(0, Math.min(1, current));

    if (progress >= 1) {
      clearInterval(rampInterval);
      rampInterval = null;
      video.volume = Math.max(0, Math.min(1, targetVolume));
    }
  }, stepMs);
}

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const video = getVideoElement();

  switch (message.action) {
    case 'GET_STATUS': {
      sendResponse(getPlaybackStatus());
      break;
    }
    case 'PLAY': {
      if (video) {
        video.play().then(() => {
          sendResponse({ success: true, status: getPlaybackStatus() });
        }).catch((err) => {
          sendResponse({ success: false, error: err.message });
        });
        return true;
      }
      sendResponse({ success: false, error: 'Video element not found' });
      break;
    }
    case 'PAUSE': {
      if (video) {
        video.pause();
        sendResponse({ success: true, status: getPlaybackStatus() });
      } else {
        sendResponse({ success: false, error: 'Video element not found' });
      }
      break;
    }
    case 'STOP': {
      if (video) {
        video.pause();
        video.currentTime = 0;
        sendResponse({ success: true, status: getPlaybackStatus() });
      } else {
        sendResponse({ success: false, error: 'Video element not found' });
      }
      break;
    }
    case 'SEEK': {
      if (video && typeof message.time === 'number') {
        video.currentTime = message.time;
        sendResponse({ success: true, status: getPlaybackStatus() });
      } else {
        sendResponse({ success: false, error: 'Cannot seek' });
      }
      break;
    }
    case 'SET_VOLUME': {
      if (video && typeof message.volume === 'number') {
        if (rampInterval) clearInterval(rampInterval);
        video.volume = Math.max(0, Math.min(1, message.volume));
        sendResponse({ success: true, volume: video.volume });
      } else {
        sendResponse({ success: false, error: 'Cannot set volume' });
      }
      break;
    }
    case 'RAMP_VOLUME': {
      if (video && typeof message.targetVolume === 'number') {
        const duration = message.durationMs || 500;
        smoothRampVolume(message.targetVolume, duration);
        sendResponse({ success: true, targetVolume: message.targetVolume });
      } else {
        sendResponse({ success: false, error: 'Cannot ramp volume' });
      }
      break;
    }
    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }

  return true;
});
`,

  'content_retrofm.js': `// Retro FM Page Bridge Content Script
// Mediates messages between the Retro FM web app and the background extension worker
// Supports running both top-level and inside nested frames/iframes

(function() {
  const SOURCE_PAGE = 'RETRO_FM_PAGE';
  const SOURCE_EXT = 'RETRO_FM_EXTENSION';

  // Announce presence to current window and top window if in iframe
  function announceReady() {
    const payload = {
      source: SOURCE_EXT,
      type: 'EXTENSION_READY',
      version: '1.0.2',
      isIframe: window !== window.top
    };

    try {
      window.postMessage(payload, '*');
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch (e) {
      // ignore
    }
  }

  announceReady();
  setInterval(announceReady, 2000);

  // Listen to requests from web page
  window.addEventListener('message', (event) => {
    // Only accept messages with proper source marker
    if (!event.data || event.data.source !== SOURCE_PAGE) {
      return;
    }

    const { id, type, payload } = event.data;
    const targetWindow = event.source || window;

    if (type === 'PING') {
      try {
        targetWindow.postMessage({
          source: SOURCE_EXT,
          id,
          type: 'PONG',
          version: '1.0.2'
        }, '*');
      } catch (e) {
        window.postMessage({
          source: SOURCE_EXT,
          id,
          type: 'PONG',
          version: '1.0.2'
        }, '*');
      }
      return;
    }

    // Forward request to background service worker
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const lastError = chrome.runtime.lastError;
      const responsePayload = {
        source: SOURCE_EXT,
        id,
        type: type + '_RESPONSE',
        success: !lastError && !!response?.success,
        data: response?.data !== undefined ? response.data : response,
        error: lastError ? lastError.message : response?.error
      };

      try {
        targetWindow.postMessage(responsePayload, '*');
      } catch (e) {
        window.postMessage(responsePayload, '*');
      }
    });
  });
})();
`,

  'popup.html': `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      width: 280px;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #12141a;
      color: #e2e8f0;
      margin: 0;
    }
    h3 {
      margin: 0 0 8px 0;
      color: #f59e0b;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    p {
      font-size: 12px;
      line-height: 1.4;
      color: #94a3b8;
      margin: 0 0 12px 0;
    }
    .status {
      display: inline-block;
      padding: 4px 8px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 4px;
      font-size: 11px;
      color: #10b981;
    }
  </style>
</head>
<body>
  <h3>Retro FM Bridge</h3>
  <p>Permitted tab controller bridge for the Retro FM proof-of-concept experiment.</p>
  <div class="status">● Bridge Active (v1.0.2)</div>
</body>
</html>
`,

  'README.md': `# Retro FM Chrome Extension Bridge (v1.0.2)

This extension provides the permitted communication bridge between the Retro FM Test Page and your YouTube tab.

## Quick 3-Step Setup

1. Open Chrome and navigate to \`chrome://extensions/\`
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** (or click the **Reload icon ↻** on the existing card) and select the unzipped \`extension\` folder.

## Key Features in v1.0.2
- **Direct Web Messaging (\`externally_connectable\`)**: Communicates directly with Retro FM without depending on DOM content script injection.
- **Fixed Extension ID**: \`hjphfmcilldbipolljlbjnnadeogocab\`
- **Dynamic Script Injection**: Automatically connects to active YouTube tabs even if opened before the extension was installed.
`
};

export async function generateAndDownloadExtensionZip(): Promise<void> {
  const zip = new JSZip();

  // Add files to zip with standard UNIX file permissions (0o644) and current date
  const now = new Date();
  for (const [filename, content] of Object.entries(EXTENSION_FILES)) {
    zip.file(filename, content, {
      date: now,
      unixPermissions: '644',
    });
  }

  // Generate ZIP Blob using DEFLATE compression with UNIX platform flags
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'retro-fm-extension.zip';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 5000);
}

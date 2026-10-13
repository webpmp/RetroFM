// Retro FM Page Bridge Content Script
// Mediates messages between the Retro FM web app and the background extension worker
// Supports running both top-level and inside nested frames/iframes

(function() {
  const SOURCE_PAGE = 'RETRO_FM_PAGE';
  const SOURCE_EXT = 'RETRO_FM_EXTENSION';

  let announceTimer = null;

  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function getExtVersion() {
    try {
      if (!isContextValid()) return '1.0.0';
      return chrome?.runtime?.getManifest?.()?.version || '1.0.0';
    } catch (e) {
      return '1.0.0';
    }
  }

  function cleanupInvalidatedContext() {
    if (announceTimer) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
    window.removeEventListener('message', onWindowMessage);
  }

  // Announce presence to current window and top window if in iframe
  function announceReady() {
    if (!isContextValid()) {
      cleanupInvalidatedContext();
      return;
    }

    const payload = {
      source: SOURCE_EXT,
      type: 'EXTENSION_READY',
      version: getExtVersion(),
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
  announceTimer = setInterval(announceReady, 2000);

  // Listen to requests from web page
  function onWindowMessage(event) {
    // Only accept messages with proper source marker
    if (!event.data || event.data.source !== SOURCE_PAGE) {
      return;
    }

    if (!isContextValid()) {
      cleanupInvalidatedContext();
      const targetWin = event.source || window;
      try {
        targetWin.postMessage({
          source: SOURCE_EXT,
          id: event.data?.id,
          type: (event.data?.type || 'UNKNOWN') + '_RESPONSE',
          success: false,
          error: 'Extension context invalidated. Please refresh the page.'
        }, '*');
      } catch (e) {}
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
          version: getExtVersion()
        }, '*');
      } catch (e) {
        window.postMessage({
          source: SOURCE_EXT,
          id,
          type: 'PONG',
          version: getExtVersion()
        }, '*');
      }
      return;
    }

    // Forward request to background service worker
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        let lastError = null;
        try {
          lastError = chrome.runtime.lastError;
        } catch (e) {
          lastError = { message: 'Extension context invalidated' };
        }

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
    } catch (sendErr) {
      cleanupInvalidatedContext();
      const responsePayload = {
        source: SOURCE_EXT,
        id,
        type: type + '_RESPONSE',
        success: false,
        error: sendErr?.message || 'Extension context invalidated'
      };
      try {
        targetWindow.postMessage(responsePayload, '*');
      } catch (e) {
        window.postMessage(responsePayload, '*');
      }
    }
  }

  window.addEventListener('message', onWindowMessage);

  // Relay push messages from background service worker to web page window
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      if (message && typeof message === 'object') {
        const payload = {
          source: SOURCE_EXT,
          ...message
        };
        try {
          window.postMessage(payload, '*');
        } catch (e) {}
      }
      sendResponse({ received: true });
      return true;
    });
  } catch (e) {}
})();


// Retro FM Page Bridge Content Script
// Mediates messages between the Retro FM web app and the background extension worker
// Supports running both top-level and inside nested frames/iframes

(function() {
  if (window.__retroFmPageBridgeLoaded) return;
  window.__retroFmPageBridgeLoaded = true;

  const SOURCE_PAGE = 'RETRO_FM_PAGE';
  const SOURCE_EXT = 'RETRO_FM_EXTENSION';

  let announceTimer = null;
  let isInvalidated = false;

  function isContextValid() {
    try {
      return !isInvalidated && !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function cleanupInvalidatedContext() {
    if (isInvalidated) return;
    isInvalidated = true;
    try {
      if (announceTimer) {
        clearInterval(announceTimer);
        announceTimer = null;
      }
      window.removeEventListener('message', onWindowMessage);
    } catch (e) {}
  }

  function reportError(err, context = '') {
    if (!isContextValid()) {
      cleanupInvalidatedContext();
      return;
    }
    try {
      const message = err?.message || String(err || 'Unknown error');
      const stack = err?.stack || '';
      chrome.runtime.sendMessage({
        type: 'EXTENSION_ERROR',
        payload: {
          source: 'content_retrofm' + (context ? `:${context}` : ''),
          message,
          stack,
          time: Date.now()
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (e) {
      cleanupInvalidatedContext();
    }
  }

  window.addEventListener('error', (event) => {
    try {
      reportError(event.error || event.message, 'window.onerror');
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      reportError(event.reason, 'window.unhandledrejection');
    } catch (e) {}
  });

  function getExtVersion() {
    try {
      if (!isContextValid()) return '1.0.0';
      return chrome?.runtime?.getManifest?.()?.version || '1.0.0';
    } catch (e) {
      return '1.0.0';
    }
  }

  // Announce presence to current window and top window if in iframe
  function announceReady() {
    try {
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
        reportError(e, 'announceReady.postMessage');
      }
    } catch (err) {
      reportError(err, 'announceReady');
    }
  }

  announceReady();
  announceTimer = setInterval(announceReady, 2000);

  // Listen to requests from web page
  function onWindowMessage(event) {
    try {
      // 1. Handle app self-registration: { type: 'RETROFM_APP_HELLO' }
      if (event && event.data && event.data.type === 'RETROFM_APP_HELLO') {
        if (!isContextValid()) {
          cleanupInvalidatedContext();
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: 'REGISTER_RETROFM_APP' }, () => {
            if (chrome.runtime?.lastError) {}
          });
        } catch (e) {
          cleanupInvalidatedContext();
          reportError(e, 'REGISTER_RETROFM_APP');
        }
        return;
      }

      // Only accept other messages with proper source marker
      if (!event || !event.data || event.data.source !== SOURCE_PAGE) {
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
        if (!isContextValid()) {
          cleanupInvalidatedContext();
          return;
        }
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
        reportError(sendErr, `onWindowMessage.send:${type}`);
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
    } catch (err) {
      reportError(err, 'onWindowMessage');
    }
  }

  window.addEventListener('message', onWindowMessage);

  // Relay push messages from background service worker to web page window
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
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
          } catch (e) {
            reportError(e, 'chrome.runtime.onMessage.postMessage');
          }
        }
        sendResponse({ received: true });
      } catch (err) {
        reportError(err, 'chrome.runtime.onMessage');
      }
    });
  } catch (e) {
    reportError(e, 'chrome.runtime.onMessage.addListener');
  }
})();


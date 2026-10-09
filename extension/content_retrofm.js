// Retro FM Page Bridge Content Script
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
      version: '1.0.4',
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
          version: '1.0.4'
        }, '*');
      } catch (e) {
        window.postMessage({
          source: SOURCE_EXT,
          id,
          type: 'PONG',
          version: '1.0.4'
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

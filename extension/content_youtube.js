// Retro FM YouTube Content Script
// Interacts with standard HTML5 video player on YouTube tabs

if (!window.__retroFmContentLoaded) {
  window.__retroFmContentLoaded = true;

  let rampInterval = null;
  let activeRampId = null;

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

  function smoothRampVolume(targetVolume, durationMs, rampId) {
    const video = getVideoElement();
    if (!video) return;

    // Cancel any existing ramp interval
    if (rampInterval) {
      clearInterval(rampInterval);
      rampInterval = null;
    }

    activeRampId = (rampId !== undefined && rampId !== null) ? rampId : Date.now();
    const assignedRampId = activeRampId;

    const startVolume = video.volume;
    const clampedTarget = Math.max(0, Math.min(1, targetVolume));
    const startTime = performance.now();
    const stepMs = 25;

    rampInterval = setInterval(() => {
      // Stale ramp check: if another ramp was started, cancel immediately
      if (activeRampId !== assignedRampId) {
        clearInterval(rampInterval);
        rampInterval = null;
        return;
      }

      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      // sinusoidal ease in-out
      const eased = 0.5 * (1 - Math.cos(Math.PI * progress));
      const current = startVolume + (clampedTarget - startVolume) * eased;
      video.volume = Math.max(0, Math.min(1, current));

      if (progress >= 1) {
        clearInterval(rampInterval);
        rampInterval = null;
        // Explicitly snap to target volume at completion
        video.volume = clampedTarget;
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
          if (rampInterval) {
            clearInterval(rampInterval);
            rampInterval = null;
          }
          activeRampId = (message.rampId !== undefined && message.rampId !== null) ? message.rampId : Date.now();
          video.volume = Math.max(0, Math.min(1, message.volume));
          sendResponse({ success: true, volume: video.volume, rampId: activeRampId });
        } else {
          sendResponse({ success: false, error: 'Cannot set volume' });
        }
        break;
      }
      case 'RAMP_VOLUME': {
        if (video && typeof message.targetVolume === 'number') {
          const duration = message.durationMs || 500;
          smoothRampVolume(message.targetVolume, duration, message.rampId);
          sendResponse({ success: true, targetVolume: message.targetVolume, rampId: message.rampId });
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
}

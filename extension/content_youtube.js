// Retro FM YouTube Content Script
// Interacts with standard HTML5 video player on YouTube tabs

if (!window.__retroFmContentLoaded) {
  window.__retroFmContentLoaded = true;

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
}

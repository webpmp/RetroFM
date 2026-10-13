// Retro FM YouTube Content Script
// Interacts with standard HTML5 video player on YouTube tabs
// Bridges volume control to player/yt_main_world.js (running in world: "MAIN")

if (!window.__retroFmContentLoaded) {
  window.__retroFmContentLoaded = true;

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_VOLUME_STATUS = 'RETROFM_YT_VOLUME_STATUS';
  const EVENT_PLAYER_COMMAND = 'RETROFM_PLAYER_COMMAND';

  let rampInterval = null;
  let activeRampId = null;

  // Track latest main-world volume status (0-100)
  let latestPlayerVolume = 100;
  let latestPlayerMuted = false;

  // Listen for volume status broadcast from player/yt_main_world.js
  window.addEventListener(EVENT_VOLUME_STATUS, (event) => {
    try {
      const detail = event.detail;
      if (detail && typeof detail.volume === 'number') {
        latestPlayerVolume = detail.volume;
        latestPlayerMuted = !!detail.muted;
      }
    } catch (e) {}
  });

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
    const reportedVolFraction = Number((latestPlayerVolume / 100).toFixed(2));

    if (!video) {
      return {
        available: false,
        title: getTitle(),
        url: window.location.href,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: reportedVolFraction,
        muted: latestPlayerMuted
      };
    }

    return {
      available: true,
      title: getTitle(),
      url: window.location.href,
      isPlaying: !video.paused && !video.ended && video.readyState > 2,
      currentTime: Math.floor(video.currentTime),
      duration: Math.floor(video.duration || 0),
      volume: reportedVolFraction,
      muted: latestPlayerMuted || video.muted
    };
  }

  /**
   * Send volume command to player/yt_main_world.js in the Main Page World.
   * targetVolume: fraction 0.0 to 1.0 (or percent 0 to 100)
   * Note: We DO NOT write video.volume directly, avoiding YouTube player reset / normalization conflicts.
   */
  function applyVolumeToPlayer(targetVolume, reason = 'applyVolume') {
    const rawVal = typeof targetVolume === 'number' ? targetVolume : 1;
    // Accept fraction (0-1) or percentage (0-100)
    const targetPercent = rawVal <= 1.0 && rawVal >= 0.0 ? Math.round(rawVal * 100) : Math.round(Math.max(0, Math.min(100, rawVal)));
    const clampedPercent = Math.max(0, Math.min(100, targetPercent));

    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Sending volume to main-world: ${clampedPercent}% (reason=${reason})`
    );

    // 1. Dispatch CustomEvent to player/yt_main_world.js
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_SET_VOLUME, {
          detail: JSON.stringify({ volume: clampedPercent, reason })
        })
      );
    } catch (e) {}

    // 2. Also dispatch window.postMessage for redundancy
    try {
      window.postMessage({ type: 'RETROFM_SET_VOLUME_MSG', volume: clampedPercent, reason }, '*');
    } catch (e) {}

    // Optimistically update latestPlayerVolume
    latestPlayerVolume = clampedPercent;
  }

  function sendPlayerCommandToMainWorld(command, payload = {}) {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_PLAYER_COMMAND, {
          detail: JSON.stringify({ command, payload })
        })
      );
    } catch (e) {}
  }

  function smoothRampVolume(targetVolume, durationMs, rampId) {
    // Cancel any existing ramp interval
    if (rampInterval) {
      clearInterval(rampInterval);
      rampInterval = null;
    }

    activeRampId = (rampId !== undefined && rampId !== null) ? rampId : Date.now();
    const assignedRampId = activeRampId;

    const startPercent = latestPlayerVolume;
    const rawTarget = typeof targetVolume === 'number' ? targetVolume : 1;
    const targetPercent = rawTarget <= 1.0 && rawTarget >= 0.0 ? Math.round(rawTarget * 100) : Math.round(Math.max(0, Math.min(100, rawTarget)));
    const clampedTargetPercent = Math.max(0, Math.min(100, targetPercent));

    const startTime = performance.now();
    const stepMs = 25;

    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] smoothRampVolume START: ${startPercent}% -> ${clampedTargetPercent}% | duration: ${durationMs}ms | rampId: ${assignedRampId}`
    );

    rampInterval = setInterval(() => {
      // Stale ramp check: if another ramp was started, cancel immediately
      if (activeRampId !== assignedRampId) {
        console.warn(
          `[RetroFM Volume] [${new Date().toISOString()}] smoothRampVolume CANCELLED stale rampId: ${assignedRampId} (active: ${activeRampId})`
        );
        clearInterval(rampInterval);
        rampInterval = null;
        return;
      }

      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      // sinusoidal ease in-out
      const eased = 0.5 * (1 - Math.cos(Math.PI * progress));
      const currentPercent = Math.round(startPercent + (clampedTargetPercent - startPercent) * eased);
      const stepTarget = Math.max(0, Math.min(100, currentPercent));

      // Call player.setVolume via main-world bridge at each step
      applyVolumeToPlayer(stepTarget, `rampStep:${assignedRampId}`);

      if (progress >= 1) {
        clearInterval(rampInterval);
        rampInterval = null;
        applyVolumeToPlayer(clampedTargetPercent, `rampCompleted:${assignedRampId}`);
        console.log(
          `[RetroFM Volume] [${new Date().toISOString()}] smoothRampVolume COMPLETED: final ${clampedTargetPercent}% | rampId: ${assignedRampId}`
        );
      }
    }, stepMs);
  }

  // Monitor native volume changes to detect external/YouTube interventions
  let lastObservedVideo = null;
  let ensureVolumeInterval = null;

  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function ensureVolumeListener() {
    if (!isContextValid()) {
      if (ensureVolumeInterval) {
        clearInterval(ensureVolumeInterval);
        ensureVolumeInterval = null;
      }
      return;
    }
    const video = getVideoElement();
    if (video && video !== lastObservedVideo) {
      lastObservedVideo = video;
      video.addEventListener('volumechange', () => {
        console.log(
          `[RetroFM Volume] [${new Date().toISOString()}] Native video.volumechange event: video.volume=${video.volume.toFixed(2)}, muted=${video.muted}, playerVolume=${latestPlayerVolume}%, currentTime=${Math.floor(video.currentTime)}s`
        );
      });
    }
  }
  ensureVolumeListener();
  ensureVolumeInterval = setInterval(ensureVolumeListener, 2000);

  let activePlayCleanup = null;

  // Listen for messages from background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const video = getVideoElement();

    // If an action arrives (e.g. PAUSE, STOP, or another PLAY), cancel any pending play polling
    if (activePlayCleanup && (message.action === 'PLAY' || message.action === 'PAUSE' || message.action === 'STOP')) {
      activePlayCleanup();
      activePlayCleanup = null;
    }

    switch (message.action) {
      case 'GET_STATUS': {
        sendResponse(getPlaybackStatus());
        break;
      }
      case 'PLAY': {
        if (!video) {
          sendResponse({ success: false, state: 'no_video', error: 'Video element not found' });
          break;
        }

        // If already actively playing, confirm immediately
        if (!video.paused && !video.ended && (video.readyState >= 3 || video.currentTime > 0)) {
          sendResponse({ success: true, state: 'already_playing', status: getPlaybackStatus() });
          break;
        }

        // Bridge to YouTube movie_player in the main world to activate player lifecycle
        sendPlayerCommandToMainWorld('PLAY');

        const initialTime = video.currentTime;
        let playPromise;
        try {
          playPromise = video.play();
        } catch (err) {
          sendResponse({
            success: false,
            state: 'play_threw',
            error: err.message,
            status: getPlaybackStatus()
          });
          break;
        }

        if (!playPromise || typeof playPromise.then !== 'function') {
          const isPlaying = !video.paused && !video.ended;
          sendResponse({
            success: isPlaying,
            state: isPlaying ? 'playing' : 'failed',
            status: getPlaybackStatus()
          });
          break;
        }

        let responded = false;
        let pollTimer = null;
        let safetyTimeout = null;

        const cleanup = () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
          video.removeEventListener('playing', onPlaying);
          video.removeEventListener('timeupdate', onTimeUpdate);
          if (activePlayCleanup === cleanup) {
            activePlayCleanup = null;
          }
        };
        activePlayCleanup = cleanup;

        const finish = (success, state, diagnostic) => {
          if (responded) return;
          responded = true;
          cleanup();
          const currentStatus = getPlaybackStatus();
          sendResponse({
            success,
            state,
            error: success ? undefined : diagnostic,
            status: currentStatus
          });
        };

        const onPlaying = () => {
          finish(true, 'playing');
        };

        const onTimeUpdate = () => {
          if (!video.paused && (video.currentTime > initialTime || video.currentTime > 0)) {
            finish(true, 'playing');
          }
        };

        video.addEventListener('playing', onPlaying, { once: true });
        video.addEventListener('timeupdate', onTimeUpdate);

        playPromise.then(() => {
          // Play request accepted by browser. Verify playback actually starts within bounded window
          if (!video.paused && (video.readyState >= 3 || video.currentTime > initialTime)) {
            finish(true, 'playing');
            return;
          }

          const startTime = performance.now();
          pollTimer = setInterval(() => {
            if (responded) return;
            if (!video.paused && (video.readyState >= 3 || video.currentTime > initialTime)) {
              finish(true, 'playing');
              return;
            }
            if (video.paused) {
              finish(false, 'paused', 'Video remained paused after play request');
              return;
            }
            if (performance.now() - startTime >= 1500) {
              if (!video.paused) {
                // Not paused, buffering or transitioning
                finish(true, 'buffering_active');
              } else {
                finish(false, 'timeout', 'Playback verification timed out');
              }
            }
          }, 100);
        }).catch((err) => {
          finish(false, 'rejected', `${err.name}: ${err.message}`);
        });

        safetyTimeout = setTimeout(() => {
          if (!responded) {
            const isPlaying = !video.paused && !video.ended && (video.readyState >= 3 || video.currentTime > initialTime);
            finish(isPlaying, isPlaying ? 'playing' : (video.paused ? 'paused' : 'timeout'), isPlaying ? undefined : 'Playback request timed out before confirmation');
          }
        }, 2000);

        return true; // Keep channel open for async response
      }
      case 'PAUSE': {
        if (!video) {
          sendResponse({ success: false, state: 'no_video', error: 'Video element not found' });
          break;
        }
        sendPlayerCommandToMainWorld('PAUSE');
        video.pause();
        const isPaused = video.paused;
        const status = getPlaybackStatus();
        sendResponse({
          success: isPaused,
          state: 'paused',
          status: {
            ...status,
            isPlaying: false
          }
        });
        break;
      }
      case 'STOP': {
        if (!video) {
          sendResponse({ success: false, state: 'no_video', error: 'Video element not found' });
          break;
        }
        sendPlayerCommandToMainWorld('STOP');
        video.pause();
        video.currentTime = 0;
        const isPaused = video.paused;
        const status = getPlaybackStatus();
        sendResponse({
          success: isPaused,
          state: 'stopped',
          status: {
            ...status,
            isPlaying: false,
            currentTime: 0
          }
        });
        break;
      }
      case 'SEEK': {
        if (video && typeof message.time === 'number') {
          sendPlayerCommandToMainWorld('SEEK', { time: message.time });
          video.currentTime = message.time;
          sendResponse({ success: true, status: getPlaybackStatus() });
        } else {
          sendResponse({ success: false, error: 'Cannot seek' });
        }
        break;
      }
      case 'SET_VOLUME': {
        if (typeof message.volume === 'number') {
          if (rampInterval) {
            clearInterval(rampInterval);
            rampInterval = null;
          }
          activeRampId = (message.rampId !== undefined && message.rampId !== null) ? message.rampId : Date.now();
          const prevVol = latestPlayerVolume;
          applyVolumeToPlayer(message.volume, `SET_VOLUME:${activeRampId}`);

          const rawVal = message.volume;
          const targetPercent = rawVal <= 1.0 && rawVal >= 0.0 ? Math.round(rawVal * 100) : Math.round(Math.max(0, Math.min(100, rawVal)));
          const clampedPercent = Math.max(0, Math.min(100, targetPercent));

          // Wait until player reports getVolume() matching target or timeout (1500ms)
          const startTime = performance.now();
          let replied = false;

          const checkConfirmed = () => {
            if (replied) return;
            // Allow exact match or if target is 0/100 or within 1%
            if (Math.abs(latestPlayerVolume - clampedPercent) <= 1 || performance.now() - startTime >= 1500) {
              replied = true;
              window.removeEventListener(EVENT_VOLUME_STATUS, onStatus);
              console.log(
                `[RetroFM Volume] [${new Date().toISOString()}] content_youtube SET_VOLUME confirmed: prev=${prevVol}% -> confirmedPlayerVol=${latestPlayerVolume}% (target=${clampedPercent}%) | elapsed=${Math.round(performance.now() - startTime)}ms | rampId: ${activeRampId}`
              );
              sendResponse({
                success: true,
                volume: Number((latestPlayerVolume / 100).toFixed(2)),
                playerVolume: latestPlayerVolume,
                confirmed: Math.abs(latestPlayerVolume - clampedPercent) <= 1,
                rampId: activeRampId
              });
            }
          };

          const onStatus = () => checkConfirmed();
          window.addEventListener(EVENT_VOLUME_STATUS, onStatus);

          // Fast path check immediately
          if (Math.abs(latestPlayerVolume - clampedPercent) <= 1) {
            checkConfirmed();
          } else {
            // Check via interval up to 1500ms
            const waitInterval = setInterval(() => {
              if (replied) {
                clearInterval(waitInterval);
                return;
              }
              checkConfirmed();
            }, 50);

            setTimeout(() => {
              clearInterval(waitInterval);
              checkConfirmed();
            }, 1500);
          }
          return true; // Keep sendResponse open for async confirmation
        } else {
          console.warn(`[RetroFM Volume] content_youtube SET_VOLUME failed: invalid volume parameter`);
          sendResponse({ success: false, error: 'Cannot set volume' });
        }
        break;
      }
      case 'RAMP_VOLUME': {
        if (typeof message.targetVolume === 'number') {
          const duration = message.durationMs || 500;
          console.log(
            `[RetroFM Volume] [${new Date().toISOString()}] content_youtube RAMP_VOLUME received: target ${message.targetVolume} (current: ${latestPlayerVolume}%) | duration: ${duration}ms | rampId: ${message.rampId}`
          );
          smoothRampVolume(message.targetVolume, duration, message.rampId);
          sendResponse({ success: true, targetVolume: message.targetVolume, rampId: message.rampId });
        } else {
          console.warn(`[RetroFM Volume] content_youtube RAMP_VOLUME failed: invalid targetVolume`);
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

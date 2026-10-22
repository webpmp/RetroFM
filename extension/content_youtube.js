// Retro FM YouTube Content Script
// Interacts with standard HTML5 video player on YouTube tabs
// Bridges volume control to player/yt_main_world.js (running in world: "MAIN")

if (!window.__retroFmContentLoaded) {
  window.__retroFmContentLoaded = true;

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_VOLUME_STATUS = 'RETROFM_YT_VOLUME_STATUS';
  const EVENT_SET_BALANCE = 'RETROFM_SET_YT_BALANCE';
  const EVENT_BALANCE_STATUS = 'RETROFM_YT_BALANCE_STATUS';
  const EVENT_PLAYER_COMMAND = 'RETROFM_PLAYER_COMMAND';
  const EVENT_STATE_CHANGE = 'RETROFM_YT_STATE_CHANGED';
  const EVENT_TRACE = 'RETROFM_TRACE';
  const EVENT_AUDIO_DIAGNOSTICS = 'RETROFM_AUDIO_DIAGNOSTICS';
  const EVENT_MAIN_WORLD_ERROR = 'RETROFM_MAIN_WORLD_ERROR';

  let isInvalidated = false;
  let activePlayCleanup = null;
  let rampInterval = null;
  let activeRampId = null;
  let ensureVolumeInterval = null;

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
      if (rampInterval) {
        clearInterval(rampInterval);
        rampInterval = null;
      }
      if (ensureVolumeInterval) {
        clearInterval(ensureVolumeInterval);
        ensureVolumeInterval = null;
      }
      if (activePlayCleanup) {
        activePlayCleanup();
        activePlayCleanup = null;
      }
      window.removeEventListener(EVENT_STATE_CHANGE, onStateChangeEvent);
      window.removeEventListener('message', onWindowMessageEvent);
      window.removeEventListener(EVENT_TRACE, onTraceEvent);
      window.removeEventListener(EVENT_AUDIO_DIAGNOSTICS, onAudioDiagnosticsEvent);
      window.removeEventListener(EVENT_VOLUME_STATUS, onVolumeStatusEvent);
      window.removeEventListener(EVENT_BALANCE_STATUS, onBalanceStatusEvent);
      window.removeEventListener(EVENT_MAIN_WORLD_ERROR, onMainWorldErrorEvent);
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
          source: 'content_youtube' + (context ? `:${context}` : ''),
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

  function safeParseDetail(detail) {
    if (detail === null || detail === undefined) return null;
    if (typeof detail === 'object') return detail;
    if (typeof detail === 'string') {
      try {
        const parsed = JSON.parse(detail);
        return (parsed && typeof parsed === 'object') ? parsed : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function trace(event, data) {
    if (!isContextValid()) {
      cleanupInvalidatedContext();
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: 'RECORD_TRACE',
        payload: {
          ts: Date.now(),
          source: 'content_youtube',
          event,
          data: data || {}
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (e) {
      cleanupInvalidatedContext();
      reportError(e, 'trace');
    }
  }

  let latestPlayerVolume = 100;
  let latestPlayerMuted = false;
  let latestPlayerBalance = 0;
  let latestLeftGain = 1;
  let latestRightGain = 1;
  let latestPlayerState = null;
  let latestVideoId = null;

  function getVideoId() {
    if (latestVideoId) return latestVideoId;
    try {
      const match = window.location.href.match(/[?&]v=([^&#]+)/);
      if (match) return match[1];
    } catch (e) {
      reportError(e, 'getVideoId');
    }
    return null;
  }

  function handleStateChangeFromMainWorld(data) {
    if (!data || typeof data.state === 'undefined') return;
    latestPlayerState = data.state;
    if (data.videoId) latestVideoId = data.videoId;
    if (!isContextValid()) {
      cleanupInvalidatedContext();
      return;
    }
    try {
      chrome.runtime.sendMessage({
        type: 'YT_STATE_CHANGED',
        payload: {
          state: data.state,
          videoId: data.videoId || getVideoId(),
          title: data.title || '',
          currentTime: typeof data.currentTime === 'number' ? data.currentTime : 0,
          duration: typeof data.duration === 'number' ? data.duration : 0
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (e) {
      cleanupInvalidatedContext();
      reportError(e, 'handleStateChangeFromMainWorld');
    }
  }

  function onStateChangeEvent(e) {
    try {
      const data = safeParseDetail(e ? e.detail : null);
      if (data) {
        handleStateChangeFromMainWorld(data);
      }
    } catch (err) {
      reportError(err, 'onStateChangeEvent');
    }
  }
  window.addEventListener(EVENT_STATE_CHANGE, onStateChangeEvent);

  function onWindowMessageEvent(e) {
    try {
      if (e && e.source === window && e.data && e.data.type === 'RETROFM_YT_STATE_CHANGED_MSG') {
        handleStateChangeFromMainWorld(e.data);
      }
    } catch (err) {
      reportError(err, 'onWindowMessageEvent');
    }
  }
  window.addEventListener('message', onWindowMessageEvent);

  // Forward main-world trace events to background
  function onTraceEvent(e) {
    try {
      const entry = safeParseDetail(e ? e.detail : null);
      if (!entry) return;
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      chrome.runtime.sendMessage({
        type: 'RECORD_TRACE',
        payload: entry
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (err) {
      cleanupInvalidatedContext();
      reportError(err, 'onTraceEvent');
    }
  }
  window.addEventListener(EVENT_TRACE, onTraceEvent);

  function onAudioDiagnosticsEvent(e) {
    try {
      const data = safeParseDetail(e ? e.detail : null);
      if (!data || !data.snapshot) return;
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      chrome.runtime.sendMessage({
        type: 'AUDIO_DIAGNOSTICS_SNAPSHOT',
        payload: data
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (err) {
      cleanupInvalidatedContext();
      reportError(err, 'onAudioDiagnosticsEvent');
    }
  }
  window.addEventListener(EVENT_AUDIO_DIAGNOSTICS, onAudioDiagnosticsEvent);

  // Listen for volume status broadcast from player/yt_main_world.js
  function onVolumeStatusEvent(event) {
    try {
      const detail = safeParseDetail(event ? event.detail : null);
      if (detail && typeof detail.volume === 'number') {
        latestPlayerVolume = detail.volume;
        latestPlayerMuted = !!detail.muted;
      }
      if (detail && typeof detail.balance === 'number') {
        latestPlayerBalance = detail.balance;
        if (typeof detail.leftGain === 'number') latestLeftGain = detail.leftGain;
        if (typeof detail.rightGain === 'number') latestRightGain = detail.rightGain;
      }
    } catch (e) {
      reportError(e, 'onVolumeStatusEvent');
    }
  }
  window.addEventListener(EVENT_VOLUME_STATUS, onVolumeStatusEvent);

  function onBalanceStatusEvent(event) {
    try {
      const detail = safeParseDetail(event ? event.detail : null);
      if (detail && typeof detail.balance === 'number') {
        latestPlayerBalance = detail.balance;
        if (typeof detail.leftGain === 'number') latestLeftGain = detail.leftGain;
        if (typeof detail.rightGain === 'number') latestRightGain = detail.rightGain;
      }
    } catch (e) {
      reportError(e, 'onBalanceStatusEvent');
    }
  }
  window.addEventListener(EVENT_BALANCE_STATUS, onBalanceStatusEvent);

  // Forward main-world errors to background
  function onMainWorldErrorEvent(event) {
    try {
      const detail = safeParseDetail(event ? event.detail : null);
      if (!detail) return;
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      chrome.runtime.sendMessage(detail, () => {
        if (chrome.runtime?.lastError) {}
      });
    } catch (e) {
      cleanupInvalidatedContext();
    }
  }
  window.addEventListener(EVENT_MAIN_WORLD_ERROR, onMainWorldErrorEvent);

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

  // Report content script presence and readiness to background
  try {
    const initialVid = getVideoId();
    if (initialVid) {
      handleStateChangeFromMainWorld({
        state: -1,
        videoId: initialVid,
        title: getTitle(),
        currentTime: 0,
        duration: 0
      });
    }
    // Always announce YouTube integration readiness to background service worker
    if (isContextValid()) {
      chrome.runtime.sendMessage({
        type: 'YT_PAGE_READY',
        payload: {
          videoId: initialVid || null,
          title: getTitle(),
          url: window.location.href,
          hasVideoElement: !!getVideoElement()
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    }
  } catch (e) {}

  function getPlaybackStatus() {
    const video = getVideoElement();
    const reportedVolFraction = Number((latestPlayerVolume / 100).toFixed(2));

    if (!video) {
      return {
        available: true,
        hasVideoElement: false,
        title: getTitle(),
        url: window.location.href,
        videoId: getVideoId(),
        playerState: latestPlayerState,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: reportedVolFraction,
        balance: latestPlayerBalance,
        leftGain: latestLeftGain,
        rightGain: latestRightGain,
        muted: latestPlayerMuted
      };
    }

    return {
      available: true,
      hasVideoElement: true,
      title: getTitle(),
      url: window.location.href,
      videoId: getVideoId(),
      playerState: latestPlayerState,
      isPlaying: !video.paused && !video.ended && video.readyState > 2,
      currentTime: Math.floor(video.currentTime),
      duration: Math.floor(video.duration || 0),
      volume: reportedVolFraction,
      balance: latestPlayerBalance,
      leftGain: latestLeftGain,
      rightGain: latestRightGain,
      muted: latestPlayerMuted || video.muted
    };
  }

  function applyBalanceToPlayer(targetBalance, reason = 'applyBalance') {
    const rawVal = typeof targetBalance === 'number' && !isNaN(targetBalance) ? targetBalance : 0;
    const clampedBalance = Number(Math.max(-1, Math.min(1, rawVal)).toFixed(4));
    const leftGain = clampedBalance <= 0 ? 1 : Number(Math.max(0, 1 - clampedBalance).toFixed(4));
    const rightGain = clampedBalance >= 0 ? 1 : Number(Math.max(0, 1 + clampedBalance).toFixed(4));

    console.log(
      `[RetroFM Balance] [${new Date().toISOString()}] Sending balance to main-world: ${clampedBalance} (L=${leftGain}, R=${rightGain}, reason=${reason})`
    );

    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_SET_BALANCE, {
          detail: JSON.stringify({ balance: clampedBalance, reason })
        })
      );
    } catch (e) {}

    try {
      window.postMessage({ type: 'RETROFM_SET_BALANCE_MSG', balance: clampedBalance, reason }, '*');
    } catch (e) {}

    latestPlayerBalance = clampedBalance;
    latestLeftGain = leftGain;
    latestRightGain = rightGain;
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

  function ensureVolumeListener() {
    try {
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      const video = getVideoElement();
      if (video && video !== lastObservedVideo) {
        lastObservedVideo = video;
        video.addEventListener('volumechange', () => {
          try {
            console.log(
              `[RetroFM Volume] [${new Date().toISOString()}] Native video.volumechange event: video.volume=${video.volume.toFixed(2)}, muted=${video.muted}, playerVolume=${latestPlayerVolume}%, currentTime=${Math.floor(video.currentTime)}s`
            );
          } catch (err) {
            reportError(err, 'video.volumechange');
          }
        });
      }
    } catch (e) {
      reportError(e, 'ensureVolumeListener');
    }
  }
  ensureVolumeListener();
  ensureVolumeInterval = setInterval(ensureVolumeListener, 2000);

  // Listen for messages from background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      if (!isContextValid()) {
        cleanupInvalidatedContext();
        return;
      }
      const video = getVideoElement();

      // If an action arrives (e.g. PAUSE, STOP, or another PLAY), cancel any pending play polling
      if (activePlayCleanup && (message?.action === 'PLAY' || message?.action === 'PAUSE' || message?.action === 'STOP')) {
        activePlayCleanup();
        activePlayCleanup = null;
      }

    switch (message.action) {
      case 'GET_STATUS': {
        sendResponse(getPlaybackStatus());
        break;
      }
      case 'PLAY': {
        const t_cs_play_recv = Date.now();
        const t_boombox_play_click = message?.t_boombox_play_click || null;
        trace('RECV_PLAY_COMMAND', {
          hasVideo: !!video,
          isPaused: video ? video.paused : null,
          t_cs_play_recv,
          t_boombox_play_click
        });
        if (!video) {
          sendResponse({ success: false, state: 'no_video', error: 'Video element not found' });
          break;
        }

        // If already actively playing, confirm immediately
        if (!video.paused && !video.ended && (video.readyState >= 3 || video.currentTime > 0)) {
          sendPlayerCommandToMainWorld('PLAY', { t_boombox_play_click, t_cs_play_recv });
          sendResponse({ success: true, state: 'already_playing', status: getPlaybackStatus() });
          break;
        }

        // Bridge to YouTube movie_player in the main world to activate player lifecycle
        sendPlayerCommandToMainWorld('PLAY', { t_boombox_play_click, t_cs_play_recv });

        const initialTime = video.currentTime;
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

        // Attempt direct video.play() if possible, but catch errors without immediately aborting
        // because main world player.playVideo() is also attempting playback
        let playPromise;
        try {
          playPromise = video.play();
        } catch (err) {
          trace('DIRECT_VIDEO_PLAY_ERROR', { error: err.message });
        }

        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err) => {
            trace('DIRECT_VIDEO_PLAY_REJECTED', { name: err.name, message: err.message });
          });
        }

        // Poll for player to transition to playing
        const startTime = performance.now();
        pollTimer = setInterval(() => {
          if (responded) return;
          if (!video.paused && (video.readyState >= 3 || video.currentTime > initialTime || video.currentTime > 0)) {
            finish(true, 'playing');
            return;
          }
          if (latestPlayerState === 1) {
            finish(true, 'playing');
            return;
          }
        }, 50);

        safetyTimeout = setTimeout(() => {
          if (!responded) {
            const isPlaying = (!video.paused && !video.ended && (video.readyState >= 3 || video.currentTime > initialTime)) || latestPlayerState === 1;
            finish(isPlaying, isPlaying ? 'playing' : (video.paused ? 'paused' : 'timeout'), isPlaying ? undefined : 'Playback request timed out before confirmation');
          }
        }, 2000);

        return true; // Keep channel open for async response
      }
      case 'PAUSE': {
        trace('RECV_PAUSE_COMMAND', { hasVideo: !!video, isPaused: video ? video.paused : null });
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
        trace('RECV_STOP_COMMAND', { hasVideo: !!video, isPaused: video ? video.paused : null });
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
        trace('RECV_SEEK_COMMAND', { time: message.time, hasVideo: !!video });
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
      case 'SET_BALANCE': {
        if (typeof message.balance === 'number' && !isNaN(message.balance)) {
          applyBalanceToPlayer(message.balance, 'SET_BALANCE');
          sendResponse({
            success: true,
            balance: latestPlayerBalance,
            leftGain: latestLeftGain,
            rightGain: latestRightGain
          });
        } else {
          console.warn(`[RetroFM Balance] content_youtube SET_BALANCE failed: invalid balance parameter`);
          sendResponse({ success: false, error: 'Cannot set balance' });
        }
        break;
      }
      case 'GET_DIAGNOSTICS_SNAPSHOT': {
        try {
          window.dispatchEvent(new CustomEvent('RETROFM_REQ_AUDIO_DIAGNOSTICS'));
        } catch (e) {}
        sendResponse({ success: true });
        break;
      }
      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (err) {
    reportError(err, 'chrome.runtime.onMessage');
    try {
      sendResponse({ success: false, error: err?.message || 'Internal content script error' });
    } catch (e) {}
  }
  });

  // YouTube content script runs quietly in background without activation overlays
}


// RetroFM YouTube Main-World Player Bridge
// Runs in world: "MAIN" with direct access to YouTube's player API (.html5-video-player / #movie_player)

(function () {
  if (window.__retroFmMainWorldLoaded) return;
  window.__retroFmMainWorldLoaded = true;

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_VOLUME_STATUS = 'RETROFM_YT_VOLUME_STATUS';
  const EVENT_PLAYER_COMMAND = 'RETROFM_PLAYER_COMMAND';
  const EVENT_STATE_CHANGE = 'RETROFM_YT_STATE_CHANGED';
  const EVENT_TRACE = 'RETROFM_TRACE';
  const EVENT_ERROR = 'RETROFM_MAIN_WORLD_ERROR';
  const STORAGE_KEY_SAVED_VOLUME = 'retrofm_saved_master_volume';

  function reportError(err, context = '') {
    try {
      const message = err?.message || String(err || 'Unknown error');
      const stack = err?.stack || '';
      const payload = {
        type: 'EXTENSION_ERROR',
        source: 'yt_main_world' + (context ? `:${context}` : ''),
        message,
        stack,
        time: Date.now()
      };
      window.dispatchEvent(new CustomEvent(EVENT_ERROR, {
        detail: JSON.stringify(payload)
      }));
    } catch (e) {}
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

  function trace(event, data) {
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_TRACE, {
          detail: JSON.stringify({
            ts: Date.now(),
            source: 'yt_main_world',
            event,
            data: data || {}
          })
        })
      );
    } catch (e) {
      reportError(e, 'trace');
    }
  }

  // Restore remembered master volume from localStorage if available
  let queuedVolume = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SAVED_VOLUME);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        queuedVolume = parsed;
      }
    }
  } catch (e) {}

  let playerFound = false;
  let lastUnmuteTime = 0;

  function getPlayer() {
    return document.querySelector('.html5-video-player') ||
           document.getElementById('movie_player') ||
           null;
  }

  function hasActivation() {
    try {
      return !!(typeof navigator !== 'undefined' && navigator.userActivation && navigator.userActivation.hasBeenActive);
    } catch (e) {
      return false;
    }
  }

  function applyVolume(vol, reason = 'direct') {
    if (typeof vol !== 'number' || isNaN(vol)) return;
    const clampedVol = Math.max(0, Math.min(100, Math.round(vol)));
    queuedVolume = clampedVol;

    try {
      localStorage.setItem(STORAGE_KEY_SAVED_VOLUME, String(clampedVol));
    } catch (e) {}

    const player = getPlayer();
    if (player && typeof player.setVolume === 'function') {
      try {
        const prevVol = typeof player.getVolume === 'function' ? player.getVolume() : 'unknown';
        player.setVolume(clampedVol);

        const isPlayerMuted = typeof player.isMuted === 'function' ? player.isMuted() : false;
        if (clampedVol > 0 && isPlayerMuted) {
          if (hasActivation()) {
            if (typeof player.unMute === 'function') {
              lastUnmuteTime = Date.now();
              player.unMute();
            }
          } else {
            recordDiagnosticEvent('Muted; cannot unmute without a click in the YouTube tab', {
              reason,
              clampedVol
            });
          }
        } else if (clampedVol === 0 && !isPlayerMuted && hasActivation()) {
          if (typeof player.mute === 'function') {
            player.mute();
          }
        }

        const resultingVol = typeof player.getVolume === 'function' ? player.getVolume() : clampedVol;
        console.log(
          `[RetroFM MainWorld] [${new Date().toISOString()}] setVolume called: requested=${clampedVol} (reason=${reason}, prev=${prevVol}) -> player.getVolume()=${resultingVol}`
        );

        broadcastStatus();
      } catch (err) {
        console.warn(`[RetroFM MainWorld] Error calling setVolume on player:`, err);
      }
    } else {
      console.log(
        `[RetroFM MainWorld] [${new Date().toISOString()}] Player not yet ready. Queued volume: ${clampedVol} (reason=${reason})`
      );
    }
  }

  function broadcastStatus() {
    const player = getPlayer();
    let currentVol = 100;
    let isMuted = false;

    if (player) {
      if (typeof player.getVolume === 'function') {
        const v = player.getVolume();
        if (typeof v === 'number' && !isNaN(v)) {
          currentVol = v;
        }
      }
      if (typeof player.isMuted === 'function') {
        isMuted = player.isMuted();
      }
    } else if (queuedVolume !== null) {
      currentVol = queuedVolume;
    }

    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_VOLUME_STATUS, {
          detail: JSON.stringify({
            volume: currentVol,
            muted: isMuted,
            hasPlayer: !!player
          })
        })
      );
    } catch (e) {
      reportError(e, 'broadcastStatus');
    }
  }

  // Listen for volume change requests from isolated content script
  window.addEventListener(EVENT_SET_VOLUME, (event) => {
    try {
      let data = event.detail;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          data = Number(data);
        }
      }

      const vol = typeof data === 'object' && data !== null && typeof data.volume === 'number'
        ? data.volume
        : (typeof data === 'number' ? data : null);

      if (vol !== null) {
        applyVolume(vol, data?.reason || 'CustomEvent');
      }
    } catch (err) {
      reportError(err, 'addEventListener:EVENT_SET_VOLUME');
      console.warn('[RetroFM MainWorld] Error processing volume event:', err);
    }
  });

  let pendingPlayerCommand = null;
  let playerCommandSeq = 0;
  let playerReadyWaitTimer = null;

  function isPlayerReady(player) {
    if (!player) player = getPlayer();
    return !!(player && typeof player.playVideo === 'function' && typeof player.pauseVideo === 'function');
  }

  function flushPendingPlayerCommand(reason = 'playerReady') {
    if (!pendingPlayerCommand) return;
    if (isPlayerReady()) {
      const { command, payload, seq } = pendingPlayerCommand;
      pendingPlayerCommand = null;
      if (playerReadyWaitTimer) {
        clearTimeout(playerReadyWaitTimer);
        playerReadyWaitTimer = null;
      }
      console.log(`[RetroFM MainWorld] [${new Date().toISOString()}] Flushing pending player command #${seq}: ${command} (reason=${reason})`);
      executePlayerCommandDirect(command, payload);
    }
  }

  function executePlayerCommandDirect(cmd, payload) {
    const player = getPlayer();
    if (!player) return false;

    const stateBefore = typeof player.getPlayerState === 'function' ? player.getPlayerState() : null;

    if (cmd === 'PLAY') {
      try {
        if (typeof player.playVideo === 'function') {
          player.playVideo();
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.playVideo threw:', e);
      }
    } else if (cmd === 'PAUSE') {
      try {
        if (typeof player.pauseVideo === 'function') {
          player.pauseVideo();
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.pauseVideo threw:', e);
      }
    } else if (cmd === 'STOP') {
      try {
        if (typeof player.pauseVideo === 'function') {
          player.pauseVideo();
        }
        if (typeof player.seekTo === 'function') {
          player.seekTo(0, true);
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player STOP threw:', e);
      }
    } else if (cmd === 'SEEK') {
      const time = typeof payload?.time === 'number' ? payload.time : (typeof payload === 'number' ? payload : 0);
      try {
        if (typeof player.seekTo === 'function') {
          player.seekTo(time, true);
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.seekTo threw:', e);
      }
    }

    const stateAfter = typeof player.getPlayerState === 'function' ? player.getPlayerState() : null;
    trace('EXECUTE_PLAYER_COMMAND', { cmd, stateBefore, stateAfter, payload });
    return true;
  }

  function executePlayerCommand(command, payload) {
    const cmd = (command || '').toUpperCase();
    const seq = ++playerCommandSeq;
    console.log(`[RetroFM MainWorld] [${new Date().toISOString()}] Received player command #${seq}: ${cmd}`, payload || '');

    if (isPlayerReady()) {
      pendingPlayerCommand = null;
      if (playerReadyWaitTimer) {
        clearTimeout(playerReadyWaitTimer);
        playerReadyWaitTimer = null;
      }
      executePlayerCommandDirect(cmd, payload);
      return;
    }

    // Player not ready yet - queue command so newer commands supersede older ones
    console.log(`[RetroFM MainWorld] [${new Date().toISOString()}] Player not ready for command #${seq} (${cmd}). Queueing pending command.`);
    pendingPlayerCommand = { command: cmd, payload, seq };

    if (!playerReadyWaitTimer) {
      playerReadyWaitTimer = setTimeout(() => {
        playerReadyWaitTimer = null;
        if (pendingPlayerCommand && pendingPlayerCommand.seq === seq) {
          console.warn(`[RetroFM MainWorld] Player readiness timed out for command #${seq} (${pendingPlayerCommand.command}). Dropping command.`);
          pendingPlayerCommand = null;
        }
      }, 5000);
    }
  }

  // Listen for playback commands via CustomEvent ONLY (single mechanism to avoid duplicate execution)
  window.addEventListener(EVENT_PLAYER_COMMAND, (event) => {
    try {
      let data = event.detail;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { data = { command: data }; }
      }
      if (data && data.command) {
        executePlayerCommand(data.command, data.payload);
      }
    } catch (err) {
      reportError(err, 'addEventListener:EVENT_PLAYER_COMMAND');
      console.warn('[RetroFM MainWorld] Error processing player command event:', err);
    }
  });

  // Support window.postMessage strictly for VOLUME commands and status queries
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window || !event.data) return;
      if (event.data.type === 'RETROFM_SET_VOLUME_MSG') {
        const vol = typeof event.data.volume === 'number' ? event.data.volume : null;
        if (vol !== null) {
          applyVolume(vol, event.data.reason || 'postMessage');
        }
      } else if (event.data.type === 'RETROFM_QUERY_VOLUME_MSG') {
        broadcastStatus();
      }
    } catch (err) {
      reportError(err, 'addEventListener:message');
    }
  });

  function recordDiagnosticEvent(event, data) {
    try {
      trace(event, data);
      recordError(event, data);
    } catch (e) {}
  }

  // Reapply queued volume on video lifecycle events (song start / loadedmetadata / playing)
  function attachMediaListeners(media) {
    if (!media || media.__retroFmListenersAttached) return;
    media.__retroFmListenersAttached = true;

    const onMediaLifecycle = (evtType) => {
      try {
        if (queuedVolume !== null) {
          applyVolume(queuedVolume, `event:${evtType}`);
        } else {
          broadcastStatus();
        }
      } catch (err) {
        reportError(err, `onMediaLifecycle:${evtType}`);
      }
    };

    // Earliest video hooks
    media.addEventListener('loadstart', () => onMediaLifecycle('loadstart'));
    media.addEventListener('loadedmetadata', () => onMediaLifecycle('loadedmetadata'));
    media.addEventListener('canplay', () => onMediaLifecycle('canplay'));
    media.addEventListener('playing', () => {
      try {
        const player = getPlayer();
        const currentVol = (player && typeof player.getVolume === 'function') ? player.getVolume() : 'unknown';
        console.log(
          `[RetroFM MainWorld] [${new Date().toISOString()}] Volume at moment playback started: player.getVolume()=${currentVol}, queuedVolume=${queuedVolume}`
        );
        onMediaLifecycle('playing');
      } catch (err) {
        reportError(err, 'media.addEventListener:playing');
      }
    });

    media.addEventListener('pause', () => {
      try {
        const now = Date.now();
        const unmutedRecently = (now - lastUnmuteTime) <= 3000;
        recordError('videoPause', {
          ts: now,
          pausedRightAfterUnmute: unmutedRecently,
          timeSinceLastUnmuteMs: lastUnmuteTime > 0 ? (now - lastUnmuteTime) : null
        });
        trace('VIDEO_PAUSE_EVENT', {
          pausedRightAfterUnmute: unmutedRecently,
          timeSinceLastUnmuteMs: lastUnmuteTime > 0 ? (now - lastUnmuteTime) : null
        });
      } catch (err) {
        reportError(err, 'media.addEventListener:pause');
      }
    });
  }

  function handleNavigationStart() {
    try {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'navigationStart');
      }
    } catch (err) {
      reportError(err, 'handleNavigationStart');
    }
  }

  // Earliest page / YouTube navigation hooks
  window.addEventListener('yt-navigate-start', () => {
    try { handleNavigationStart(); } catch (err) { reportError(err, 'yt-navigate-start'); }
  });
  window.addEventListener('yt-navigate-finish', () => {
    try {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'yt-navigate-finish');
      }
    } catch (err) { reportError(err, 'yt-navigate-finish'); }
  });
  window.addEventListener('yt-player-updated', () => {
    try {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'yt-player-updated');
      }
      flushPendingPlayerCommand('yt-player-updated');
    } catch (err) { reportError(err, 'yt-player-updated'); }
  });

  function attachPlayerStateListener(player) {
    if (!player || player.__retroFmStateListenerAttached) return;
    player.__retroFmStateListenerAttached = true;
    try {
      if (typeof player.addEventListener === 'function') {
        player.addEventListener('onStateChange', (state) => {
          trace('YT_PLAYER_ON_STATE_CHANGE', { state });
          let videoId = null;
          let title = '';
          let currentTime = 0;
          let duration = 0;
          try {
            if (typeof player.getVideoData === 'function') {
              const vd = player.getVideoData();
              videoId = vd?.video_id || null;
              title = vd?.title || '';
            }
          } catch (e) {}
          if (!videoId) {
            try {
              const url = window.location.href;
              const match = url.match(/[?&]v=([^&#]+)/);
              if (match) videoId = match[1];
            } catch (e) {}
          }
          if (!title) {
            try {
              const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                         document.querySelector('h1.title yt-formatted-string');
              title = h1?.textContent?.trim() || document.title.replace(' - YouTube', '').trim() || '';
            } catch (e) {}
          }
          try {
            if (typeof player.getCurrentTime === 'function') {
              currentTime = Math.floor(player.getCurrentTime() || 0);
            }
          } catch (e) {}
          try {
            if (typeof player.getDuration === 'function') {
              duration = Math.floor(player.getDuration() || 0);
            }
          } catch (e) {}

          const detail = { state, videoId, title, currentTime, duration };
          try {
            window.dispatchEvent(new CustomEvent(EVENT_STATE_CHANGE, { detail: JSON.stringify(detail) }));
          } catch (e) {
            reportError(e, 'dispatchEvent:EVENT_STATE_CHANGE');
          }
          try {
            window.postMessage({ type: 'RETROFM_YT_STATE_CHANGED_MSG', ...detail }, '*');
          } catch (e) {
            reportError(e, 'postMessage:RETROFM_YT_STATE_CHANGED_MSG');
          }
          sendDiagnosticsSnapshot('stateChange');
        });

        // Also catch and record any error YouTube reports
        if (typeof player.addEventListener === 'function') {
          player.addEventListener('onError', (errCode) => {
            recordError('ytPlayerError', { errorCode: errCode });
          });
        }
      }
    } catch (e) {}
  }

  // --- Audio Diagnostics Collection ---
  const EVENT_AUDIO_DIAGNOSTICS = 'RETROFM_AUDIO_DIAGNOSTICS';
  let recordedErrors = [];

  function recordError(type, details) {
    try {
      const errItem = {
        type,
        ts: Date.now(),
        timeIso: new Date().toISOString(),
        details: details || {}
      };
      recordedErrors.push(errItem);
      if (recordedErrors.length > 20) {
        recordedErrors.shift();
      }
      trace('AUDIO_DIAGNOSTIC_ERROR', errItem);
      sendDiagnosticsSnapshot('errorRecorded');
    } catch (e) {}
  }

  function getDiagnosticsSnapshot() {
    const player = getPlayer();
    const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');

    let playerState = null;
    let playerMuted = null;
    let playerVolume = null;
    let videoId = null;
    let title = '';

    if (player) {
      try {
        if (typeof player.getPlayerState === 'function') playerState = player.getPlayerState();
      } catch (e) {}
      try {
        if (typeof player.isMuted === 'function') playerMuted = player.isMuted();
      } catch (e) {}
      try {
        if (typeof player.getVolume === 'function') playerVolume = player.getVolume();
      } catch (e) {}
      try {
        if (typeof player.getVideoData === 'function') {
          const vd = player.getVideoData();
          videoId = vd?.video_id || null;
          title = vd?.title || '';
        }
      } catch (e) {}
    }

    if (!videoId) {
      try {
        const match = window.location.href.match(/[?&]v=([^&#]+)/);
        if (match) videoId = match[1];
      } catch (e) {}
    }

    if (!title) {
      try {
        const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                   document.querySelector('h1.title yt-formatted-string');
        title = h1?.textContent?.trim() || document.title.replace(' - YouTube', '').trim() || '';
      } catch (e) {}
    }

    const videoPaused = video ? video.paused : null;
    const videoMuted = video ? video.muted : null;
    const videoVolume = video ? Math.round(video.volume * 100) : null;
    const videoReadyState = video ? video.readyState : null;

    const visibilityState = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    const userActivation = typeof navigator !== 'undefined' && navigator.userActivation ? {
      hasBeenActive: !!navigator.userActivation.hasBeenActive,
      isActive: !!navigator.userActivation.isActive
    } : {
      hasBeenActive: false,
      isActive: false
    };

    const now = Date.now();
    const pausedRightAfterUnmute = (now - lastUnmuteTime) <= 3000;

    return {
      ts: now,
      playerState,
      playerMuted,
      playerVolume,
      videoPaused,
      videoMuted,
      videoVolume,
      videoReadyState,
      visibilityState,
      userActivation,
      pausedRightAfterUnmute,
      timeSinceLastUnmuteMs: lastUnmuteTime > 0 ? (now - lastUnmuteTime) : null,
      videoId,
      title,
      href: typeof window !== 'undefined' ? window.location.href : '',
      lastError: recordedErrors.length > 0 ? recordedErrors[recordedErrors.length - 1] : null,
      errors: [...recordedErrors]
    };
  }

  function sendDiagnosticsSnapshot(reason = 'onDemand') {
    try {
      const snapshot = getDiagnosticsSnapshot();
      window.dispatchEvent(new CustomEvent(EVENT_AUDIO_DIAGNOSTICS, {
        detail: JSON.stringify({ snapshot, reason })
      }));
    } catch (e) {
      reportError(e, 'sendDiagnosticsSnapshot');
    }
  }

  // Intercept HTMLMediaElement.prototype.play to catch rejected play() promises (e.g. NotAllowedError)
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const res = origPlay.apply(this, args);
      if (res && typeof res.catch === 'function') {
        res.catch((err) => {
          recordError('playPromiseRejected', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack
          });
        });
      }
      return res;
    };
  } catch (e) {}

  // Listen for demand request for diagnostics snapshot
  window.addEventListener('RETROFM_REQ_AUDIO_DIAGNOSTICS', () => {
    try {
      sendDiagnosticsSnapshot('requested');
    } catch (err) {
      reportError(err, 'addEventListener:RETROFM_REQ_AUDIO_DIAGNOSTICS');
    }
  });

  // Poll for player existence on initialization
  let checkPlayerInterval = setInterval(() => {
    const player = getPlayer();
    if (player) {
      if (!playerFound) {
        playerFound = true;
        console.log(`[RetroFM MainWorld] YouTube player element detected.`);
      }
      try {
        attachPlayerStateListener(player);
      } catch (e) {}
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'playerReady');
      }
      flushPendingPlayerCommand('checkPlayerInterval');
      broadcastStatus();

      const video = player.querySelector('video') || document.querySelector('video');
      if (video) {
        attachMediaListeners(video);
      }
    }
  }, 200);

  // Stop polling after 15 seconds, but observe DOM / handle future navigations
  setTimeout(() => {
    if (checkPlayerInterval) {
      clearInterval(checkPlayerInterval);
      checkPlayerInterval = setInterval(() => {
        const player = getPlayer();
        if (player) {
          flushPendingPlayerCommand('intervalHeartbeat');
          const video = player.querySelector('video') || document.querySelector('video');
          if (video && !video.__retroFmListenersAttached) {
            attachMediaListeners(video);
          }
        }
      }, 2000);
    }
  }, 15000);

  // Initial broadcast and video attach check
  const initialVideo = document.querySelector('video');
  if (initialVideo) {
    attachMediaListeners(initialVideo);
  }
  // Send initial diagnostics snapshot
  setTimeout(() => sendDiagnosticsSnapshot('initial'), 1000);
})();

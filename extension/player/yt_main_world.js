// RetroFM YouTube Main-World Player Bridge
// Runs in world: "MAIN" with direct access to YouTube's player API (.html5-video-player / #movie_player)

(function () {
  if (window.__retroFmMainWorldLoaded) return;
  window.__retroFmMainWorldLoaded = true;

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_VOLUME_STATUS = 'RETROFM_YT_VOLUME_STATUS';
  const EVENT_SET_BALANCE = 'RETROFM_SET_YT_BALANCE';
  const EVENT_BALANCE_STATUS = 'RETROFM_YT_BALANCE_STATUS';
  const EVENT_PLAYER_COMMAND = 'RETROFM_PLAYER_COMMAND';
  const EVENT_STATE_CHANGE = 'RETROFM_YT_STATE_CHANGED';
  const EVENT_TRACE = 'RETROFM_TRACE';
  const EVENT_ERROR = 'RETROFM_MAIN_WORLD_ERROR';
  const STORAGE_KEY_SAVED_VOLUME = 'retrofm_saved_master_volume';
  const STORAGE_KEY_SAVED_BALANCE = 'retrofm_saved_stereo_balance';

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

  // Restore remembered stereo balance (-1 to +1, default 0 = center) from sessionStorage if available
  let queuedBalance = 0;
  try {
    const savedBal = sessionStorage.getItem(STORAGE_KEY_SAVED_BALANCE);
    if (savedBal !== null) {
      const parsedBal = parseFloat(savedBal);
      if (!isNaN(parsedBal) && parsedBal >= -1 && parsedBal <= 1) {
        queuedBalance = Number(parsedBal.toFixed(4));
      }
    }
  } catch (e) {}

  function clampBalance(val) {
    if (typeof val !== 'number' || isNaN(val)) return 0;
    return Number(Math.max(-1, Math.min(1, val)).toFixed(4));
  }

  function computeStereoBalanceGains(balance) {
    const b = clampBalance(balance);
    // Conventional stereo balance: attenuate opposite channel, never boost favored channel above 1.0
    // -1 -> L=1.0, R=0.0 | -0.5 -> L=1.0, R=0.5 | 0 -> L=1.0, R=1.0 | +0.5 -> L=0.5, R=1.0 | +1 -> L=0.0, R=1.0
    const leftGain = b <= 0 ? 1 : Number(Math.max(0, 1 - b).toFixed(4));
    const rightGain = b >= 0 ? 1 : Number(Math.max(0, 1 + b).toFixed(4));
    return { balance: b, leftGain, rightGain };
  }

  // Web Audio API true stereo channel balance routing graph
  let stereoAudioCtx = null;
  let stereoInputNode = null;
  let stereoSplitterNode = null;
  let leftGainNode = null;
  let rightGainNode = null;
  let stereoMergerNode = null;
  const attachedMediaElements = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  const initialBalanceGains = computeStereoBalanceGains(queuedBalance);
  let appliedLeftGain = initialBalanceGains.leftGain;
  let appliedRightGain = initialBalanceGains.rightGain;

  function isVideoAttachedToStereoGraph(video) {
    if (!video) return false;
    return !!(attachedMediaElements ? attachedMediaElements.has(video) : video.__retroFmMediaSourceNode);
  }

  function ensureStereoBalanceNodes() {
    if (stereoAudioCtx && leftGainNode && rightGainNode && stereoInputNode) {
      return true;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    try {
      stereoAudioCtx = new AudioCtx();

      // Input node preserves 2-channel discrete stereo (L->0, R->1) while upmixing 1-channel mono to L+R
      stereoInputNode = stereoAudioCtx.createGain();
      stereoInputNode.gain.value = 1;
      try {
        stereoInputNode.channelCount = 2;
        stereoInputNode.channelCountMode = 'explicit';
        stereoInputNode.channelInterpretation = 'speakers';
      } catch (e) {}

      stereoSplitterNode = stereoAudioCtx.createChannelSplitter(2);
      leftGainNode = stereoAudioCtx.createGain();
      rightGainNode = stereoAudioCtx.createGain();
      stereoMergerNode = stereoAudioCtx.createChannelMerger(2);

      const gains = computeStereoBalanceGains(queuedBalance);
      appliedLeftGain = gains.leftGain;
      appliedRightGain = gains.rightGain;
      leftGainNode.gain.value = gains.leftGain;
      rightGainNode.gain.value = gains.rightGain;

      stereoInputNode.connect(stereoSplitterNode);
      stereoSplitterNode.connect(leftGainNode, 0, 0);
      stereoSplitterNode.connect(rightGainNode, 1, 0);
      leftGainNode.connect(stereoMergerNode, 0, 0);
      rightGainNode.connect(stereoMergerNode, 0, 1);
      stereoMergerNode.connect(stereoAudioCtx.destination);

      stereoAudioCtx.onstatechange = () => {
        try {
          if (stereoAudioCtx && stereoAudioCtx.state === 'running') {
            const player = getPlayer();
            const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
            if (video) {
              attachVideoToStereoGraph(video, true);
            }
          }
          broadcastBalanceStatus();
        } catch (e) {}
      };

      return true;
    } catch (err) {
      reportError(err, 'ensureStereoBalanceNodes');
      return false;
    }
  }

  function attachVideoToStereoGraph(video, forceAttach = false) {
    if (!video) return false;
    if (!ensureStereoBalanceNodes()) return false;

    if (stereoAudioCtx.state === 'suspended') {
      stereoAudioCtx.resume().catch(() => {});
    }

    if (isVideoAttachedToStereoGraph(video)) {
      return true;
    }

    // If video is paused, AudioContext is still suspended, and balance is at center (0),
    // wait until AudioContext is running, playback starts, or balance is adjusted
    if (!forceAttach && video.paused && stereoAudioCtx.state === 'suspended' && queuedBalance === 0) {
      return false;
    }

    try {
      const sourceNode = stereoAudioCtx.createMediaElementSource(video);
      sourceNode.connect(stereoInputNode);
      if (attachedMediaElements) {
        attachedMediaElements.set(video, sourceNode);
      }
      video.__retroFmMediaSourceNode = sourceNode;
      trace('STEREO_BALANCE_GRAPH_ATTACHED', {
        balance: queuedBalance,
        leftGain: appliedLeftGain,
        rightGain: appliedRightGain,
        audioContextState: stereoAudioCtx.state
      });
      return true;
    } catch (err) {
      reportError(err, 'attachVideoToStereoGraph');
      return false;
    }
  }

  function broadcastBalanceStatus() {
    const player = getPlayer();
    const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
    try {
      window.dispatchEvent(
        new CustomEvent(EVENT_BALANCE_STATUS, {
          detail: JSON.stringify({
            balance: queuedBalance,
            leftGain: appliedLeftGain,
            rightGain: appliedRightGain,
            stereoGraphAttached: isVideoAttachedToStereoGraph(video),
            audioContextState: stereoAudioCtx ? stereoAudioCtx.state : 'uninitialized'
          })
        })
      );
    } catch (e) {
      reportError(e, 'broadcastBalanceStatus');
    }
  }

  function applyBalance(balance, reason = 'direct') {
    if (typeof balance !== 'number' || isNaN(balance)) return;
    const { balance: clampedBal, leftGain, rightGain } = computeStereoBalanceGains(balance);
    queuedBalance = clampedBal;
    appliedLeftGain = leftGain;
    appliedRightGain = rightGain;

    try {
      sessionStorage.setItem(STORAGE_KEY_SAVED_BALANCE, String(clampedBal));
    } catch (e) {}

    const hasGraph = ensureStereoBalanceNodes();
    const player = getPlayer();
    const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
    if (video) {
      attachVideoToStereoGraph(video, true);
    }

    if (hasGraph && stereoAudioCtx && leftGainNode && rightGainNode) {
      try {
        if (stereoAudioCtx.state === 'suspended') {
          stereoAudioCtx.resume().catch(() => {});
        }
        const now = stereoAudioCtx.currentTime;
        if (stereoAudioCtx.state === 'running' && !reason.startsWith('init') && !reason.startsWith('event:')) {
          leftGainNode.gain.cancelScheduledValues(now);
          leftGainNode.gain.setValueAtTime(leftGainNode.gain.value, now);
          leftGainNode.gain.linearRampToValueAtTime(leftGain, now + 0.015);

          rightGainNode.gain.cancelScheduledValues(now);
          rightGainNode.gain.setValueAtTime(rightGainNode.gain.value, now);
          rightGainNode.gain.linearRampToValueAtTime(rightGain, now + 0.015);
        } else {
          leftGainNode.gain.cancelScheduledValues(now);
          leftGainNode.gain.setValueAtTime(leftGain, now);
          leftGainNode.gain.value = leftGain;

          rightGainNode.gain.cancelScheduledValues(now);
          rightGainNode.gain.setValueAtTime(rightGain, now);
          rightGainNode.gain.value = rightGain;
        }
      } catch (err) {
        reportError(err, 'applyBalance:gainRamp');
      }
    }

    console.log(
      `[RetroFM MainWorld] [${new Date().toISOString()}] setBalance called: balance=${clampedBal} (reason=${reason}) -> leftGain=${leftGain}, rightGain=${rightGain}`
    );

    broadcastBalanceStatus();
    broadcastStatus();
  }

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
          if (typeof player.unMute === 'function') {
            lastUnmuteTime = Date.now();
            player.unMute();
          }
        } else if (clampedVol === 0 && !isPlayerMuted) {
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
            balance: queuedBalance,
            leftGain: appliedLeftGain,
            rightGain: appliedRightGain,
            hasPlayer: !!player
          })
        })
      );
    } catch (e) {
      reportError(e, 'broadcastStatus');
    }
  }

  // Listen for stereo balance change requests from isolated content script
  window.addEventListener(EVENT_SET_BALANCE, (event) => {
    try {
      let data = event.detail;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          data = Number(data);
        }
      }

      const bal = typeof data === 'object' && data !== null && typeof data.balance === 'number'
        ? data.balance
        : (typeof data === 'number' ? data : null);

      if (bal !== null && !isNaN(bal)) {
        applyBalance(bal, data?.reason || 'CustomEvent');
      }
    } catch (err) {
      reportError(err, 'addEventListener:EVENT_SET_BALANCE');
      console.warn('[RetroFM MainWorld] Error processing balance event:', err);
    }
  });

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
  let lastPlayCommandTimestamps = null;

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

    if (cmd === 'PLAY' || cmd === 'STOP' || cmd === 'SEEK') {
      lastReportedTime = -1;
    }

    const stateBefore = typeof player.getPlayerState === 'function' ? player.getPlayerState() : null;

    if (cmd === 'PLAY') {
      const t_mw_play_call = Date.now();
      const t_boombox_play_click = payload?.t_boombox_play_click || null;
      const t_cs_play_recv = payload?.t_cs_play_recv || null;
      lastPlayCommandTimestamps = { t_boombox_play_click, t_cs_play_recv, t_mw_play_call };
      trace('MAIN_WORLD_PLAY_CALLED', {
        t_mw_play_call,
        t_boombox_play_click,
        t_cs_play_recv,
        dispatchDelayMs: t_boombox_play_click ? (t_mw_play_call - t_boombox_play_click) : null
      });
      try {
        const video = player.querySelector('video') || document.querySelector('video');
        if (video) {
          attachVideoToStereoGraph(video, true);
        }
        if (stereoAudioCtx && stereoAudioCtx.state === 'suspended') {
          stereoAudioCtx.resume().catch(() => {});
        }
        if (typeof player.playVideo === 'function') {
          player.playVideo();
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.playVideo threw:', e);
      }
      syncPlaybackProgress(true);
    } else if (cmd === 'PAUSE') {
      try {
        if (typeof player.pauseVideo === 'function') {
          player.pauseVideo();
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.pauseVideo threw:', e);
      }
      syncPlaybackProgress(false);
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
      syncPlaybackProgress(false);
    } else if (cmd === 'SEEK') {
      const time = typeof payload?.time === 'number' ? payload.time : (typeof payload === 'number' ? payload : 0);
      try {
        if (typeof player.seekTo === 'function') {
          player.seekTo(time, true);
        }
      } catch (e) {
        console.warn('[RetroFM MainWorld] player.seekTo threw:', e);
      }
      lastReportedTime = -1;
      emitCurrentProgress();
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

  // Support window.postMessage strictly for VOLUME/BALANCE commands and status queries
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window || !event.data) return;
      if (event.data.type === 'RETROFM_SET_VOLUME_MSG') {
        const vol = typeof event.data.volume === 'number' ? event.data.volume : null;
        if (vol !== null) {
          applyVolume(vol, event.data.reason || 'postMessage');
        }
      } else if (event.data.type === 'RETROFM_SET_BALANCE_MSG') {
        const bal = typeof event.data.balance === 'number' ? event.data.balance : null;
        if (bal !== null && !isNaN(bal)) {
          applyBalance(bal, event.data.reason || 'postMessage');
        }
      } else if (event.data.type === 'RETROFM_QUERY_VOLUME_MSG') {
        broadcastStatus();
        broadcastBalanceStatus();
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

  // Reapply queued volume and stereo balance on video lifecycle events (song start / loadedmetadata / playing)
  function attachMediaListeners(media) {
    if (!media) return;
    attachVideoToStereoGraph(media, !media.paused);
    if (media.__retroFmListenersAttached) return;
    media.__retroFmListenersAttached = true;

    const onMediaLifecycle = (evtType) => {
      try {
        attachVideoToStereoGraph(media, evtType === 'play' || evtType === 'playing' || !media.paused);
        applyBalance(queuedBalance, `event:${evtType}`);
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
    media.addEventListener('play', () => onMediaLifecycle('play'));
    media.addEventListener('playing', () => {
      try {
        const player = getPlayer();
        const currentVol = (player && typeof player.getVolume === 'function') ? player.getVolume() : 'unknown';
        console.log(
          `[RetroFM MainWorld] [${new Date().toISOString()}] Volume at moment playback started: player.getVolume()=${currentVol}, queuedVolume=${queuedVolume}, queuedBalance=${queuedBalance}`
        );
        onMediaLifecycle('playing');
        syncPlaybackProgress(true);
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
        syncPlaybackProgress(false);
      } catch (err) {
        reportError(err, 'media.addEventListener:pause');
      }
    });

    media.addEventListener('ended', () => {
      try {
        syncPlaybackProgress(false);
      } catch (err) {}
    });
  }

  function handleNavigationStart() {
    try {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'navigationStart');
      }
      applyBalance(queuedBalance, 'navigationStart');
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
      applyBalance(queuedBalance, 'yt-navigate-finish');
    } catch (err) { reportError(err, 'yt-navigate-finish'); }
  });
  window.addEventListener('yt-player-updated', () => {
    try {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'yt-player-updated');
      }
      applyBalance(queuedBalance, 'yt-player-updated');
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
          if (state === 1) {
            const t_mw_playing = Date.now();
            const latencyMetrics = {
              t_mw_playing,
              t_boombox_play_click: lastPlayCommandTimestamps?.t_boombox_play_click || null,
              t_cs_play_recv: lastPlayCommandTimestamps?.t_cs_play_recv || null,
              t_mw_play_call: lastPlayCommandTimestamps?.t_mw_play_call || null,
              e2eLatencyMs: lastPlayCommandTimestamps?.t_boombox_play_click ? (t_mw_playing - lastPlayCommandTimestamps.t_boombox_play_click) : null,
              playCallToPlaybackMs: lastPlayCommandTimestamps?.t_mw_play_call ? (t_mw_playing - lastPlayCommandTimestamps.t_mw_play_call) : null
            };
            trace('YT_PLAYBACK_STARTED_CONFIRMED', latencyMetrics);
            console.log(`[RetroFM MainWorld] [${new Date().toISOString()}] ▶ CONFIRMED PLAYING (State 1) | Latency: ${latencyMetrics.e2eLatencyMs !== null ? `${latencyMetrics.e2eLatencyMs}ms` : 'N/A'}`);
          }
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
          syncPlaybackProgress(state === 1);
        });

        // Also catch and record any error YouTube reports
        if (typeof player.addEventListener === 'function') {
          player.addEventListener('onError', (errCode) => {
            recordError('ytPlayerError', { errorCode: errCode });
          });
        }

        // Immediately emit current player state upon attachment so listeners learn current video/readiness
        try {
          let curState = -1;
          if (typeof player.getPlayerState === 'function') {
            curState = player.getPlayerState();
          }
          let curVid = null;
          let curTitle = '';
          if (typeof player.getVideoData === 'function') {
            const vd = player.getVideoData();
            curVid = vd?.video_id || null;
            curTitle = vd?.title || '';
          }
          if (!curVid) {
            const match = window.location.href.match(/[?&]v=([^&#]+)/);
            if (match) curVid = match[1];
          }
          if (curVid) {
            const initialDetail = {
              state: curState,
              videoId: curVid,
              title: curTitle,
              currentTime: typeof player.getCurrentTime === 'function' ? Math.floor(player.getCurrentTime() || 0) : 0,
              duration: typeof player.getDuration === 'function' ? Math.floor(player.getDuration() || 0) : 0
            };
            window.dispatchEvent(new CustomEvent(EVENT_STATE_CHANGE, { detail: JSON.stringify(initialDetail) }));
            window.postMessage({ type: 'RETROFM_YT_STATE_CHANGED_MSG', ...initialDetail }, '*');
          }
          if (curState === 1) {
            syncPlaybackProgress(true);
          }
        } catch (initErr) {}
      }
    } catch (e) {}
  }

  // --- Active Playback Position Synchronization (~1s periodic tick) ---
  let progressTrackingTimer = null;
  let lastReportedTime = -1;

  function emitCurrentProgress() {
    try {
      const player = getPlayer();
      const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
      if (!player && !video) return;
      let currentTime = 0;
      let duration = 0;
      try {
        if (player && typeof player.getCurrentTime === 'function') {
          currentTime = Math.floor(player.getCurrentTime() || 0);
        } else if (video && typeof video.currentTime === 'number') {
          currentTime = Math.floor(video.currentTime || 0);
        }
      } catch (e) {}
      try {
        if (player && typeof player.getDuration === 'function') {
          duration = Math.floor(player.getDuration() || 0);
        } else if (video && typeof video.duration === 'number') {
          duration = Math.floor(video.duration || 0);
        }
      } catch (e) {}

      if (currentTime === lastReportedTime) return;
      lastReportedTime = currentTime;

      let videoId = null;
      let title = '';
      try {
        if (player && typeof player.getVideoData === 'function') {
          const vd = player.getVideoData();
          videoId = vd?.video_id || null;
          title = vd?.title || '';
        }
      } catch (e) {}
      if (!videoId) {
        const match = window.location.href.match(/[?&]v=([^&#]+)/);
        if (match) videoId = match[1];
      }

      let state = 1;
      try {
        if (player && typeof player.getPlayerState === 'function') {
          state = player.getPlayerState();
        } else if (video) {
          state = video.paused ? 2 : 1;
        }
      } catch (e) {}

      const detail = { state, videoId, title, currentTime, duration };
      try {
        window.dispatchEvent(new CustomEvent(EVENT_STATE_CHANGE, { detail: JSON.stringify(detail) }));
      } catch (e) {}
      try {
        window.postMessage({ type: 'RETROFM_YT_STATE_CHANGED_MSG', ...detail }, '*');
      } catch (e) {}
    } catch (e) {}
  }

  function syncPlaybackProgress(isPlaying) {
    if (isPlaying) {
      if (!progressTrackingTimer) {
        lastReportedTime = -1;
        emitCurrentProgress();
        progressTrackingTimer = setInterval(emitCurrentProgress, 1000);
      }
    } else {
      if (progressTrackingTimer) {
        clearInterval(progressTrackingTimer);
        progressTrackingTimer = null;
      }
      lastReportedTime = -1;
      emitCurrentProgress();
    }
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
      stereoBalance: queuedBalance,
      leftChannelGain: appliedLeftGain,
      rightChannelGain: appliedRightGain,
      stereoGraphAttached: isVideoAttachedToStereoGraph(video),
      audioContextState: stereoAudioCtx ? stereoAudioCtx.state : 'uninitialized',
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
        if (!video.paused && !video.ended && video.readyState >= 3 && !progressTrackingTimer) {
          syncPlaybackProgress(true);
        }
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
          if (video) {
            if (!video.__retroFmListenersAttached) {
              attachMediaListeners(video);
            }
            if (!video.paused && !video.ended && video.readyState >= 3 && !progressTrackingTimer) {
              syncPlaybackProgress(true);
            }
          }
        }
      }, 2000);
    }
  }, 15000);

  // Initial broadcast and video attach check
  ensureStereoBalanceNodes();
  const initialVideo = document.querySelector('video');
  if (initialVideo) {
    attachMediaListeners(initialVideo);
  }
  applyBalance(queuedBalance, 'init');
  // Send initial diagnostics snapshot
  setTimeout(() => sendDiagnosticsSnapshot('initial'), 1000);
})();

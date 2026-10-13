// RetroFM YouTube Main-World Player Bridge
// Runs in world: "MAIN" with direct access to YouTube's player API (.html5-video-player / #movie_player)

(function () {
  if (window.__retroFmMainWorldLoaded) return;
  window.__retroFmMainWorldLoaded = true;

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_VOLUME_STATUS = 'RETROFM_YT_VOLUME_STATUS';
  const STORAGE_KEY_SAVED_VOLUME = 'retrofm_saved_master_volume';

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
  let navigationMuted = false;
  let muteSafetyTimer = null;

  function getPlayer() {
    return document.querySelector('.html5-video-player') ||
           document.getElementById('movie_player') ||
           null;
  }

  function clearMuteSafety() {
    if (muteSafetyTimer) {
      clearTimeout(muteSafetyTimer);
      muteSafetyTimer = null;
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

        // If temporarily muted during navigation, or player is muted while target > 0, unMute now
        if (clampedVol > 0 && typeof player.isMuted === 'function' && player.isMuted()) {
          if (typeof player.unMute === 'function') {
            player.unMute();
          }
        }
        navigationMuted = false;
        clearMuteSafety();

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
          detail: {
            volume: currentVol,
            muted: isMuted,
            hasPlayer: !!player
          }
        })
      );
    } catch (e) {}
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
      console.warn('[RetroFM MainWorld] Error processing volume event:', err);
    }
  });

  // Also support window.postMessage for redundancy
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'RETROFM_SET_VOLUME_MSG') {
      const vol = typeof event.data.volume === 'number' ? event.data.volume : null;
      if (vol !== null) {
        applyVolume(vol, event.data.reason || 'postMessage');
      }
    } else if (event.data.type === 'RETROFM_QUERY_VOLUME_MSG') {
      broadcastStatus();
    }
  });

  // Reapply queued volume on video lifecycle events (song start / loadedmetadata / playing)
  function attachMediaListeners(media) {
    if (!media || media.__retroFmListenersAttached) return;
    media.__retroFmListenersAttached = true;

    const onMediaLifecycle = (evtType) => {
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, `event:${evtType}`);
      } else {
        broadcastStatus();
      }
    };

    // Earliest video hooks
    media.addEventListener('loadstart', () => onMediaLifecycle('loadstart'));
    media.addEventListener('loadedmetadata', () => onMediaLifecycle('loadedmetadata'));
    media.addEventListener('canplay', () => onMediaLifecycle('canplay'));
    media.addEventListener('playing', () => {
      const player = getPlayer();
      const currentVol = (player && typeof player.getVolume === 'function') ? player.getVolume() : 'unknown';
      console.log(
        `[RetroFM MainWorld] [${new Date().toISOString()}] Volume at moment playback started: player.getVolume()=${currentVol}, queuedVolume=${queuedVolume}`
      );
      onMediaLifecycle('playing');
    });
  }

  function handleNavigationStart() {
    const player = getPlayer();
    if (player && typeof player.mute === 'function') {
      try {
        navigationMuted = true;
        player.mute();
        clearMuteSafety();
        // Failsafe: unMute after 1.5s regardless so audio can never stay stuck muted
        muteSafetyTimer = setTimeout(() => {
          navigationMuted = false;
          if (player && typeof player.unMute === 'function') {
            player.unMute();
          }
          if (queuedVolume !== null) {
            applyVolume(queuedVolume, 'navigationMuteFailsafe');
          }
        }, 1500);
      } catch (e) {}
    }
    if (queuedVolume !== null) {
      applyVolume(queuedVolume, 'navigationStart');
    }
  }

  // Earliest page / YouTube navigation hooks
  window.addEventListener('yt-navigate-start', () => handleNavigationStart());
  window.addEventListener('yt-navigate-finish', () => {
    if (queuedVolume !== null) {
      applyVolume(queuedVolume, 'yt-navigate-finish');
    }
  });
  window.addEventListener('yt-player-updated', () => {
    if (queuedVolume !== null) {
      applyVolume(queuedVolume, 'yt-player-updated');
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
      if (queuedVolume !== null) {
        applyVolume(queuedVolume, 'playerReady');
      }
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
})();

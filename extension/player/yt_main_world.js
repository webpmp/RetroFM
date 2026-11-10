// RetroFM YouTube Main-World Player Bridge
// Runs in world: "MAIN" with direct access to YouTube's player API (.html5-video-player / #movie_player)

(function () {
  if (window.__retroFmMainWorldLoaded) return;
  window.__retroFmMainWorldLoaded = true;
  window.__retroFmMainWorldVersion = '1.0.16';
  console.log('[RetroFM] yt_main_world.js loaded v1.0.16');

  const EVENT_SET_VOLUME = 'RETROFM_SET_YT_VOLUME';
  const EVENT_RAMP_VOLUME = 'RETROFM_RAMP_YT_VOLUME';
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
  let userMasterVolume = 100;
  let activeMainWorldRamp = null; // { rampId, startPercent, targetPercent, durationMs, startTime }
  let lastAppliedRampId = null;
  let rampPostVerifyTimer = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY_SAVED_VOLUME);
    if (saved !== null) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        queuedVolume = parsed;
        userMasterVolume = parsed;
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
  let leftAnalyserNode = null;
  let rightAnalyserNode = null;
  let leftTimeData = null;
  let rightTimeData = null;
  let leftFreqData = null;
  let rightFreqData = null;
  let vuSamplingInterval = null;
  let lastNonZeroSentTime = 0;
  let consecutiveSilenceCount = 0;
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

      // Real-time Audio Analysers for VU metering and Spectrum Analyzer (post-balance gain)
      try {
        leftAnalyserNode = stereoAudioCtx.createAnalyser();
        leftAnalyserNode.fftSize = 1024;
        leftAnalyserNode.smoothingTimeConstant = 0.55;
        leftTimeData = new Float32Array(leftAnalyserNode.fftSize);
        leftFreqData = new Uint8Array(leftAnalyserNode.frequencyBinCount);

        rightAnalyserNode = stereoAudioCtx.createAnalyser();
        rightAnalyserNode.fftSize = 1024;
        rightAnalyserNode.smoothingTimeConstant = 0.55;
        rightTimeData = new Float32Array(rightAnalyserNode.fftSize);
        rightFreqData = new Uint8Array(rightAnalyserNode.frequencyBinCount);
      } catch (e) {
        reportError(e, 'createAnalyser');
      }

      stereoInputNode.connect(stereoSplitterNode);
      stereoSplitterNode.connect(leftGainNode, 0, 0);
      stereoSplitterNode.connect(rightGainNode, 1, 0);

      // Tap balance-gain outputs into analysers (parallel branch, does not alter destination path)
      if (leftAnalyserNode) {
        try { leftGainNode.connect(leftAnalyserNode); } catch (e) {}
      }
      if (rightAnalyserNode) {
        try { rightGainNode.connect(rightAnalyserNode); } catch (e) {}
      }

      leftGainNode.connect(stereoMergerNode, 0, 0);
      rightGainNode.connect(stereoMergerNode, 0, 1);
      stereoMergerNode.connect(stereoAudioCtx.destination);

      startVuSamplingLoop();

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

  function calculateRms(analyser, dataBuffer) {
    if (!analyser || !dataBuffer) return 0;
    try {
      analyser.getFloatTimeDomainData(dataBuffer);
      let sumSquares = 0;
      const len = dataBuffer.length;
      for (let i = 0; i < len; i++) {
        const val = dataBuffer[i];
        sumSquares += val * val;
      }
      return Math.sqrt(sumSquares / len);
    } catch (e) {
      return 0;
    }
  }

  // 12 log-spaced frequency bands across 512 FFT bins (at 44.1/48kHz, bin ~43-47Hz)
  // Covers ~30Hz to ~18kHz:
  // [0]  sub-bass (30-90Hz)
  // [1]  bass fundamental (90-180Hz)
  // [2]  upper bass (180-300Hz)
  // [3]  low-mid / warmth (300-500Hz)
  // [4]  midrange (500-850Hz)
  // [5]  upper-mid / body (850-1.4kHz)
  // [6]  presence body (1.4-2.2kHz)
  // [7]  presence attack (2.2-3.6kHz)
  // [8]  treble crispness (3.6-5.8kHz)
  // [9]  high treble (5.8-9.0kHz)
  // [10] brilliance / cymbals (9.0-13.5kHz)
  // [11] top shimmer / air (13.5-18kHz)
  const SPECTRUM_BAND_RANGES = [
    [1, 2],     // ~43 - 130 Hz
    [3, 4],     // ~130 - 215 Hz
    [5, 7],     // ~215 - 345 Hz
    [8, 12],    // ~345 - 560 Hz
    [13, 19],   // ~560 - 860 Hz
    [20, 32],   // ~860 - 1.4 kHz
    [33, 50],   // ~1.4 - 2.2 kHz
    [51, 80],   // ~2.2 - 3.6 kHz
    [81, 130],  // ~3.6 - 5.8 kHz
    [131, 200], // ~5.8 - 9.0 kHz
    [201, 305], // ~9.0 - 13.5 kHz
    [306, 420]  // ~13.5 - 18.5 kHz
  ];

  // High-frequency pre-emphasis boost per band: compensates for natural 1/f music roll-off
  const SPECTRUM_HF_BOOST = [1.0, 1.0, 1.05, 1.1, 1.15, 1.25, 1.35, 1.5, 1.7, 1.95, 2.25, 2.6];

  function calculateFrequencyBands(leftAnalyser, rightAnalyser) {
    if (!leftAnalyser || !rightAnalyser || !leftFreqData || !rightFreqData) {
      return null;
    }
    try {
      leftAnalyser.getByteFrequencyData(leftFreqData);
      rightAnalyser.getByteFrequencyData(rightFreqData);

      const bands = [];
      const numBands = SPECTRUM_BAND_RANGES.length;
      for (let b = 0; b < numBands; b++) {
        const [startBin, endBin] = SPECTRUM_BAND_RANGES[b];
        let maxVal = 0;
        let count = 0;
        let sum = 0;
        for (let i = startBin; i <= endBin && i < leftFreqData.length; i++) {
          const valL = leftFreqData[i];
          const valR = rightFreqData[i];
          const combined = (valL + valR) * 0.5;
          sum += combined;
          if (combined > maxVal) maxVal = combined;
          count++;
        }
        // Balanced weighting: combine average and peak in bin range, normalized to 0..1
        const avg = count > 0 ? (sum / count) : 0;
        const rawEnergy = (avg * 0.65 + maxVal * 0.35) / 255;
        // Mild noise gate per band (< 0.015 is noise floor)
        const gated = rawEnergy > 0.015 ? (rawEnergy - 0.015) / 0.985 : 0;
        // Apply gentle high-frequency boost curve
        const boosted = gated * (SPECTRUM_HF_BOOST[b] || 1.0);
        bands.push(Number(Math.min(1.5, Math.max(0, boosted)).toFixed(3)));
      }
      return bands;
    } catch (e) {
      return null;
    }
  }

  let lastVuSampleTickTs = 0;

  function runMainWorldTick() {
    const now = performance.now();
    if (now - lastVuSampleTickTs < 15) {
      try { tickMainWorldVolumeRamp(); } catch (e) {}
      return;
    }
    lastVuSampleTickTs = now;
    try { tickMainWorldVolumeRamp(); } catch (e) {}
    try { sampleAndBroadcastVuLevels(); } catch (e) {}
  }

  function startVuSamplingLoop() {
    if (vuSamplingInterval) return;
    // YouTube enforces Trusted Types, so inline Blob Worker creation fails with
    // "This document requires 'TrustedScriptURL' assignment".
    // We run a 33ms setInterval directly which safely handles VU sampling and volume ramps.
    const intervalTimer = setInterval(runMainWorldTick, 33);

    vuSamplingInterval = {
      stop: () => {
        clearInterval(intervalTimer);
      }
    };
  }

  function sampleAndBroadcastVuLevels() {
    const player = getPlayer();
    const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
    const isVideoPlaying = !!(video && !video.paused && !video.ended && video.readyState >= 2);
    const isContextRunning = !!(stereoAudioCtx && stereoAudioCtx.state === 'running');

    // If video is not actively playing, audio context is suspended/inactive, or elements unattached:
    if (!isVideoPlaying || !isContextRunning || !leftAnalyserNode || !rightAnalyserNode) {
      // Send zero levels to settle meters if we previously had non-zero values
      if (consecutiveSilenceCount < 5) {
        consecutiveSilenceCount++;
        postVuLevels(0, 0, false, null);
      }
      return;
    }

    const rawL = calculateRms(leftAnalyserNode, leftTimeData);
    const rawR = calculateRms(rightAnalyserNode, rightTimeData);
    const bands = calculateFrequencyBands(leftAnalyserNode, rightAnalyserNode);

    // Noise floor & silence threshold:
    // When music is paused, stopped, between tracks, or in silent passages, RMS drops to near zero (< 0.001)
    const SILENCE_THRESHOLD = 0.0015;
    const cleanL = rawL > SILENCE_THRESHOLD ? rawL : 0;
    const cleanR = rawR > SILENCE_THRESHOLD ? rawR : 0;

    if (cleanL === 0 && cleanR === 0) {
      consecutiveSilenceCount++;
      // Once silence has been confirmed for 3+ consecutive frames (~100ms),
      // keep sending zero for a few updates so the meters finish decaying to 0
      if (consecutiveSilenceCount <= 5) {
        postVuLevels(0, 0, true, bands);
      }
    } else {
      consecutiveSilenceCount = 0;
      lastNonZeroSentTime = Date.now();
      postVuLevels(cleanL, cleanR, true, bands);
    }
  }

  function postVuLevels(leftLevel, rightLevel, isActive, bands) {
    try {
      const player = getPlayer();
      const video = player ? (player.querySelector('video') || document.querySelector('video')) : document.querySelector('video');
      const msg = {
        type: 'RETROFM_VU_LEVELS_MSG',
        l: Number(leftLevel.toFixed(4)),
        r: Number(rightLevel.toFixed(4)),
        active: Boolean(isActive),
        ts: Date.now(),
        t_read: Math.round(performance.now()),
        visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
        ctxState: stereoAudioCtx ? stereoAudioCtx.state : 'uninitialized',
        videoAttached: isVideoAttachedToStereoGraph(video)
      };
      if (Array.isArray(bands) && bands.length > 0) {
        msg.bands = bands;
      }
      window.postMessage(msg, '*');
    } catch (e) {
      reportError(e, 'postVuLevels');
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
      // If element is already connected to another AudioNode or graph, mark it attached
      if (String(err?.message || '').includes('already been connected') || err?.name === 'InvalidStateError') {
        if (attachedMediaElements) {
          attachedMediaElements.set(video, true);
        }
        video.__retroFmMediaSourceNode = true;
        return true;
      }
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

  const INTERNAL_REASON = /^(ramp|RAMP_|duck|event:|navigationStart|yt-|playerReady)/;

  function applyVolume(vol, reason = 'direct') {
    if (typeof vol !== 'number' || isNaN(vol)) return;
    const clampedVol = Math.max(0, Math.min(100, Math.round(vol)));

    const isInternal = INTERNAL_REASON.test(String(reason));
    const isRampDriver = /^(ramp|duck)/.test(String(reason));
    if (isInternal && !isRampDriver && activeMainWorldRamp) {
      return;
    }

    queuedVolume = clampedVol;

    if (!isInternal) {
      activeMainWorldRamp = null;
      userMasterVolume = clampedVol;
      try {
        localStorage.setItem(STORAGE_KEY_SAVED_VOLUME, String(clampedVol));
      } catch (e) {}
    }

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
        if (!reason.startsWith('rampStep:')) {
          console.log(
            `[RetroFM MainWorld] [${new Date().toISOString()}] setVolume called: requested=${clampedVol} (reason=${reason}, prev=${prevVol}) -> player.getVolume()=${resultingVol}`
          );
        }

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

  function startMainWorldVolumeRamp(targetVol, durationMs, rampId) {
    if (typeof targetVol !== 'number' || isNaN(targetVol)) return;
    const rawTarget = targetVol <= 1.0 && targetVol >= 0.0 && !Number.isInteger(targetVol)
      ? Math.round(targetVol * 100)
      : Math.round(targetVol);
    const clampedTarget = Math.max(0, Math.min(100, rawTarget));
    const dur = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 400;

    // Ensure the 33ms sampling and ramp ticker is running
    startVuSamplingLoop();

    const player = getPlayer();
    let startPercent = queuedVolume !== null ? queuedVolume : userMasterVolume;
    if (player && typeof player.getVolume === 'function') {
      const pv = player.getVolume();
      if (typeof pv === 'number' && !isNaN(pv)) {
        startPercent = pv;
      }
    }

    const assignedId = rampId !== undefined && rampId !== null ? rampId : Date.now();
    // Deduplicate if this exact rampId is already active or just completed
    if (activeMainWorldRamp && activeMainWorldRamp.rampId === assignedId) {
      return;
    }
    if (lastAppliedRampId === assignedId && queuedVolume === clampedTarget) {
      broadcastStatus();
      return;
    }

    if (rampPostVerifyTimer) {
      clearTimeout(rampPostVerifyTimer);
      rampPostVerifyTimer = null;
    }

    const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    const isDuckRamp = clampedTarget < startPercent;

    console.log(
      `[DJ Ducking Timing] [YouTube MW] ${isDuckRamp ? 'DUCK_RAMP_START' : 'RELEASE_RAMP_START'}: ${startPercent}% -> ${clampedTarget}% | duration=${dur}ms | rampId=${assignedId} | ytVisibility=${vis} | ts=${Date.now()}`
    );

    if (dur <= 20 || startPercent === clampedTarget) {
      activeMainWorldRamp = null;
      lastAppliedRampId = assignedId;
      applyVolume(clampedTarget, `rampCompleted:${assignedId}`);
      schedulePostRampVerify(clampedTarget, assignedId);
      console.log(
        `[DJ Ducking Timing] [YouTube MW] ${isDuckRamp ? '2b. YT_VOLUME_REACHED_DUCK' : '4b. YT_VOLUME_REACHED_NORMAL'}: ${clampedTarget}% | elapsed=0ms | rampId=${assignedId} | ytVisibility=${vis} | ts=${Date.now()}`
      );
      trace(isDuckRamp ? 'YT_VOLUME_REACHED_DUCK' : 'YT_VOLUME_REACHED_NORMAL', {
        targetPercent: clampedTarget,
        actualPlayerVol: queuedVolume,
        rampElapsedMs: 0,
        targetDurationMs: dur,
        rampId: assignedId,
        ytVisibility: vis,
        ts: Date.now()
      });
      return;
    }

    activeMainWorldRamp = {
      rampId: assignedId,
      startPercent,
      targetPercent: clampedTarget,
      durationMs: dur,
      startTime: performance.now(),
      startWallTs: Date.now(),
      isDuckRamp
    };
  }

  function schedulePostRampVerify(targetPercent, rampId) {
    if (rampPostVerifyTimer) {
      clearTimeout(rampPostVerifyTimer);
      rampPostVerifyTimer = null;
    }
    rampPostVerifyTimer = setTimeout(() => {
      rampPostVerifyTimer = null;
      if (activeMainWorldRamp) return;
      if (lastAppliedRampId !== rampId && queuedVolume !== targetPercent) return;
      const player = getPlayer();
      if (player && typeof player.getVolume === 'function') {
        const actual = player.getVolume();
        if (typeof actual === 'number' && !isNaN(actual) && Math.abs(actual - targetPercent) >= 2) {
          console.warn(
            `[RetroFM MainWorld] Post-ramp verification mismatch: expected=${targetPercent}%, actual=${actual}% (rampId=${rampId}) — enforcing target immediately`
          );
          applyVolume(targetPercent, `rampVerifyEnforce:${rampId}`);
        } else {
          broadcastStatus();
        }
      }
    }, 150);
  }

  function tickMainWorldVolumeRamp() {
    if (!activeMainWorldRamp) return;
    const r = activeMainWorldRamp;
    const elapsed = performance.now() - r.startTime;
    const progress = Math.min(1, Math.max(0, elapsed / r.durationMs));
    const eased = 0.5 * (1 - Math.cos(Math.PI * progress));
    const currentPercent = Math.round(r.startPercent + (r.targetPercent - r.startPercent) * eased);
    const stepTarget = Math.max(0, Math.min(100, currentPercent));

    if (progress >= 1) {
      activeMainWorldRamp = null;
      lastAppliedRampId = r.rampId;
      applyVolume(r.targetPercent, `rampCompleted:${r.rampId}`);
      schedulePostRampVerify(r.targetPercent, r.rampId);
      const totalElapsedMs = Math.round(performance.now() - r.startTime);
      const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
      const tsNow = Date.now();
      const player = getPlayer();
      const actualVol = (player && typeof player.getVolume === 'function') ? player.getVolume() : queuedVolume;
      console.log(
        `[DJ Ducking Timing] [YouTube MW] ${r.isDuckRamp ? '2b. YT_VOLUME_REACHED_DUCK' : '4b. YT_VOLUME_REACHED_NORMAL'}: target=${r.targetPercent}% | actualPlayerVol=${actualVol}% | rampElapsed=${totalElapsedMs}ms (target=${r.durationMs}ms) | rampId=${r.rampId} | ytVisibility=${vis} | ts=${tsNow}`
      );
      trace(r.isDuckRamp ? 'YT_VOLUME_REACHED_DUCK' : 'YT_VOLUME_REACHED_NORMAL', {
        targetPercent: r.targetPercent,
        actualPlayerVol: actualVol,
        rampElapsedMs: totalElapsedMs,
        targetDurationMs: r.durationMs,
        rampId: r.rampId,
        ytVisibility: vis,
        ts: tsNow
      });
    } else {
      applyVolume(stepTarget, `rampStep:${r.rampId}`);
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
            hasPlayer: !!player,
            rampId: lastAppliedRampId,
            activeRampId: activeMainWorldRamp ? activeMainWorldRamp.rampId : null
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

  // Listen for unthrottled volume ramp requests from isolated content script
  window.addEventListener(EVENT_RAMP_VOLUME, (event) => {
    try {
      let data = event.detail;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          data = null;
        }
      }
      if (data && typeof data.targetVolume === 'number') {
        startMainWorldVolumeRamp(data.targetVolume, data.durationMs || 400, data.rampId);
      }
    } catch (err) {
      reportError(err, 'addEventListener:EVENT_RAMP_VOLUME');
      console.warn('[RetroFM MainWorld] Error processing ramp volume event:', err);
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
    const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    const source = payload?.source || 'unknown';
    console.log(`[Transport Timing] [YouTube MW] Executing direct player command: ${cmd} (source=${source}, visibility=${vis}, stateBefore=${stateBefore})`);

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
      } else if (event.data.type === 'RETROFM_RAMP_VOLUME_MSG') {
        if (typeof event.data.targetVolume === 'number') {
          startMainWorldVolumeRamp(event.data.targetVolume, event.data.durationMs || 400, event.data.rampId);
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
        if (activeMainWorldRamp) {
          // Let the active unthrottled volume ramp continue without resetting
          tickMainWorldVolumeRamp();
        } else if (queuedVolume !== null) {
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
    media.addEventListener('play', () => {
      const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
      console.log(`[Transport Timing] [YouTube MW] video 'play' event (visibility=${vis}, paused=${media.paused}, currentTime=${media.currentTime})`);
      onMediaLifecycle('play');
      emitCurrentProgress();
    });
    media.addEventListener('playing', () => {
      try {
        const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
        const player = getPlayer();
        const currentVol = (player && typeof player.getVolume === 'function') ? player.getVolume() : 'unknown';
        console.log(
          `[Transport Timing] [YouTube MW] video 'playing' event: player.getVolume()=${currentVol}, visibility=${vis}, currentTime=${media.currentTime}`
        );
        onMediaLifecycle('playing');
        syncPlaybackProgress(true);
      } catch (err) {
        reportError(err, 'media.addEventListener:playing');
      }
    });

    media.addEventListener('pause', () => {
      try {
        const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
        const isConfirmDialogVisible = Boolean(
          document.querySelector('yt-confirm-dialog-renderer, ytd-popup-container ytd-modal-with-dimmed-background-renderer') ||
          Array.from(document.querySelectorAll('tp-yt-paper-dialog, ytd-dialog, yt-confirm-dialog-renderer')).some(el => {
            const txt = el.textContent || '';
            return (txt.includes('Continue watching?') || txt.includes('Video paused.')) && (el.offsetWidth > 0 || el.offsetHeight > 0 || !el.hasAttribute('aria-hidden'));
          })
        );
        if (isConfirmDialogVisible) {
          console.warn(`[YouTube MW] DETECTED "Video paused. Continue watching?" confirmation dialog!`);
          recordError('continueWatchingDialog', { ts: now, currentTime: media.currentTime });
        }
        console.log(`[Transport Timing] [YouTube MW] video 'pause' event (visibility=${vis}, paused=${media.paused}, currentTime=${media.currentTime}, continueWatchingDialog=${isConfirmDialogVisible})`);
        const unmutedRecently = (now - lastUnmuteTime) <= 3000;
        recordError('videoPause', {
          ts: now,
          pausedRightAfterUnmute: unmutedRecently,
          continueWatchingDialog: isConfirmDialogVisible,
          timeSinceLastUnmuteMs: lastUnmuteTime > 0 ? (now - lastUnmuteTime) : null
        });
        trace('VIDEO_PAUSE_EVENT', {
          pausedRightAfterUnmute: unmutedRecently,
          continueWatchingDialog: isConfirmDialogVisible,
          timeSinceLastUnmuteMs: lastUnmuteTime > 0 ? (now - lastUnmuteTime) : null
        });
        syncPlaybackProgress(false);
      } catch (err) {
        reportError(err, 'media.addEventListener:pause');
      }
    });

    media.addEventListener('timeupdate', () => {
      // Event-driven progress update directly from video element
      try { tickMainWorldVolumeRamp(); } catch (e) {}
      emitCurrentProgress();
    });

    media.addEventListener('volumechange', () => {
      broadcastStatus();
    });

    media.addEventListener('ended', () => {
      try {
        const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
        console.log(`[Transport Timing] [YouTube MW] video 'ended' event (visibility=${vis})`);
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

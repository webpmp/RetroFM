const $=id=>document.getElementById(id);
if (document.title !== 'RetroFM') document.title = 'RetroFM';
const emit=(n,d)=>document.dispatchEvent(new CustomEvent('retrofm:'+n,{detail:d}));
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
// scale stage to window width
const wrap=$('wrap'),stage=$('stage');
const fit=()=>{const s=wrap.clientWidth/1408;stage.style.transform='translate(0,'+(-92*s)+'px) scale('+s+')'};
new ResizeObserver(fit).observe(wrap);fit();
// scale the whole player (boom box, display, footer) with the window width; designed at 450px wide
const app=$('app');
function scaleApp(){const w=document.documentElement.clientWidth,h=document.documentElement.clientHeight,ah=app.offsetHeight,s=Math.min(3,Math.max(.3,Math.min(w/450,(h-4)/ah)));
 app.style.transform='scale('+s+')';app.style.marginLeft=Math.max(0,(w-450*s)/2)+'px';app.style.marginBottom=(ah*s-ah)+'px'}
new ResizeObserver(scaleApp).observe(app);addEventListener('resize',scaleApp);scaleApp();

const S={state:'stopped',vol:.7,bal:.5,tun:(100.3-87.5)/20.5,dec:1990};
const ST={
1960:[['Pop',95.1],['Motown',101.5],['Soul',107.1],['R&B',93.5],['Rock',99.5],['Folk Rock',102.7],['Rock and Roll',104.1]],
1970:[['AOR',95.5],['Disco',98.7],['Progressive Rock',92.3],['Soft Rock',103.5],['Funk',107.5],['Punk Rock',91.1],['Outlaw Country',97.1]],
1980:[['New Wave',90.7],['Synth-Pop',93.1],['Hair Metal',105.5],['Hip-Hop',89.9],['CHR',101.9],['Urban Contemporary',97.9],['College Rock',88.9]],
1990:[['Grunge',99.9],['Alternative Rock',106.7],['Gangsta Rap',92.7],['Contemporary R&B',105.1],['Teen Pop',100.3],['Eurodance',96.3],['Country Pop',94.7]],
2000:[['Nu-Metal',93.7],['Post-Grunge',107.3],['Emo',91.3],['Crunk',106.1],['Electropop',102.3],['Indie Rock',90.3],['Reggaeton',96.7]],
2010:[['EDM',101.1],['Trap',104.5],['Indie Pop',91.9],['Mumble Rap',99.1],['Synthwave',89.3],['Afrobeats',105.9]],
2020:[['Bedroom Pop',88.1],['Hyperpop',90.9],['Amapiano',103.9],['Drift Phonk',95.9],['Regional Mexican',102.9],['Lofi Hip-Hop',88.5]]};
let hasFirstSongStartedPlaying = false;
let isStartupReady = false;
let isYtPlaybackActive = false;
let hasInitializedDial = false;
let transientStatus = null;
let transientTimer = null;
let playbackEnabled = false;
let isSeeking = false;
let seekSafetyTimer = null;

// Analog FM Stereo Indicator state machine ('off' | 'searching' | 'locked')
let stereoState = 'off';
let stereoSeq = 0;
let stereoDelayTimer = null;
let stereoFlickerTimer = null;
let stereoLockTimer = null;
let stereoTargetKey = null;
let stereoLockedKey = null;
let stereoAcquiring = false;
let hasActiveSignalPlayback = false;
const STEREO_FLICKER_LEVELS = [0.34, 0.08, 0.42, 0.05, 0.26, 0.38, 0.11, 0.46, 0.06, 0.30, 0.19, 0.44];
let stereoFlickerStepIdx = 0;

// Scale graduation mapping:
// #scale draws visible ticks for f = 88..108 MHz at step 1.0 MHz using fx(f) = 330 + (f - 87.5) * 27.3.
// One visible scale graduation = 1.0 MHz (27.3 SVG units on #scale).
const SCALE_GRADUATION_MHZ = 1.0;

function getTuningProximity(freq, stations) {
  const list = Array.isArray(stations) ? stations : (ST[S.dec] || []);
  const mapX = typeof fx === 'function' ? fx : (v => 330 + (v - 87.5) * 27.3);
  const gradPx = Math.abs(mapX(89) - mapX(88)); // 27.3 SVG units per 1.0 MHz tick graduation
  let best = null;
  let nearestStation = null;
  let minFreqDiff = Infinity;
  let minGraduations = Infinity;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const dFreq = Math.abs(s[1] - freq);
    const dPx = Math.abs(mapX(s[1]) - mapX(freq));
    const dGrad = gradPx > 0 ? (dPx / gradPx) : (dFreq / SCALE_GRADUATION_MHZ);
    if (dFreq < 0.05) {
      best = s;
    }
    if (dFreq < minFreqDiff) {
      minFreqDiff = dFreq;
      minGraduations = dGrad;
      nearestStation = s;
    }
  }
  const withinOneGraduation = !best && nearestStation !== null && minGraduations <= (1.0 + 1e-6);
  return {
    best,
    nearestStation,
    minFreqDiff: Number.isFinite(minFreqDiff) ? Number(minFreqDiff.toFixed(4)) : Infinity,
    minGraduations: Number.isFinite(minGraduations) ? Number(minGraduations.toFixed(4)) : Infinity,
    withinOneGraduation
  };
}

function clearStereoTimers() {
  if (stereoDelayTimer) { clearTimeout(stereoDelayTimer); stereoDelayTimer = null; }
  if (stereoFlickerTimer) { clearTimeout(stereoFlickerTimer); stereoFlickerTimer = null; }
  if (stereoLockTimer) { clearTimeout(stereoLockTimer); stereoLockTimer = null; }
}

function setStereoVisualState(nextState, flickerOpacity) {
  stereoState = nextState;
  const el = $('stereo');
  if (!el) return;
  el.classList.toggle('stereo-off', nextState === 'off');
  el.classList.toggle('stereo-searching', nextState === 'searching');
  el.classList.toggle('stereo-locked', nextState === 'locked');
  if (nextState === 'searching') {
    const op = typeof flickerOpacity === 'number' ? flickerOpacity : 0.28;
    el.style.setProperty('--stereo-flicker-op', String(op));
  } else {
    el.style.removeProperty('--stereo-flicker-op');
  }
}

function startStereoFlickerLoop(seq) {
  if (stereoFlickerTimer) { clearTimeout(stereoFlickerTimer); stereoFlickerTimer = null; }
  const step = () => {
    if (seq !== stereoSeq || stereoState !== 'searching') return;
    const baseOp = STEREO_FLICKER_LEVELS[stereoFlickerStepIdx % STEREO_FLICKER_LEVELS.length];
    stereoFlickerStepIdx++;
    const jitter = (Math.random() - 0.5) * 0.06;
    const op = Number(Math.max(0.04, Math.min(0.48, baseOp + jitter)).toFixed(2));
    setStereoVisualState('searching', op);
    const nextDelay = 38 + Math.floor(Math.random() * 45);
    stereoFlickerTimer = setTimeout(step, nextDelay);
  };
  step();
}

function resetStereoIndicator() {
  stereoSeq++;
  clearStereoTimers();
  stereoAcquiring = false;
  stereoTargetKey = null;
  stereoLockedKey = null;
  setStereoVisualState('off');
}

function startBetweenStationsFlicker() {
  const panelEl = $('panel');
  if (!panelEl || !panelEl.classList.contains('live')) {
    resetStereoIndicator();
    return;
  }
  stereoLockedKey = null;
  if (stereoState === 'searching' && !stereoAcquiring && stereoTargetKey === null && stereoFlickerTimer !== null) {
    return;
  }
  const seq = ++stereoSeq;
  clearStereoTimers();
  stereoAcquiring = false;
  stereoTargetKey = null;
  setStereoVisualState('searching', 0.28);
  startStereoFlickerLoop(seq);
}

function syncStereoIndicator() {
  const panelEl = $('panel');
  if (!panelEl || !panelEl.classList.contains('live')) {
    if (stereoState !== 'off' || stereoAcquiring || stereoTargetKey !== null || stereoLockedKey !== null) {
      resetStereoIndicator();
    }
    return;
  }

  const stations = ST[S.dec] || [];
  const minFreq = typeof MIN === 'number' ? MIN : 87.5;
  const spanFreq = typeof SPAN === 'number' ? SPAN : 20.5;
  const f = Math.round((minFreq + S.tun * spanFreq) * 10) / 10;
  const prox = getTuningProximity(f, stations);
  const best = prox.best;
  S.locked = !!best;

  if (!best) {
    stereoLockedKey = null;
    const canFlickerNearStation = Boolean(
      prox.withinOneGraduation &&
      hasFirstSongStartedPlaying &&
      hasActiveSignalPlayback &&
      playbackEnabled &&
      S.state === 'playing'
    );
    if (canFlickerNearStation) {
      startBetweenStationsFlicker();
    } else if (stereoState !== 'off' || stereoAcquiring || stereoTargetKey !== null) {
      resetStereoIndicator();
    }
    return;
  }

  const currentKey = S.dec + '|' + best[0];
  if (stereoLockedKey && stereoLockedKey !== currentKey) {
    stereoLockedKey = null;
  }

  // Once a station is acquired and locked, keep the STEREO indicator steadily illuminated
  // across song transitions, buffering, and pause/resume while the dial remains on this station.
  if (stereoLockedKey === currentKey) {
    clearStereoTimers();
    stereoAcquiring = false;
    stereoTargetKey = currentKey;
    if (stereoState !== 'locked') {
      setStereoVisualState('locked');
    }
    return;
  }

  const isStationMusicPlaying = Boolean(
    S.locked &&
    hasFirstSongStartedPlaying &&
    hasActiveSignalPlayback &&
    S.state === 'playing' &&
    isYtPlaybackActive &&
    !isSeeking &&
    transientStatus !== 'seek' &&
    !pendingTuneData
  );

  if (!isStationMusicPlaying) {
    if (stereoState !== 'off' || stereoAcquiring || stereoTargetKey !== null) {
      resetStereoIndicator();
    }
    return;
  }

  if (stereoTargetKey === currentKey && (stereoState === 'locked' || stereoAcquiring)) {
    return;
  }

  const seq = ++stereoSeq;
  clearStereoTimers();
  stereoTargetKey = currentKey;
  stereoAcquiring = true;
  setStereoVisualState('off');

  const acquireDelayMs = 130 + Math.floor(Math.random() * 90);
  stereoDelayTimer = setTimeout(() => {
    if (seq !== stereoSeq || stereoTargetKey !== currentKey) return;
    const curF = Math.round((minFreq + S.tun * spanFreq) * 10) / 10;
    const curProx = getTuningProximity(curF, ST[S.dec] || []);
    if (!curProx.best || (S.dec + '|' + curProx.best[0]) !== currentKey || !S.locked || isSeeking || S.state !== 'playing' || !isYtPlaybackActive || !hasActiveSignalPlayback || !panelEl.classList.contains('live')) {
      syncStereoIndicator();
      return;
    }

    setStereoVisualState('searching', 0.26);
    startStereoFlickerLoop(seq);

    const flickerDurationMs = 420 + Math.floor(Math.random() * 240);
    stereoLockTimer = setTimeout(() => {
      if (seq !== stereoSeq || stereoTargetKey !== currentKey) return;
      const lockF = Math.round((minFreq + S.tun * spanFreq) * 10) / 10;
      const lockProx = getTuningProximity(lockF, ST[S.dec] || []);
      if (!lockProx.best || (S.dec + '|' + lockProx.best[0]) !== currentKey || !S.locked || isSeeking || S.state !== 'playing' || !isYtPlaybackActive || !hasActiveSignalPlayback || !panelEl.classList.contains('live')) {
        syncStereoIndicator();
        return;
      }

      clearStereoTimers();
      stereoAcquiring = false;
      stereoLockedKey = currentKey;
      setStereoVisualState('locked');
    }, flickerDurationMs);
  }, acquireDelayMs);
}

function setSeekingState(active) {
  isSeeking = Boolean(active);
  if (seekSafetyTimer) {
    clearTimeout(seekSafetyTimer);
    seekSafetyTimer = null;
  }
  if (isSeeking) {
    seekSafetyTimer = setTimeout(() => {
      if (isSeeking) {
        isSeeking = false;
        updateStatusDisplay();
        syncStereoIndicator();
      }
    }, 12000);
  }
  updateStatusDisplay();
  syncStereoIndicator();
}

// Local Web Audio static noise generator
class StaticNoiseController {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.filter = null;
    this.gain = null;
    this.isPlaying = false;
    this.noiseBuffer = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  getBuffer(ctx) {
    if (!this.noiseBuffer || this.noiseBuffer.sampleRate !== ctx.sampleRate) {
      const bufferSize = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return this.noiseBuffer;
  }

  start(volume) {
    if (this.isPlaying) {
      this.setVolume(volume);
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const buffer = this.getBuffer(ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      // Analog radio bandpass filter centered around ~1400Hz
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1400, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);

      const gain = ctx.createGain();
      const targetGain = Math.max(0, (typeof volume === 'number' ? volume : S.vol) * 0.22);
      gain.gain.setValueAtTime(targetGain, ctx.currentTime);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      source.start();

      this.source = source;
      this.filter = filter;
      this.gain = gain;
      this.isPlaying = true;
    } catch (e) {
      console.warn('[StaticNoiseController] Start error:', e);
    }
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.gain && this.ctx) {
      try {
        this.gain.gain.setValueAtTime(this.gain.gain.value, this.ctx.currentTime);
        this.gain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.02);
      } catch (e) {}
    }
    const src = this.source;
    this.source = null;
    this.filter = null;
    this.gain = null;
    setTimeout(() => {
      try {
        if (src) src.stop();
      } catch (e) {}
    }, 25);
  }

  setVolume(volume) {
    if (!this.isPlaying || !this.gain || !this.ctx) return;
    try {
      const targetGain = Math.max(0, volume * 0.22);
      this.gain.gain.setValueAtTime(targetGain, this.ctx.currentTime);
    } catch (e) {}
  }

  dispose() {
    this.stop();
    if (this.ctx) {
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null;
    }
  }
}
const staticController = new StaticNoiseController();

let boomBoxDjAudio = null;
let boomBoxDjEffects = null;
let boomBoxDjSafetyTimer = null;

function ensureBoomBoxDjAudio() {
  if (!boomBoxDjAudio) {
    boomBoxDjAudio = document.createElement('audio');
    boomBoxDjAudio.id = 'boombox-dj-speech-audio';
    boomBoxDjAudio.style.display = 'none';
    boomBoxDjAudio.preload = 'auto';
    document.body.appendChild(boomBoxDjAudio);
  }
  return boomBoxDjAudio;
}

function generateSaturationCurve(drive, samples = 2048) {
  const k = Math.max(1, drive || 15);
  const curve = new Float32Array(samples);
  const normFactor = Math.tanh(k * 0.7);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(k * 0.7 * x) / normFactor;
  }
  return curve;
}

function generateNeutralCurve(samples = 256) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    curve[i] = (i * 2) / (samples - 1) - 1;
  }
  return curve;
}

function generateImpulseResponse(ctx, duration = 2.5, decay = 1.2) {
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.floor(sampleRate * duration);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t / decay);
    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }
  return buffer;
}

class BoomBoxDjVoiceEffects {
  constructor(ctx) {
    this.ctx = ctx;
    this.sourceNode = null;
    this.inputGain = ctx.createGain();

    this.amHighpass = ctx.createBiquadFilter();
    this.amHighpass.type = 'highpass';
    this.amHighpass.frequency.value = 20;

    this.amLowpass = ctx.createBiquadFilter();
    this.amLowpass.type = 'lowpass';
    this.amLowpass.frequency.value = 20000;

    this.fmSparkle = ctx.createBiquadFilter();
    this.fmSparkle.type = 'peaking';
    this.fmSparkle.frequency.value = 10000;
    this.fmSparkle.Q.value = 1.0;
    this.fmSparkle.gain.value = 0;

    this.waveshaper = ctx.createWaveShaper();
    this.waveshaper.curve = generateNeutralCurve();

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = 0;
    this.compressor.ratio.value = 1;

    this.makeupGain = ctx.createGain();
    this.makeupGain.gain.value = 1.0;

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;

    this.convolver = ctx.createConvolver();
    try {
      this.convolver.buffer = generateImpulseResponse(ctx);
    } catch (e) {}

    this.reverbWetGain = ctx.createGain();
    this.reverbWetGain.gain.value = 0.0;

    this.masterOutput = ctx.createGain();
    this.masterOutput.gain.value = 1.0;

    // Connect Dry Chain
    this.inputGain.connect(this.amHighpass);
    this.amHighpass.connect(this.amLowpass);
    this.amLowpass.connect(this.fmSparkle);
    this.fmSparkle.connect(this.waveshaper);
    this.waveshaper.connect(this.compressor);
    this.compressor.connect(this.makeupGain);
    this.makeupGain.connect(this.dryGain);
    this.dryGain.connect(this.masterOutput);

    // Connect Reverb Wet Chain
    this.inputGain.connect(this.convolver);
    this.convolver.connect(this.reverbWetGain);
    this.reverbWetGain.connect(this.masterOutput);

    // Master to Destination
    this.masterOutput.connect(ctx.destination);
  }

  attach(audio) {
    if (!this.sourceNode) {
      try {
        this.sourceNode = this.ctx.createMediaElementSource(audio);
        this.sourceNode.connect(this.inputGain);
      } catch (e) {
        console.warn('[BoomBox DJ] MediaElementSource attach warning:', e);
      }
    }
  }

  applySettings(s) {
    if (!s || typeof s !== 'object') return;
    try {
      const now = this.ctx.currentTime;
      // 1. Reverb
      const targetWet = s.reverbEnabled ? (typeof s.reverbWetMix === 'number' ? s.reverbWetMix : 0.3) : 0;
      this.reverbWetGain.gain.setValueAtTime(targetWet, now);

      // 2. AM Radio
      this.amHighpass.frequency.setValueAtTime(s.amRadioEnabled ? 250 : 20, now);
      const nyquist = (this.ctx.sampleRate || 44100) / 2;
      this.amLowpass.frequency.setValueAtTime(s.amRadioEnabled ? 3000 : Math.min(20000, nyquist - 50), now);

      // 3. FM Sparkle
      this.fmSparkle.gain.setValueAtTime(s.fmSparkleEnabled ? (typeof s.fmSparkleBoost === 'number' ? s.fmSparkleBoost : 6) : 0, now);

      // 4. Saturation
      if (s.saturationEnabled) {
        this.waveshaper.curve = generateSaturationCurve(s.saturationDrive || 15);
      } else {
        this.waveshaper.curve = generateNeutralCurve();
      }

      // 5. Compressor
      if (s.compressionEnabled) {
        this.compressor.threshold.setValueAtTime(typeof s.compressionThreshold === 'number' ? s.compressionThreshold : -24, now);
        this.compressor.ratio.setValueAtTime(typeof s.compressionRatio === 'number' ? s.compressionRatio : 3, now);
        this.compressor.attack.setValueAtTime(typeof s.compressionAttack === 'number' ? s.compressionAttack : 0.010, now);
        this.compressor.release.setValueAtTime(typeof s.compressionRelease === 'number' ? s.compressionRelease : 0.150, now);
        this.compressor.knee.setValueAtTime(typeof s.compressionKnee === 'number' ? s.compressionKnee : 12, now);
        const makeup = Math.pow(10, (typeof s.compressionMakeupGain === 'number' ? s.compressionMakeupGain : 3) / 20);
        this.makeupGain.gain.setValueAtTime(makeup, now);
      } else {
        this.compressor.threshold.setValueAtTime(0, now);
        this.compressor.ratio.setValueAtTime(1, now);
        this.makeupGain.gain.setValueAtTime(1.0, now);
      }

      // 6. Master DJ Voice Volume (0.0 to 1.0)
      if (typeof s.voiceVolume === 'number') {
        const clampedVol = Math.max(0, Math.min(1, s.voiceVolume));
        this.masterOutput.gain.setValueAtTime(clampedVol, now);
      }
    } catch (e) {
      console.warn('[BoomBox DJ] Error applying settings:', e);
    }
  }
}

function playBoomBoxDjSpeech(payload) {
  if (boomBoxDjSafetyTimer) {
    clearTimeout(boomBoxDjSafetyTimer);
    boomBoxDjSafetyTimer = null;
  }

  const durationSec = typeof payload?.durationSec === 'number' && payload.durationSec > 0 ? payload.durationSec : 4;
  const text = payload?.text || '';
  const isBrowser = Boolean(payload?.isBrowser);

  let finished = false;
  const notifyFinished = (success, error) => {
    if (finished) return;
    finished = true;
    if (boomBoxDjSafetyTimer) {
      clearTimeout(boomBoxDjSafetyTimer);
      boomBoxDjSafetyTimer = null;
    }
    trace('BOOMBOX_DJ_SPEECH_FINISHED', { success, error, text });
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'BOOMBOX_DJ_SPEECH_FINISHED',
        payload: { success, error, text, durationSec }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    }
  };

  boomBoxDjSafetyTimer = setTimeout(() => {
    notifyFinished(true, 'safety_timeout');
  }, Math.max(12000, (durationSec + 4) * 1000));

  if (isBrowser) {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        if (typeof payload?.effectsSettings?.voiceVolume === 'number') {
          u.volume = Math.max(0, Math.min(1, payload.effectsSettings.voiceVolume));
        }
        u.onend = () => notifyFinished(true);
        u.onerror = (e) => notifyFinished(false, e?.error || 'speech_synthesis_error');
        window.speechSynthesis.speak(u);
        trace('BOOMBOX_DJ_SPEECH_PLAYING', { engine: 'browser', text });
        return;
      } catch (err) {
        notifyFinished(false, err?.message || 'browser_speech_failed');
        return;
      }
    } else {
      notifyFinished(false, 'speech_synthesis_not_supported');
      return;
    }
  }

  const audioSrc = payload?.audioSrc;
  if (!audioSrc) {
    notifyFinished(false, 'no_audio_src');
    return;
  }

  const audio = ensureBoomBoxDjAudio();
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch (e) {}

  // Route through Web Audio DJ Voice Effects
  try {
    const ctx = staticController.ensureContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (!boomBoxDjEffects) {
        boomBoxDjEffects = new BoomBoxDjVoiceEffects(ctx);
      }
      boomBoxDjEffects.attach(audio);
      if (payload?.effectsSettings) {
        boomBoxDjEffects.applySettings(payload.effectsSettings);
      }
    }
  } catch (err) {
    console.warn('[BoomBox DJ] Effects routing warning:', err);
  }

  audio.onended = () => {
    notifyFinished(true);
  };
  audio.onerror = (e) => {
    notifyFinished(false, 'audio_element_error');
  };

  audio.src = audioSrc;
  audio.play().then(() => {
    trace('BOOMBOX_DJ_SPEECH_PLAYING', { durationSec, text });
  }).catch((err) => {
    console.warn('[BoomBox DJ] Play error:', err);
    notifyFinished(false, err?.message || 'play_rejected');
  });
}

const SEG_ALPHA_MAP = {
  'A': ['a','b','c','e','f','g'],
  'B': ['c','d','e','f','g'],
  'C': ['a','d','e','f'],
  'D': ['b','c','d','e','g'],
  'E': ['a','d','e','f','g'],
  'F': ['a','e','f','g'],
  'G': ['a','c','d','e','f'],
  'H': ['b','c','e','f','g'],
  'I': ['b','c'],
  'J': ['b','c','d','e'],
  'K': ['b','d','e','f','g'],
  'L': ['d','e','f'],
  'M': ['a','c','e','g'],
  'N': ['c','e','g'],
  'O': ['a','b','c','d','e','f'],
  'P': ['a','b','e','f','g'],
  'Q': ['a','b','c','f','g'],
  'R': ['e','g'],
  'S': ['a','c','d','f','g'],
  'T': ['d','e','f','g'],
  'U': ['b','c','d','e','f'],
  'V': ['c','d','e'],
  'W': ['c','d','e'],
  'X': ['b','c','e','f','g'],
  'Y': ['b','c','d','f','g'],
  'Z': ['a','b','d','e','g']
};

function render7SegStatus(mode) {
  if (!mode || mode === 'blank') return '';
  const CONFIG = {
    playing: { sym: '\u25B6', text: 'PLAY' },
    paused: { sym: '\u275A\u275A', text: 'PAUSE' },
    stopped: { sym: '\u25A0', text: 'STOP' },
    seek: { sym: '\u25B6\u25B6', text: 'SEEK' },
    seeking: { sym: '\u25B6\u25B6', text: 'SEEK' },
    rew: { sym: '\u25C0\u25C0', text: 'REW' },
    rewind: { sym: '\u25C0\u25C0', text: 'REW' },
    ff: { sym: '\u25B6\u25B6', text: 'FF' },
    forward: { sym: '\u25B6\u25B6', text: 'FF' },
    disconnected: { sym: '\u25A0', text: 'DISCONNECTED' }
  };
  const cfg = CONFIG[mode] || { sym: '', text: String(mode).toUpperCase() };
  const fullLabel = (cfg.sym ? cfg.sym + ' ' : '') + cfg.text;
  let h = '<span class="seg-st-display" aria-label="' + fullLabel + '">';
  if (cfg.sym) {
    h += '<span class="seg-st-sym">' + cfg.sym + '</span> ';
  }
  h += '<span class="sr-only">' + cfg.text + '</span>';
  h += '<span class="seg-st-text" aria-hidden="true">' + cfg.text + '</span>';
  h += '<span class="seg-st-chars" aria-hidden="true">';
  for (const ch of cfg.text) {
    const segs = SEG_ALPHA_MAP[ch];
    if (segs) {
      const on = new Set(segs);
      h += '<span class="seg-st-char">';
      for (const s of ['a','b','c','d','e','f','g']) {
        h += '<span class="seg-st-bar seg-st-' + s + (on.has(s) ? ' on' : '') + '"></span>';
      }
      h += '</span>';
    } else if (ch === ' ') {
      h += '<span style="width:4px"></span>';
    }
  }
  h += '</span></span>';
  return h;
}

function updateStatusDisplay() {
  const stEl = $('st');
  if (!stEl) return;
  if (!S.locked) {
    stEl.innerHTML = '';
    return;
  }
  if (!appConnected) {
    stEl.innerHTML = render7SegStatus('disconnected');
    return;
  }
  if (isSeeking || transientStatus === 'seek' || S.state === 'seek') {
    stEl.innerHTML = render7SegStatus('seek');
    return;
  }
  if (transientStatus) {
    stEl.innerHTML = render7SegStatus(transientStatus);
    return;
  }
  if (!hasFirstSongStartedPlaying || S.state === 'blank' || S.state === 'stopped') {
    stEl.innerHTML = '';
    return;
  }
  stEl.innerHTML = render7SegStatus(S.state);
}

function clearTransientStatus() {
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  if (transientStatus !== null) {
    transientStatus = null;
    updateStatusDisplay();
  }
}

function showTransientStatus(mode) {
  if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
  transientStatus = mode;
  updateStatusDisplay();
  transientTimer = setTimeout(() => {
    transientStatus = null;
    transientTimer = null;
    updateStatusDisplay();
  }, 1000);
}

// transport
function setState(s,quiet){
 const normalized = (s === 'playing' || s === 'paused') ? s : (s === 'blank' ? 'blank' : 'stopped');
 const prevState = S.state;
 S.state = (normalized === 'blank') ? 'stopped' : normalized;
 $('bPlay').classList.toggle('on', normalized === 'playing');
 $('bPause').classList.toggle('on', normalized === 'paused');
 $('gPlay').classList.toggle('on', normalized === 'playing');
 document.querySelectorAll('.gp').forEach(e => e.classList.toggle('on', normalized === 'paused'));
 if (normalized === 'stopped') {
   $('gStop').classList.add('on');
   $('bStop').classList.add('on');
   setTimeout(() => {
     $('gStop').classList.remove('on');
     $('bStop').classList.remove('on');
   }, 1000);
 } else {
   $('gStop').classList.remove('on');
   $('bStop').classList.remove('on');
 }
 $('stage').classList.toggle('playing', normalized === 'playing');

 updateStatusDisplay();
 updateGenrePills();
  if (normalized === 'stopped' || normalized === 'blank') {
    isYtPlaybackActive = false;
    hasActiveSignalPlayback = false;
    resetStereoIndicator();
  } else if (normalized === 'paused') {
    isYtPlaybackActive = false;
    syncStereoIndicator();
  } else {
    syncStereoIndicator();
  }

 if (normalized === 'stopped' || normalized === 'blank' || (prevState !== 'playing' && prevState !== 'paused')) {
   renderSong();
 } else if (normalized === 'playing' || normalized === 'paused') {
   if (!sTimer && !sFadeTimer) {
     scheduleSongFade();
   }
 }
 if (!vuRunning) { vuRunning = true; requestAnimationFrame(vu); }
 if (!quiet && normalized !== 'blank') emit('transport', { state: normalized });
}
let lastUserTransportAction = null; // { state, time }
let transportReconcileTimer = null;

function trace(event, data) {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'RECORD_TRACE',
        payload: {
          ts: Date.now(),
          source: 'boombox',
          event,
          data: data || {}
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    }
  } catch (e) {}
}

const act=(el,f)=>{el.onclick=f;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f()}}};
act($('bPlay'),()=>{
  clearTransientStatus();
  // Resume local Web Audio Context on user play interaction
  playbackEnabled = true;
  staticController.ensureContext();
  if (!S.locked) {
    staticController.start(S.vol);
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
    }
  } catch (e) {}

  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  const t_boombox_play_click = Date.now();
  lastUserTransportAction = { state: 'playing', time: t_boombox_play_click };
  trace('CLICK_PLAY', { t_boombox_play_click });
  sendBoomBoxAction('PLAY', { t_boombox_play_click });
});
act($('bPause'),()=>{
  clearTransientStatus();
  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  const next = S.state === 'playing' ? 'paused' : 'playing';
  playbackEnabled = next === 'playing';
  if (next === 'paused') {
    isYtPlaybackActive = false;
  }
  staticController.stop();
  lastUserTransportAction = { state: next, time: Date.now() };
  setState(next, true);
  trace('CLICK_PAUSE', { optimisticState: next });
  sendBoomBoxAction(next === 'paused' ? 'PAUSE' : 'PLAY');
});
act($('bStop'),()=>{
  playbackEnabled = false;
  isYtPlaybackActive = false;
  hasActiveSignalPlayback = false;
  resetStereoIndicator();
  staticController.stop();
  showTransientStatus('stopped');
  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  lastUserTransportAction = { state: 'stopped', time: Date.now() };
  setState('stopped', true);
  trace('CLICK_STOP', { optimisticState: 'stopped' });
  sendBoomBoxAction('STOP');
});

// knobs
let isTuningDrag = false;
let isBalanceDrag = false;
let lastUserBalanceTime = 0;
function knob(el,key,base,min,max,onSet,step,sens){
 const rot=()=>el.style.transform='rotate('+(min+S[key]*(max-min)-base)+'deg)';
 const set=v=>{S[key]=clamp(v);onSet&&onSet();rot();};
 let lx=0,ly=0,drag=false,activePointerId=null,hadPrimaryButtonDown=false,lastMoveEvent=null;
 const divisor = typeof sens === 'number' ? sens : 220;
 const stopDrag=e=>{
   if(!drag)return;
   if(e && typeof e.pointerId==='number' && activePointerId!==null && e.pointerId!==activePointerId && e.type!=='blur' && e.type!=='visibilitychange' && e.type!=='lostpointercapture')return;
   const pid=activePointerId;
   drag=false;
   activePointerId=null;
   hadPrimaryButtonDown=false;
   lastMoveEvent=null;
   el.style.cursor='grab';
   window.removeEventListener('pointermove',onMove,true);
   window.removeEventListener('pointerup',stopDrag,true);
   window.removeEventListener('pointercancel',stopDrag,true);
   window.removeEventListener('mouseup',stopDrag,true);
   window.removeEventListener('blur',stopDrag);
   document.removeEventListener('visibilitychange',onVisChange);
   if(pid!==null){
     try{if(el.hasPointerCapture&&el.hasPointerCapture(pid))el.releasePointerCapture(pid);}catch(_){}
   }
   if(key==='tun'){
     isTuningDrag=false;
     if(typeof flushPendingTune==='function') flushPendingTune();
     syncStereoIndicator();
   }
   if(key==='bal') isBalanceDrag=false;
 };
 const onVisChange=()=>{if(document.hidden)stopDrag({type:'visibilitychange'});};
 const onMove=e=>{
   if(!drag||e===lastMoveEvent)return;
   if(typeof e.pointerId==='number' && activePointerId!==null && e.pointerId!==activePointerId)return;
   if((e.isTrusted||hadPrimaryButtonDown) && typeof e.buttons==='number' && e.pointerType!=='touch' && (e.buttons&1)===0){
     stopDrag(e);
     return;
   }
   lastMoveEvent=e;
   if(e.clientX===lx && e.clientY===ly)return;
   set(S[key]+((e.clientX-lx)-(e.clientY-ly))/divisor);
   lx=e.clientX;
   ly=e.clientY;
 };
 el.onpointerdown=e=>{
   if(typeof e.button==='number' && e.button!==0)return;
   if(drag)stopDrag();
   e.preventDefault();
   drag=true;
   activePointerId=typeof e.pointerId==='number'?e.pointerId:null;
   hadPrimaryButtonDown=Boolean(e.isTrusted||(typeof e.buttons==='number'&&(e.buttons&1)===1));
   lx=e.clientX;
   ly=e.clientY;
   try{if(activePointerId!==null&&el.setPointerCapture)el.setPointerCapture(activePointerId);}catch(_){}
   el.style.cursor='grabbing';
   if(key==='tun') isTuningDrag=true;
   if(key==='bal') isBalanceDrag=true;
   staticController.ensureContext();
   window.addEventListener('pointermove',onMove,true);
   window.addEventListener('pointerup',stopDrag,true);
   window.addEventListener('pointercancel',stopDrag,true);
   window.addEventListener('mouseup',stopDrag,true);
   window.addEventListener('blur',stopDrag);
   document.addEventListener('visibilitychange',onVisChange);
 };
 el.onpointermove=onMove;
 el.onpointerup=el.onpointercancel=el.onlostpointercapture=stopDrag;
 el.onwheel=e=>{e.preventDefault();staticController.ensureContext();set(S[key]-Math.sign(e.deltaY)*step)};
 el.onkeydown=e=>{const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key];if(d){e.preventDefault();staticController.ensureContext();set(S[key]+d*step)}};
 rot();
 set.isDragging=()=>drag;
 set.stopDrag=stopDrag;
 return set;
}
const setVolKnob=knob($('kVol'),'vol',-163,-140,140,()=>{staticController.setVolume(S.vol);emit('volume',{value:S.vol});sendBoomBoxAction('SET_VOLUME',{volume:Math.round(S.vol*100)})},.03);
if($('kBal')){$('kBal').setAttribute('aria-valuemin','-1');$('kBal').setAttribute('aria-valuemax','1');$('kBal').setAttribute('aria-valuenow','0');}
const setBalKnob=knob($('kBal'),'bal',10,-135,135,()=>{lastUserBalanceTime=Date.now();const bVal=Number((S.bal*2-1).toFixed(2));if($('kBal'))$('kBal').setAttribute('aria-valuenow',String(bVal));emit('balance',{value:bVal});sendBoomBoxAction('SET_BALANCE',{balance:bVal})},.04);
const setTunKnob=knob($('kTun'),'tun',40,-135,135,tune,.2/20.5,450);
$('kBal').ondblclick=()=>{lastUserBalanceTime=Date.now();S.bal=.5;$('kBal').style.transform='rotate(-10deg)';$('kBal').setAttribute('aria-valuenow','0');emit('balance',{value:0});sendBoomBoxAction('SET_BALANCE',{balance:0})};

// optional deck buttons: rewind / fast forward flash when clicked, record latches on/off.
// Set any of these to false to disable that button completely (no click area, no event).
const BUTTONS={rewind:true,forward:true,record:true};
[['rewind',573,'Rewind 10s / Previous','gRew',true],['forward',625,'Fast forward 10s / Next','gFwd',true],['record',677,'Request a song','gRec',false]].forEach(([k,left,label,cls,pulse])=>{
 if(!BUTTONS[k])return;
 const b=document.createElement('div');b.className='hit btn';b.style.left=left+'px';b.tabIndex=0;b.setAttribute('role','button');b.setAttribute('aria-label',label);$('stage').appendChild(b);
 const gs=document.querySelectorAll('.'+cls);
 act(b,()=>{if(pulse){gs.forEach(e=>e.classList.add('on'));setTimeout(()=>gs.forEach(e=>e.classList.remove('on')),600);
   if(k==='rewind'){showTransientStatus('rew');sendBoomBoxAction('REWIND');emit('previous',{});}
   else if(k==='forward'){showTransientStatus('ff');sendBoomBoxAction('FAST_FORWARD');emit('next',{});}}
  else{const on=!gs[0].classList.contains('on');gs.forEach(e=>e.classList.toggle('on',on));emit('record',{on})}})});

// display panel expand/collapse
const pan=$('panel');
const TGL_GLOW_DEF='<defs><filter id="tglGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="0.6" result="b1"/><feGaussianBlur stdDeviation="1.6" result="b2"/><feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
const TGL_MINUS_ICON=TGL_GLOW_DEF+'<rect x="1" y="4.2" width="8" height="1.6" rx="0.8" fill="#8dffb0" filter="url(#tglGlow)"/>';
const TGL_PLUS_ICON=TGL_MINUS_ICON+'<rect x="4.2" y="1" width="1.6" height="8" rx="0.8" fill="#8dffb0" filter="url(#tglGlow)"/>';
function setOpen(o){
  pan.classList.toggle('collapsed',!o);
  $('tgl').setAttribute('aria-expanded',o);
  const icon=$('tglIcon');
  if(icon)icon.innerHTML=o?TGL_MINUS_ICON:TGL_PLUS_ICON;
  emit('display',{open:o});
  try{localStorage.setItem('rfm-open',o?'1':'0')}catch(e){}
}
$('tgl').onclick=()=>setOpen(pan.classList.contains('collapsed'));
try{if(localStorage.getItem('rfm-open')==='0')setOpen(false)}catch(e){}

// logo: file pattern <decade>s-white.png / <decade>s-black.png in LOGO_BASE
const LOGO_BASE='logos/';let dark=true,logoDec=S.dec;
// boom box art swaps with the theme: boom-box-white.png / boom-box-black.png in BOX_BASE (falls back to the built-in image if missing)
const BOX_BASE='images/';let boxUrl='';
function setBox(){const u=BOX_BASE+'boom-box-'+(dark?'black':'white')+'.png';if(u===boxUrl)return;boxUrl=u;
 const im=new Image(),r=document.body.style;
 im.onload=()=>{if(u===boxUrl)r.setProperty('--img','url('+u+')')};
 im.onerror=()=>{if(u===boxUrl)r.removeProperty('--img')};
 im.src=u;}
function paintLogo(){const i=$('logo'),f=$('fb');document.body.classList.toggle('dark',dark);document.documentElement.classList.toggle('dark',dark);setBox();if(!logoDec){i.style.display='none';f.style.display='none';i.removeAttribute('src');$('logoBar').style.cursor='default';return}$('logoBar').style.cursor='pointer';
 i.style.display='block';f.style.display='none';
 i.onerror=()=>{i.style.display='none';f.style.display='block';f.textContent='RetroFM \u00B7 '+logoDec+'s'};
 const targetSrc = LOGO_BASE+logoDec+'s-'+(dark?'black':'white')+'.png';
 if (i.getAttribute('src') !== targetSrc) {
   i.src = targetSrc;
 }}
paintLogo();
function setSongYear(y){}
const flip=()=>{if(!logoDec)return;dark=!dark;paintLogo();emit('theme',{dark})};
$('logoBar').onclick=flip;$('logoBar').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}};
document.addEventListener('retrofm:song',e=>{const d=e.detail||{};if(d.title)setSong(d);if(d.year)setSongYear(d.year)});
window.RetroFM={setSongYear,setSong,setTransport:s=>setState(s,true),getStereoState:()=>stereoState,getTuningProximity,syncStereoIndicator,resetStereoIndicator,getKnobDragState:()=>({vol:setVolKnob.isDragging(),bal:setBalKnob.isDragging(),tun:setTunKnob.isDragging(),isTuningDrag,isBalanceDrag}),animateTuningToFrequency,cancelTuningAnimation,getTuningAnimationState:()=>tuningAnimState};

// tuning: dial = FM frequency, locks onto the selected decade's genre stations
const MIN=87.5,SPAN=20.5;let lastKey='';
// Coordinated analog tuner needle & digital frequency transition state
let tuningAnimRaf = 0;
let tuningAnimState = null;

function cancelTuningAnimation(applyCurrentState = false) {
  if (tuningAnimRaf) {
    cancelAnimationFrame(tuningAnimRaf);
    tuningAnimRaf = 0;
  }
  if (tuningAnimState && applyCurrentState) {
    applyTuningVisuals(tuningAnimState.currentF, tuningAnimState.currentTun);
  }
  tuningAnimState = null;
}

function applyTuningVisuals(fVal, tunVal) {
  const roundedF = Math.round(fVal * 10) / 10;
  const fClamped = Math.max(MIN, Math.min(MIN + SPAN, roundedF));
  const normalizedTun = typeof tunVal === 'number'
    ? clamp(tunVal, 0, 1)
    : clamp((fClamped - MIN) / SPAN, 0, 1);

  // Update needle and tuning knob without triggering playback / events
  const x = fx(MIN + normalizedTun * SPAN);
  const tnEl = $('tn');
  if (tnEl) {
    tnEl.setAttribute('x1', x);
    tnEl.setAttribute('x2', x);
  }
  const kTunEl = $('kTun');
  if (kTunEl) {
    kTunEl.style.transform = 'rotate(' + (-135 + normalizedTun * 270 - 40) + 'deg)';
  }

  // Update digital frequency readout (avoid redundant re-renders)
  const yrEl = $('year');
  if (yrEl) {
    const fStr = fClamped.toFixed(1);
    if (yrEl.dataset.curF !== fStr) {
      yrEl.dataset.curF = fStr;
      yrEl.innerHTML = render7SegFreq(fStr);
    }
  }
}

function animateTuningToFrequency(targetFreq, fromTun) {
  const destinationFreq = Math.round(Math.max(MIN, Math.min(MIN + SPAN, targetFreq)) * 10) / 10;
  const destinationTun = (destinationFreq - MIN) / SPAN;

  // Determine starting point: use explicit fromTun if passed, or in-flight animation state, or fallback to S.tun
  let startingTun;
  if (typeof fromTun === 'number' && Number.isFinite(fromTun)) {
    startingTun = clamp(fromTun, 0, 1);
  } else if (tuningAnimState) {
    startingTun = clamp(tuningAnimState.currentTun, 0, 1);
  } else {
    startingTun = clamp(S.tun, 0, 1);
  }
  let startingFreq = Math.round((MIN + startingTun * SPAN) * 10) / 10;

  cancelTuningAnimation(false);

  // If already at target frequency, ensure exact alignment and return
  if (Math.abs(startingFreq - destinationFreq) < 0.001) {
    applyTuningVisuals(destinationFreq, destinationTun);
    return;
  }

  // Respect user preference for reduced motion
  const prefersReducedMotion = typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    applyTuningVisuals(destinationFreq, destinationTun);
    return;
  }

  // Duration scales with tuning distance: 550ms base up to 750ms for wide spans
  const spanRatio = Math.abs(destinationFreq - startingFreq) / SPAN;
  const animDuration = Math.round(550 + spanRatio * 200);
  const animStartTime = performance.now();

  tuningAnimState = {
    startF: startingFreq,
    destF: destinationFreq,
    startTun: startingTun,
    destTun: destinationTun,
    currentF: startingFreq,
    currentTun: startingTun,
    startTime: animStartTime,
    duration: animDuration
  };

  // Responsive initial movement with smooth, controlled deceleration at the station
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

  const stepAnim = now => {
    if (!tuningAnimState) return;
    const elapsed = now - tuningAnimState.startTime;
    const rawProgress = Math.min(1, Math.max(0, elapsed / tuningAnimState.duration));
    const easedProgress = easeOutCubic(rawProgress);

    const curTun = tuningAnimState.startTun + (tuningAnimState.destTun - tuningAnimState.startTun) * easedProgress;
    const curF = tuningAnimState.startF + (tuningAnimState.destF - tuningAnimState.startF) * easedProgress;

    tuningAnimState.currentTun = curTun;
    tuningAnimState.currentF = curF;

    if (rawProgress >= 1) {
      applyTuningVisuals(tuningAnimState.destF, tuningAnimState.destTun);
      tuningAnimState = null;
      tuningAnimRaf = 0;
    } else {
      applyTuningVisuals(curF, curTun);
      tuningAnimRaf = requestAnimationFrame(stepAnim);
    }
  };

  // Immediate first frame reflects the starting visual state
  applyTuningVisuals(startingFreq, startingTun);
  tuningAnimRaf = requestAnimationFrame(stepAnim);
}
// Seven-segment display mapping: A, B, C, D, E, F, G
const SEG_MAP = {
  '0': ['a','b','c','d','e','f'],
  '1': ['b','c'],
  '2': ['a','b','g','e','d'],
  '3': ['a','b','g','c','d'],
  '4': ['f','g','b','c'],
  '5': ['a','f','g','c','d'],
  '6': ['a','f','g','e','c','d'],
  '7': ['a','b','c'],
  '8': ['a','b','c','d','e','f','g'],
  '9': ['a','b','c','d','f','g']
};
function render7SegFreq(fStr){
  let h = '<span class="seg-display" aria-label="' + fStr + ' FM">';
  for (const ch of fStr) {
    if (ch === '.') {
      h += '<span class="seg-dp"><span class="seg-dp-box"></span></span>';
    } else if (SEG_MAP[ch]) {
      const on = new Set(SEG_MAP[ch]);
      h += '<span class="seg-digit">';
      for (const s of ['a','b','c','d','e','f','g']) {
        h += '<span class="seg-bar seg-' + s + (on.has(s) ? ' on' : '') + '"></span>';
      }
      h += '</span>';
    }
  }
  h += '<span class="seg-unit" aria-hidden="true"><span class="seg-unit-fm">FM</span><span class="seg-unit-mhz">MHz</span></span></span>';
  return h;
}
function tune(skipVisuals = false){
 if (!skipVisuals) cancelTuningAnimation(false);
 const f=Math.round((MIN+S.tun*SPAN)*10)/10;S.tun=(f-MIN)/SPAN;
 if (!skipVisuals) {
   $('kTun').style.transform='rotate('+(-135+S.tun*270-40)+'deg)';
   const x=fx(MIN+S.tun*SPAN);$('tn').setAttribute('x1',x);$('tn').setAttribute('x2',x);
   const yrEl=$('year');
   if(yrEl){yrEl.dataset.curF=f.toFixed(1);yrEl.innerHTML=render7SegFreq(f.toFixed(1));}
 }
 let best=null;
 const stations=ST[S.dec]||[];
 stations.forEach(s=>{const d=Math.abs(s[1]-f);if(d<0.05)best=s});
 if (!skipVisuals) {
   const yrEl=$('year');
   if(yrEl){yrEl.dataset.curF=f.toFixed(1);yrEl.innerHTML=render7SegFreq(f.toFixed(1));}
 }
 S.locked=!!best;
 const sdotEl=$('sdot');if(sdotEl)sdotEl.style.display=best?'':'none';
 const giEl=$('gi');if(giEl)giEl.textContent=best?'':'Between stations';
 updateGenrePills();
 const key=S.dec+'|'+(best?best[0]:'');
 const stationChanged = key !== lastKey;
 if(best){const hg=$('hGen');if(hg)hg.textContent=best[0].toUpperCase();if(gl===stations)gi=gl.indexOf(best)}
  if(!best){
    isYtPlaybackActive = false;
    stereoLockedKey = null;
    setSeekingState(false);
    if(playbackEnabled) staticController.start(S.vol);
    song=null;
    playbackProgress.currentTime = 0;
    playbackProgress.duration = 0;
    playbackProgress.videoId = null;
    renderSong();
    updateStatusDisplay();
    syncStereoIndicator();
  }else{
   staticController.stop();
   if (stationChanged) {
     isYtPlaybackActive = false;
     resetStereoIndicator();
     setSeekingState(true);
   }
   playbackEnabled = true;
   updateStatusDisplay();
   syncStereoIndicator();
 }
  if(key!==lastKey){
   lastKey=key;
   if(best){
     song=null;
     playbackProgress.currentTime = 0;
     playbackProgress.duration = 0;
     playbackProgress.videoId = null;
     clearSongTimers();
     renderSong();
   }
   marks();
   if(pan.classList.contains('live')){
     emit('tune',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best});
     sendBoomBoxAction('TUNE',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best,autoPlay:best ? true : playbackEnabled});
   }
 }
}
function paintChips(d){
 const chipsEl=$('chips');if(!chipsEl)return;chipsEl.innerHTML='';
 [...(ST[d]||[])].sort((a,b)=>a[1]-b[1]).forEach(s=>{const b=document.createElement('button');b.className='chip';b.dataset.g=s[0];b.textContent=s[0];b.title=s[1].toFixed(1)+' FM';
  b.onclick=()=>{
    staticController.ensureContext();
    const prevTun = tuningAnimState ? tuningAnimState.currentTun : S.tun;
    S.tun=(s[1]-MIN)/SPAN;
    tune(true);
    animateTuningToFrequency(s[1], prevTun);
  };chipsEl.appendChild(b)});
 updateGenrePills();
}
function setDec(d){S.dec=d;lastKey='';
 document.querySelectorAll('.dec').forEach(b=>b.classList.toggle('sel',+b.textContent===d));
 logoDec=d;paintLogo();paintChips(d);
 tune();}
// FM scale drawn to match the dial: x position for a frequency (88 to 108 MHz)
const fx=f=>330+(f-87.5)*27.3;
(function(){let h='';for(let f=88;f<=108;f++){const M=f%4===0,x=fx(f).toFixed(1);
 h+='<line x1="'+x+'" x2="'+x+'" y1="'+(M?158:163)+'" y2="168" stroke="#3d3a37" stroke-width="'+(M?1.8:1.1)+'"/>';
 if(M)h+='<text x="'+x+'" y="153" text-anchor="middle" font-size="15" fill="#3d3a37" font-family="system-ui,sans-serif">'+f+'</text>'}
 $('scale').innerHTML=h})();
function marks(){$('stn').innerHTML=ST[S.dec].map(s=>'<circle cx="'+fx(s[1]).toFixed(1)+'" cy="180" r="3.4" fill="#c8741a"/>').join('')}
// Live mode: real songs received from RetroFM session
const DEMO=false;
// song info on the display: title and artist alternate with 1.2s fade and 3s hold
// songDisplayMode: 'song_info' (1) -> 'elapsed_time' (2) -> 'hidden' (3)
// By default, Artist Name and Song Title is the default display mode on entering the green display.
let songDisplayMode = 'song_info';
try {
  const savedMode = localStorage.getItem('rfm-song-display-mode');
  if (savedMode === 'song_info' || savedMode === 'elapsed_time' || savedMode === 'hidden') {
    songDisplayMode = savedMode;
  }
} catch (e) {}

let playbackProgress = { currentTime: 0, duration: 0, videoId: null };

function formatPlaybackTime(sec) {
  if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateGenrePills() {
  const isPlaying = (S.state === 'playing' || isYtPlaybackActive);
  const stations = ST[S.dec] || [];
  const f = Math.round((MIN + S.tun * SPAN) * 10) / 10;
  let best = null;
  stations.forEach(s => {
    if (Math.abs(s[1] - f) < 0.05) best = s;
  });
  S.locked = !!best;
  document.querySelectorAll('.chip').forEach(c => {
    const isSelected = !!best && c.dataset.g === best[0];
    c.classList.toggle('sel', isSelected && isPlaying);
  });
}

let song=null,fadeOn=true,phase=0,sTimer=0,sFadeTimer=0,appConnected=false;

function clearSongTimers(){
  if(sTimer){clearTimeout(sTimer);sTimer=0;}
  if(sFadeTimer){clearTimeout(sFadeTimer);sFadeTimer=0;}
}

function renderSong(){
  const el=$('sg');
  const sdotEl=$('sdot');
  clearSongTimers();
  el.className='';
  el.style.opacity='1';
  el.title='';

  if(sdotEl){
    sdotEl.classList.remove('mode-hidden');
    if(songDisplayMode==='song_info'){
      sdotEl.textContent='\u266B';
      sdotEl.title='Song Information (click for elapsed time)';
      sdotEl.setAttribute('aria-label','Song information mode: showing title and artist');
    }else if(songDisplayMode==='elapsed_time'){
      sdotEl.textContent='\u23F1';
      sdotEl.title='Elapsed Time (click to hide)';
      sdotEl.setAttribute('aria-label','Elapsed time mode: showing playback position');
    }else{
      sdotEl.textContent='\u2022';
      sdotEl.classList.add('mode-hidden');
      sdotEl.title='Display Hidden (click for song information)';
      sdotEl.setAttribute('aria-label','Display hidden mode: click to show song information');
    }
  }

  if(songDisplayMode==='hidden'){
    el.textContent='';
    return;
  }

  if(!fadeOn){el.textContent='';return;}
  if(!appConnected){el.textContent='Offline';el.className='dim';return;}
  if(!S.locked){el.textContent='';el.title='';return;}

  if(!song || !hasFirstSongStartedPlaying){
    el.textContent='';
    return;
  }

  if(songDisplayMode==='elapsed_time'){
    if(playbackProgress.videoId && song.videoId && playbackProgress.videoId !== song.videoId){
      el.textContent='';
      el.title='';
      return;
    }
    const curFmt = formatPlaybackTime(playbackProgress.currentTime) || '00:00';
    const durFmt = formatPlaybackTime(playbackProgress.duration);
    if(durFmt){
      el.textContent = curFmt + ' / ' + durFmt;
    }else{
      el.textContent = curFmt;
    }
    el.title = 'Elapsed playback time: ' + el.textContent;
    return;
  }

  el.title=song.title+(song.artist?' by '+song.artist:'');
  if(!song.artist){
    el.textContent=song.title;
    return;
  }

  // Two screens: phase 0 = Song Title, phase 1 = Artist
  phase=0;
  el.textContent=song.title;
  if(S.state==='playing' || S.state==='paused' || S.state==='stopped'){
    scheduleSongFade();
  }
}

function scheduleSongFade(){
  clearSongTimers();
  if(songDisplayMode!=='song_info')return;
  if(!song||!song.artist||!fadeOn||!appConnected||!S.locked||(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped'))return;

  // Hold current screen for 3000ms
  sTimer=setTimeout(()=>{
    const el=$('sg');
    if(!el)return;
    // Fade out (CSS transition: 1.2s)
    el.style.opacity='0';
    sFadeTimer=setTimeout(()=>{
      if(songDisplayMode!=='song_info')return;
      if(!song||!fadeOn||!appConnected||!S.locked||(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped'))return;
      // Switch screen: phase 0 was Title -> next is Artist (1); phase 1 was Artist -> next is Title (0)
      phase=phase===0?1:0;
      el.textContent=phase===1?song.artist:song.title;
      // Fade in
      el.style.opacity='1';
      // Schedule next rotation
      scheduleSongFade();
    },1200);
  },3000);
}

function cleanTitle(rawTitle, artist) {
  if (!rawTitle) return '';
  let t = String(rawTitle).trim();
  // Strip release year in parentheses e.g. (1985) or (1985 Remastered)
  t = t.replace(/\s*\(\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\)/gi, '');
  // Also strip [1985] or [1985 Remastered]
  t = t.replace(/\s*\[\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\]/gi, '');

  // Strip leading artist if present at start e.g. "a-ha - Take on Me" or "a-ha — Take on Me"
  if (artist && artist.trim()) {
    const aEsc = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadArtistRegex = new RegExp('^' + aEsc + '\\s*[-:—–~]\\s*', 'i');
    t = t.replace(leadArtistRegex, '');
  } else {
    // If no artist provided, check if format is "Artist - Title" (allowing hyphens inside artist name by splitting on first space-dash-space or em-dash)
    const match = t.match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match) {
      t = match[2];
    }
  }
  return t.trim();
}

function cleanArtist(rawArtist, rawTitle) {
  const cleanStr = (s) => (s && String(s).trim() !== 'undefined' && String(s).trim() !== 'null') ? String(s).trim() : '';
  const rA = cleanStr(rawArtist);
  let embeddedArtist = '';
  if (rawTitle) {
    const match = String(rawTitle).trim().match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match && match[1].trim()) {
      embeddedArtist = match[1].trim();
    }
  }

  // If rawTitle contains "EmbeddedArtist - Title" and rawArtist differs from embeddedArtist:
  if (embeddedArtist && rA) {
    const rALower = rA.toLowerCase();
    const embLower = embeddedArtist.toLowerCase();
    if (rALower !== embLower && !embLower.includes(rALower) && !rALower.includes(embLower)) {
      return embeddedArtist;
    }
  }

  if (rA) {
    return rA;
  }
  return embeddedArtist;
}

let lastSongUpdateSeq = -1;

function setSong(d){
  if(!S.locked) return;
  if(d && typeof d.songSeq === 'number'){
    if(d.songSeq < lastSongUpdateSeq) return;
    lastSongUpdateSeq = d.songSeq;
  }
  let nextSong = null;
  if(d&&d.title){
    const rawTitle=String(d.title).trim();
    const rawArtist=d.artist?String(d.artist).trim():'';
    const rawYear=d.year?String(d.year).trim():'';
    if(rawTitle&&rawTitle!=='undefined'&&rawTitle!=='null'){
      const artist = cleanArtist(rawArtist, rawTitle);
      const title = cleanTitle(rawTitle, artist);
      const vid = d.videoId || null;
      nextSong={title: title || rawTitle, artist, year: rawYear, videoId: d.videoId || null};
    }
  }
  if (!nextSong && !song) return;
  if (nextSong && song) {
    const isSameVideo = nextSong.videoId && song.videoId && nextSong.videoId === song.videoId;
    const isSameMetadata = nextSong.title.toLowerCase() === song.title.toLowerCase() &&
      (nextSong.artist.toLowerCase() === song.artist.toLowerCase() || (!nextSong.artist && song.artist));
    if (isSameVideo || isSameMetadata) {
      song.title = nextSong.title;
      song.artist = nextSong.artist;
      song.year = nextSong.year;
      if (nextSong.videoId) song.videoId = nextSong.videoId;
      return;
    }
  }
  song = nextSong;
  renderSong();
}
window.addEventListener('beforeunload',()=>{clearSongTimers();clearTransientStatus();});
window.addEventListener('beforeunload',()=>{cancelTuningAnimation();clearStereoTimers();staticController.dispose();});
$('sdot').onclick=()=>{
  if(songDisplayMode==='song_info'){
    songDisplayMode='elapsed_time';
  }else if(songDisplayMode==='elapsed_time'){
    songDisplayMode='hidden';
  }else{
    songDisplayMode='song_info';
  }
  try{localStorage.setItem('rfm-song-display-mode',songDisplayMode)}catch(e){}
  renderSong();
};

// entry board: type a date, pick a genre, press Enter to tune in
const FN=20,MON=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const dIn=$('dIn'),fD=$('fDate'),fG=$('fGen'),hint=$('bHint'),brd=$('board');
let D=null,gi=0,gl=[],step='date';
function cells(el){if(!el.children.length)for(let i=0;i<FN;i++){const c=document.createElement('span');c.className='fl';c.textContent=' ';c.dataset.c=' ';el.appendChild(c)}return el.children}
function flap(el,txt,ph){el.classList.toggle('ph',!!ph);const cs=cells(el);
 for(let i=0;i<FN;i++){const c=cs[i],ch=(txt[i]||' ').toUpperCase();
  if(c.dataset.c!==ch){c.dataset.c=ch;c.classList.remove('f');void c.offsetWidth;c.style.animationDelay=i*16+'ms';c.classList.add('f');setTimeout(()=>{c.textContent=ch},i*16+130)}}}
function caret(){const n=dIn.value.length;[...cells(fD)].forEach((c,i)=>c.classList.toggle('cur',i===Math.min(n,FN-1)))}
function parseDate(s){s=s.trim();let m,d;
 if(m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))d=new Date(+m[1],m[2]-1,+m[3]);
 else{if(!/\d{4}/.test(s)||s.split(/[\s,\/\-]+/).filter(Boolean).length<3)return null;const t=Date.parse(s);if(isNaN(t))return null;d=new Date(t)}
 if(d.getFullYear()<1960||d>new Date())return null;return d}
const MIDX=s=>MON.findIndex(m=>m.toLowerCase().startsWith(s.toLowerCase()));
// month spell-check: a unique prefix (Jul, Sept) or a close misspelling (Marrch, Febuary) resolves to the month
const lev=(a,b)=>{const d=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return d[b.length]};
function fixMonth(w){const s=w.toLowerCase();if(s.length<3)return -1;
 const pre=MON.map((m,i)=>m.toLowerCase().startsWith(s)?i:-1).filter(i=>i>=0);if(pre.length===1)return pre[0];
 let best=-1,bd=9,tie=false;MON.forEach((m,i)=>{const d=lev(s,m.toLowerCase());if(d<bd){bd=d;best=i;tie=false}else if(d===bd)tie=true});
 return !tie&&bd<=Math.min(2,Math.max(1,Math.floor(s.length/3)))?best:-1}
const MDAYS=[31,29,31,30,31,30,31,31,30,31,30,31];
function problem(v){v=v.trim();if(!v)return'';
 const m=v.match(/^([A-Za-z]+)\.?(?:\s+(\d{1,2})(?:\s*,?\s*(\d{0,4}))?)?\s*$/);
 if(!m)return /^\d/.test(v)?'':'Use a format like July 4, 1978';
 const mi=MIDX(m[1]);if(mi<0)return m[2]===undefined?'':'Start with a month, like July';
 const nm=MON[mi][0]+MON[mi].slice(1).toLowerCase();
 if(m[2]&&(+m[2]<1||+m[2]>MDAYS[mi]))return nm+' has at most '+MDAYS[mi]+' days';
 if(m[3]&&m[3].length===4){const y=+m[3];if(y<1960)return'The dial starts in 1960';if(y>new Date().getFullYear())return'That year hasn\'t happened yet'}
 return''}
 function refresh(q){const v=dIn.value;D=parseDate(v);if(D&&!(v.match(/\d+/g)||[]).map(Number).includes(D.getDate()))D=null;if(!D)step='date';
  if(D){flap(fD,MON[D.getMonth()]+' '+D.getDate()+', '+D.getFullYear());
   const dec=Math.floor(D.getFullYear()/10)*10;if(gl!==ST[dec]){gl=ST[dec];gi=0}
   if(dec>=1960&&dec<=2020&&logoDec!==dec){logoDec=dec;paintLogo();}
   const dateStr=D.getFullYear()+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0');
   sendBoomBoxAction('REQUEST_DATE_STATIONS',{date:dateStr,decade:dec});
   flap(fG,gl[gi]?gl[gi][0]:'GENRE');hint.textContent=step==='genre'?'\u2191\u2193 CHOOSE GENRE \u00B7 ENTER TO TUNE IN \u00B7 TAB: DATE':'ENTER OR TAB TO CHOOSE A GENRE';hint.className=''}
  else{flap(fD,v||'TYPE A DATE',!v);gl=[];flap(fG,'GENRE',1);
   if(logoDec!==S.dec){logoDec=S.dec;paintLogo();}
   const p=q?'':problem(v);hint.textContent=p||(v.length>5?'Try July 4, 1978 \u00B7 1960 to today':'e.g. July 4, 1978');hint.className=p?'err':''}
  brd.dataset.s=step;caret()}
function cyc(d){if(!D)return;gi=(gi+d+gl.length)%gl.length;flap(fG,gl[gi][0])}
let committedSelection = null;

function goLive(){
  const y=D.getFullYear(),dec=Math.floor(y/10)*10,g=gl[gi];
  isYtPlaybackActive = false;
  hasActiveSignalPlayback = false;
  resetStereoIndicator();
  setSeekingState(true);
  pan.classList.replace('entry','live');
  $('hDate').textContent=MON[D.getMonth()]+' '+D.getDate()+', '+y;
  const hg=$('hGen');if(hg)hg.textContent=g[0].toUpperCase();
  S.tun=(g[1]-MIN)/SPAN;setDec(dec);
  const dateStr=y+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0');

  // Remember committed selection for Escape key cancellation
  committedSelection = {
    date: new Date(D.getTime()),
    inputValue: dIn.value,
    genreIndex: gi,
    decade: dec,
    genre: g[0],
    frequency: g[1],
    dateStr: dateStr,
    hDateText: $('hDate').textContent,
    hGenText: g[0].toUpperCase(),
    tun: S.tun
  };

  // Requirement 1: When the green display is active, Artist Name and Song Title must be the default display
  songDisplayMode = 'song_info';
  renderSong();

  emit('select',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});
  sendBoomBoxAction('SELECT_DATE_GENRE',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});
}

function cancelToLive(){
  if (!committedSelection) return false;
  resetStereoIndicator();
  // Restore committed date & genre
  D = new Date(committedSelection.date.getTime());
  dIn.value = committedSelection.inputValue || (MON[D.getMonth()]+' '+D.getDate()+', '+D.getFullYear());
  const dec = committedSelection.decade;
  gl = ST[dec] || [];
  gi = committedSelection.genreIndex >= 0 && committedSelection.genreIndex < gl.length ? committedSelection.genreIndex : 0;
  S.tun = committedSelection.tun;
  setDec(dec);
  if ($('hDate')) $('hDate').textContent = committedSelection.hDateText;
  const hg = $('hGen');
  if (hg) hg.textContent = committedSelection.hGenText;

  // Return to live display
  pan.classList.replace('entry', 'live');
  step = 'date';
  tune();
  renderSong();
  return true;
}

dIn.oninput=e=>{step='date';let v=dIn.value.replace(/[^A-Za-z0-9 ,\/\-]/g,'').replace(/^\s+/,'').replace(/\s{2,}/g,' ').replace(/,\s*,/g,', ');
 if(e.inputType&&e.inputType.startsWith('insert')){
  v=v.replace(/^([A-Za-z]+)(?=\d)/,'$1 ');
  const mm=v.match(/^([A-Za-z]+)(?=[\s\d.,\/\-])/);if(mm){const k=fixMonth(mm[1]);if(k>=0){const nm=MON[k][0]+MON[k].slice(1).toLowerCase();if(mm[1]!==nm)v=nm+v.slice(mm[1].length)}}
  if(/^[A-Za-z]+$/.test(v)&&MON.some(m=>m.toLowerCase()===v.toLowerCase()))v+=' ';
  else if(/^[A-Za-z]+\s\d$/.test(v)&&+v.slice(-1)>3)v+=', ';
  else if(/^[A-Za-z]+\s[123]\d$/.test(v)&&+v.slice(-2)<=31)v+=', '}
 if(v!==dIn.value)dIn.value=v;refresh(!!(e.inputType&&e.inputType.startsWith('delete')))};
document.addEventListener('keydown',e=>{if(!pan.classList.contains('entry')||e.ctrlKey||e.metaKey||e.altKey)return;
 if(e.key==='Tab'){e.preventDefault();if(step==='genre'){step='date';refresh();dIn.focus()}else if(D){step='genre';refresh()}else{hint.textContent='Enter a date from 1960 to today';hint.className='err'}}
 else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();if(step==='genre')cyc(e.key==='ArrowUp'?-1:1)}
 else if(e.key==='Enter'){e.preventDefault();if(!D){hint.textContent='Enter a date from 1960 to today';hint.className='err'}else if(step==='date'){step='genre';refresh()}else goLive()}
 else if(e.key==='Escape'){
   e.preventDefault();
   // If we have a committed selection from an active live session, Escape cancels draft edits and returns to live
   if(committedSelection){
     cancelToLive();
   }else if(step==='genre'){
     step='date';refresh();
   }else if(dIn.value){
     dIn.value='';refresh(true);
   }
 }
 else if((e.key.length===1||e.key==='Backspace'||e.key==='Delete')&&document.activeElement!==dIn){step='date';dIn.focus()}});
const endCaret=()=>{const n=dIn.value.length;try{dIn.setSelectionRange(n,n)}catch(e){}};
dIn.onfocus=()=>{brd.classList.add('foc');endCaret()};dIn.onblur=()=>brd.classList.remove('foc');
dIn.addEventListener('keydown',e=>{if(!e.metaKey&&!e.ctrlKey&&dIn.selectionStart===dIn.selectionEnd)endCaret()});
dIn.addEventListener('mouseup',()=>setTimeout(endCaret,0));
fG.onclick=()=>{if(D){if(step==='genre')cyc(1);else{step='genre';refresh()}}else{hint.textContent='Enter a date first';hint.className='err'}dIn.focus()};
dIn.onclick=()=>{if(step==='genre'){step='date';refresh()}};
$('bDate').onclick=()=>{step='date';refresh();dIn.focus()};
$('bGen').onclick=()=>{if(D){step='genre';refresh()}dIn.focus()};
const back=s=>{
  hasActiveSignalPlayback = false;
  resetStereoIndicator();
  pan.classList.replace('live','entry');
  step=s;
  emit('update',{});
  refresh();
  dIn.focus();
};
$('hDate').onclick=()=>back('date');if($('hGen'))$('hGen').onclick=()=>back('genre');
tune();refresh();dIn.focus();

// VU meters (driven by real-time audio analysis from YouTube tab via Web Audio API)
let nl = 0, nr = 0, vuRunning = false;
let latestAudioLeft = 0, latestAudioRight = 0, lastAudioUpdateTime = 0;

function onVuAudioLevelsReceived(payload) {
  if (!payload) return;
  const rawL = typeof payload.l === 'number' && isFinite(payload.l) ? payload.l : 0;
  const rawR = typeof payload.r === 'number' && isFinite(payload.r) ? payload.r : 0;
  latestAudioLeft = Math.max(0, Math.min(2, rawL));
  latestAudioRight = Math.max(0, Math.min(2, rawR));
  lastAudioUpdateTime = Date.now();
  if (!vuRunning) {
    vuRunning = true;
    requestAnimationFrame(vu);
  }
}

// Convert RMS amplitude to vintage analog VU needle deflection (0..1)
function mapRmsToVuDeflection(rms) {
  if (typeof rms !== 'number' || isNaN(rms) || rms <= 0.0015) {
    return 0;
  }
  // Vintage analog receiver VU meter calibration:
  // Normalizes decibels to the full physical sweep of the meter:
  // -38 dBFS (very quiet music) maps to lower deflection (~0.05)
  // -24 to -18 dBFS (typical verse / energetic music) maps to mid-scale (~0.45 - 0.62)
  // -14 dBFS (loud chorus / drum hits) reaches ~0.76 (threshold of +0dB / red zone)
  // -10 to -6 dBFS (dense peaks / maximum crest) sweeps through upper red zone (0.88 - 1.0)
  // True digital silence / noise floor (< 0.0015 RMS) reliably returns to absolute 0
  const db = 20 * Math.log10(rms);
  const minDb = -38;
  const maxDb = -6.5;
  if (db <= minDb) return 0;
  if (db >= maxDb) return 1;
  return (db - minDb) / (maxDb - minDb);
}

function vu(){
 const isPlaying = S.state === 'playing' && isYtPlaybackActive;
 const now = Date.now();
 const isDataStale = (now - lastAudioUpdateTime) > 350;

 let targetL = 0;
 let targetR = 0;

 if (isPlaying && !isDataStale) {
   targetL = mapRmsToVuDeflection(latestAudioLeft);
   targetR = mapRmsToVuDeflection(latestAudioRight);
 }

 // Vintage analog VU ballistics:
 // Fast attack (~30-40ms) when signal rises to capture transients, musical beats, and drum hits
 // Smooth, natural mechanical inertia decay (~160-200ms) when signal falls
 nl += (targetL - nl) * (targetL > nl ? 0.38 : 0.12);
 nr += (targetR - nr) * (targetR > nr ? 0.38 : 0.12);

 aim('nl', 833, nl);
 aim('nr', 957, nr);

 // Stop RAF loop once needles have settled back to absolute zero if not playing or silent
 if(isPlaying && !isDataStale || nl > 0.002 || nr > 0.002){
  vuRunning = true;
  requestAnimationFrame(vu);
 } else {
  nl = 0; nr = 0;
  aim('nl', 833, 0);
  aim('nr', 957, 0);
  vuRunning = false;
 }
}
function aim(id,px,l){const a=(-47+clamp(l)*94)*Math.PI/180,n=$(id);n.setAttribute('x2',px+Math.sin(a)*58);n.setAttribute('y2',352-Math.cos(a)*58)}
vuRunning = true;
requestAnimationFrame(vu);

$('copy').onclick=e=>e.stopPropagation();

// --- Chrome Extension Integration Bridge ---
function setVisualVolume(fraction) {
  if (typeof fraction !== 'number' || isNaN(fraction)) return;
  S.vol = clamp(fraction);
  staticController.setVolume(S.vol);
  $('kVol').style.transform = 'rotate(' + (-140 + S.vol * 280 - (-163)) + 'deg)';
}

function setVisualBalance(balance) {
  if (typeof balance !== 'number' || isNaN(balance)) return;
  if (isBalanceDrag || (Date.now() - lastUserBalanceTime < 400)) return;
  const clampedBal = Math.max(-1, Math.min(1, balance));
  S.bal = clamp((clampedBal + 1) / 2);
  const el = $('kBal');
  if (el) {
    el.style.transform = 'rotate(' + (-135 + S.bal * 270 - 10) + 'deg)';
    el.setAttribute('aria-valuenow', String(Number(clampedBal.toFixed(2))));
  }
}

function setVisualTransport(incomingState) {
  if (incomingState !== 'playing' && incomingState !== 'paused' && incomingState !== 'stopped') return;

  const prevState = S.state;

  // If user clicked a transport button recently, allow up to ~1.5s for app/YouTube to synchronize
  if (lastUserTransportAction) {
    const elapsed = Date.now() - lastUserTransportAction.time;
    if (incomingState === lastUserTransportAction.state) {
      // Dispatched state agrees with user action: clear guard
      lastUserTransportAction = null;
      if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
      const changed = S.state !== incomingState;
      setState(incomingState, true);
      trace('RECONCILE_AGREED', { incomingState, prevState, changedUI: changed, elapsed });
      return;
    }

    if (elapsed < 1500) {
      // Incoming state still disagrees and within the 1.5s window: retain local state and schedule correction if still disagreeing after timeout
      trace('RECONCILE_DEFERRED', { incomingState, pendingUserAction: lastUserTransportAction.state, elapsed });
      if (!transportReconcileTimer) {
        const remaining = Math.max(50, 1500 - elapsed);
        transportReconcileTimer = setTimeout(() => {
          transportReconcileTimer = null;
          lastUserTransportAction = null;
          const changed = S.state !== incomingState;
          setState(incomingState, true);
          trace('RECONCILE_TIMEOUT_CORRECTED', { incomingState, prevState: S.state, changedUI: changed });
        }, remaining);
      }
      return;
    }

    // Window exceeded (>1.5s): reconcile to incoming authoritative state
    lastUserTransportAction = null;
    if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  }

  const changed = S.state !== incomingState;
  setState(incomingState, true);
  trace('APPLY_TRANSPORT_STATE', { incomingState, prevState, changedUI: changed });
}

let pendingTuneData = null;
let tuneActionTimer = null;

function flushPendingTune() {
  if (tuneActionTimer) {
    clearTimeout(tuneActionTimer);
    tuneActionTimer = null;
  }
  if (pendingTuneData) {
    const data = pendingTuneData;
    pendingTuneData = null;
    rawSendBoomBoxAction('TUNE', data);
  }
}

function rawSendBoomBoxAction(action, data) {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'BOOMBOX_ACTION',
        payload: { action, ...(data || {}) }
      }, () => {
        if (chrome.runtime?.lastError) {
          // Extension service worker might be waking up or app disconnected
        }
      });
    }
  } catch (err) {
    console.warn('[BoomBox] Action send error:', err);
  }
}

function sendBoomBoxAction(action, data) {
  if (action === 'TUNE' && isTuningDrag) {
    pendingTuneData = data;
    if (tuneActionTimer) clearTimeout(tuneActionTimer);
    tuneActionTimer = setTimeout(() => {
      tuneActionTimer = null;
      flushPendingTune();
    }, 120);
    return;
  }
  if (action === 'TUNE') {
    if (tuneActionTimer) {
      clearTimeout(tuneActionTimer);
      tuneActionTimer = null;
    }
    pendingTuneData = null;
  }
  rawSendBoomBoxAction(action, data);
}

function applyRadioState(state) {
  if (!state || typeof state !== 'object') return;
  appConnected = state.appConnected !== false;

  if (!appConnected) {
    hasActiveSignalPlayback = false;
    resetStereoIndicator();
    updateStatusDisplay();
    const giEl = $('gi'); if (giEl) giEl.textContent = 'Open RetroFM app to broadcast';
    song = null;
    renderSong();
    return;
  }

  // Authoritative decade update for footer logo
  if (typeof state.decade === 'number' && state.decade >= 1960 && state.decade <= 2020) {
    if ((logoDec !== state.decade || S.dec !== state.decade) && !isYtPlaybackActive) {
      logoDec = state.decade;
      S.dec = state.decade;
      document.querySelectorAll('.dec').forEach(b => b.classList.toggle('sel', +b.textContent === state.decade));
      paintLogo();
    }
  }

  // Authoritative tracking of startup readiness (YouTube tab loaded first video)
  if (state.isStartupReady || (state.videoId && state.videoId !== 'Unknown' && state.videoId !== 'Unknown Video')) {
    isStartupReady = true;
    markStartupReady();
  }

  // Authoritative tracking of first song playback status suppression
  if (typeof state.hasFirstSongStartedPlaying === 'boolean') {
    hasFirstSongStartedPlaying = state.hasFirstSongStartedPlaying;
  }

  // Dynamic station definitions
  if (Array.isArray(state.stations) && state.stations.length > 0) {
    const normalized = state.stations.map(s => {
      if (Array.isArray(s)) return s;
      return [s.genre || s.name, typeof s.frequency === 'number' ? s.frequency : s.freq];
    });
    const targetDec = typeof state.decade === 'number' ? state.decade : S.dec;
    const currentStations = ST[targetDec] || [];
    const hasStationsChanged = currentStations.length !== normalized.length ||
      normalized.some((s, idx) => !currentStations[idx] || currentStations[idx][0] !== s[0] || Math.abs(currentStations[idx][1] - s[1]) > 0.01);

    if (hasStationsChanged) {
      ST[targetDec] = normalized;
      ST[S.dec] = normalized;
      paintChips(targetDec);
      marks();
      if (gl === currentStations || (D && Math.floor(D.getFullYear() / 10) * 10 === targetDec)) {
        gl = ST[targetDec];
        if (gi >= gl.length) gi = 0;
        if (gl[gi]) flap(fG, gl[gi][0]);
      }
    } else {
      updateGenrePills();
    }
  }

  // Align dial frequency to active genre if needed
  if (state.genre && !hasInitializedDial) {
    const stations = ST[S.dec] || [];
    const matched = stations.find(s => s[0] === state.genre);
    if (matched) {
      const curF = Math.round((MIN + S.tun * SPAN) * 10) / 10;
      if (Math.abs(curF - matched[1]) > 0.15) {
        S.tun = (matched[1] - MIN) / SPAN;
        tune();
      }
      hasInitializedDial = true;
    }
  }

  // Authoritative date & genre tracking for committedSelection
  if (state.date && typeof state.date === 'string') {
    const parsedD = parseDate(state.date);
    if (parsedD) {
      const y = parsedD.getFullYear();
      const dec = typeof state.decade === 'number' ? state.decade : Math.floor(y / 10) * 10;
      const gName = state.genre || (gl[gi] ? gl[gi][0] : '');
      const stations = ST[dec] || [];
      const gIdx = stations.findIndex(s => s[0] === gName);
      const matchedSt = gIdx >= 0 ? stations[gIdx] : null;

      if (!committedSelection) {
        committedSelection = {
          date: parsedD,
          inputValue: MON[parsedD.getMonth()] + ' ' + parsedD.getDate() + ', ' + y,
          genreIndex: gIdx >= 0 ? gIdx : 0,
          decade: dec,
          genre: gName,
          frequency: matchedSt ? matchedSt[1] : 88.1,
          dateStr: state.date,
          hDateText: MON[parsedD.getMonth()] + ' ' + parsedD.getDate() + ', ' + y,
          hGenText: gName.toUpperCase(),
          tun: matchedSt ? (matchedSt[1] - MIN) / SPAN : S.tun
        };
      }
    }
  }

  const stations = ST[S.dec] || [];
  const f = Math.round((MIN + S.tun * SPAN) * 10) / 10;
  let matchedStation = null;
  stations.forEach(s => {
    if (Math.abs(s[1] - f) < 0.05) matchedStation = s;
  });
  const activeDialGenre = matchedStation ? matchedStation[0] : null;
  const isMismatchedGenre = state.genre && activeDialGenre && state.genre !== activeDialGenre;

  // 1. Playback status
  if (state.playbackStatus) {
    if (state.playbackStatus === 'blank') {
      setSeekingState(false);
      if (!lastUserTransportAction || lastUserTransportAction.state !== 'playing') {
        isYtPlaybackActive = false;
        setState('blank', true);
      }
      hasActiveSignalPlayback = false;
      resetStereoIndicator();
    } else if (state.playbackStatus === 'seek' || state.playbackStatus === 'seeking') {
      isYtPlaybackActive = false;
      setSeekingState(true);
    } else if (!isMismatchedGenre) {
      isYtPlaybackActive = state.playbackStatus === 'playing';
      if (state.playbackStatus === 'playing') {
        if (typeof state.hasFirstSongStartedPlaying !== 'boolean') {
          hasFirstSongStartedPlaying = true;
        }
        hasActiveSignalPlayback = true;
        setSeekingState(false);
        playbackEnabled = true;
      } else if (state.playbackStatus === 'stopped') {
        setSeekingState(false);
        playbackEnabled = false;
        hasActiveSignalPlayback = false;
        staticController.stop();
        resetStereoIndicator();
      } else if (state.playbackStatus === 'paused') {
        if (!stereoLockedKey) {
          hasActiveSignalPlayback = false;
          resetStereoIndicator();
        } else {
          syncStereoIndicator();
        }
        if (!isSeeking) {
          setVisualTransport('paused');
        }
        if (typeof state.masterVolume === 'number') {
          setVisualVolume(state.masterVolume / 100);
        }
        if (typeof state.balance === 'number') {
          setVisualBalance(state.balance);
        }
        return;
      }
      setVisualTransport(state.playbackStatus);
      syncStereoIndicator();
    }
  }

  // 2. Volume & Balance (visual only, no command feedback loop)
  if (typeof state.masterVolume === 'number') {
    setVisualVolume(state.masterVolume / 100);
  }
  if (typeof state.balance === 'number') {
    setVisualBalance(state.balance);
  }

  // 3. Current Song
  if (state.clearSong) {
    song = null;
    clearSongTimers();
    renderSong();
  } else if (state.playbackStatus === 'seek' || state.playbackStatus === 'seeking' || isSeeking) {
    song = null;
    clearSongTimers();
    renderSong();
  } else if (state.currentSong && state.currentSong.title) {
    const activeDialGenre = matchedStation ? matchedStation[0] : null;
    const isMismatchedGenre = state.genre && activeDialGenre && state.genre !== activeDialGenre;
    if (!isMismatchedGenre) {
      if (state.currentSong.videoId && state.currentSong.videoId !== playbackProgress.videoId) {
        playbackProgress.videoId = state.currentSong.videoId;
        playbackProgress.currentTime = typeof state.currentSong.currentTime === 'number' ? state.currentSong.currentTime : 0;
      } else if (typeof state.currentSong.currentTime === 'number' && state.currentSong.currentTime > 0) {
        playbackProgress.currentTime = state.currentSong.currentTime;
      }
      if (typeof state.currentSong.durationSec === 'number' && state.currentSong.durationSec > 0) {
        playbackProgress.duration = state.currentSong.durationSec;
      } else if (typeof state.currentSong.duration === 'string') {
        const parts = state.currentSong.duration.split(':').map(Number);
        if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          playbackProgress.duration = parts[0] * 60 + parts[1];
        } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
          playbackProgress.duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }
      setSong(state.currentSong);
    }
  } else if (!song) {
    renderSong();
  }
}

function requestRadioState() {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_RADIO_STATE' }, (response) => {
        if (!chrome.runtime?.lastError && response?.success && response?.data) {
          applyRadioState(response.data);
        } else {
          appConnected = false;
          updateStatusDisplay();
          const giEl = $('gi'); if (giEl) giEl.textContent = 'Open RetroFM app to broadcast';
          renderSong();
        }
      });
    }
  } catch (e) {}
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'VU_AUDIO_LEVELS' && message.payload) {
      onVuAudioLevelsReceived(message.payload);
      sendResponse({ received: true });
    } else if (message && message.type === 'RADIO_STATE') {
      applyRadioState(message.payload);
      sendResponse({ received: true });
    } else if (message && message.type === 'YT_READY') {
      isStartupReady = true;
      markStartupReady();
      sendResponse({ received: true });
    } else if (message && message.type === 'YT_STATE_CHANGED' && message.payload) {
      if (message.payload.isStartupReady) {
        isStartupReady = true;
        markStartupReady();
      }
      const rawState = message.payload.state;
      const isPlaying = rawState === 1;
      const vid = message.payload.videoId;
      const isJingle = vid === '3Wk2FzsxK4k' || !hasFirstSongStartedPlaying;
      if (vid) {
        isStartupReady = true;
        markStartupReady();
      }
      if (rawState === 1 && vid && vid !== '3Wk2FzsxK4k') {
        hasFirstSongStartedPlaying = true;
      } else if (rawState === 1 && !vid && pan.classList.contains('live')) {
        hasFirstSongStartedPlaying = true;
      }
      if (rawState === 1) {
        if (vid !== '3Wk2FzsxK4k') {
          isYtPlaybackActive = true;
          hasActiveSignalPlayback = true;
        }
        playbackEnabled = true;
        setSeekingState(false);
        setVisualTransport('playing');
        syncStereoIndicator();
      } else if (rawState === 2) {
        if (!isSeeking) {
          setVisualTransport('paused');
        }
      } else if (rawState === 0) {
        if (!isJingle) {
          setSeekingState(true);
        } else {
          setSeekingState(false);
        }
      }
      if (rawState === 2 || rawState === 0) {
        isYtPlaybackActive = false;
        if (isJingle) {
          hasActiveSignalPlayback = false;
          resetStereoIndicator();
        } else {
          syncStereoIndicator();
        }
      }
      if (rawState === 0) {
        // When startup jingle ends naturally, stop playback and reels until user clicks PLAY
        if (isJingle) {
          isYtPlaybackActive = false;
          setVisualTransport('stopped');
        } else if (S.state !== 'playing') {
          setVisualTransport('stopped');
        }
      }
      if (rawState === 0 && isJingle) {
        playbackEnabled = false;
      } else if (rawState === 3) {
        // Buffering / loading
        isYtPlaybackActive = false;
        setSeekingState(true);
      }

      // Update actual playback progress from YouTube
      if (vid && vid !== playbackProgress.videoId) {
        playbackProgress.videoId = vid;
        playbackProgress.currentTime = 0;
      }
      if (typeof message.payload.currentTime === 'number') {
        playbackProgress.currentTime = message.payload.currentTime;
      }
      if (typeof message.payload.duration === 'number' && message.payload.duration > 0) {
        playbackProgress.duration = message.payload.duration;
      }

      trace('YT_STATE_CHANGED_RECV', { rawState, state: S.state, title: message.payload.title });
      if (songDisplayMode === 'elapsed_time') {
        const curFmt = formatPlaybackTime(playbackProgress.currentTime) || '00:00';
        const durFmt = formatPlaybackTime(playbackProgress.duration);
        const targetText = durFmt ? `${curFmt} / ${durFmt}` : curFmt;
        const el = $('sg');
        if (el && el.textContent !== targetText) {
          el.textContent = targetText;
          el.title = 'Elapsed playback time: ' + targetText;
        }
      } else if (!song && message.payload.title && hasFirstSongStartedPlaying) {
        setSong({ title: message.payload.title });
      }
      sendResponse({ received: true });
    } else if (message && message.type === 'PLAY_DJ_SPEECH') {
      playBoomBoxDjSpeech(message.payload);
      sendResponse({ success: true, started: true });
    }
  });
}

// Request initial state on load and announce Boom Box session startup / refresh
sendBoomBoxAction('BOOMBOX_RELOADED');
requestRadioState();
// Check health every 6 seconds if disconnected
setInterval(() => {
  if (!appConnected) {
    requestRadioState();
  }
}, 6000);

// Bounded polling while waiting for startup readiness (polls every 1.5s until YouTube is ready)
const startupReadyInterval = setInterval(() => {
  if (isStartupReady) {
    clearInterval(startupReadyInterval);
    return;
  }
  requestRadioState();
}, 1500);

function markStartupReady() {
  isStartupReady = true;
  if (typeof startupReadyInterval !== 'undefined' && startupReadyInterval) {
    clearInterval(startupReadyInterval);
  }
  const modal = $('rfmModal');
  const btn = $('rfmStartBtn');
  if (modal && btn) {
    if (modal.classList.contains('hidden')) return;
    const box = modal.firstElementChild;
    if (box) box.classList.add('ready');
    btn.classList.add('ready');
    if (btn.textContent !== 'STARTING...') {
      btn.disabled = false;
    }
    trace('START_RETRO_FM_READY');
  }
}

// START RETRO FM modal & handoff controller
(function setupStartModal() {
  const modal = $('rfmModal');
  const btn = $('rfmStartBtn');
  const appEl = $('app');
  if (!modal || !btn) return;

  let handoffStarted = false;

  // The button starts disabled and visually black (powered off) until YouTube is ready
  if (isStartupReady) {
    markStartupReady();
  } else {
    btn.disabled = true;
  }

  function dismissModal() {
    modal.classList.add('hidden');
    if (appEl) appEl.classList.remove('rfm-dimmed');
  }

  btn.addEventListener('click', async () => {
    if (!isStartupReady || btn.disabled || handoffStarted) return;
    handoffStarted = true;
    playbackEnabled = true;
    btn.disabled = true;
    btn.textContent = 'STARTING...';
    trace('START_RETRO_FM_CLICKED');

    let finished = false;
    const safetyTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        dismissModal();
      }
    }, 3000);

    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'START_RETRO_FM_HANDOFF' }, (res) => {
          if (!finished) {
            finished = true;
            clearTimeout(safetyTimer);
            dismissModal();
          }
        });
      } else {
        finished = true;
        clearTimeout(safetyTimer);
        dismissModal();
      }
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(safetyTimer);
        dismissModal();
      }
    }
  });
})();





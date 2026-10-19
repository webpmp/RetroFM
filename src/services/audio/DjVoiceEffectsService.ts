/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export interface DjVoiceEffectsSettings {
  reverbEnabled: boolean;
  reverbWetMix: number; // 0.0 to 1.0 (default: 0.30)
  amRadioEnabled: boolean;
  fmSparkleEnabled: boolean;
  fmSparkleBoost: number; // dB (default: +6)
  saturationEnabled: boolean;
  saturationDrive: number; // 1 to 50 (default: 15)
  // Audio Compression
  compressionEnabled: boolean;
  compressionThreshold: number; // -60 to 0 dB (default: -24)
  compressionRatio: number; // 1 to 12 (default: 3)
  compressionAttack: number; // 0.001 to 0.100 sec (default: 0.010 = 10ms)
  compressionRelease: number; // 0.020 to 1.000 sec (default: 0.150 = 150ms)
  compressionKnee: number; // 0 to 30 dB (default: 12)
  compressionMakeupGain: number; // 0 to 12 dB (default: +3)
}

export const DEFAULT_DJ_EFFECTS_SETTINGS: DjVoiceEffectsSettings = {
  reverbEnabled: false,
  reverbWetMix: 0.30,
  amRadioEnabled: false,
  fmSparkleEnabled: false,
  fmSparkleBoost: 6,
  saturationEnabled: false,
  saturationDrive: 15,
  compressionEnabled: false,
  compressionThreshold: -24,
  compressionRatio: 3,
  compressionAttack: 0.010,
  compressionRelease: 0.150,
  compressionKnee: 12,
  compressionMakeupGain: 3,
};

const STORAGE_KEY = 'retrofm_dj_effects';

/**
 * Validate and sanitize effects settings, falling back to safe defaults for invalid/missing values.
 */
export function sanitizeDjEffectsSettings(input: any): DjVoiceEffectsSettings {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_DJ_EFFECTS_SETTINGS };
  }

  const reverbEnabled = Boolean(input.reverbEnabled);
  let reverbWetMix = Number(input.reverbWetMix);
  if (isNaN(reverbWetMix) || reverbWetMix < 0 || reverbWetMix > 1) {
    reverbWetMix = DEFAULT_DJ_EFFECTS_SETTINGS.reverbWetMix;
  }

  const amRadioEnabled = Boolean(input.amRadioEnabled);

  const fmSparkleEnabled = Boolean(input.fmSparkleEnabled);
  let fmSparkleBoost = Number(input.fmSparkleBoost);
  if (isNaN(fmSparkleBoost) || fmSparkleBoost < 0 || fmSparkleBoost > 15) {
    fmSparkleBoost = DEFAULT_DJ_EFFECTS_SETTINGS.fmSparkleBoost;
  }

  const saturationEnabled = Boolean(input.saturationEnabled);
  let saturationDrive = Number(input.saturationDrive);
  if (isNaN(saturationDrive) || saturationDrive < 1 || saturationDrive > 100) {
    saturationDrive = DEFAULT_DJ_EFFECTS_SETTINGS.saturationDrive;
  }

  const compressionEnabled = Boolean(input.compressionEnabled);

  let compressionThreshold = Number(input.compressionThreshold);
  if (isNaN(compressionThreshold) || compressionThreshold < -60 || compressionThreshold > 0) {
    compressionThreshold = DEFAULT_DJ_EFFECTS_SETTINGS.compressionThreshold;
  }

  let compressionRatio = Number(input.compressionRatio);
  if (isNaN(compressionRatio) || compressionRatio < 1 || compressionRatio > 12) {
    compressionRatio = DEFAULT_DJ_EFFECTS_SETTINGS.compressionRatio;
  }

  let compressionAttack = Number(input.compressionAttack);
  if (isNaN(compressionAttack) || compressionAttack < 0.001 || compressionAttack > 0.100) {
    compressionAttack = DEFAULT_DJ_EFFECTS_SETTINGS.compressionAttack;
  }

  let compressionRelease = Number(input.compressionRelease);
  if (isNaN(compressionRelease) || compressionRelease < 0.020 || compressionRelease > 1.000) {
    compressionRelease = DEFAULT_DJ_EFFECTS_SETTINGS.compressionRelease;
  }

  let compressionKnee = Number(input.compressionKnee);
  if (isNaN(compressionKnee) || compressionKnee < 0 || compressionKnee > 30) {
    compressionKnee = DEFAULT_DJ_EFFECTS_SETTINGS.compressionKnee;
  }

  let compressionMakeupGain = Number(input.compressionMakeupGain);
  if (isNaN(compressionMakeupGain) || compressionMakeupGain < 0 || compressionMakeupGain > 12) {
    compressionMakeupGain = DEFAULT_DJ_EFFECTS_SETTINGS.compressionMakeupGain;
  }

  return {
    reverbEnabled,
    reverbWetMix,
    amRadioEnabled,
    fmSparkleEnabled,
    fmSparkleBoost,
    saturationEnabled,
    saturationDrive,
    compressionEnabled,
    compressionThreshold,
    compressionRatio,
    compressionAttack,
    compressionRelease,
    compressionKnee,
    compressionMakeupGain,
  };
}

export function loadDjEffectsSettings(): DjVoiceEffectsSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_DJ_EFFECTS_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DJ_EFFECTS_SETTINGS };
    const parsed = JSON.parse(raw);
    return sanitizeDjEffectsSettings(parsed);
  } catch (err) {
    console.warn('[DjVoiceEffects] Failed to load settings from localStorage, using defaults.', err);
    return { ...DEFAULT_DJ_EFFECTS_SETTINGS };
  }
}

export function saveDjEffectsSettings(settings: DjVoiceEffectsSettings): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const sanitized = sanitizeDjEffectsSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.warn('[DjVoiceEffects] Failed to save settings to localStorage.', err);
  }
}

/**
 * Generate synthetic stereo impulse response for Reverb.
 * 2.5s duration, 1.2s exponential decay parameter.
 */
export function generateImpulseResponse(
  audioCtx: AudioContext,
  duration = 2.5,
  decay = 1.2
): AudioBuffer {
  const sampleRate = audioCtx.sampleRate || 44100;
  const length = Math.floor(sampleRate * duration);
  const buffer = audioCtx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // Exponential decay envelope
    const envelope = Math.exp(-t / decay);
    // Stereo decorrelated white noise
    left[i] = (Math.random() * 2 - 1) * envelope;
    right[i] = (Math.random() * 2 - 1) * envelope;
  }

  return buffer;
}

/**
 * Generate a numerically stable, smoothly bounded soft-clipping saturation curve.
 * Uses tanh shaping normalized by tanh(drive) to guarantee output is strictly bounded to [-1, 1]
 * with smooth harmonic coloration and no harsh digital clipping.
 */
export function generateSaturationCurve(drive: number, samples = 2048): Float32Array {
  const k = Math.max(1, drive);
  const curve = new Float32Array(samples);
  const normFactor = Math.tanh(k * 0.7);

  for (let i = 0; i < samples; i++) {
    // x ranges from -1 to 1
    const x = (i * 2) / (samples - 1) - 1;
    // Soft saturation with tanh compression
    curve[i] = Math.tanh(k * 0.7 * x) / normFactor;
  }

  return curve;
}

/**
 * Generate a neutral (linear) curve for the WaveShaperNode when disabled.
 */
export function generateNeutralCurve(samples = 256): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    curve[i] = (i * 2) / (samples - 1) - 1;
  }
  return curve;
}

/**
 * Dedicated DJ Voice Effects Service
 *
 * Audio Graph Topology:
 *
 *               +--> [ConvolverNode] --> [Reverb Wet Gain] --------------------------------------+
 *               |                                                                                |
 * [Input Node] -+                                                                                +--> [Master Output Gain] --> [Destination]
 *               |                                                                                |
 *               +--> [AM Highpass] --> [AM Lowpass] --> [FM Sparkle EQ] --> [WaveShaper]         |
 *                                                                               |                |
 *                                                                        [Compressor]            |
 *                                                                               |                |
 *                                                                        [Makeup Gain] ----------+
 */
export class DjVoiceEffectsService {
  private static instance: DjVoiceEffectsService | null = null;

  private audioCtx: AudioContext | null = null;
  private settings: DjVoiceEffectsSettings;

  // Node cache for HTMLAudioElements to prevent duplicate MediaElementAudioSourceNode creation
  private mediaSourceMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

  // Graph nodes
  private inputGain: GainNode | null = null;
  private amHighpass: BiquadFilterNode | null = null;
  private amLowpass: BiquadFilterNode | null = null;
  private fmSparkle: BiquadFilterNode | null = null;
  private waveshaper: WaveShaperNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private makeupGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbWetGain: GainNode | null = null;
  private masterOutput: GainNode | null = null;

  // Keep-alive source to prevent browser from suspending AudioContext in background tabs
  private keepAliveSource: AudioBufferSourceNode | null = null;
  private keepAliveGain: GainNode | null = null;

  // Cached curves & impulse buffer
  private impulseBuffer: AudioBuffer | null = null;
  private saturationCurve: Float32Array | null = null;
  private neutralCurve: Float32Array | null = null;

  private isGraphInitialized = false;

  constructor() {
    this.settings = loadDjEffectsSettings();
  }

  public static getInstance(): DjVoiceEffectsService {
    if (!DjVoiceEffectsService.instance) {
      DjVoiceEffectsService.instance = new DjVoiceEffectsService();
    }
    return DjVoiceEffectsService.instance;
  }

  /**
   * Return current settings snapshot.
   */
  public getSettings(): DjVoiceEffectsSettings {
    return { ...this.settings };
  }

  /**
   * Return the underlying AudioContext instance if initialized.
   */
  public getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  /**
   * Start a silent looping buffer source into destination to keep AudioContext
   * running in the background when the RetroFM tab is not focused.
   */
  private startKeepAlive(): void {
    if (!this.audioCtx || this.keepAliveSource) return;
    try {
      if (typeof this.audioCtx.createBufferSource !== 'function') return;
      const silentBuffer = this.audioCtx.createBuffer(1, 1, this.audioCtx.sampleRate || 44100);
      const source = this.audioCtx.createBufferSource();
      source.buffer = silentBuffer;
      source.loop = true;

      this.keepAliveGain = this.audioCtx.createGain();
      this.keepAliveGain.gain.setValueAtTime(0.000001, this.audioCtx.currentTime);

      source.connect(this.keepAliveGain);
      this.keepAliveGain.connect(this.audioCtx.destination);
      source.start();
      this.keepAliveSource = source;
    } catch (e) {
      console.warn('[DjVoiceEffects] Could not start audio keep-alive:', e);
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveSource) {
      try {
        this.keepAliveSource.stop();
        this.keepAliveSource.disconnect();
      } catch (e) {}
      this.keepAliveSource = null;
    }
    if (this.keepAliveGain) {
      try {
        this.keepAliveGain.disconnect();
      } catch (e) {}
      this.keepAliveGain = null;
    }
  }

  /**
   * Lazily initialize the AudioContext and processing graph.
   * Safe to call multiple times; idempotent.
   */
  public async ensureInitialized(): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('[DjVoiceEffects] Web Audio API is not supported in this browser.');
        return false;
      }

      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }

      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
        } catch (e) {
          console.warn('[DjVoiceEffects] Could not resume suspended AudioContext:', e);
        }
      }

      if (this.audioCtx.state === 'running') {
        this.startKeepAlive();
      }

      if (!this.isGraphInitialized) {
        this.buildGraph();
      }

      return true;
    } catch (err) {
      console.error('[DjVoiceEffects] Error during initialization:', err);
      return false;
    }
  }

  /**
   * Construct the Web Audio processing graph once.
   */
  private buildGraph(): void {
    if (!this.audioCtx) return;

    try {
      const ctx = this.audioCtx;

      // 1. Common Input Node
      this.inputGain = ctx.createGain();
      this.inputGain.gain.setValueAtTime(1.0, ctx.currentTime);

      // 2. AM Radio Bandwidth Filters
      // Highpass (20Hz neutral/disabled, 250Hz enabled)
      this.amHighpass = ctx.createBiquadFilter();
      this.amHighpass.type = 'highpass';
      const initialHpFreq = this.settings.amRadioEnabled ? 250 : 20;
      this.amHighpass.frequency.setValueAtTime(initialHpFreq, ctx.currentTime);

      // Lowpass (20,000Hz neutral/disabled, 3000Hz enabled)
      this.amLowpass = ctx.createBiquadFilter();
      this.amLowpass.type = 'lowpass';
      const nyquist = ctx.sampleRate ? ctx.sampleRate / 2 : 22050;
      const initialLpFreq = this.settings.amRadioEnabled ? 3000 : Math.min(20000, nyquist - 50);
      this.amLowpass.frequency.setValueAtTime(initialLpFreq, ctx.currentTime);

      // 3. FM Sparkle EQ
      // Peaking filter (5,000 Hz, Q: 1.0, 0dB disabled, +6dB enabled)
      this.fmSparkle = ctx.createBiquadFilter();
      this.fmSparkle.type = 'peaking';
      this.fmSparkle.frequency.setValueAtTime(5000, ctx.currentTime);
      this.fmSparkle.Q.setValueAtTime(1.0, ctx.currentTime);
      const initialSparkleGain = this.settings.fmSparkleEnabled ? this.settings.fmSparkleBoost : 0;
      this.fmSparkle.gain.setValueAtTime(initialSparkleGain, ctx.currentTime);

      // 4. Analog Saturation WaveShaperNode
      this.waveshaper = ctx.createWaveShaper();
      this.waveshaper.oversample = '4x';
      this.neutralCurve = generateNeutralCurve();
      this.saturationCurve = generateSaturationCurve(this.settings.saturationDrive);

      this.waveshaper.curve = this.settings.saturationEnabled
        ? (this.saturationCurve as any)
        : (this.neutralCurve as any);

      // 5. DynamicsCompressorNode & Makeup Gain
      this.compressor = ctx.createDynamicsCompressor();
      this.makeupGain = ctx.createGain();

      if (this.settings.compressionEnabled) {
        this.compressor.threshold.setValueAtTime(this.settings.compressionThreshold, ctx.currentTime);
        this.compressor.ratio.setValueAtTime(this.settings.compressionRatio, ctx.currentTime);
        this.compressor.attack.setValueAtTime(this.settings.compressionAttack, ctx.currentTime);
        this.compressor.release.setValueAtTime(this.settings.compressionRelease, ctx.currentTime);
        this.compressor.knee.setValueAtTime(this.settings.compressionKnee, ctx.currentTime);
        const linearMakeup = Math.pow(10, this.settings.compressionMakeupGain / 20);
        this.makeupGain.gain.setValueAtTime(linearMakeup, ctx.currentTime);
      } else {
        // Disabled: neutral bypass settings (threshold 0dB, ratio 1:1, makeup gain 0dB = 1.0)
        this.compressor.threshold.setValueAtTime(0, ctx.currentTime);
        this.compressor.ratio.setValueAtTime(1, ctx.currentTime);
        this.compressor.attack.setValueAtTime(this.settings.compressionAttack, ctx.currentTime);
        this.compressor.release.setValueAtTime(this.settings.compressionRelease, ctx.currentTime);
        this.compressor.knee.setValueAtTime(this.settings.compressionKnee, ctx.currentTime);
        this.makeupGain.gain.setValueAtTime(1.0, ctx.currentTime);
      }

      // Dry path gain
      this.dryGain = ctx.createGain();
      this.dryGain.gain.setValueAtTime(1.0, ctx.currentTime);

      // 6. Reverb Parallel Path
      this.convolver = ctx.createConvolver();
      this.impulseBuffer = generateImpulseResponse(ctx, 2.5, 1.2);
      this.convolver.buffer = this.impulseBuffer;

      this.reverbWetGain = ctx.createGain();
      const initialWet = this.settings.reverbEnabled ? this.settings.reverbWetMix : 0.0;
      this.reverbWetGain.gain.setValueAtTime(initialWet, ctx.currentTime);

      // 7. Master Output Gain Stage
      this.masterOutput = ctx.createGain();
      this.masterOutput.gain.setValueAtTime(1.0, ctx.currentTime);

      // Connect Dry Processing Path:
      // inputGain -> amHighpass -> amLowpass -> fmSparkle -> waveshaper -> compressor -> makeupGain -> dryGain -> masterOutput
      this.inputGain.connect(this.amHighpass);
      this.amHighpass.connect(this.amLowpass);
      this.amLowpass.connect(this.fmSparkle);
      this.fmSparkle.connect(this.waveshaper);
      this.waveshaper.connect(this.compressor);
      this.compressor.connect(this.makeupGain);
      this.makeupGain.connect(this.dryGain);
      this.dryGain.connect(this.masterOutput);

      // Connect Wet Reverb Path:
      // inputGain -> convolver -> reverbWetGain -> masterOutput
      this.inputGain.connect(this.convolver);
      this.convolver.connect(this.reverbWetGain);
      this.reverbWetGain.connect(this.masterOutput);

      // Connect to Destination
      this.masterOutput.connect(ctx.destination);

      this.isGraphInitialized = true;
    } catch (err) {
      console.error('[DjVoiceEffects] Failed to build audio graph:', err);
    }
  }

  /**
   * Connect an HTMLAudioElement to the DJ Voice effects graph.
   * Safe against multiple calls on the same element.
   */
  public attachAudioElement(audio: HTMLAudioElement): boolean {
    if (!this.audioCtx || !this.inputGain) {
      this.buildGraph();
    }
    if (!this.audioCtx || !this.inputGain) return false;

    // Safety guard: only attach if AudioContext is running (or mock environment) to avoid locking element to suspended graph
    if (this.audioCtx.state === 'suspended') {
      try {
        this.audioCtx.resume().catch(() => {});
      } catch {}
      if (this.audioCtx.state === 'suspended') {
        console.warn('[DjVoiceEffects] AudioContext is suspended; skipping attach to prevent media element freeze.');
        return false;
      }
    }

    try {
      let sourceNode = this.mediaSourceMap.get(audio);
      if (!sourceNode) {
        sourceNode = this.audioCtx.createMediaElementSource(audio);
        this.mediaSourceMap.set(audio, sourceNode);
        sourceNode.connect(this.inputGain);
      }
      return true;
    } catch (err) {
      console.error('[DjVoiceEffects] Failed to attach HTMLAudioElement to effects graph:', err);
      return false;
    }
  }

  // --- Setting Updaters with Smooth Transitions ---

  public updateSettings(partial: Partial<DjVoiceEffectsSettings>): DjVoiceEffectsSettings {
    const updated = sanitizeDjEffectsSettings({
      ...this.settings,
      ...partial,
    });
    this.settings = updated;
    saveDjEffectsSettings(updated);

    this.applySettingsToGraph();
    return { ...this.settings };
  }

  private applySettingsToGraph(): void {
    if (!this.audioCtx || !this.isGraphInitialized) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    // 1. Reverb Wet Mix & Enable State
    if (this.reverbWetGain) {
      const targetWet = this.settings.reverbEnabled ? this.settings.reverbWetMix : 0.0;
      this.reverbWetGain.gain.cancelScheduledValues(now);
      this.reverbWetGain.gain.setTargetAtTime(targetWet, now, 0.03);
    }

    // 2. AM Radio Bandwidth (approx 80ms transition)
    const timeConstantAm = 0.08 / 3; // ~95% reached in 80ms
    if (this.amHighpass) {
      const targetHp = this.settings.amRadioEnabled ? 250 : 20;
      this.amHighpass.frequency.cancelScheduledValues(now);
      this.amHighpass.frequency.setTargetAtTime(targetHp, now, timeConstantAm);
    }
    if (this.amLowpass) {
      const nyquist = ctx.sampleRate ? ctx.sampleRate / 2 : 22050;
      const targetLp = this.settings.amRadioEnabled ? 3000 : Math.min(20000, nyquist - 50);
      this.amLowpass.frequency.cancelScheduledValues(now);
      this.amLowpass.frequency.setTargetAtTime(targetLp, now, timeConstantAm);
    }

    // 3. FM Sparkle (approx 50ms transition)
    const timeConstantFm = 0.05 / 3;
    if (this.fmSparkle) {
      const targetGain = this.settings.fmSparkleEnabled ? this.settings.fmSparkleBoost : 0;
      this.fmSparkle.gain.cancelScheduledValues(now);
      this.fmSparkle.gain.setTargetAtTime(targetGain, now, timeConstantFm);
    }

    // 4. Analog Saturation
    if (this.waveshaper) {
      if (this.settings.saturationEnabled) {
        this.saturationCurve = generateSaturationCurve(this.settings.saturationDrive);
        this.waveshaper.curve = this.saturationCurve as any;
      } else {
        if (!this.neutralCurve) this.neutralCurve = generateNeutralCurve();
        this.waveshaper.curve = this.neutralCurve as any;
      }
    }

    // 5. Audio Compression & Makeup Gain
    if (this.compressor && this.makeupGain) {
      const timeConstantComp = 0.03; // Smooth ~30ms transition to avoid clicks
      if (this.settings.compressionEnabled) {
        this.compressor.threshold.cancelScheduledValues(now);
        this.compressor.threshold.setTargetAtTime(this.settings.compressionThreshold, now, timeConstantComp);

        this.compressor.ratio.cancelScheduledValues(now);
        this.compressor.ratio.setTargetAtTime(this.settings.compressionRatio, now, timeConstantComp);

        this.compressor.attack.cancelScheduledValues(now);
        this.compressor.attack.setTargetAtTime(this.settings.compressionAttack, now, timeConstantComp);

        this.compressor.release.cancelScheduledValues(now);
        this.compressor.release.setTargetAtTime(this.settings.compressionRelease, now, timeConstantComp);

        this.compressor.knee.cancelScheduledValues(now);
        this.compressor.knee.setTargetAtTime(this.settings.compressionKnee, now, timeConstantComp);

        const targetMakeup = Math.pow(10, this.settings.compressionMakeupGain / 20);
        this.makeupGain.gain.cancelScheduledValues(now);
        this.makeupGain.gain.setTargetAtTime(targetMakeup, now, timeConstantComp);
      } else {
        // Disabled: neutral bypass (threshold 0dB, ratio 1:1, makeup 1.0 = 0dB)
        this.compressor.threshold.cancelScheduledValues(now);
        this.compressor.threshold.setTargetAtTime(0, now, timeConstantComp);

        this.compressor.ratio.cancelScheduledValues(now);
        this.compressor.ratio.setTargetAtTime(1, now, timeConstantComp);

        this.makeupGain.gain.cancelScheduledValues(now);
        this.makeupGain.gain.setTargetAtTime(1.0, now, timeConstantComp);
      }
    }
  }

  /**
   * Reset or disconnect all nodes cleanly.
   */
  public cleanup(): void {
    try {
      if (this.inputGain) {
        this.inputGain.disconnect();
      }
      if (this.amHighpass) {
        this.amHighpass.disconnect();
      }
      if (this.amLowpass) {
        this.amLowpass.disconnect();
      }
      if (this.fmSparkle) {
        this.fmSparkle.disconnect();
      }
      if (this.waveshaper) {
        this.waveshaper.disconnect();
      }
      if (this.compressor) {
        this.compressor.disconnect();
      }
      if (this.makeupGain) {
        this.makeupGain.disconnect();
      }
      if (this.dryGain) {
        this.dryGain.disconnect();
      }
      if (this.convolver) {
        this.convolver.disconnect();
      }
      if (this.reverbWetGain) {
        this.reverbWetGain.disconnect();
      }
      if (this.masterOutput) {
        this.masterOutput.disconnect();
      }
    } catch (e) {
      // Ignored
    } finally {
      this.stopKeepAlive();
      this.isGraphInitialized = false;
      this.inputGain = null;
      this.amHighpass = null;
      this.amLowpass = null;
      this.fmSparkle = null;
      this.waveshaper = null;
      this.compressor = null;
      this.makeupGain = null;
      this.dryGain = null;
      this.convolver = null;
      this.reverbWetGain = null;
      this.masterOutput = null;
    }
  }
}

export const djVoiceEffects = DjVoiceEffectsService.getInstance();

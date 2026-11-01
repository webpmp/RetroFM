/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import {
  DjVoiceEffectsService,
  DjVoiceEffectsSettings,
  DEFAULT_DJ_EFFECTS_SETTINGS,
  sanitizeDjEffectsSettings,
  generateImpulseResponse,
  generateSaturationCurve,
  generateNeutralCurve,
} from '../src/services/audio/DjVoiceEffectsService.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
    throw new Error(msg);
  } else {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  }
}

console.log('================================================================================');
console.log('RetroFM: DJ Voice Effects Test Suite');
console.log('================================================================================');

// --- Mock Web Audio API Environment for Node / Bun ---
class MockAudioParam {
  public value: number;
  public target: number | null = null;
  public timeConstant: number | null = null;

  constructor(initial: number) {
    this.value = initial;
  }

  setValueAtTime(val: number, _time: number) {
    this.value = val;
  }

  setTargetAtTime(target: number, _time: number, timeConstant: number) {
    this.target = target;
    this.timeConstant = timeConstant;
    this.value = target; // Simulate instantaneous convergence in unit tests
  }

  cancelScheduledValues(_time: number) {}
}

class MockAudioNode {
  public connectedTo: any[] = [];

  connect(target: any) {
    this.connectedTo.push(target);
    return target;
  }

  disconnect() {
    this.connectedTo = [];
  }
}

class MockGainNode extends MockAudioNode {
  public gain: MockAudioParam;
  constructor(initial = 1.0) {
    super();
    this.gain = new MockAudioParam(initial);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  public type: string = 'lowpass';
  public frequency: MockAudioParam;
  public Q: MockAudioParam;
  public gain: MockAudioParam;

  constructor() {
    super();
    this.frequency = new MockAudioParam(350);
    this.Q = new MockAudioParam(1);
    this.gain = new MockAudioParam(0);
  }
}

class MockWaveShaperNode extends MockAudioNode {
  public oversample: string = 'none';
  public curve: Float32Array | null = null;
}

class MockConvolverNode extends MockAudioNode {
  public buffer: any = null;
}

class MockDynamicsCompressorNode extends MockAudioNode {
  public threshold: MockAudioParam = new MockAudioParam(-24);
  public ratio: MockAudioParam = new MockAudioParam(3);
  public attack: MockAudioParam = new MockAudioParam(0.010);
  public release: MockAudioParam = new MockAudioParam(0.150);
  public knee: MockAudioParam = new MockAudioParam(12);
}

class MockAudioContext {
  public sampleRate: number = 44100;
  public currentTime: number = 0;
  public state: string = 'running';
  public destination: MockAudioNode = new MockAudioNode();
  public createdSourceNodes: any[] = [];

  createGain() {
    return new MockGainNode(1.0);
  }

  createBiquadFilter() {
    return new MockBiquadFilterNode();
  }

  createWaveShaper() {
    return new MockWaveShaperNode();
  }

  createConvolver() {
    return new MockConvolverNode();
  }

  createDynamicsCompressor() {
    return new MockDynamicsCompressorNode();
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (_channel: number) => new Float32Array(length),
    };
  }

  createMediaElementSource(audio: any) {
    const node = new MockAudioNode();
    (node as any).mediaElement = audio;
    this.createdSourceNodes.push(node);
    return node as any;
  }

  createBufferSource() {
    const node = new MockAudioNode();
    (node as any).start = () => {};
    (node as any).stop = () => {};
    (node as any).loop = false;
    (node as any).buffer = null;
    return node as any;
  }

  async resume() {
    this.state = 'running';
  }
}

// Setup global window mock
(globalThis as any).window = {
  AudioContext: MockAudioContext,
  localStorage: {
    store: {} as Record<string, string>,
    getItem(k: string) {
      return this.store[k] || null;
    },
    setItem(k: string, v: string) {
      this.store[k] = v;
    },
    removeItem(k: string) {
      delete this.store[k];
    },
    clear() {
      this.store = {};
    },
  },
};

// --- Test 1: All effects default to disabled ---
console.log('\n--- Test 1: Default Settings ---');
{
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.reverbEnabled === false, 'Reverb defaults to disabled');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.reverbWetMix === 0.30, 'Reverb wet mix defaults to 0.30');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.amRadioEnabled === false, 'AM Radio defaults to disabled');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.fmSparkleEnabled === false, 'FM Sparkle defaults to disabled');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.fmSparkleBoost === 6, 'FM Sparkle boost defaults to +6 dB');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.saturationEnabled === false, 'Analog Saturation defaults to disabled');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.saturationDrive === 15, 'Saturation drive defaults to 15');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionEnabled === false, 'Audio Compression defaults to disabled');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionThreshold === -24, 'Threshold defaults to -24 dB');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionRatio === 3, 'Ratio defaults to 3:1');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionAttack === 0.010, 'Attack defaults to 10 ms');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionRelease === 0.150, 'Release defaults to 150 ms');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionKnee === 12, 'Knee defaults to 12 dB');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.compressionMakeupGain === 3, 'Makeup gain defaults to +3 dB');
  assert(DEFAULT_DJ_EFFECTS_SETTINGS.voiceVolume === 0.50, 'DJ voice volume defaults to 0.50 (50%)');
}

// --- Test 2: Sanitization & Out-of-Range Handling ---
console.log('\n--- Test 2: Sanitization and Resilience ---');
{
  const invalidSettings = {
    reverbEnabled: 'yes',
    reverbWetMix: 5.5, // out of range [0, 1]
    amRadioEnabled: 1,
    fmSparkleEnabled: true,
    fmSparkleBoost: 999, // out of range [0, 15]
    saturationEnabled: true,
    saturationDrive: -10, // out of range [1, 100]
    compressionEnabled: 'true',
    compressionThreshold: -100, // out of range [-60, 0]
    compressionRatio: 25, // out of range [1, 12]
    compressionAttack: 0.5, // out of range [0.001, 0.100]
    compressionRelease: 5.0, // out of range [0.020, 1.000]
    compressionKnee: 50, // out of range [0, 30]
    compressionMakeupGain: 20, // out of range [0, 12]
    voiceVolume: 2.5, // out of range [0, 1]
  };
  const sanitized = sanitizeDjEffectsSettings(invalidSettings);
  assert(sanitized.reverbEnabled === true, 'reverbEnabled coerced to boolean');
  assert(sanitized.reverbWetMix === 0.30, 'Out-of-range wet mix resets to default (0.30)');
  assert(sanitized.amRadioEnabled === true, 'amRadioEnabled coerced to boolean');
  assert(sanitized.fmSparkleEnabled === true, 'fmSparkleEnabled is boolean true');
  assert(sanitized.fmSparkleBoost === 6, 'Out-of-range sparkle boost resets to default (6 dB)');
  assert(sanitized.saturationEnabled === true, 'saturationEnabled is boolean true');
  assert(sanitized.saturationDrive === 15, 'Out-of-range saturation drive resets to default (15)');
  assert(sanitized.compressionEnabled === true, 'compressionEnabled coerced to boolean true');
  assert(sanitized.compressionThreshold === -24, 'Out-of-range threshold resets to default (-24 dB)');
  assert(sanitized.compressionRatio === 3, 'Out-of-range ratio resets to default (3:1)');
  assert(sanitized.compressionAttack === 0.010, 'Out-of-range attack resets to default (0.010s)');
  assert(sanitized.compressionRelease === 0.150, 'Out-of-range release resets to default (0.150s)');
  assert(sanitized.compressionKnee === 12, 'Out-of-range knee resets to default (12 dB)');
  assert(sanitized.compressionMakeupGain === 3, 'Out-of-range makeup gain resets to default (+3 dB)');
  assert(sanitized.voiceVolume === 0.50, 'Out-of-range voice volume resets to default (0.50)');

  // Missing or null input
  const nullSettings = sanitizeDjEffectsSettings(null);
  assert(nullSettings.reverbEnabled === false, 'Null settings fall back to default');
  assert(nullSettings.compressionEnabled === false, 'Null settings provide default compression state');
  assert(nullSettings.saturationDrive === 15, 'Null settings provide default saturation drive');
  assert(nullSettings.voiceVolume === 0.50, 'Null settings provide default voiceVolume 0.50');
}

// --- Test 3: Mathematical Curves Generation (Impulse Response, WaveShaper, Neutral) ---
console.log('\n--- Test 3: DSP Curves & Impulse Generation ---');
{
  const mockCtx = new MockAudioContext();
  const ir = generateImpulseResponse(mockCtx as any, 2.5, 1.2);
  assert(ir.numberOfChannels === 2, 'Impulse response is stereo (2 channels)');
  assert(ir.length === 44100 * 2.5, 'Impulse response duration matches 2.5s');

  const satCurve = generateSaturationCurve(15, 1024);
  assert(satCurve.length === 1024, 'Saturation curve generates correct sample count');
  assert(satCurve[0] < -0.9 && satCurve[0] >= -1.0, 'Saturation lower bound is normalized and stable near -1.0');
  assert(satCurve[1023] > 0.9 && satCurve[1023] <= 1.0, 'Saturation upper bound is normalized and stable near +1.0');
  // In an even-length array like 1024, index 511 is slightly negative and 512 is slightly positive
  const midPointVal = (satCurve[511] + satCurve[512]) / 2;
  assert(Math.abs(midPointVal) < 0.005, 'Center point passes symmetrically through 0 without DC bias');

  const neutralCurve = generateNeutralCurve(256);
  assert(neutralCurve.length === 256, 'Neutral curve generates 256 samples');
  assert(Math.abs(neutralCurve[0] - (-1)) < 1e-4, 'Neutral curve begins at -1.0');
  assert(Math.abs(neutralCurve[255] - 1) < 1e-4, 'Neutral curve ends at +1.0');
}

// --- Test 4: DjVoiceEffectsService Lifecycle & Graph Initialization ---
console.log('\n--- Test 4: DjVoiceEffectsService Lifecycle & Node Topology ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const initOk = await service.ensureInitialized();
  assert(initOk === true, 'ensureInitialized returns true');

  // Verify singleton idempotent behavior
  const service2 = DjVoiceEffectsService.getInstance();
  assert(service === service2, 'DjVoiceEffectsService is a singleton');
  const initOk2 = await service2.ensureInitialized();
  assert(initOk2 === true, 'Second initialization call succeeds without re-allocating duplicate graph');

  // Attach an HTMLAudioElement
  const mockAudioEl = { id: 'test-audio-element-1' } as any;
  const attach1 = service.attachAudioElement(mockAudioEl);
  assert(attach1 === true, 'Attached HTMLAudioElement to effects graph');

  // Attach same audio element again - must NOT create duplicate MediaElementAudioSourceNode
  const attach2 = service.attachAudioElement(mockAudioEl);
  assert(attach2 === true, 'Repeated attach call succeeds');
  const mockCtx = (service as any).audioCtx as MockAudioContext;
  assert(mockCtx.createdSourceNodes.length === 1, 'Only one MediaElementAudioSourceNode created for the element');
}

// --- Test 5: Reverb Toggle & Parameter Updates ---
console.log('\n--- Test 5: Reverb Enable/Disable and Wet Mix ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const wetGainNode = (service as any).reverbWetGain as MockGainNode;

  // Initial state: disabled -> gain 0
  assert(wetGainNode.gain.value === 0.0, 'Reverb wet gain starts at 0.0 when disabled');

  // Enable reverb
  service.updateSettings({ reverbEnabled: true });
  assert(wetGainNode.gain.target === 0.30, 'Enabling reverb sets target wet gain to 0.30');

  // Adjust wet mix
  service.updateSettings({ reverbWetMix: 0.55 });
  assert(wetGainNode.gain.target === 0.55, 'Updating wet mix sets target to 0.55');

  // Disable reverb -> target wet gain goes to 0
  service.updateSettings({ reverbEnabled: false });
  assert(wetGainNode.gain.target === 0.0, 'Disabling reverb transitions wet gain to 0.0');
}

// --- Test 6: AM Radio Filter Frequency Transitions ---
console.log('\n--- Test 6: AM Radio Filter Transitions ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const hpFilter = (service as any).amHighpass as MockBiquadFilterNode;
  const lpFilter = (service as any).amLowpass as MockBiquadFilterNode;

  // Initially disabled: HP at 20 Hz, LP at full-band (Nyquist or 20,000 Hz)
  assert(hpFilter.frequency.value === 20, 'AM Highpass starts at neutral 20 Hz');
  assert(lpFilter.frequency.value >= 20000, 'AM Lowpass starts at neutral >= 20,000 Hz');

  // Enable AM Radio
  service.updateSettings({ amRadioEnabled: true });
  assert(hpFilter.frequency.target === 250, 'AM Highpass transitions to 250 Hz when enabled');
  assert(lpFilter.frequency.target === 3000, 'AM Lowpass transitions to 3,000 Hz when enabled');
  assert(hpFilter.frequency.timeConstant !== null && hpFilter.frequency.timeConstant < 0.05, 'AM frequency transition uses smooth ~80ms constant');

  // Disable AM Radio
  service.updateSettings({ amRadioEnabled: false });
  assert(hpFilter.frequency.target === 20, 'AM Highpass restores full-band 20 Hz when disabled');
  assert(lpFilter.frequency.target !== null && lpFilter.frequency.target >= 20000, 'AM Lowpass restores full-band >= 20,000 Hz when disabled');
}

// --- Test 7: FM Sparkle Boost Transitions ---
console.log('\n--- Test 7: FM Sparkle Presence Boost ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const sparkleFilter = (service as any).fmSparkle as MockBiquadFilterNode;

  assert(sparkleFilter.gain.value === 0, 'FM Sparkle starts at 0 dB gain');
  assert(sparkleFilter.frequency.value === 5000, 'FM Sparkle center frequency is 5,000 Hz');
  assert(sparkleFilter.Q.value === 1.0, 'FM Sparkle Q is 1.0');

  // Enable FM Sparkle
  service.updateSettings({ fmSparkleEnabled: true });
  assert(sparkleFilter.gain.target === 6, 'FM Sparkle boosts by +6 dB when enabled');
  assert(sparkleFilter.gain.timeConstant !== null && sparkleFilter.gain.timeConstant < 0.03, 'FM Sparkle transition uses smooth ~50ms constant');

  // Adjust boost
  service.updateSettings({ fmSparkleBoost: 8.5 });
  assert(sparkleFilter.gain.target === 8.5, 'FM Sparkle boost updates to +8.5 dB');

  // Disable FM Sparkle
  service.updateSettings({ fmSparkleEnabled: false });
  assert(sparkleFilter.gain.target === 0, 'FM Sparkle returns to 0 dB when disabled');
}

// --- Test 8: Analog Saturation Curve & Drive Intensity ---
console.log('\n--- Test 8: Analog Saturation Oversampling & Curve Dynamics ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const shaper = (service as any).waveshaper as MockWaveShaperNode;

  assert(shaper.oversample === '4x', 'WaveShaper operates with 4x oversampling');
  assert(shaper.curve !== null, 'WaveShaper has initialized curve');

  // When disabled, curve is linear/neutral
  service.updateSettings({ saturationEnabled: false });
  assert(shaper.curve!.length === 256, 'Disabled saturation uses 256-sample neutral curve');
  assert(Math.abs(shaper.curve![0] - (-1)) < 1e-4, 'Neutral curve minimum is -1.0');
  assert(Math.abs(shaper.curve![255] - 1) < 1e-4, 'Neutral curve maximum is 1.0');

  // When enabled, curve is saturated tanh shaper
  service.updateSettings({ saturationEnabled: true, saturationDrive: 20 });
  assert(shaper.curve!.length === 2048, 'Enabled saturation generates 2048-sample soft-clipping curve');
  assert(shaper.curve![0] >= -1.0 && shaper.curve![0] < -0.9, 'Saturated curve is bounded to [-1, 1]');
}

// --- Test 9: Audio Compression & Makeup Gain Transitions ---
console.log('\n--- Test 9: Audio Compression Node & Makeup Gain ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const comp = (service as any).compressor as MockDynamicsCompressorNode;
  const makeup = (service as any).makeupGain as MockGainNode;

  // Initially disabled: neutral bypass (threshold 0dB, ratio 1:1, makeup gain 1.0)
  service.updateSettings({ compressionEnabled: false });
  assert(comp.threshold.target === 0, 'Disabled compression sets threshold target to 0 dB');
  assert(comp.ratio.target === 1, 'Disabled compression sets ratio target to 1:1');
  assert(makeup.gain.target === 1.0, 'Disabled compression sets makeup gain target to 1.0 (0 dB)');

  // Enable compression
  service.updateSettings({
    compressionEnabled: true,
    compressionThreshold: -20,
    compressionRatio: 4,
    compressionAttack: 0.015,
    compressionRelease: 0.200,
    compressionKnee: 10,
    compressionMakeupGain: 4.5,
  });

  assert(comp.threshold.target === -20, 'Threshold target updated to -20 dB');
  assert(comp.ratio.target === 4, 'Ratio target updated to 4:1');
  assert(comp.attack.target === 0.015, 'Attack target updated to 15 ms');
  assert(comp.release.target === 0.200, 'Release target updated to 200 ms');
  assert(comp.knee.target === 10, 'Knee target updated to 10 dB');
  const expectedLinear = Math.pow(10, 4.5 / 20);
  assert(Math.abs((makeup.gain.target as number) - expectedLinear) < 1e-4, 'Makeup gain target updated to +4.5 dB linear');

  // Disable compression again -> restores neutral bypass smoothly
  service.updateSettings({ compressionEnabled: false });
  assert(comp.threshold.target === 0, 'Disabling compression returns threshold target to 0 dB');
  assert(comp.ratio.target === 1, 'Disabling compression returns ratio target to 1:1');
  assert(makeup.gain.target === 1.0, 'Disabling compression returns makeup gain target to 1.0 (0 dB)');
}

// --- Test 10: Persistence in localStorage & DJ Voice Volume Master Gain ---
console.log('\n--- Test 10: DJ Voice Volume Gain & Settings Persistence ---');
{
  const service = DjVoiceEffectsService.getInstance();
  const masterOutput = (service as any).masterOutput as MockGainNode;

  // Master output gain defaults to 0.50 (50%)
  assert(service.getSettings().voiceVolume === 0.50, 'DJ voice volume initial setting is 0.50');
  assert(masterOutput.gain.value === 0.50, 'MasterOutput GainNode initializes to 0.50');

  // Updating DJ Voice Volume to 0% (silence)
  service.updateSettings({ voiceVolume: 0.0 });
  assert(masterOutput.gain.target === 0.0, 'Setting voiceVolume to 0% sets masterOutput target to 0.0');

  // Updating DJ Voice Volume to 100% (unattenuated)
  service.updateSettings({ voiceVolume: 1.0 });
  assert(masterOutput.gain.target === 1.0, 'Setting voiceVolume to 100% sets masterOutput target to 1.0');

  // Updating DJ Voice Volume to 75%
  service.updateSettings({ voiceVolume: 0.75 });
  assert(masterOutput.gain.target === 0.75, 'Setting voiceVolume to 75% sets masterOutput target to 0.75');

  service.updateSettings({
    reverbEnabled: true,
    reverbWetMix: 0.45,
    amRadioEnabled: true,
    fmSparkleEnabled: true,
    fmSparkleBoost: 7,
    saturationEnabled: true,
    saturationDrive: 25,
    compressionEnabled: true,
    compressionThreshold: -18,
    compressionRatio: 5,
    compressionAttack: 0.02,
    compressionRelease: 0.25,
    compressionKnee: 15,
    compressionMakeupGain: 4,
    voiceVolume: 0.65,
  });

  const storedRaw = window.localStorage.getItem('retrofm_dj_effects');
  assert(storedRaw !== null, 'Settings saved to localStorage key "retrofm_dj_effects"');
  const parsed = JSON.parse(storedRaw!);
  assert(parsed.reverbEnabled === true, 'Persisted reverbEnabled is true');
  assert(parsed.reverbWetMix === 0.45, 'Persisted reverbWetMix is 0.45');
  assert(parsed.saturationDrive === 25, 'Persisted saturationDrive is 25');
  assert(parsed.compressionEnabled === true, 'Persisted compressionEnabled is true');
  assert(parsed.compressionThreshold === -18, 'Persisted compressionThreshold is -18');
  assert(parsed.compressionRatio === 5, 'Persisted compressionRatio is 5');
  assert(parsed.compressionMakeupGain === 4, 'Persisted compressionMakeupGain is 4');
  assert(parsed.voiceVolume === 0.65, 'Persisted voiceVolume is 0.65');

  // Verify cleanup doesn't throw and resets nodes
  service.cleanup();
  assert((service as any).isGraphInitialized === false, 'Cleanup resets isGraphInitialized to false');
}

// --- Summary ---
console.log('\n================================================================================');
console.log(`DJ EFFECTS TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

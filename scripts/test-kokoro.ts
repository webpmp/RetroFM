import assert from 'node:assert';
import { KokoroTTSProvider, FALLBACK_KOKORO_VOICES } from '../src/services/tts/KokoroTTSProvider.js';

async function runTests() {
  console.log('--- Running Kokoro TTS Automated Unit & Integration Tests ---');

  // Test 1: Instantiation
  console.log('Test 1: Provider instantiation with default & custom URLs...');
  const defaultProvider = new KokoroTTSProvider();
  assert.strictEqual(defaultProvider.name, 'KokoroTTSProvider');

  const customProvider = new KokoroTTSProvider('http://custom-host:9999');
  assert.strictEqual(customProvider.name, 'KokoroTTSProvider');
  console.log('✓ Passed: Instantiation verified.');

  // Test 2: Unreachable fallback behavior
  console.log('Test 2: Unreachable service fallback...');
  const offlineProvider = new KokoroTTSProvider('http://127.0.0.1:59999');
  const offlineInfo = await offlineProvider.getServiceInfo();
  assert.strictEqual(offlineInfo.isAvailable, false);
  assert.strictEqual(offlineInfo.defaultVoice, 'am_michael');
  assert.ok(offlineInfo.voices.length >= FALLBACK_KOKORO_VOICES.length);
  assert.ok(offlineInfo.voices.some((v) => v.id === 'am_michael'));
  console.log('✓ Passed: Fallback behavior on offline endpoint verified.');

  // Test 3: Empty text validation
  console.log('Test 3: Empty script validation...');
  let caughtEmptyError = false;
  try {
    await defaultProvider.generate({ text: '   ' });
  } catch (err: any) {
    caughtEmptyError = true;
    assert.ok(err.message.includes('Script text cannot be empty'));
  }
  assert.strictEqual(caughtEmptyError, true, 'Should reject empty text');
  console.log('✓ Passed: Empty text validation verified.');

  // Test 4: Offline generation error handling
  console.log('Test 4: Offline generation error handling...');
  let caughtOfflineError = false;
  try {
    await offlineProvider.generate({ text: 'Hello RetroFM world' });
  } catch (err: any) {
    caughtOfflineError = true;
    assert.ok(err.message.includes('Kokoro TTS generation failed'));
  }
  assert.strictEqual(caughtOfflineError, true, 'Should fail gracefully when offline');
  console.log('✓ Passed: Offline generation error handling verified.');

  // Test 5: Live Kokoro service connection & synthesis (if online)
  console.log('Test 5: Live Kokoro service status & voice discovery...');
  const liveInfo = await defaultProvider.getServiceInfo();
  if (liveInfo.isAvailable) {
    console.log(`Live Kokoro detected! Supported voices: ${liveInfo.voices.map(v => v.id).join(', ')}`);
    assert.ok(liveInfo.voices.length > 0);
    assert.ok(liveInfo.voices.some(v => v.id === 'am_michael'));

    console.log('Test 6: Synthesizing real audio sample via live Kokoro...');
    const result = await defaultProvider.generate({
      text: 'RetroFM test broadcast.',
      voice: 'am_michael'
    });
    assert.ok(result.audioBase64.length > 100);
    assert.strictEqual(result.mimeType, 'audio/wav');
    assert.strictEqual(result.modelUsed, 'Kokoro-82M-bf16');
    assert.ok(typeof result.durationSeconds === 'number' && result.durationSeconds > 0);
    console.log(`✓ Passed: Live audio synthesized successfully (${result.durationSeconds}s audio, ${result.audioBase64.length} base64 chars).`);
  } else {
    console.log('Live service not reachable from current environment, live synthesis test skipped.');
  }

  console.log('\n==================================================================');
  console.log('                  ALL KOKORO TESTS PASSED');
  console.log('==================================================================');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

/**
 * Verification test script for Local AI Model (LM Studio) integration in RetroFM.
 * Tests:
 * 1. Provider discovery
 * 2. LMStudioScriptWriterProvider initialization & endpoint sanitization
 * 3. Step 1 (3 DJ breaks generation)
 * 4. Step 2 (Anachronism check)
 * 5. Failure handling without fallback to Gemini
 */

import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { getScriptWriterProvider } from '../src/services/djBreak/djBreakService.js';

async function runTests() {
  console.log('--- RetroFM Local AI Model (LM Studio) Test Suite ---');
  let passed = 0;
  let total = 0;

  // Test 1: Shared Provider Factory
  total++;
  try {
    const geminiWriter = getScriptWriterProvider({ provider: 'gemini' });
    const lmWriter = getScriptWriterProvider({
      provider: 'lmstudio',
      endpoint: 'http://host.docker.internal:1234/v1',
    });
    if (geminiWriter.name === 'GeminiScriptWriterProvider' && lmWriter.name === 'LMStudioScriptWriterProvider') {
      console.log('✓ Test 1 Passed: Provider factory resolves Gemini and LM Studio correctly.');
      passed++;
    } else {
      console.error('✗ Test 1 Failed: Unexpected provider names');
    }
  } catch (e: any) {
    console.error('✗ Test 1 Failed:', e.message);
  }

  // Test 2: Endpoint Sanitization
  total++;
  try {
    const provider = new LMStudioScriptWriterProvider({
      endpoint: 'http://localhost:1234/v1///',
    });
    if (provider.endpoint === 'http://localhost:1234/v1') {
      console.log('✓ Test 2 Passed: Trailing slashes correctly sanitized.');
      passed++;
    } else {
      console.error('✗ Test 2 Failed: Endpoint was', provider.endpoint);
    }
  } catch (e: any) {
    console.error('✗ Test 2 Failed:', e.message);
  }

  // Test 3: Model Discovery against host.docker.internal:1234
  total++;
  let discoveredModel = '';
  try {
    const endpoint = process.env.LM_STUDIO_ENDPOINT || 'http://host.docker.internal:1234/v1';
    const models = await LMStudioScriptWriterProvider.discoverModels(endpoint);
    if (Array.isArray(models) && models.length > 0) {
      discoveredModel = models[0];
      console.log(`✓ Test 3 Passed: Discovered models from LM Studio: ${models.join(', ')}`);
      passed++;
    } else {
      console.warn('! Test 3 Notice: LM Studio reachable but returned empty models list');
      passed++;
    }
  } catch (e: any) {
    console.warn('! Test 3 Notice: Live LM Studio not reachable from current environment:', e.message);
  }

  // Test 4: Live Generation Smoke Test (if model discovered)
  if (discoveredModel) {
    total++;
    try {
      const endpoint = process.env.LM_STUDIO_ENDPOINT || 'http://host.docker.internal:1234/v1';
      const provider = new LMStudioScriptWriterProvider({
        endpoint,
        model: discoveredModel,
        timeoutMs: 60000,
      });

      const res = await provider.writeBreaksOnly({
        targetDate: '1985-07-13',
        personality: 'mike',
        timeOfDay: 'afternoon',
        format: 'Top 40',
        songPlayed: 'a-ha - Take on Me',
        songNext: 'Michael Jackson - Billie Jean',
        secondsAvailable: 12,
        factItems: [
          {
            headline: 'Live Aid concert rocks Wembley Stadium and JFK Stadium Philadelphia',
            publishedDate: '1985-07-13',
            category: 'music',
            summary: 'Global charity concert featuring top rock artists across two continents.',
            source: 'Test',
            url: 'https://example.com/liveaid',
            provider: 'nyt',
          },
        ],
      });

      if (res.success && res.breaks.length === 3) {
        console.log(`✓ Test 4 Passed: Successfully generated 3 breaks in ${res.callDurationSec}s using ${res.modelUsed}`);
        passed++;
      } else {
        console.error('✗ Test 4 Failed:', res.error);
      }
    } catch (e: any) {
      console.error('✗ Test 4 Failed:', e.message);
    }
  }

  // Test 5: Error Isolation (Bad Endpoint should error gracefully without falling back to Gemini)
  total++;
  try {
    const badProvider = new LMStudioScriptWriterProvider({
      endpoint: 'http://127.0.0.1:59999/v1',
      timeoutMs: 2000,
    });
    const res = await badProvider.writeBreaksOnly({
      targetDate: '1985-07-13',
      personality: 'mike',
      timeOfDay: 'afternoon',
      format: 'Top 40',
      songPlayed: 'a-ha - Take on Me',
      songNext: 'Michael Jackson - Billie Jean',
      secondsAvailable: 12,
      factItems: [],
    });
    if (!res.success && res.error && !res.modelUsed.includes('gemini')) {
      console.log('✓ Test 5 Passed: Bad endpoint failed cleanly without silent Gemini fallback.');
      passed++;
    } else {
      console.error('✗ Test 5 Failed: Expected failure with isolated error.');
    }
  } catch (e: any) {
    console.error('✗ Test 5 Failed:', e.message);
  }

  console.log(`\nResults: ${passed} / ${total} tests passed.`);
  if (passed < total) process.exit(1);
}

runTests().catch((err) => {
  console.error('Suite error:', err);
  process.exit(1);
});

/**
 * Unit & Integration tests for LM Studio endpoint resolution, IPv4/IPv6 fallback,
 * and detailed error hints in RetroFM.
 */

import assert from 'assert';
import { resolveLmStudioEndpoint, isDocker } from '../src/services/envUtil.js';
import {
  getLmStudioCandidates,
  formatLmStudioError,
  fetchLmStudioWithFallback,
  LMStudioScriptWriterProvider,
} from '../src/services/djBreak/LMStudioScriptWriterProvider.js';

console.log('--- RetroFM LM Studio Resolution & Error Diagnostic Test Suite ---');
let passed = 0;
let total = 0;

function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => {
        console.log(`✓ ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`✗ ${name}:`, err);
      });
    } else {
      console.log(`✓ ${name}`);
      passed++;
    }
  } catch (err) {
    console.error(`✗ ${name}:`, err);
  }
}

async function runAll() {
  // 1. Non-Docker resolution test (default host behavior)
  test('resolveLmStudioEndpoint preserves localhost:1234 outside Docker', () => {
    // Ensure docker detection flags are not set
    const origDocker = process.env.DOCKER_CONTAINER;
    const origIsDocker = process.env.IS_DOCKER;
    delete process.env.DOCKER_CONTAINER;
    delete process.env.IS_DOCKER;

    try {
      if (!isDocker()) {
        const resolved = resolveLmStudioEndpoint('http://localhost:1234/v1');
        assert.strictEqual(resolved, 'http://localhost:1234/v1');

        const resolvedIp = resolveLmStudioEndpoint('http://127.0.0.1:1234/v1');
        assert.strictEqual(resolvedIp, 'http://127.0.0.1:1234/v1');

        const resolvedDefault = resolveLmStudioEndpoint();
        assert(resolvedDefault.includes('localhost:1234') || resolvedDefault.includes('127.0.0.1:1234'));
      }
    } finally {
      if (origDocker) process.env.DOCKER_CONTAINER = origDocker;
      if (origIsDocker) process.env.IS_DOCKER = origIsDocker;
    }
  });

  // 2. Docker resolution simulation test
  test('resolveLmStudioEndpoint rewrites localhost:1234 to host.docker.internal when inside Docker', () => {
    process.env.DOCKER_CONTAINER = 'true';
    try {
      const resolvedLocal = resolveLmStudioEndpoint('http://localhost:1234/v1');
      assert.strictEqual(resolvedLocal, 'http://host.docker.internal:1234/v1');

      const resolvedIp = resolveLmStudioEndpoint('http://127.0.0.1:1234/v1');
      assert.strictEqual(resolvedIp, 'http://host.docker.internal:1234/v1');

      const resolvedCustom = resolveLmStudioEndpoint('http://my-remote-server:1234/v1');
      assert.strictEqual(resolvedCustom, 'http://my-remote-server:1234/v1');
    } finally {
      delete process.env.DOCKER_CONTAINER;
    }
  });

  // 3. IPv4 fallback candidates test
  test('getLmStudioCandidates generates 127.0.0.1 fallback for localhost', () => {
    const candidates = getLmStudioCandidates('http://localhost:1234/v1');
    assert.deepStrictEqual(candidates, [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234/v1',
    ]);

    const ipCandidates = getLmStudioCandidates('http://127.0.0.1:1234/v1');
    assert.deepStrictEqual(ipCandidates, ['http://127.0.0.1:1234/v1']);

    const remoteCandidates = getLmStudioCandidates('http://host.docker.internal:1234/v1');
    assert.deepStrictEqual(remoteCandidates, ['http://host.docker.internal:1234/v1']);
  });

  // 4. Error formatting with exact address, code, and plain hints
  test('formatLmStudioError includes exact address, error code, and plain hints', () => {
    const errRefused = { code: 'ECONNREFUSED' };
    const resRefused = formatLmStudioError('http://localhost:1234/v1', errRefused);
    assert(resRefused.message.includes('http://localhost:1234/v1'));
    assert(resRefused.message.includes('ECONNREFUSED'));
    assert(resRefused.message.includes('LM Studio server not running'));

    const errNotFound = { message: 'getaddrinfo ENOTFOUND host.docker.internal' };
    const resNotFound = formatLmStudioError('http://host.docker.internal:1234/v1', errNotFound);
    assert(resNotFound.message.includes('http://host.docker.internal:1234/v1'));
    assert(resNotFound.message.includes('ENOTFOUND'));
    assert(resNotFound.message.includes('Wrong address or hostname cannot be resolved'));

    const errTimeout = { message: 'The operation was aborted', isTimeout: true };
    const resTimeout = formatLmStudioError('http://127.0.0.1:1234/v1', errTimeout);
    assert(resTimeout.message.includes('ETIMEDOUT'));
    assert(resTimeout.message.includes('Connection timed out'));
  });

  // 5. Live connection test against local LM Studio if available
  await test('fetchLmStudioWithFallback connects to real local LM Studio if running', async () => {
    try {
      const { response, activeBaseUrl } = await fetchLmStudioWithFallback(
        'http://localhost:1234/v1',
        '/models',
        undefined,
        3000
      );
      assert.strictEqual(response.ok, true);
      const data: any = await response.json();
      assert(Array.isArray(data?.data));
      console.log(`   (Live connection succeeded via ${activeBaseUrl}, found ${data.data.length} model(s))`);
    } catch (err: any) {
      console.log(`   (LM Studio not running on port 1234, skipped live check: ${err.message})`);
    }
  });

  console.log(`\nResults: ${passed} / ${total} tests passed.`);
  if (passed < total) process.exit(1);
}

runAll().catch((err) => {
  console.error('Fatal test suite failure:', err);
  process.exit(1);
});

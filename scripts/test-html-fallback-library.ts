import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadLibrary,
  validateJsonFetch,
  isNonEmptySongArray,
  type LibrarySong
} from '../src/services/songSelector.js';

console.log('================================================================================');
console.log('       TEST: DEV SERVER HTML 200 OK SPA FALLBACK FOR MISSING FILES');
console.log('================================================================================\n');

// 1. Unit test validateJsonFetch against HTML response (Status 200, Content-Type text/html)
const mockHtmlBody = `<!DOCTYPE html>
<html lang="en">
  <head><title>RetroFM</title></head>
  <body><div id="root"></div></body>
</html>`;

const mockHtmlResponse = new Response(mockHtmlBody, {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' }
});

const htmlResult = await validateJsonFetch(mockHtmlResponse, isNonEmptySongArray);
assert.strictEqual(htmlResult, null, 'validateJsonFetch must return null when server responds with HTML (status 200)');
console.log('  ✓ Test 1 Passed: Server returning HTML (200 OK) is rejected and not parsed as song library.');

// 2. Unit test validateJsonFetch against empty array
const mockEmptyResponse = new Response(JSON.stringify([]), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});
const emptyResult = await validateJsonFetch(mockEmptyResponse, isNonEmptySongArray);
assert.strictEqual(emptyResult, null, 'validateJsonFetch must return null for an empty array');
console.log('  ✓ Test 2 Passed: Empty array is rejected by isNonEmptySongArray.');

// 3. Unit test validateJsonFetch against valid sample dataset
const samplePath = path.resolve(process.cwd(), 'public/data/sample/retrofm_library_youtube.json');
const sampleRaw = fs.readFileSync(samplePath, 'utf8');
const mockSampleResponse = new Response(sampleRaw, {
  status: 200,
  headers: { 'content-type': 'application/json' }
});
const validResult = await validateJsonFetch<LibrarySong[]>(mockSampleResponse, isNonEmptySongArray);
assert(validResult !== null && validResult.length > 0, 'validateJsonFetch must return parsed array for valid JSON');
console.log(`  ✓ Test 3 Passed: Valid sample JSON parsed successfully (${validResult?.length} songs).`);

// 4. Integration test: simulate loadLibrary when primary URL returns HTML 200 (dev server SPA fallback)
// We create a custom fetch mock that returns mockHtmlBody for primaryUrl, and real sample for sampleUrl
const originalFetch = globalThis.fetch;
try {
  let requestedUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    requestedUrls.push(urlStr);

    if (urlStr === '/data/retrofm_library_youtube.json') {
      // Simulate Vite dev server fallback returning index.html with 200 OK
      return new Response(mockHtmlBody, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }

    if (urlStr === '/data/sample/retrofm_library_youtube.json') {
      return new Response(sampleRaw, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  };

  const loaded = await loadLibrary();
  assert(Array.isArray(loaded) && loaded.length > 0, 'loadLibrary must successfully load sample songs when full library returns HTML');
  assert.strictEqual(requestedUrls[0], '/data/retrofm_library_youtube.json', 'Attempted primary URL first');
  assert.strictEqual(requestedUrls[1], '/data/sample/retrofm_library_youtube.json', 'Fell back to sample URL second');
  console.log(`  ✓ Test 4 Passed: loadLibrary fell back from HTML 200 to sample dataset (${loaded.length} songs loaded).`);

  // 5. Integration test: when BOTH primary and sample fail (e.g. both return HTML or 404)
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    return new Response(mockHtmlBody, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  };

  let threwExpected = false;
  try {
    await loadLibrary();
  } catch (err: any) {
    threwExpected = true;
    assert(err.message.includes('No song library files could be loaded'), 'Error message contains clear explanation and remediation');
    assert(err.message.includes('bun run export-library') || err.message.includes('public/data/sample'), 'Error message explains how to fix');
  }
  assert(threwExpected, 'loadLibrary must throw when both primary and sample fail');
  console.log('  ✓ Test 5 Passed: Clear error thrown when both primary and sample are unavailable/HTML.');

} finally {
  globalThis.fetch = originalFetch;
}

console.log('\n================================================================================');
console.log('ALL TESTS PASSED: Dev server HTML 200 fallback correctly triggers sample library!');
console.log('================================================================================\n');

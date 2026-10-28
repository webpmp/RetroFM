/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * In-memory session stats for DJ break model calls and cache hits.
 * Safe for both browser and Node environments (no fs/path/crypto dependencies).
 */

import { DJBreakSessionStats } from './types.js';

let sessionStats: DJBreakSessionStats = {
  textModelCalls: 0,
  cacheHits: 0,
};

export function recordTextModelCall(count = 1): void {
  sessionStats.textModelCalls += count;
}

export function recordBreakCacheHit(): void {
  sessionStats.cacheHits += 1;
}

export function getDJBreakSessionStats(): DJBreakSessionStats {
  return { ...sessionStats };
}

export function resetDJBreakSessionStats(): void {
  sessionStats = { textModelCalls: 0, cacheHits: 0 };
}

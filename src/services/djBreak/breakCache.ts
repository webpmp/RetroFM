/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { BreakGeneratorResult, DJBreakSessionStats } from './types.js';

function getCacheDir(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../cache/dj_breaks');
  } catch {
    return path.resolve(process.cwd(), 'cache', 'dj_breaks');
  }
}

function ensureCacheDir(): string {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function computeBreakCacheKey(input: {
  targetDate: string;
  personality: string;
  timeOfDay: string;
  format: string;
  songPlayed: string;
  songNext: string;
  secondsAvailable: number;
  nationalFocus?: boolean;
}): string {
  const nf = input.nationalFocus !== false ? 'nf' : 'all';
  const rawKey = `${input.targetDate}_${input.personality}_${input.timeOfDay}_${input.format}_${input.songPlayed.trim().toLowerCase()}_${input.songNext.trim().toLowerCase()}_${input.secondsAvailable}_${nf}`;
  const hash = crypto.createHash('md5').update(rawKey).digest('hex').substring(0, 10);
  const safeDate = input.targetDate.replace(/[^0-9-]/g, '_');
  return `break_${safeDate}_${input.personality}_${input.secondsAvailable}s_${nf}_${hash}`;
}

export function readBreakCache(key: string): BreakGeneratorResult | null {
  try {
    const dir = ensureCacheDir();
    const filePath = path.join(dir, `${key}.json`);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data) as BreakGeneratorResult;
    }
  } catch (err) {
    console.warn(`[djBreakCache] Error reading cache for ${key}:`, err);
  }
  return null;
}

export function writeBreakCache(key: string, data: BreakGeneratorResult): void {
  try {
    const dir = ensureCacheDir();
    const filePath = path.join(dir, `${key}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[djBreakCache] Error writing cache for ${key}:`, err);
  }
}

// Session metrics
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

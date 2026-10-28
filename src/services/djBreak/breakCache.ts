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
  provider?: string;
  model?: string;
}): string {
  const nf = input.nationalFocus !== false ? 'nf' : 'all';
  const prov = input.provider || 'gemini';
  const mdl = input.model ? `_${input.model.trim().toLowerCase()}` : '';
  const rawKey = `${input.targetDate}_${input.personality}_${input.timeOfDay}_${input.format}_${input.songPlayed.trim().toLowerCase()}_${input.songNext.trim().toLowerCase()}_${input.secondsAvailable}_${nf}_${prov}${mdl}`;
  const hash = crypto.createHash('md5').update(rawKey).digest('hex').substring(0, 10);
  const safeDate = input.targetDate.replace(/[^0-9-]/g, '_');
  return `break_${safeDate}_${input.personality}_${input.secondsAvailable}s_${nf}_${prov}_${hash}`;
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

// Re-export session stats from breakSessionStats (safe for browser and server)
export {
  recordTextModelCall,
  recordBreakCacheHit,
  getDJBreakSessionStats,
  resetDJBreakSessionStats,
} from './breakSessionStats.js';

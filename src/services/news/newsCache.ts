/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FactSessionStats } from './types.js';

function getCacheDir(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../cache/news');
  } catch {
    return path.resolve(process.cwd(), 'cache', 'news');
  }
}

// Ensure directory exists
function ensureCacheDir(): string {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function readNewsCache<T>(key: string): T | null {
  try {
    const dir = ensureCacheDir();
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeKey}.json`);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data) as T;
    }
  } catch (err) {
    console.warn(`[newsCache] Error reading cache for ${key}:`, err);
  }
  return null;
}

export function writeNewsCache<T>(key: string, data: T): void {
  try {
    const dir = ensureCacheDir();
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[newsCache] Error writing cache for ${key}:`, err);
  }
}

// Session call counters
const sessionStats: FactSessionStats = {
  apiCalls: {
    newsapi: 0,
    newsdata: 0,
    nyt: 0,
  },
  cacheHits: {
    newsapi: 0,
    newsdata: 0,
    nyt: 0,
  },
};

export function recordNewsApiCall(provider: 'newsapi' | 'newsdata' | 'nyt'): void {
  sessionStats.apiCalls[provider] = (sessionStats.apiCalls[provider] || 0) + 1;
}

export function recordNewsCacheHit(provider: 'newsapi' | 'newsdata' | 'nyt'): void {
  sessionStats.cacheHits[provider] = (sessionStats.cacheHits[provider] || 0) + 1;
}

export function getNewsSessionStats(): FactSessionStats {
  return {
    apiCalls: { ...sessionStats.apiCalls },
    cacheHits: { ...sessionStats.cacheHits },
  };
}

export function resetNewsSessionStats(): void {
  sessionStats.apiCalls = { newsapi: 0, newsdata: 0, nyt: 0 };
  sessionStats.cacheHits = { newsapi: 0, newsdata: 0, nyt: 0 };
}

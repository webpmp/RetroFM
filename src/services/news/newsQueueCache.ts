/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NewsPacket } from '../djBreak/newsAudit.js';

export interface CachedNewsLine {
  date: string; // YYYY-MM-DD
  line: string;
  packet: NewsPacket;
  auditedAt: string;
}

function getAuditedCacheDir(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../cache/dj-news');
  } catch {
    return path.resolve(process.cwd(), 'cache', 'dj-news');
  }
}

function ensureAuditedCacheDir(): string {
  const dir = getAuditedCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Reads cached audited news lines for a specific date (cache/dj-news/YYYY-MM-DD.json).
 */
export function readAuditedNewsCache(date: string): CachedNewsLine[] {
  try {
    const dir = ensureAuditedCacheDir();
    const safeDate = date.replace(/[^0-9-]/g, '_');
    const filePath = path.join(dir, `${safeDate}.json`);
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data)) {
        return data as CachedNewsLine[];
      }
    }
  } catch (err) {
    console.warn(`[newsCache] Error reading audited news cache for ${date}:`, err);
  }
  return [];
}

/**
 * Saves audited news lines for a specific date (cache/dj-news/YYYY-MM-DD.json).
 */
export function writeAuditedNewsCache(date: string, lines: CachedNewsLine[]): void {
  try {
    const dir = ensureAuditedCacheDir();
    const safeDate = date.replace(/[^0-9-]/g, '_');
    const filePath = path.join(dir, `${safeDate}.json`);
    fs.writeFileSync(filePath, JSON.stringify(lines, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[newsCache] Error writing audited news cache for ${date}:`, err);
  }
}

/**
 * Appends a new audited line to the cache for that date if not already present.
 */
export function appendAuditedNewsLine(date: string, entry: CachedNewsLine): void {
  const existing = readAuditedNewsCache(date);
  if (!existing.some((e) => e.line.trim().toLowerCase() === entry.line.trim().toLowerCase())) {
    existing.push(entry);
    writeAuditedNewsCache(date, existing);
  }
}

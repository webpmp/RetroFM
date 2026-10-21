/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NewsPacket, isSensitive } from '../djBreak/newsAudit.js';
import { evaluateNYTNationalFocus, computeDJInterestScore, categorizeNYTArticle } from './nationalFocusFilter.js';
import { extractDateString } from './categoryNormalizer.js';
import { recordNewsApiCall, recordNewsCacheHit } from './newsCache.js';

export interface ReducedNYTArticle {
  pubDate: string; // YYYY-MM-DD
  headline: string;
  abstract: string;
  section: string;
  desk: string;
  typeOfMaterial: string;
  printPage: string;
  printSection: string;
  keywords?: string[];
}

export interface MonthlyArchiveCache {
  year: number;
  month: number;
  fetchedAt: string;
  articles: ReducedNYTArticle[];
}

function getNytCacheDir(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../cache/nyt');
  } catch {
    return path.resolve(process.cwd(), 'cache', 'nyt');
  }
}

function ensureNytCacheDir(): string {
  const dir = getNytCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Compute date N days before a given YYYY-MM-DD */
export function getDateNDaysBefore(dateStr: string, n: number): string {
  const [year, month, day] = dateStr.split('-').map((v) => parseInt(v, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().split('T')[0];
}

// NYT Rate Limiting: ~5 requests/minute allowed (6.5s spacing baseline)
let lastNytCallTimestamp = 0;
const NYT_MIN_INTERVAL_MS = 6500;

async function throttleNytCall(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastNytCallTimestamp;
  if (timeSinceLast < NYT_MIN_INTERVAL_MS) {
    const delay = NYT_MIN_INTERVAL_MS - timeSinceLast;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastNytCallTimestamp = Date.now();
}

/**
 * Fetches and reduces monthly NYT archive articles (or reads from cache/nyt/YYYY-MM.json).
 * Handles rate limits (5/min), backoff on 429, and bounded retries.
 */
export async function getReducedMonthlyArchive(
  year: number,
  month: number,
  forceFresh = false
): Promise<{ articles: ReducedNYTArticle[]; error?: string; status: 'OK' | 'CACHED' | 'RATE_LIMIT' | 'ERROR' }> {
  const monthStr = month < 10 ? `0${month}` : `${month}`;
  const fileName = `${year}-${monthStr}.json`;
  const dir = ensureNytCacheDir();
  const filePath = path.join(dir, fileName);

  if (!forceFresh && fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MonthlyArchiveCache;
      recordNewsCacheHit('nyt');
      return { articles: data.articles, status: 'CACHED' };
    } catch (err) {
      console.warn(`[nytArchive] Error reading cache file ${filePath}:`, err);
    }
  }

  // Also check legacy cache/news/nyt_archive_YYYY_M.json for backwards compatibility
  const legacyPath = path.resolve(getNytCacheDir(), '..', 'news', `nyt_archive_${year}_${month}.json`);
  if (!forceFresh && fs.existsSync(legacyPath)) {
    try {
      const legacyRaw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      const rawDocs = legacyRaw?.response?.docs;
      if (Array.isArray(rawDocs)) {
        const reduced = reduceDocs(rawDocs);
        const cacheObj: MonthlyArchiveCache = {
          year,
          month,
          fetchedAt: new Date().toISOString(),
          articles: reduced,
        };
        fs.writeFileSync(filePath, JSON.stringify(cacheObj, null, 2), 'utf8');
        recordNewsCacheHit('nyt');
        return { articles: reduced, status: 'CACHED' };
      }
    } catch (err) {
      console.warn(`[nytArchive] Error migrating legacy cache for ${year}-${month}:`, err);
    }
  }

  const apiKey = (process.env.NYT_API_KEY || '').trim();
  if (!apiKey) {
    return {
      articles: [],
      error: 'NYT_API_KEY is not configured in server environment.',
      status: 'ERROR',
    };
  }

  // Remote fetch with throttle & backoff on 429
  const url = `https://api.nytimes.com/svc/archive/v1/${year}/${month}.json?api-key=${encodeURIComponent(apiKey)}`;
  const maxRetries = 2;
  const backoffDelays = [4000, 8000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttleNytCall();
    recordNewsApiCall('nyt');

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'RetroFM/1.0.6 (Historical Radio Simulation)',
          Accept: 'application/json',
        },
      });

      if (res.status === 429) {
        if (attempt < maxRetries) {
          const waitMs = backoffDelays[attempt];
          console.warn(`[nytArchive] NYT 429 Rate Limit hit. Backing off ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        } else {
          return {
            articles: [],
            error: 'NYT Rate limit reached (429). Max retries exceeded.',
            status: 'RATE_LIMIT',
          };
        }
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          articles: [],
          error: `HTTP ${res.status}: ${res.statusText} ${errText}`.trim(),
          status: 'ERROR',
        };
      }

      const data = await res.json().catch(() => null);
      const rawDocs = data?.response?.docs;
      if (!Array.isArray(rawDocs)) {
        return { articles: [], status: 'OK' };
      }

      const reduced = reduceDocs(rawDocs);
      const cacheObj: MonthlyArchiveCache = {
        year,
        month,
        fetchedAt: new Date().toISOString(),
        articles: reduced,
      };
      fs.writeFileSync(filePath, JSON.stringify(cacheObj, null, 2), 'utf8');

      return { articles: reduced, status: 'OK' };
    } catch (err: any) {
      if (attempt < maxRetries) {
        const waitMs = backoffDelays[attempt];
        console.warn(`[nytArchive] Network error fetching NYT: ${err?.message}. Retrying in ${waitMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        return {
          articles: [],
          error: err?.message || 'Failed connecting to NYT Archive API',
          status: 'ERROR',
        };
      }
    }
  }

  return { articles: [], error: 'Failed to fetch NYT Archive', status: 'ERROR' };
}

function reduceDocs(rawDocs: any[]): ReducedNYTArticle[] {
  return rawDocs.map((doc) => {
    const pubDate = extractDateString(doc.pub_date) || '';
    const headline = (doc.headline?.main || doc.headline?.print_headline || '').trim();
    const abstract = (doc.abstract || doc.snippet || doc.lead_paragraph || '').trim();
    const section = (doc.section_name || '').trim();
    const desk = (doc.news_desk || '').trim();
    const typeOfMaterial = (doc.type_of_material || '').trim();
    const printPage = String(doc.print_page || '').trim();
    const printSection = (doc.print_section || '').trim().toUpperCase();
    const keywords: string[] = Array.isArray(doc.keywords)
      ? doc.keywords.map((k: any) => typeof k === 'string' ? k : (k.value || ''))
      : [];

    return {
      pubDate,
      headline,
      abstract,
      section,
      desk,
      typeOfMaterial,
      printPage,
      printSection,
      keywords,
    };
  });
}

/**
 * Filter and select top 8 to 10 NewsPackets for the target date.
 * - Published on selected date; if < 5 usable, add previous 1 to 3 days (never later).
 * - National focus filter and interest scoring.
 * - Drop sensitive items, obituaries, letters, op-eds, reviews, and ads.
 * - Return top 8 to 10 NewsPacket { date: selectedDate, headline, abstract, section }
 */
export function selectNewsPackets(
  allMonthlyArticles: ReducedNYTArticle[],
  targetDate: string
): NewsPacket[] {
  // Candidate dates: targetDate first, then previous 1, 2, 3 days
  const prev1 = getDateNDaysBefore(targetDate, 1);
  const prev2 = getDateNDaysBefore(targetDate, 2);
  const prev3 = getDateNDaysBefore(targetDate, 3);

  // Group reduced articles by date
  const articlesByDate = new Map<string, ReducedNYTArticle[]>();
  for (const art of allMonthlyArticles) {
    if (art.pubDate) {
      let list = articlesByDate.get(art.pubDate);
      if (!list) {
        list = [];
        articlesByDate.set(art.pubDate, list);
      }
      list.push(art);
    }
  }

  const scoreAndFilter = (articles: ReducedNYTArticle[]): { packet: NewsPacket; score: number }[] => {
    const result: { packet: NewsPacket; score: number }[] = [];

    for (const art of articles) {
      // Must not be after selected date under any circumstances
      if (art.pubDate > targetDate) continue;

      const headline = art.headline;
      const abstract = art.abstract;
      if (!headline && !abstract) continue;

      // Drop obituaries, letters, op-eds, reviews, and ads
      const type = art.typeOfMaterial.toLowerCase();
      const hLower = headline.toLowerCase();
      const deskLower = art.desk.toLowerCase();
      const secLower = art.section.toLowerCase();

      if (
        /obituar|memorial|deaths elsewhere/i.test(type) ||
        /obituar|memorial|deaths elsewhere/i.test(deskLower) ||
        /obituar|memorial|deaths elsewhere/i.test(secLower) ||
        /\b(obituary|in memoriam|funeral notice)\b/i.test(hLower)
      ) {
        continue;
      }

      if (/letter/i.test(type) || /\bletters to the editor\b/i.test(hLower)) continue;
      if (/op-ed|editorial/i.test(type) || /\b(op-ed|editorial)\b/i.test(deskLower)) continue;
      if (/review/i.test(type) || deskLower.includes('book review')) continue;
      if (/advertis/i.test(type) || /^advertising:/i.test(headline) || deskLower.includes('advertising')) continue;

      const packet: NewsPacket = {
        date: targetDate, // Normalized to selected date as per spec
        headline,
        abstract,
        section: art.section || art.desk || 'News',
      };

      // Check isSensitive
      if (isSensitive(packet)) {
        continue;
      }

      // National focus filter
      // Synthesize doc structure for evaluateNYTNationalFocus
      const mockDoc = {
        headline: { main: art.headline },
        abstract: art.abstract,
        print_section: art.printSection,
        print_page: art.printPage,
        news_desk: art.desk,
        section_name: art.section,
        type_of_material: art.typeOfMaterial,
        keywords: (art.keywords || []).map((k) => ({ name: 'subject', value: k })),
      };

      const natResult = evaluateNYTNationalFocus(mockDoc);
      if (!natResult.keep) {
        continue;
      }

      const catResult = categorizeNYTArticle(mockDoc);
      const score = computeDJInterestScore({
        isFrontPage: natResult.isFrontPage,
        category: catResult.category,
        publishedDate: art.pubDate,
        targetDate,
        desk: art.desk,
      });

      result.push({ packet, score });
    }

    return result;
  };

  // 1. Articles published on targetDate
  let scored = scoreAndFilter(articlesByDate.get(targetDate) || []);

  // 2. If fewer than 5 usable ones, add previous 1 to 3 days (never later)
  if (scored.length < 5) {
    const prevDays = [prev1, prev2, prev3];
    for (const d of prevDays) {
      const extra = scoreAndFilter(articlesByDate.get(d) || []);
      scored = scored.concat(extra);
      if (scored.length >= 5) break;
    }
  }

  // Sort by score descending, then headline
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.packet.headline.localeCompare(b.packet.headline);
  });

  // Keep the top 8 to 10
  const topPackets = scored.slice(0, 10).map((s) => s.packet);
  return topPackets;
}

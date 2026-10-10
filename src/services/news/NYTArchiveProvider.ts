/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsProvider, ProviderFactResult, FactItem, ExcludedFactItem } from './types.js';
import { readNewsCache, writeNewsCache, recordNewsApiCall, recordNewsCacheHit } from './newsCache.js';
import { normalizeCategory, extractDateString } from './categoryNormalizer.js';
import { evaluateNYTNationalFocus } from './nationalFocusFilter.js';

// Rate-limiting queue for NYT: 5 requests/minute allowed (12s spacing safe baseline, min 6s)
let lastNytCallTimestamp = 0;
const NYT_MIN_INTERVAL_MS = 6500; // 6.5s spacing between remote calls

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
 * Helper to compute date N days before a given YYYY-MM-DD
 */
function getDateNDaysBefore(dateStr: string, n: number): string {
  const [year, month, day] = dateStr.split('-').map((v) => parseInt(v, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().split('T')[0];
}

/**
 * NYT Archive API Provider
 * Environment Variable: NYT_API_KEY
 * Uses the New York Times Archive API (monthly endpoints: https://api.nytimes.com/svc/archive/v1/{year}/{month}.json).
 * Then filters down to the target date plus the 2 days before it (targetDate, targetDate - 1, targetDate - 2).
 * Caches monthly responses on disk to respect the NYT rate limit.
 * Supports national focus filtering (exclude NYC-local coverage).
 */
export class NYTArchiveProvider implements NewsProvider {
  readonly id = 'nyt' as const;
  readonly name = 'New York Times (Archive API)';

  isConfigured(): boolean {
    return Boolean(process.env.NYT_API_KEY && process.env.NYT_API_KEY.trim());
  }

  async fetchFacts(
    targetDate: string,
    forceFresh = false,
    nationalFocus = true
  ): Promise<ProviderFactResult> {
    if (!this.isConfigured()) {
      return {
        provider: this.id,
        providerName: this.name,
        status: 'NOT CONFIGURED',
        itemCount: 0,
        items: [],
        error: 'API key missing: NYT_API_KEY is not configured in server environment.',
      };
    }

    const [yearStr, monthStr] = targetDate.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    if (isNaN(year) || isNaN(month) || year < 1851) {
      return {
        provider: this.id,
        providerName: this.name,
        status: 'OUT OF RANGE',
        itemCount: 0,
        items: [],
        error: `Date ${targetDate} is outside NYT Archive range (1851 - present).`,
      };
    }

    // Target range: target date plus the 2 days before it
    const twoDaysBefore = getDateNDaysBefore(targetDate, 2);
    const oneDayBefore = getDateNDaysBefore(targetDate, 1);
    const validDates = new Set([twoDaysBefore, oneDayBefore, targetDate]);

    // Month cache key: e.g. "nyt_archive_1985_7"
    const monthCacheKey = `nyt_archive_${year}_${month}`;
    let rawMonthData: any = null;

    if (!forceFresh) {
      rawMonthData = readNewsCache<any>(monthCacheKey);
      if (rawMonthData) {
        recordNewsCacheHit(this.id);
      }
    }

    if (!rawMonthData) {
      // Throttle remote call to respect NYT rate limits
      await throttleNytCall();

      const apiKey = process.env.NYT_API_KEY!.trim();
      const url = `https://api.nytimes.com/svc/archive/v1/${year}/${month}.json?api-key=${encodeURIComponent(apiKey)}`;

      recordNewsApiCall(this.id);

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'RetroFM/1.0.6 (Historical Fact Packet Test)',
            Accept: 'application/json',
          },
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          const errMsg = data?.fault?.faultstring || data?.message || `HTTP ${res.status}: ${res.statusText}`;
          const isRateLimit = res.status === 429 || errMsg.toLowerCase().includes('rate');
          return {
            provider: this.id,
            providerName: this.name,
            status: isRateLimit ? 'ERROR' : res.status === 404 ? 'OUT OF RANGE' : 'ERROR',
            itemCount: 0,
            items: [],
            error: isRateLimit ? `NYT Rate limit reached: ${errMsg}` : errMsg,
            rawResponse: data,
            cached: false,
          };
        }

        rawMonthData = data;
        writeNewsCache(monthCacheKey, rawMonthData);
      } catch (err: any) {
        return {
          provider: this.id,
          providerName: this.name,
          status: 'ERROR',
          itemCount: 0,
          items: [],
          error: err?.message || 'Failed connecting to NYT Archive API',
          cached: false,
        };
      }
    }

    // Filter monthly articles to target date plus the 2 days before it
    const rawDocs = rawMonthData?.response?.docs;
    if (!Array.isArray(rawDocs)) {
      return {
        provider: this.id,
        providerName: this.name,
        status: 'EMPTY',
        itemCount: 0,
        items: [],
        rawResponse: rawMonthData,
        cached: Boolean(rawMonthData),
      };
    }

    const items: FactItem[] = [];
    const excludedItems: ExcludedFactItem[] = [];

    for (const doc of rawDocs) {
      const pubDate = extractDateString(doc.pub_date);

      // Requirement: Drop any item whose published date is after the selected date
      if (pubDate && pubDate > targetDate) {
        continue;
      }

      // Filter down to the target date plus the 2 days before it
      if (!pubDate || !validDates.has(pubDate)) {
        continue;
      }

      const headline = (doc.headline?.main || doc.headline?.print_headline || '').trim();
      // Requirement: abstract or description only, never full article text
      const summary = (doc.abstract || doc.snippet || doc.lead_paragraph || '').trim();

      if (!headline && !summary) continue;

      const rawCategory = `${doc.section_name || ''} ${doc.news_desk || ''} ${doc.subsection_name || ''}`;
      const category = normalizeCategory(rawCategory, `${headline} ${summary}`);

      // National Focus filter evaluation
      if (nationalFocus) {
        const evalResult = evaluateNYTNationalFocus(doc);
        if (!evalResult.keep) {
          excludedItems.push({
            headline: headline || 'Untitled NYT Item',
            publishedDate: pubDate,
            category,
            reason: evalResult.reason,
            desk: doc.news_desk,
            section: doc.section_name,
          });
          continue; // Exclude from kept items
        }

        items.push({
          headline: headline || 'New York Times Report',
          summary,
          category,
          publishedDate: pubDate,
          source: 'The New York Times',
          url: doc.web_url || '',
          provider: this.id,
          nationalFocusReason: evalResult.reason,
          isFrontPage: evalResult.isFrontPage,
          desk: doc.news_desk,
        });
      } else {
        // Without national focus filter
        items.push({
          headline: headline || 'New York Times Report',
          summary,
          category,
          publishedDate: pubDate,
          source: 'The New York Times',
          url: doc.web_url || '',
          provider: this.id,
          desk: doc.news_desk,
        });
      }
    }

    // Sort items by date descending, then headline
    items.sort((a, b) => {
      if (a.publishedDate !== b.publishedDate) {
        return b.publishedDate.localeCompare(a.publishedDate);
      }
      return a.headline.localeCompare(b.headline);
    });

    const keptCount = items.length;
    const excludedCount = excludedItems.length;

    return {
      provider: this.id,
      providerName: this.name,
      status: items.length > 0 ? 'OK' : 'EMPTY',
      itemCount: items.length,
      items,
      excludedItems,
      keptCount,
      excludedCount,
      nationalFocusEnabled: nationalFocus,
      rawResponse: {
        totalMonthDocs: rawDocs.length,
        filteredDocsCount: items.length,
        excludedDocsCount: excludedItems.length,
        filterWindow: Array.from(validDates),
        nationalFocus,
        sampleDocs: rawDocs.slice(0, 3),
      },
      cached: Boolean(rawMonthData),
    };
  }
}

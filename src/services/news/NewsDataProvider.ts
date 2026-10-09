/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsProvider, ProviderFactResult, FactItem } from './types.js';
import { readNewsCache, writeNewsCache, recordNewsApiCall, recordNewsCacheHit } from './newsCache.js';
import { normalizeCategory, extractDateString } from './categoryNormalizer.js';

/**
 * NewsData.io Provider
 * Environment Variable: NEWSDATA_API_KEY
 * Note: NewsData.io free tier searches recent articles (up to 48-72h) or archive with paid plan.
 * Historical queries will legitimately return OUT OF RANGE or empty/error depending on plan.
 */
export class NewsDataProvider implements NewsProvider {
  readonly id = 'newsdata' as const;
  readonly name = 'NewsData.io';

  isConfigured(): boolean {
    return Boolean(process.env.NEWSDATA_API_KEY && process.env.NEWSDATA_API_KEY.trim());
  }

  async fetchFacts(targetDate: string, forceFresh = false): Promise<ProviderFactResult> {
    if (!this.isConfigured()) {
      return {
        provider: this.id,
        providerName: this.name,
        status: 'NOT CONFIGURED',
        itemCount: 0,
        items: [],
        error: 'API key missing: NEWSDATA_API_KEY is not configured in server environment.',
      };
    }

    const cacheKey = `newsdata_${targetDate}`;
    if (!forceFresh) {
      const cached = readNewsCache<ProviderFactResult>(cacheKey);
      if (cached) {
        recordNewsCacheHit(this.id);
        return { ...cached, cached: true };
      }
    }

    const apiKey = process.env.NEWSDATA_API_KEY!.trim();
    // Check archive vs standard endpoint
    const url = new URL('https://newsdata.io/api/1/archive');
    url.searchParams.set('apikey', apiKey);
    url.searchParams.set('from_date', targetDate);
    url.searchParams.set('to_date', targetDate);
    url.searchParams.set('language', 'en');

    recordNewsApiCall(this.id);

    try {
      const res = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'RetroFM/1.0.6 (Historical Fact Packet Test)',
        },
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || data?.status === 'error') {
        const errorMsg =
          data?.results?.message ||
          data?.message ||
          `HTTP ${res.status}: ${res.statusText}`;

        const isOutOfRange =
          errorMsg.toLowerCase().includes('plan') ||
          errorMsg.toLowerCase().includes('upgrade') ||
          errorMsg.toLowerCase().includes('range') ||
          errorMsg.toLowerCase().includes('archive') ||
          errorMsg.toLowerCase().includes('date');

        const result: ProviderFactResult = {
          provider: this.id,
          providerName: this.name,
          status: isOutOfRange ? 'OUT OF RANGE' : 'ERROR',
          itemCount: 0,
          items: [],
          error: errorMsg,
          rawResponse: data,
          cached: false,
        };
        writeNewsCache(cacheKey, result);
        return result;
      }

      const rawResults = Array.isArray(data?.results) ? data.results : [];
      const items: FactItem[] = [];

      for (const article of rawResults) {
        const pubDate = extractDateString(article.pubDate);
        // Drop any item whose published date is after selected date
        if (pubDate && pubDate > targetDate) {
          continue;
        }

        const headline = (article.title || '').trim();
        const summary = (article.description || '').trim();
        if (!headline && !summary) continue;

        const rawCategory = Array.isArray(article.category)
          ? article.category.join(' ')
          : String(article.category || '');

        items.push({
          headline: headline || 'No headline',
          summary: summary || '',
          category: normalizeCategory(rawCategory, `${headline} ${summary}`),
          publishedDate: pubDate || targetDate,
          source: article.source_id || article.source_name || 'NewsData.io',
          url: article.link || '',
          provider: this.id,
        });
      }

      const result: ProviderFactResult = {
        provider: this.id,
        providerName: this.name,
        status: items.length > 0 ? 'OK' : 'EMPTY',
        itemCount: items.length,
        items,
        rawResponse: data,
        cached: false,
      };

      writeNewsCache(cacheKey, result);
      return result;
    } catch (err: any) {
      const result: ProviderFactResult = {
        provider: this.id,
        providerName: this.name,
        status: 'ERROR',
        itemCount: 0,
        items: [],
        error: err?.message || 'Failed connecting to NewsData.io',
        cached: false,
      };
      return result;
    }
  }
}

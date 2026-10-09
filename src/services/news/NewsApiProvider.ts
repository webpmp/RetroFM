/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsProvider, ProviderFactResult, FactItem } from './types.js';
import { readNewsCache, writeNewsCache, recordNewsApiCall, recordNewsCacheHit } from './newsCache.js';
import { normalizeCategory, extractDateString } from './categoryNormalizer.js';

/**
 * NewsAPI.org Provider
 * Environment Variable: NEWSAPI_KEY
 * Note: NewsAPI Developer tier restricts /v2/everything queries to articles no older than 1 month.
 * Historical queries (>1 month ago) will legitimately return an error or empty from the upstream API.
 */
export class NewsApiProvider implements NewsProvider {
  readonly id = 'newsapi' as const;
  readonly name = 'NewsAPI.org';

  isConfigured(): boolean {
    return Boolean(process.env.NEWSAPI_KEY && process.env.NEWSAPI_KEY.trim());
  }

  async fetchFacts(targetDate: string, forceFresh = false): Promise<ProviderFactResult> {
    if (!this.isConfigured()) {
      return {
        provider: this.id,
        providerName: this.name,
        status: 'NOT CONFIGURED',
        itemCount: 0,
        items: [],
        error: 'API key missing: NEWSAPI_KEY is not configured in server environment.',
      };
    }

    const cacheKey = `newsapi_${targetDate}`;
    if (!forceFresh) {
      const cached = readNewsCache<ProviderFactResult>(cacheKey);
      if (cached) {
        recordNewsCacheHit(this.id);
        return { ...cached, cached: true };
      }
    }

    // Check if date is older than ~30 days (documented limitation for developer tier)
    const targetTime = new Date(targetDate).getTime();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const isHistorical = targetTime < thirtyDaysAgo;

    const apiKey = process.env.NEWSAPI_KEY!.trim();
    const url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', 'news OR world OR event');
    url.searchParams.set('from', targetDate);
    url.searchParams.set('to', targetDate);
    url.searchParams.set('sortBy', 'relevancy');
    url.searchParams.set('pageSize', '50');

    recordNewsApiCall(this.id);

    try {
      const res = await fetch(url.toString(), {
        headers: {
          'X-Api-Key': apiKey,
          'User-Agent': 'RetroFM/1.0.6 (Historical Fact Packet Test)',
        },
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || data?.status === 'error') {
        const message = data?.message || `HTTP ${res.status}: ${res.statusText}`;
        const isOutOfRange =
          isHistorical ||
          message.toLowerCase().includes('too far in the past') ||
          message.toLowerCase().includes('upgrade to a paid plan') ||
          message.toLowerCase().includes('older than');

        const result: ProviderFactResult = {
          provider: this.id,
          providerName: this.name,
          status: isOutOfRange ? 'OUT OF RANGE' : 'ERROR',
          itemCount: 0,
          items: [],
          error: message,
          rawResponse: data,
          cached: false,
        };
        writeNewsCache(cacheKey, result);
        return result;
      }

      const rawArticles = Array.isArray(data?.articles) ? data.articles : [];
      const items: FactItem[] = [];

      for (const article of rawArticles) {
        const pubDate = extractDateString(article.publishedAt);
        // Requirement: Drop any item whose published date is after the selected date
        if (pubDate && pubDate > targetDate) {
          continue;
        }

        const headline = (article.title || '').trim();
        const summary = (article.description || '').trim();
        if (!headline && !summary) continue;

        items.push({
          headline: headline || 'No headline',
          summary: summary || '',
          category: normalizeCategory(undefined, `${headline} ${summary}`),
          publishedDate: pubDate || targetDate,
          source: article.source?.name || 'NewsAPI',
          url: article.url || '',
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
        error: err?.message || 'Failed connecting to NewsAPI.org',
        cached: false,
      };
      return result;
    }
  }
}

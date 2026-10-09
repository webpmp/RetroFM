/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsProvider, FactPacket, ProviderFactResult, FactCategory } from './types.js';
import { NewsApiProvider } from './NewsApiProvider.js';
import { NewsDataProvider } from './NewsDataProvider.js';
import { NYTArchiveProvider } from './NYTArchiveProvider.js';
import { getNewsSessionStats } from './newsCache.js';

export const providers: Record<'newsapi' | 'newsdata' | 'nyt', NewsProvider> = {
  newsapi: new NewsApiProvider(),
  newsdata: new NewsDataProvider(),
  nyt: new NYTArchiveProvider(),
};

/**
 * Builds a normalized FactPacket across all three providers for a given target date.
 */
export async function buildFactPacket(targetDate: string, forceFresh = false): Promise<FactPacket> {
  const providerKeys: ('newsapi' | 'newsdata' | 'nyt')[] = ['newsapi', 'newsdata', 'nyt'];

  // Run each provider
  const resultsArr = await Promise.all(
    providerKeys.map(async (key) => {
      const provider = providers[key];
      try {
        return await provider.fetchFacts(targetDate, forceFresh);
      } catch (err: any) {
        const errorResult: ProviderFactResult = {
          provider: key,
          providerName: provider.name,
          status: 'ERROR',
          itemCount: 0,
          items: [],
          error: err?.message || 'Unexpected provider execution error',
        };
        return errorResult;
      }
    })
  );

  const results: Record<'newsapi' | 'newsdata' | 'nyt', ProviderFactResult> = {
    newsapi: resultsArr[0],
    newsdata: resultsArr[1],
    nyt: resultsArr[2],
  };

  const countsPerCategory: Record<FactCategory, number> = {
    news: 0,
    sports: 0,
    'movies-tv-arts': 0,
    music: 0,
    business: 0,
    other: 0,
  };

  let totalCount = 0;

  for (const res of resultsArr) {
    for (const item of res.items) {
      if (countsPerCategory[item.category] !== undefined) {
        countsPerCategory[item.category]++;
      } else {
        countsPerCategory.other++;
      }
      totalCount++;
    }
  }

  return {
    targetDate,
    providersQueried: providerKeys,
    countsPerCategory,
    totalCount,
    results,
    generatedAt: new Date().toISOString(),
  };
}

export function getProviderConfigStatus(): Record<string, { configured: boolean; name: string }> {
  return {
    newsapi: {
      configured: providers.newsapi.isConfigured(),
      name: providers.newsapi.name,
    },
    newsdata: {
      configured: providers.newsdata.isConfigured(),
      name: providers.newsdata.name,
    },
    nyt: {
      configured: providers.nyt.isConfigured(),
      name: providers.nyt.name,
    },
  };
}

export { getNewsSessionStats };

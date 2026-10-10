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
 * Builds a normalized FactPacket for a given target date.
 * NewsAPI.org and NewsData.io are stopped by default; NYT is the active news source.
 * nationalFocus: When true, filters out NYC-local stories and keeps national/front-page/national-desk items.
 */
export async function buildFactPacket(
  targetDate: string,
  forceFresh = false,
  providersToQuery: ('newsapi' | 'newsdata' | 'nyt')[] = ['nyt'],
  nationalFocus = true
): Promise<FactPacket> {
  const providerKeys: ('newsapi' | 'newsdata' | 'nyt')[] = providersToQuery;

  // Run each requested provider
  const resultsArr = await Promise.all(
    providerKeys.map(async (key) => {
      const provider = providers[key];
      try {
        return await provider.fetchFacts(targetDate, forceFresh, nationalFocus);
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
    newsapi: resultsArr.find((r) => r.provider === 'newsapi') || {
      provider: 'newsapi',
      providerName: providers.newsapi.name,
      status: 'NOT CONFIGURED',
      itemCount: 0,
      items: [],
    },
    newsdata: resultsArr.find((r) => r.provider === 'newsdata') || {
      provider: 'newsdata',
      providerName: providers.newsdata.name,
      status: 'NOT CONFIGURED',
      itemCount: 0,
      items: [],
    },
    nyt: resultsArr.find((r) => r.provider === 'nyt') || {
      provider: 'nyt',
      providerName: providers.nyt.name,
      status: 'NOT CONFIGURED',
      itemCount: 0,
      items: [],
    },
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
  let totalKept = 0;
  let totalExcluded = 0;
  const allExcludedItems: any[] = [];

  for (const res of resultsArr) {
    if (res.excludedItems) {
      allExcludedItems.push(...res.excludedItems);
    }
    totalKept += res.keptCount ?? res.itemCount;
    totalExcluded += res.excludedCount ?? 0;

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
    nationalFocusEnabled: nationalFocus,
    keptCount: totalKept,
    excludedCount: totalExcluded,
    excludedItems: allExcludedItems,
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

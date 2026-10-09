/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export type FactCategory = 'news' | 'sports' | 'movies-tv-arts' | 'music' | 'business' | 'other';

export interface FactItem {
  headline: string;
  summary: string;
  category: FactCategory;
  publishedDate: string; // ISO date string: YYYY-MM-DD
  source: string;
  url: string;
  provider: 'newsapi' | 'newsdata' | 'nyt';
}

export type ProviderStatus = 'OK' | 'EMPTY' | 'NOT CONFIGURED' | 'OUT OF RANGE' | 'ERROR';

export interface ProviderFactResult {
  provider: 'newsapi' | 'newsdata' | 'nyt';
  providerName: string;
  status: ProviderStatus;
  itemCount: number;
  items: FactItem[];
  error?: string;
  rawResponse?: any;
  cached?: boolean;
}

export interface FactPacket {
  targetDate: string; // YYYY-MM-DD
  providersQueried: ('newsapi' | 'newsdata' | 'nyt')[];
  countsPerCategory: Record<FactCategory, number>;
  totalCount: number;
  results: Record<'newsapi' | 'newsdata' | 'nyt', ProviderFactResult>;
  generatedAt: string;
}

export interface NewsProvider {
  readonly id: 'newsapi' | 'newsdata' | 'nyt';
  readonly name: string;
  isConfigured(): boolean;
  fetchFacts(targetDate: string, forceFresh?: boolean): Promise<ProviderFactResult>;
}

export interface FactSessionStats {
  apiCalls: Record<'newsapi' | 'newsdata' | 'nyt', number>;
  cacheHits: Record<'newsapi' | 'newsdata' | 'nyt', number>;
}

/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { FactCategory } from './types.js';

/**
 * Normalizes text, sections, desks, or sources into one of the 6 standard FactCategories:
 * 'news', 'sports', 'movies-tv-arts', 'music', 'business', 'other'
 */
export function normalizeCategory(rawCategory?: string, text?: string): FactCategory {
  const combined = `${rawCategory || ''} ${text || ''}`.toLowerCase();

  // Music check first (high value for Retro FM DJ)
  if (
    /\b(music|song|album|concert|band|billboard|grammy|rock|pop|singer|vocalist|hip hop|jazz|orchestra|record label)\b/.test(
      combined
    )
  ) {
    return 'music';
  }

  // Sports
  if (
    /\b(sport|sports|baseball|football|basketball|soccer|tennis|olympic|olympics|nfl|nba|mlb|nhl|golf|boxing|cup|race|championship|tournament)\b/.test(
      combined
    )
  ) {
    return 'sports';
  }

  // Movies / TV / Arts
  if (
    /\b(movie|movies|film|films|cinema|tv|television|theater|theatre|art|arts|actor|actress|hollywood|broadcast|broadway|oscar|emmy|exhibit|culture|entertainment)\b/.test(
      combined
    )
  ) {
    return 'movies-tv-arts';
  }

  // Business / Economy / Finance
  if (
    /\b(business|economy|economic|market|stock|stocks|wall street|inflation|trade|company|industry|corporate|merger|banking|financial|shares)\b/.test(
      combined
    )
  ) {
    return 'business';
  }

  // General news / politics / world / national
  if (
    /\b(news|politics|political|world|national|foreign|president|congress|senate|war|treaty|government|election|white house|united nations|un|crisis|policy)\b/.test(
      combined
    )
  ) {
    return 'news';
  }

  return 'other';
}

/**
 * Validates date string in YYYY-MM-DD format
 */
export function isValidDate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
}

/**
 * Parses published date string into YYYY-MM-DD
 */
export function extractDateString(rawDate?: string): string {
  if (!rawDate) return '';
  try {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch {
    // fallback regex matching
  }
  const match = String(rawDate).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : '';
}

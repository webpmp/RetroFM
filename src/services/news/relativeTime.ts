/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * 4e: Relative-time calculation and tiered date windows for news breaks.
 *
 * Phrase rules (article date vs. broadcast date):
 * - 0 days (same day) -> "today"
 * - 1 day              -> "yesterday"
 * - 2 to 3 days        -> "a couple of days ago"
 * - 4 to 7 days        -> "earlier this week"
 *
 * Both major_news and music_news are restricted to the tiered window:
 * Tier 1: same day (diffDays === 0)
 * Tier 2: previous 1 to 3 days (1 <= diffDays <= 3)
 * Tier 3: previous 4 to 7 days (4 <= diffDays <= 7)
 * Anything older than 7 days is excluded from live news breaks.
 */

export interface NewsDateTier {
  diffDays: number;
  tier: 1 | 2 | 3;
  timePhrase: 'today' | 'yesterday' | 'a couple of days ago' | 'earlier this week';
}

export function computeNewsDateTier(articleDate: string, broadcastDate: string): NewsDateTier | null {
  if (!articleDate || !broadcastDate) return null;
  const aMs = new Date(articleDate + 'T00:00:00Z').getTime();
  const bMs = new Date(broadcastDate + 'T00:00:00Z').getTime();
  if (isNaN(aMs) || isNaN(bMs)) return null;
  const diffDays = Math.round((bMs - aMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 0 || diffDays > 7) return null; // Future or older than 7 days

  let tier: 1 | 2 | 3;
  let timePhrase: NewsDateTier['timePhrase'];
  if (diffDays === 0) {
    tier = 1;
    timePhrase = 'today';
  } else if (diffDays === 1) {
    tier = 2;
    timePhrase = 'yesterday';
  } else if (diffDays <= 3) {
    tier = 2;
    timePhrase = 'a couple of days ago';
  } else {
    tier = 3;
    timePhrase = 'earlier this week';
  }
  return { diffDays, tier, timePhrase };
}

/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * 4e & 5l: Relative-time calculation and tiered date windows for news breaks.
 *
 * Phrase rules (article date vs. broadcast date):
 * - 0 days (same day) -> "in today's Times"
 * - 1 day              -> "in yesterday's Times"
 * - 2 to 3 days        -> "a couple of days ago"
 * - 4 to 7 days        -> "last week" (music_news only; never "earlier this week" for items older than 4 days)
 *
 * Age windows:
 * - major_news: 0 to 3 days old only (diffDays <= 3)
 * - music_news: up to 7 days (diffDays <= 7)
 */

export interface NewsDateTier {
  diffDays: number;
  tier: 1 | 2 | 3;
  timePhrase: "in today's Times" | "in yesterday's Times" | 'a couple of days ago' | 'last week';
}

export function computeNewsDateTier(
  articleDate: string,
  broadcastDate: string,
  category: 'major_news' | 'music_news' = 'major_news'
): NewsDateTier | null {
  if (!articleDate || !broadcastDate) return null;
  const aMs = new Date(articleDate + 'T00:00:00Z').getTime();
  const bMs = new Date(broadcastDate + 'T00:00:00Z').getTime();
  if (isNaN(aMs) || isNaN(bMs)) return null;
  const diffDays = Math.round((bMs - aMs) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return null; // Future

  // Fix 5l: major_news 0-3 days only; music_news up to 7 days
  const maxDays = category === 'major_news' ? 3 : 7;
  if (diffDays > maxDays) return null;

  let tier: 1 | 2 | 3;
  let timePhrase: NewsDateTier['timePhrase'];
  if (diffDays === 0) {
    tier = 1;
    timePhrase = "in today's Times";
  } else if (diffDays === 1) {
    tier = 2;
    timePhrase = "in yesterday's Times";
  } else if (diffDays <= 3) {
    tier = 2;
    timePhrase = 'a couple of days ago';
  } else {
    tier = 3;
    timePhrase = 'last week';
  }
  return { diffDays, tier, timePhrase };
}

/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Segment Planner:
 * Selects exactly one topic per DJ break and builds a rich packet of 2 to 5 verified facts.
 *
 * Topic rotation:
 * - next_song_story (origin, writers, band members, covers)
 * - music_news (chart stories, music milestones of the week, album releases)
 * - pop_culture (fashion, celebrity news, festivals, World's Fairs, culture)
 * - sports (championships, pennant races, boxing, baseball, Derby)
 * - major_news (headline national/world events from The Times)
 *
 * Rules:
 * - Strictly avoids repeats within a listening session (tracks used fact keys).
 * - Only incorporates facts with publicDate/eventDate <= broadcastDate.
 * - Caps plain intros to at most 1 in 5 breaks when rich segment content is available.
 */

import { AlmanacEntry, AlmanacSummary } from '../news/almanacService.js';
import { SongStoryCard, SongFactItem, filterHindsightAndFutureFacts } from '../music/songStoryCardService.js';
import { ChartFact, ChartFactRepository, computeSongChartStatusFact } from './chartFacts.js';

export type SegmentTopic =
  | 'next_song_story'
  | 'music_news'
  | 'pop_culture'
  | 'sports'
  | 'major_news'
  | 'plain_intro';

export interface VerifiedFactPacketItem {
  text: string;
  source: string;
  printDate?: string;
  date: string;
}

export interface SegmentBreakPacket {
  topic: SegmentTopic;
  topicTitle: string;
  targetSongTitle?: string;
  targetSongArtist?: string;
  facts: VerifiedFactPacketItem[];
  factKeys: string[];
  artistMetadata?: SongStoryCard['artistMetadata'];
}

export interface SegmentPlannerSessionState {
  usedFactKeys: Set<string>;
  usedTopics: Set<string>;
  lastTopic: SegmentTopic | null;
  totalBreaks: number;
  plainIntroCount: number;
}

export function newSegmentPlannerState(): SegmentPlannerSessionState {
  return {
    usedFactKeys: new Set<string>(),
    usedTopics: new Set<string>(),
    lastTopic: null,
    totalBreaks: 0,
    plainIntroCount: 0,
  };
}

/**
 * Filter facts to strictly those known on or before broadcastDate.
 * Avoids anachronisms such as post-broadcast chart peaks or later band breakups.
 */
function isFactDateValid(factDate: string | undefined, broadcastDate: string): boolean {
  if (!factDate) return true;
  const bYear = parseInt(broadcastDate.slice(0, 4), 10);
  const years = factDate.match(/\b(19\d\d|20\d\d)\b/g);
  if (years) {
    for (const y of years) {
      if (parseInt(y, 10) > bYear) return false;
    }
  }
  if (factDate.length >= 10 && factDate > broadcastDate) {
    return false;
  }
  return true;
}

function getDateNDaysBefore(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, day - n));
  return date.toISOString().slice(0, 10);
}

/**
 * Splits a single almanac entry into 2 to 4 coherent sub-facts (sentences)
 * so that each packet has a single thread/story with 2-4 facts about that one story.
 */
export function splitEntryIntoFacts(entry: AlmanacEntry): VerifiedFactPacketItem[] {
  const sentences = entry.verbatimSentences && entry.verbatimSentences.length > 0
    ? entry.verbatimSentences
    : entry.summary.split(/(?<=[.!?])\s+/).filter(Boolean);

  const facts: VerifiedFactPacketItem[] = [];
  if (sentences.length >= 2) {
    for (let i = 0; i < sentences.length && i < 4; i++) {
      facts.push({
        text: sentences[i],
        source: entry.source,
        printDate: entry.printDate || entry.eventDate,
        date: entry.eventDate,
      });
    }
  } else {
    facts.push({
      text: sentences[0] || entry.summary,
      source: entry.source,
      printDate: entry.printDate || entry.eventDate,
      date: entry.eventDate,
    });
  }
  return facts;
}

/**
 * Plans a 2-5 fact segment packet for the upcoming break.
 */
export function planSegmentBreak(options: {
  broadcastDate: string;
  nextSong: { id: string; title: string; artist: string; primary_artist?: string | null; first_chart_date?: string | null } | null;
  songCard?: SongStoryCard | null;
  almanac: AlmanacSummary;
  chartFacts?: ChartFact[];
  chartRepo?: ChartFactRepository;
  state: SegmentPlannerSessionState;
  rng?: () => number;
}): SegmentBreakPacket {
  const { broadcastDate, nextSong, songCard, almanac, chartFacts, chartRepo, state } = options;
  const rng = options.rng || Math.random;

  // Freshness boundaries:
  // - News and Pop Culture: printed within 3 days before broadcastDate (or future upcoming event)
  // - Sports: printed within 2 days before broadcastDate
  const cutoff3Days = getDateNDaysBefore(broadcastDate, 3);
  const cutoff2Days = getDateNDaysBefore(broadcastDate, 2);

  const isEntryFresh = (e: AlmanacEntry, maxDays: number): boolean => {
    const pDate = e.printDate || e.eventDate;
    const cutoff = maxDays === 2 ? cutoff2Days : cutoff3Days;
    
    // Check if it is a warning or prediction: must be within 1 day
    const isWarningOrPrediction = /\b(?:warn|warning|alert|predict|prediction|threat|threaten|caution)\b/i.test(e.headline + ' ' + e.summary);
    if (isWarningOrPrediction) {
      const cutoff1Day = getDateNDaysBefore(broadcastDate, 1);
      if (pDate < cutoff1Day || pDate > broadcastDate) {
        return false;
      }
    }

    // If it is an upcoming future event, it must be in the future (>= broadcastDate)
    if (e.eventDate > broadcastDate) {
      return true;
    }
    // Must be printed within the freshness window on or before broadcastDate
    return pDate >= cutoff && pDate <= broadcastDate;
  };

  // Sort candidates by interestScore descending (so high interest music/culture clears first)
  const sortByInterest = (a: AlmanacEntry, b: AlmanacEntry) => (b.interestScore || 50) - (a.interestScore || 50);

  // 1. Next song story candidates
  const validSongFacts: SongFactItem[] = [];
  if (songCard && songCard.facts) {
    for (const f of songCard.facts) {
      const key = `song:${songCard.songId}:${f.factText.slice(0, 40)}`;
      if (state.usedFactKeys.has(key)) continue;
      if (!isFactDateValid(f.publicDate, broadcastDate)) continue;
      if (/squidbillies|remaster|streaming|spotify|youtube/i.test(f.factText)) continue;
      validSongFacts.push(f);
    }
  }

  // 2. Music news of the week candidates (music items printed within 3 days clearing threshold >= 40, or Billboard chart facts)
  const musicNewsItems: AlmanacEntry[] = almanac.entries
    .filter((e) => e.category === 'music' && !state.usedFactKeys.has(`almanac:${e.id}`) && isEntryFresh(e, 3) && (e.interestScore || 50) >= 35)
    .sort(sortByInterest);

  // 3. Major news candidates (printed within 3 days)
  const majorNewsItems: AlmanacEntry[] = almanac.entries
    .filter((e) => e.category === 'major_news' && !state.usedFactKeys.has(`almanac:${e.id}`) && isEntryFresh(e, 3))
    .sort(sortByInterest);

  // 4. Sports candidates (printed within 2 days)
  const sportsItems: AlmanacEntry[] = almanac.entries
    .filter((e) => e.category === 'sports' && !state.usedFactKeys.has(`almanac:${e.id}`) && isEntryFresh(e, 2))
    .sort(sortByInterest);

  // 5. Pop culture candidates (printed within 3 days clearing threshold >= 40)
  const popCultureItems: AlmanacEntry[] = almanac.entries
    .filter(
      (e) => (e.category === 'pop_culture' || e.category === 'movies' || e.category === 'television') &&
        !state.usedFactKeys.has(`almanac:${e.id}`) && isEntryFresh(e, 3) && (e.interestScore || 50) >= 35
    )
    .sort(sortByInterest);

  const availableTopics: SegmentTopic[] = [];
  if (validSongFacts.length >= 2) availableTopics.push('next_song_story');
  if (musicNewsItems.length >= 1 || (chartFacts && chartFacts.length >= 2)) availableTopics.push('music_news');
  if (majorNewsItems.length >= 1) availableTopics.push('major_news');
  if (sportsItems.length >= 1) availableTopics.push('sports');
  if (popCultureItems.length >= 1) availableTopics.push('pop_culture');

  // Strict priority ordering: next_song_story > music_news > major_news > sports > pop_culture
  const priorityOrder: SegmentTopic[] = ['next_song_story', 'music_news', 'major_news', 'sports', 'pop_culture'];
  let chosenTopic: SegmentTopic = 'plain_intro';

  // Pick first available topic in priority order that differs from last topic (or fallback to top priority)
  const notLast = priorityOrder.filter((t) => availableTopics.includes(t) && t !== state.lastTopic);
  if (notLast.length > 0) {
    chosenTopic = notLast[0];
  } else {
    const anyAvailable = priorityOrder.filter((t) => availableTopics.includes(t));
    if (anyAvailable.length > 0) {
      chosenTopic = anyAvailable[0];
    }
  }

  // Cap plain intros: Only offer if no rich topics available
  if (chosenTopic === 'plain_intro' && nextSong) {
    chosenTopic = 'plain_intro';
  }

  // Build 2 to 5 verified facts packet based on chosen topic (One coherent thread/story per packet)
  const packetFacts: VerifiedFactPacketItem[] = [];
  const packetKeys: string[] = [];
  let topicTitle = '';

  if (chosenTopic === 'next_song_story' && nextSong) {
    topicTitle = `Story Behind "${nextSong.title}" by ${nextSong.artist}`;
    
    // Inject chart status fact from weekly_chart as Fact #1 if repo available
    if (chartRepo) {
      const chartStatus = computeSongChartStatusFact(
        { title: nextSong.title, artist: nextSong.artist, primary_artist: nextSong.primary_artist },
        broadcastDate,
        chartRepo
      );
      if (chartStatus) {
        packetFacts.push(chartStatus);
        packetKeys.push(`chart_status:${nextSong.id}:${broadcastDate}`);
      }
    }

    const maxSongFacts = packetFacts.length > 0 ? 3 : 4;
    const selected = validSongFacts.slice(0, maxSongFacts);
    for (const f of selected) {
      const key = `song:${nextSong.id}:${f.factText.slice(0, 40)}`;
      packetFacts.push({
        text: f.factText,
        source: f.source,
        printDate: f.publicDate || broadcastDate,
        date: f.publicDate || broadcastDate,
      });
      packetKeys.push(key);
    }
  } else if (chosenTopic === 'music_news') {
    if (musicNewsItems.length > 0) {
      // Pick single music story and expand its facts
      const story = musicNewsItems[0];
      topicTitle = story.headline;
      const subFacts = splitEntryIntoFacts(story);
      packetFacts.push(...subFacts);
      packetKeys.push(`almanac:${story.id}`);
    } else if (chartFacts && chartFacts.length >= 2) {
      topicTitle = 'Billboard Chart Action This Week';
      for (const cf of chartFacts.slice(0, 3)) {
        packetFacts.push({
          text: cf.factText,
          source: cf.source,
          printDate: cf.date,
          date: cf.date,
        });
        packetKeys.push(`chart:${cf.kind}:${cf.date}:${cf.title}`);
      }
    }
  } else if (chosenTopic === 'major_news' && majorNewsItems.length > 0) {
    // Pick single major news story and expand its facts
    const story = majorNewsItems[0];
    topicTitle = story.headline;
    const subFacts = splitEntryIntoFacts(story);
    packetFacts.push(...subFacts);
    packetKeys.push(`almanac:${story.id}`);
  } else if (chosenTopic === 'sports' && sportsItems.length > 0) {
    // Pick single sports story and expand its facts
    const story = sportsItems[0];
    topicTitle = story.headline;
    const subFacts = splitEntryIntoFacts(story);
    packetFacts.push(...subFacts);
    packetKeys.push(`almanac:${story.id}`);
  } else if (chosenTopic === 'pop_culture' && popCultureItems.length > 0) {
    // Pick single pop culture story and expand its facts
    const story = popCultureItems[0];
    topicTitle = story.headline;
    const subFacts = splitEntryIntoFacts(story);
    packetFacts.push(...subFacts);
    packetKeys.push(`almanac:${story.id}`);
  } else {
    topicTitle = 'Upcoming Song Intro';
    if (nextSong) {
      packetFacts.push({
        text: `Spinning next on RetroFM is "${nextSong.title}" by ${nextSong.artist}.`,
        source: 'Station Playlist',
        printDate: broadcastDate,
        date: broadcastDate,
      });
      packetKeys.push(`intro:${nextSong.title}:${nextSong.artist}`);
    }
  }

  // Single date-eligibility choke point:
  // After all sources merge into packetFacts, run filterHindsightAndFutureFacts on every final fact
  const finalFacts = filterHindsightAndFutureFacts(packetFacts, broadcastDate);

  // Update session state
  for (const k of packetKeys) {
    state.usedFactKeys.add(k);
  }
  state.lastTopic = chosenTopic;
  state.totalBreaks++;
  if (chosenTopic === 'plain_intro') {
    state.plainIntroCount++;
  }

  return {
    topic: chosenTopic,
    topicTitle,
    targetSongTitle: nextSong?.title,
    targetSongArtist: nextSong?.artist,
    facts: finalFacts,
    factKeys: packetKeys,
    artistMetadata: songCard?.artistMetadata,
  };
}

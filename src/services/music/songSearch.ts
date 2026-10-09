/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import manifest from '../../../extension/manifest.json';

export interface CandidateVideo {
  videoId: string;
  title: string;
  channel: string;
  duration?: string;
  durationSec?: number;
  score: number;
  reason: string;
  isPassed?: boolean;
  rejectionReason?: string;
  rankCategory?: 'TOPIC' | 'OFFICIAL_CHANNEL_OR_VEVO' | 'OFFICIAL_UPLOAD' | 'OTHER';
}

export interface MusicBrainzInfo {
  canonicalYear?: string;
  canonicalLengthSec?: number;
  canonicalLengths?: number[];
  recordingTitle?: string;
  artistCredit?: string;
}

export interface SongSearchResult {
  success: boolean;
  status: 'ok' | 'not_found' | 'api_error' | 'error';
  selected?: {
    title: string;
    videoId: string;
    channel: string;
    url: string;
    duration?: string;
    confidenceScore: number;
    reason: string;
  };
  canonicalInfo?: {
    year?: string;
    lengthSec?: number;
    formattedLength?: string;
  };
  candidatesCount?: number;
  candidates?: CandidateVideo[];
  rejectedCandidates?: CandidateVideo[];
  error?: string;
}

export interface CachedSongRecord {
  key: string;
  artist: string;
  song: string;
  year?: string;
  cachedAt: string;
  rawSearchData?: any;
  rawVideosData?: any;
  mbInfo?: MusicBrainzInfo | null;
  result: SongSearchResult;
}

export type DiskCacheMap = Record<string, CachedSongRecord>;

// In-memory cache by "artist|song"
const searchCache = new Map<string, SongSearchResult>();

// --- Quota Tracking (Session Units) ---
// YouTube Data API v3 quota costs: search.list = 100 units, videos.list = 1 unit.
interface SessionQuotaState {
  searchCalls: number;
  detailsCalls: number;
  cacheHits: number;
}

let sessionQuota: SessionQuotaState = {
  searchCalls: 0,
  detailsCalls: 0,
  cacheHits: 0,
};

export function recordQuotaUse(type: 'search' | 'details' | 'cache'): void {
  if (type === 'search') sessionQuota.searchCalls++;
  else if (type === 'details') sessionQuota.detailsCalls++;
  else if (type === 'cache') sessionQuota.cacheHits++;
}

export function getSessionQuota() {
  const totalUnitsUsed = sessionQuota.searchCalls * 100 + sessionQuota.detailsCalls * 1;
  const estimatedRemainingDaily = Math.max(0, 10000 - totalUnitsUsed);
  return {
    searchCalls: sessionQuota.searchCalls,
    detailsCalls: sessionQuota.detailsCalls,
    totalUnitsUsed,
    cacheHits: sessionQuota.cacheHits,
    estimatedRemainingDaily,
  };
}

export function resetSessionQuota(): void {
  sessionQuota = { searchCalls: 0, detailsCalls: 0, cacheHits: 0 };
}

// --- Persistent Disk Cache ---
function getCacheFilePath(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, '../../../cache/music-search-cache.json');
  } catch {
    return path.resolve(process.cwd(), 'cache', 'music-search-cache.json');
  }
}

let diskCache: DiskCacheMap = {};

export function loadDiskCache(): DiskCacheMap {
  try {
    const filePath = getCacheFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      diskCache = JSON.parse(content);
      return diskCache;
    }
  } catch (err) {
    console.warn('[songSearch] Could not read disk cache:', err);
  }
  diskCache = {};
  return diskCache;
}

export function saveDiskCache(): void {
  try {
    const filePath = getCacheFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(diskCache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[songSearch] Could not save disk cache:', err);
  }
}

// Initialize disk cache on module load
loadDiskCache();

/**
 * Clears the search cache (in-memory, optionally disk)
 */
export function clearSearchCache(clearDisk: boolean = false): void {
  searchCache.clear();
  if (clearDisk) {
    diskCache = {};
    saveDiskCache();
  }
}

/**
 * Checks if an HTTP status or error payload indicates a YouTube API quota or key error
 */
export function isQuotaOrKeyError(status: number, errorText: string): boolean {
  if (status === 429) return true;
  const lower = (errorText || '').toLowerCase();
  return (
    lower.includes('quotaexceeded') ||
    lower.includes('dailylimitexceeded') ||
    lower.includes('ratelimitexceeded') ||
    lower.includes('exceeded your quota') ||
    lower.includes('quota') ||
    lower.includes('keyinvalid') ||
    lower.includes('api key not valid') ||
    lower.includes('developerkeyinvalid') ||
    lower.includes('billing') ||
    (status === 403 &&
      (lower.includes('forbidden') ||
        lower.includes('accessnotconfigured') ||
        lower.includes('usage limits')))
  );
}

export const QUOTA_ERROR_MESSAGE =
  'YouTube API daily quota exceeded. It resets at midnight Pacific time.';

// MusicBrainz rate-limiter: at most 1 request per second
let lastMusicBrainzRequestTime = 0;

async function rateLimitMusicBrainz(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastMusicBrainzRequestTime;
  if (elapsed < 1200) {
    const waitMs = 1200 - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastMusicBrainzRequestTime = Date.now();
}

/**
 * Load overrides from src/services/music/overrides.json
 */
export function loadOverrides(): Record<string, string> {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const overridesPath = path.resolve(__dirname, 'overrides.json');
    if (fs.existsSync(overridesPath)) {
      const data = fs.readFileSync(overridesPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('[songSearch] Could not read overrides.json:', err);
  }
  return {};
}

/**
 * Normalizes artist and song into a consistent cache/override key
 */
export function getLookupKey(artist: string, song: string): string {
  return `${artist.trim().toLowerCase()}|${song.trim().toLowerCase()}`;
}

/**
 * Whole-word matching check (case-insensitive)
 */
export function matchesWholeWord(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, 'i');
  return regex.test(haystack);
}

/**
 * Parses ISO 8601 duration string (e.g. PT3M47S, PT4M, PT1H2M3S) into seconds
 */
export function parseIsoDuration(durationStr: string): number {
  if (!durationStr) return 0;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Formats duration in seconds to M:SS or H:MM:SS string
 */
export function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Decodes standard HTML entities commonly returned by YouTube API
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Queries MusicBrainz for canonical release year and length.
 * At most 1 request per second. Descriptive User-Agent.
 * If it finds nothing or errors, continues gracefully without it.
 */
export async function lookupMusicBrainz(
  artist: string,
  song: string,
  requestedYear?: string
): Promise<MusicBrainzInfo | null> {
  try {
    await rateLimitMusicBrainz();

    const cleanArtist = artist.trim();
    const cleanSong = song.trim();
    // Query MusicBrainz with song name and artist (including prefix for groups like Prince and the Revolution)
    const artistPrefix = cleanArtist.split(/\s+/)[0];
    const query = `recording:"${cleanSong}" AND (artist:"${cleanArtist}" OR artist:${artistPrefix}*)`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=100&fmt=json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `RetroFM/${manifest.version} ( https://github.com/webpmp/RetroFM/issues )`,
        Accept: 'application/json',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    const recordings: any[] = data.recordings || [];
    if (recordings.length === 0) {
      return null;
    }

    // Filter clean studio recordings (ignore live, rehearsal, remix, karaoke, tribute, dj-mix, alternate arrangements)
    // Canonical pop/rock studio recording length must fall strictly within the standard 2:00 to 9:00 window (120s to 540s)
    const cleanRecordings = recordings.filter((r) => {
      if (typeof r.length !== 'number') return false;
      const lenSec = Math.round(r.length / 1000);
      if (lenSec < 120 || lenSec > 540) return false;
      const d = (r.disambiguation || '').toLowerCase();
      const t = (r.title || '').toLowerCase();
      const forbidden = [
        'live',
        'rehearsal',
        'remix',
        'karaoke',
        'tribute',
        'cover',
        'soundcheck',
        'dj-mix',
        'instrumental',
        'acoustic',
        'unplugged',
        'demo',
        'stripped',
        'orchestral',
        'piano version',
        'piano',
        'reimagined',
        'session',
        'radio session',
        'live version',
        'extended',
        '12″',
        '12"',
        'megamix',
      ];
      for (const term of forbidden) {
        if (d.includes(term)) return false;
        if (t.includes(`(${term}`) || t.includes(`[${term}`)) return false;
      }
      return true;
    });

    const reqYear = requestedYear ? parseInt(requestedYear.trim(), 10) : NaN;
    const hasValidReqYear = !isNaN(reqYear) && reqYear >= 1900 && reqYear <= 2100;

    // Helper to extract all valid release years associated with a recording
    function getRecordingYears(rec: any): number[] {
      const years: number[] = [];
      if (rec['first-release-date'] && /^\d{4}/.test(rec['first-release-date'])) {
        years.push(parseInt(rec['first-release-date'].substring(0, 4), 10));
      }
      if (Array.isArray(rec.releases)) {
        for (const rel of rec.releases) {
          if (rel.date && /^\d{4}/.test(rel.date)) {
            years.push(parseInt(rel.date.substring(0, 4), 10));
          }
        }
      }
      return [...new Set(years)].filter((y) => y >= 1900 && y <= 2100);
    }

    if (cleanRecordings.length === 0) {
      // No clean studio recordings found with known duration within standard 2:00 - 9:00 bounds.
      // Treat duration as unknown so Rule 2 standard fallback window (2:00 - 9:00) applies gracefully.
      return {
        canonicalYear: requestedYear,
        canonicalLengthSec: undefined,
        canonicalLengths: [],
        recordingTitle: recordings[0]?.title,
        artistCredit: recordings[0]?.['artist-credit']?.[0]?.name,
      };
    }

    if (hasValidReqYear) {
      // Treat the user's requested year as the source of truth.
      // When MusicBrainz returns several recordings of the song, use the length of the one
      // whose release year is closest to the requested year (within 1 year).
      // If none is that close, ignore the MusicBrainz length and use the 2:00–9:00 window instead.
      let bestDiff = Infinity;
      const recordingsWithDiff = cleanRecordings.map((r) => {
        const years = getRecordingYears(r);
        const diff = years.length > 0 ? Math.min(...years.map((y) => Math.abs(y - reqYear))) : Infinity;
        if (diff < bestDiff) {
          bestDiff = diff;
        }
        return { recording: r, diff };
      });

      if (bestDiff <= 1) {
        // Collect recordings within 1 year of requested year
        const closeRecordings = recordingsWithDiff.filter((item) => item.diff <= 1);
        // Prefer minimal diff, then prefer "album" in disambiguation or standard title
        closeRecordings.sort((a, b) => {
          if (a.diff !== b.diff) return a.diff - b.diff;
          const aDis = (a.recording.disambiguation || '').toLowerCase();
          const bDis = (b.recording.disambiguation || '').toLowerCase();
          if (aDis.includes('album') && !bDis.includes('album')) return -1;
          if (!aDis.includes('album') && bDis.includes('album')) return 1;
          return 0;
        });

        const chosen = closeRecordings[0].recording;
        const chosenLenSec = Math.round(chosen.length / 1000);
        const lengthsWithin1Year = Array.from(
          new Set(closeRecordings.map((item) => Math.round(item.recording.length / 1000)))
        );

        return {
          canonicalYear: requestedYear,
          canonicalLengthSec: chosenLenSec,
          canonicalLengths: lengthsWithin1Year,
          recordingTitle: chosen.title,
          artistCredit: chosen['artist-credit']?.[0]?.name,
        };
      } else {
        // None is within 1 year: ignore MusicBrainz length, fall back to 2:00 - 9:00 window
        return {
          canonicalYear: requestedYear,
          canonicalLengthSec: undefined,
          canonicalLengths: [],
          recordingTitle: cleanRecordings[0]?.title,
          artistCredit: cleanRecordings[0]?.['artist-credit']?.[0]?.name,
        };
      }
    }

    // Fallback if no valid requestedYear provided
    cleanRecordings.sort((a, b) => {
      const aDis = (a.disambiguation || '').toLowerCase();
      const bDis = (b.disambiguation || '').toLowerCase();
      if (aDis.includes('album') && !bDis.includes('album')) return -1;
      if (!aDis.includes('album') && bDis.includes('album')) return 1;
      const aYear = a['first-release-date'] ? parseInt(a['first-release-date'].substring(0, 4), 10) : 9999;
      const bYear = b['first-release-date'] ? parseInt(b['first-release-date'].substring(0, 4), 10) : 9999;
      return aYear - bYear;
    });

    const candidate = cleanRecordings[0];
    const lengthSec = candidate?.length ? Math.round(candidate.length / 1000) : undefined;
    return {
      canonicalYear: candidate?.['first-release-date']?.substring(0, 4),
      canonicalLengthSec: lengthSec,
      canonicalLengths: lengthSec ? [lengthSec] : [],
      recordingTitle: candidate?.title,
      artistCredit: candidate?.['artist-credit']?.[0]?.name,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Pure scoring function that evaluates a candidate against the 4 hard rejection rules
 * and ranks survivors according to canonical music release hierarchy.
 *
 * Hard rejection rules:
 * 1. Artist name must appear as a whole word in video title or channel name.
 * 2. Duration must be within 15 seconds of MusicBrainz length, or between 2:00 and 9:00 if unknown.
 * 3. Reject titles containing: cover, karaoke, reaction, interview, tribute, parody, remix,
 *    slowed, sped up, nightcore, 8D, mashup, tutorial, lesson, compilation, "1 hour", loop,
 *    acoustic, unplugged, demo, stripped, orchestral, piano version, reimagined, session,
 *    "live version", "radio session", using whole-word matching only.
 * 4. Reject live versions unless live was requested, including "(Live)".
 *
 * Ranking the survivors:
 * - Tier 1: "Artist - Topic" channels (YouTube Music Topic channels)
 * - Tier 2: Artist's official channel or VEVO
 * - Tier 3: Other "Official Video/Audio" uploads
 * - Tier 4: Other matching uploads
 *
 * Within the same tier:
 * - Prefer titles with no parenthetical qualifier at all (+150)
 * - Then those with an allowed qualifier: Remaster/Remastered, Single Edit, Single Version,
 *   Album Version, Video Version, Radio Edit (+75)
 * - Small duration-closeness bonus (0-10) to never override title preferences.
 */
export function scoreCandidateVideo(
  video: {
    videoId: string;
    title: string;
    channel: string;
    durationSec: number;
    durationStr?: string;
  },
  artist: string,
  song: string,
  mbInfo?: MusicBrainzInfo | null,
  requestedYear?: string
): CandidateVideo {
  const tDecoded = decodeHtmlEntities(video.title);
  const cDecoded = decodeHtmlEntities(video.channel);
  const durSec = video.durationSec;
  const durFormatted = video.durationStr || formatDuration(durSec);

  // --- HARD REJECTION RULE 1 ---
  // The artist name must appear as a whole word in the video title or channel name
  const artistInTitle = matchesWholeWord(tDecoded, artist);
  const artistInChannel = matchesWholeWord(cDecoded, artist);

  if (!artistInTitle && !artistInChannel) {
    return {
      videoId: video.videoId,
      title: tDecoded,
      channel: cDecoded,
      duration: durFormatted,
      durationSec: durSec,
      score: -100,
      isPassed: false,
      rejectionReason: `Artist "${artist}" not found as whole word in title or channel`,
      reason: `Rejected (Rule 1): Artist "${artist}" must appear as a whole word in video title or channel name. Neither contained it.`,
    };
  }

  // --- HARD GATE: SONG TITLE AS WHOLE WORDS IN VIDEO TITLE ---
  // The video title must contain the requested song title as whole words.
  // Rejects other songs by the same artist (e.g. "Big Time" when searching "Sledgehammer").
  if (!matchesWholeWord(tDecoded, song)) {
    return {
      videoId: video.videoId,
      title: tDecoded,
      channel: cDecoded,
      duration: durFormatted,
      durationSec: durSec,
      score: -150,
      isPassed: false,
      rejectionReason: `Title does not contain song title "${song}" as whole words`,
      reason: `Rejected: Video title "${tDecoded}" does not contain the requested song "${song}" as whole words.`,
    };
  }

  // --- HARD GATE: REJECT COLLABORATORS / OTHER ARTISTS ---
  // Reject titles that name another artist alongside the requested one:
  // "&", "feat", "ft", "featuring", "duet", "vs", unless the requested artist's own name contains that word.
  const COLLAB_WORDS = ['&', 'feat', 'ft', 'featuring', 'duet', 'vs'];
  for (const cw of COLLAB_WORDS) {
    const artistHasCollab =
      cw === '&'
        ? artist.includes('&') || matchesWholeWord(artist, 'and')
        : matchesWholeWord(artist, cw);
    const songHasCollab =
      cw === '&' ? song.includes('&') : matchesWholeWord(song, cw);

    if (!artistHasCollab && !songHasCollab) {
      let titleHasCollab = false;
      if (cw === '&') {
        titleHasCollab = /(^|[^a-zA-Z0-9])&([^a-zA-Z0-9]|$)/.test(tDecoded);
      } else {
        titleHasCollab = matchesWholeWord(tDecoded, cw);
      }

      if (titleHasCollab) {
        return {
          videoId: video.videoId,
          title: tDecoded,
          channel: cDecoded,
          duration: durFormatted,
          durationSec: durSec,
          score: -350,
          isPassed: false,
          rejectionReason: `Title names another artist alongside requested artist ("${cw}")`,
          reason: `Rejected: Title names another artist or collaborator alongside requested artist ("${cw}").`,
        };
      }
    }
  }

  // --- HARD GATE: REJECT BROADCAST & CONCERT EVENTS ---
  // Also reject: "at the BBC", "BBC", "in concert", "concert", "tour".
  const EVENT_WORDS = ['at the bbc', 'bbc', 'in concert', 'concert', 'tour'];
  for (const ew of EVENT_WORDS) {
    if (!matchesWholeWord(song, ew) && matchesWholeWord(tDecoded, ew)) {
      return {
        videoId: video.videoId,
        title: tDecoded,
        channel: cDecoded,
        duration: durFormatted,
        durationSec: durSec,
        score: -380,
        isPassed: false,
        rejectionReason: `Title indicates broadcast or concert performance ("${ew}")`,
        reason: `Rejected: Title indicates broadcast or concert event ("${ew}").`,
      };
    }
  }

  // --- HARD REJECTION RULE 2: 2:00 TO 9:00 DURATION WINDOW ---
  // The only hard duration rule is the 2:00–9:00 window (120s to 540s).
  // MusicBrainz length is a soft signal, never a hard rejection.
  if (durSec < 120 || durSec > 540) {
    return {
      videoId: video.videoId,
      title: tDecoded,
      channel: cDecoded,
      duration: durFormatted,
      durationSec: durSec,
      score: -200,
      isPassed: false,
      rejectionReason: `Duration ${durFormatted} outside 2:00 - 9:00 window`,
      reason: `Rejected (Rule 2): Duration (${durFormatted}) is outside the acceptable 2:00 to 9:00 window for canonical studio recordings.`,
    };
  }

  // --- HARD REJECTION RULE 3 ---
  // Reject titles containing: cover, karaoke, reaction, interview, tribute, parody, remix,
  // slowed, sped up, nightcore, 8D, mashup, tutorial, lesson, compilation, "1 hour", loop,
  // acoustic, unplugged, demo, stripped, orchestral, piano version, reimagined, session,
  // "live version", "radio session", using whole-word matching only.
  const FORBIDDEN_WORDS = [
    'cover',
    'karaoke',
    'reaction',
    'interview',
    'tribute',
    'parody',
    'remix',
    'slowed',
    'sped up',
    'nightcore',
    '8D',
    'mashup',
    'tutorial',
    'lesson',
    'compilation',
    '1 hour',
    'loop',
    'acoustic',
    'unplugged',
    'demo',
    'stripped',
    'orchestral',
    'piano version',
    'reimagined',
    'session',
    'live version',
    'radio session',
  ];

  for (const term of FORBIDDEN_WORDS) {
    if (matchesWholeWord(tDecoded, term) && !matchesWholeWord(song, term)) {
      return {
        videoId: video.videoId,
        title: tDecoded,
        channel: cDecoded,
        duration: durFormatted,
        durationSec: durSec,
        score: -300,
        isPassed: false,
        rejectionReason: `Title contains forbidden keyword "${term}" (whole-word match)`,
        reason: `Rejected (Rule 3): Title contains forbidden non-original keyword "${term}" via whole-word match.`,
      };
    }
  }

  // --- HARD REJECTION RULE 4 ---
  // Reject live versions unless live was requested, including "(Live)"
  const isLiveRequested = matchesWholeWord(song, 'live');
  if (!isLiveRequested) {
    const isLive =
      matchesWholeWord(tDecoded, 'live') ||
      /\(live\)/i.test(tDecoded) ||
      /\[live\]/i.test(tDecoded) ||
      /live\s+at\b/i.test(tDecoded) ||
      /live\s+in\b/i.test(tDecoded) ||
      /live\s+from\b/i.test(tDecoded);

    if (isLive) {
      return {
        videoId: video.videoId,
        title: tDecoded,
        channel: cDecoded,
        duration: durFormatted,
        durationSec: durSec,
        score: -400,
        isPassed: false,
        rejectionReason: `Live version detected when studio version was requested`,
        reason: `Rejected (Rule 4): Title indicates a live concert performance while the original studio recording was requested.`,
      };
    }
  }

  // --- RANK THE SURVIVORS ---
  // 1. "Artist - Topic" channels (YouTube Music Topic channels)
  // 2. The artist's official channel or VEVO
  // 3. Other "Official Video/Audio" uploads
  // 4. Other uploads
  let score = 0;
  let rankCategory: 'TOPIC' | 'OFFICIAL_CHANNEL_OR_VEVO' | 'OFFICIAL_UPLOAD' | 'OTHER' = 'OTHER';
  const reasonsList: string[] = [];

  const isTopicChannel =
    cDecoded.toLowerCase().trim() === `${artist.toLowerCase().trim()} - topic` ||
    cDecoded.toLowerCase().endsWith(' - topic');

  const isVevoChannel = cDecoded.toLowerCase().endsWith('vevo');
  const isArtistChannel = cDecoded.toLowerCase().trim() === artist.toLowerCase().trim();
  const isArtistOfficialChannel =
    matchesWholeWord(cDecoded, artist) &&
    (cDecoded.toLowerCase().includes('official') || isArtistChannel);

  const isOfficialUpload =
    /official\s+(music\s+)?(video|audio|visualizer)/i.test(tDecoded) ||
    /\(official\s+video\)/i.test(tDecoded) ||
    /\[official\s+video\]/i.test(tDecoded) ||
    matchesWholeWord(tDecoded, 'remastered') ||
    matchesWholeWord(tDecoded, 'single version');

  if (isTopicChannel) {
    rankCategory = 'TOPIC';
    score += 1000;
    reasonsList.push(`Tier 1: YouTube Music Topic channel ("${cDecoded}") (+1000)`);
  } else if (isVevoChannel || isArtistOfficialChannel) {
    rankCategory = 'OFFICIAL_CHANNEL_OR_VEVO';
    score += 700;
    reasonsList.push(`Tier 2: Artist official / VEVO channel ("${cDecoded}") (+700)`);
  } else if (isOfficialUpload) {
    rankCategory = 'OFFICIAL_UPLOAD';
    score += 400;
    reasonsList.push(`Tier 3: Official Video / Audio release indicators in title (+400)`);
  } else {
    rankCategory = 'OTHER';
    score += 200;
    reasonsList.push(`Tier 4: Valid matching recording upload (+200)`);
  }

  // --- TITLE QUALIFIER PREFERENCE WITHIN TIER ---
  // Among candidates in the same tier:
  // 1. Prefer titles with no parenthetical qualifier at all (+150)
  // 2. Then those with an allowed qualifier (+75):
  //    Remaster/Remastered, Single Edit, Single Version, Album Version, Video Version, Radio Edit
  const parentheticalMatches = Array.from(tDecoded.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g));
  const hasParentheticals = parentheticalMatches.length > 0;

  const ALLOWED_QUALIFIERS_PATTERNS = [
    /\bremaster(ed)?\b/i,
    /\bsingle\s+edit\b/i,
    /\bsingle\s+version\b/i,
    /\balbum\s+version\b/i,
    /\bvideo\s+version\b/i,
    /\bradio\s+edit\b/i,
    /\bofficial\s+(music\s+)?(video|audio|visualizer)\b/i,
    /\b4k\b/i,
    /\bhd\b/i,
  ];

  let hasAllowedQualifier = false;
  const allowedFound: string[] = [];

  if (hasParentheticals) {
    for (const match of parentheticalMatches) {
      const content = (match[1] || match[2] || '').trim();
      for (const pattern of ALLOWED_QUALIFIERS_PATTERNS) {
        if (pattern.test(content)) {
          hasAllowedQualifier = true;
          allowedFound.push(content);
          break;
        }
      }
      // Also recognize pure 4-digit year parentheticals e.g. (1985)
      if (/^\d{4}$/.test(content)) {
        hasAllowedQualifier = true;
        allowedFound.push(content);
      }
    }
  }

  if (!hasParentheticals) {
    score += 150;
    reasonsList.push('Preferred: Title has no parenthetical qualifier (+150)');
  } else if (hasAllowedQualifier) {
    score += 75;
    reasonsList.push(`Allowed qualifier in title (${allowedFound.join(', ')}) (+75)`);
  } else {
    reasonsList.push('Has other parenthetical qualifier (+0)');
  }

  // Bonus: Song title match
  if (matchesWholeWord(tDecoded, song)) {
    score += 50;
    reasonsList.push(`Title matches song name "${song}" (+50)`);
  }

  // Small duration-closeness bonus (0 - 10 pts) that never overrides title preference
  if (mbInfo && typeof mbInfo.canonicalLengthSec === 'number') {
    const delta = Math.abs(durSec - mbInfo.canonicalLengthSec);
    const proximityBonus = Math.min(10, Math.max(0, 10 - Math.floor(delta / 2)));
    if (proximityBonus > 0) {
      score += proximityBonus;
      reasonsList.push(`Duration matches MusicBrainz length within ${delta}s (+${proximityBonus})`);
    }
  }

  // Bonus: Historical year match in title (10 pts)
  const targetYear = requestedYear || mbInfo?.canonicalYear;
  if (targetYear && matchesWholeWord(tDecoded, targetYear)) {
    score += 10;
    reasonsList.push(`Historical year match ${targetYear} in title (+10)`);
  }

  return {
    videoId: video.videoId,
    title: tDecoded,
    channel: cDecoded,
    duration: durFormatted,
    durationSec: durSec,
    score,
    isPassed: true,
    rankCategory,
    reason: reasonsList.join('; '),
  };
}

/**
 * Evaluates and scores raw YouTube video items using canonical rules and channel tiers.
 * Can be called with live API results OR cached raw API video-details responses.
 */
export function evaluateCandidateVideos(
  videoItems: any[],
  cleanArtist: string,
  cleanSong: string,
  cleanYear?: string,
  mbInfo?: MusicBrainzInfo | null
): SongSearchResult {
  if (!videoItems || videoItems.length === 0) {
    return {
      success: false,
      status: 'not_found',
      error: `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
      candidates: [],
      rejectedCandidates: [],
      canonicalInfo: mbInfo
        ? {
            year: mbInfo.canonicalYear,
            lengthSec: mbInfo.canonicalLengthSec,
            formattedLength: mbInfo.canonicalLengthSec ? formatDuration(mbInfo.canonicalLengthSec) : undefined,
          }
        : undefined,
    };
  }

  // 1. Check if MusicBrainz length differs by more than 30 seconds from every Tier 1 and Tier 2 candidate
  let activeMbInfo = mbInfo;
  if (activeMbInfo && typeof activeMbInfo.canonicalLengthSec === 'number') {
    const mbLen = activeMbInfo.canonicalLengthSec;
    const tier1And2Candidates = videoItems.filter((item) => {
      const rawCh = decodeHtmlEntities(item.snippet?.channelTitle || '');
      const chLower = rawCh.toLowerCase().trim();
      const isTopic = chLower === `${cleanArtist.toLowerCase()} - topic` || chLower.endsWith(' - topic');
      const isVevo = chLower.endsWith('vevo');
      const isArtistCh = chLower === cleanArtist.toLowerCase();
      const isArtistOfficial = matchesWholeWord(rawCh, cleanArtist) && (chLower.includes('official') || isArtistCh);
      return isTopic || isVevo || isArtistOfficial;
    });

    if (tier1And2Candidates.length > 0) {
      const differsFromAllByMoreThan30 = tier1And2Candidates.every((item) => {
        const dur = parseIsoDuration(item.contentDetails?.duration);
        return Math.abs(dur - mbLen) > 30;
      });

      if (differsFromAllByMoreThan30) {
        activeMbInfo = {
          ...activeMbInfo,
          canonicalLengthSec: undefined,
          canonicalLengths: [],
        };
      }
    }
  }

  // 2. Score and evaluate every candidate
  const scoredCandidates: CandidateVideo[] = videoItems.map((item) => {
    const rawTitle = item.snippet?.title || '';
    const rawChannel = item.snippet?.channelTitle || '';
    const durationSec = parseIsoDuration(item.contentDetails?.duration);

    return scoreCandidateVideo(
      {
        videoId: item.id,
        title: rawTitle,
        channel: rawChannel,
        durationSec,
        durationStr: formatDuration(durationSec),
      },
      cleanArtist,
      cleanSong,
      activeMbInfo,
      cleanYear
    );
  });

  // 3. Separate survivors from rejected
  const survivors = scoredCandidates
    .filter((c) => c.isPassed)
    .sort((a, b) => b.score - a.score);

  const rejected = scoredCandidates.filter((c) => !c.isPassed);

  // Only Tier 1 (Topic) and Tier 2 (the artist's official channel or VEVO) may be chosen automatically.
  // If none qualify, return status not_found along with the full list of rejected candidates and their reasons.
  // Do not auto-play anything in that case, and do not substitute another song, another artist, or a lower-tier upload.
  const officialSurvivors = survivors.filter(
    (c) => c.rankCategory === 'TOPIC' || c.rankCategory === 'OFFICIAL_CHANNEL_OR_VEVO'
  );

  if (officialSurvivors.length === 0) {
    // Mark any lower-tier (Tier 3 or Tier 4) survivors as rejected with explanation
    const lowerTierRejected: CandidateVideo[] = survivors.map((c) => ({
      ...c,
      isPassed: false,
      rejectionReason: `Lower-tier upload (${c.rankCategory}); only Tier 1 (Topic) and Tier 2 (Official / VEVO) qualify for automatic selection`,
      reason: `Rejected: Channel "${c.channel}" is a lower-tier upload (${c.rankCategory}). Only Tier 1 (Topic) and Tier 2 (Official / VEVO) qualify for automatic selection.`,
    }));

    const allRejected = [...rejected, ...lowerTierRejected];

    return {
      success: false,
      status: 'not_found',
      error: `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
      candidatesCount: allRejected.length,
      candidates: allRejected.slice(0, 5),
      rejectedCandidates: allRejected,
      canonicalInfo: activeMbInfo
        ? {
            year: activeMbInfo.canonicalYear,
            lengthSec: activeMbInfo.canonicalLengthSec,
            formattedLength: activeMbInfo.canonicalLengthSec ? formatDuration(activeMbInfo.canonicalLengthSec) : undefined,
          }
        : undefined,
    };
  }

  const topCandidate = officialSurvivors[0];

  return {
    success: true,
    status: 'ok',
    selected: {
      title: topCandidate.title,
      videoId: topCandidate.videoId,
      channel: topCandidate.channel,
      url: `https://www.youtube.com/watch?v=${topCandidate.videoId}`,
      duration: topCandidate.duration,
      confidenceScore: topCandidate.score,
      reason: topCandidate.reason,
    },
    canonicalInfo: activeMbInfo
      ? {
          year: activeMbInfo.canonicalYear,
          lengthSec: activeMbInfo.canonicalLengthSec,
          formattedLength: activeMbInfo.canonicalLengthSec ? formatDuration(activeMbInfo.canonicalLengthSec) : undefined,
        }
      : undefined,
    candidatesCount: survivors.length,
    candidates: survivors.slice(0, 5),
    rejectedCandidates: rejected.slice(0, 5),
  };
}

/**
 * Executes YouTube Data API v3 search and duration queries.
 * Read API key from YOUTUBE_API_KEY environment variable. Never hardcoded.
 */
export async function searchYouTubeForSong(
  artist: string,
  song: string,
  year?: string,
  options?: { skipOverrides?: boolean; skipCache?: boolean; forceFresh?: boolean }
): Promise<SongSearchResult> {
  const cleanArtist = (artist || '').trim();
  const cleanSong = (song || '').trim();
  const cleanYear = (year || '').trim();

  if (!cleanArtist || !cleanSong) {
    return {
      success: false,
      status: 'error',
      error: 'Both artist and song title are required to search for a recording.',
    };
  }

  const cacheKey = getLookupKey(cleanArtist, cleanSong);
  const bypassCache = Boolean(options?.forceFresh || options?.skipCache);

  // 1. Check persistent disk cache & in-memory cache if not bypassing
  if (!bypassCache) {
    const cachedRecord = diskCache[cacheKey];
    if (cachedRecord) {
      // If we have cached raw API responses, re-evaluate candidate scoring & ranking with current rules!
      // This allows rule modifications to be tested without spending more API quota.
      if (cachedRecord.rawVideosData && Array.isArray(cachedRecord.rawVideosData.items)) {
        recordQuotaUse('cache');
        const reEvaluated = evaluateCandidateVideos(
          cachedRecord.rawVideosData.items,
          cleanArtist,
          cleanSong,
          cleanYear || cachedRecord.year,
          cachedRecord.mbInfo
        );
        cachedRecord.result = reEvaluated;
        saveDiskCache();
        searchCache.set(cacheKey, reEvaluated);
        return reEvaluated;
      }

      if (cachedRecord.result) {
        recordQuotaUse('cache');
        searchCache.set(cacheKey, cachedRecord.result);
        return cachedRecord.result;
      }
    }

    if (searchCache.has(cacheKey)) {
      recordQuotaUse('cache');
      return searchCache.get(cacheKey)!;
    }
  }

  // 2. Check overrides.json (takes priority over searching unless skipOverrides is set)
  if (!options?.skipOverrides) {
    const overrides = loadOverrides();
    if (overrides[cacheKey]) {
      const overrideVideoId = overrides[cacheKey];
      const selected = {
        title: `${cleanArtist} - ${cleanSong}`,
        videoId: overrideVideoId,
        channel: cleanArtist,
        url: `https://www.youtube.com/watch?v=${overrideVideoId}`,
        duration: 'Official',
        confidenceScore: 9999,
        reason: `Selected via verified canonical override (src/services/music/overrides.json).`,
      };

      // If YouTube API key is available, enrich with real title & duration from videos.list
      const apiKey = process.env.YOUTUBE_API_KEY;
      if (apiKey) {
        try {
          recordQuotaUse('details');
          const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${overrideVideoId}&key=${apiKey}`;
          const vRes = await fetch(vUrl, {
            headers: {
              Accept: 'application/json',
              Referer: process.env.YOUTUBE_REFERER || 'http://localhost:3000/',
            },
          });
          if (vRes.ok) {
            const vData = await vRes.json();
            const item = vData.items?.[0];
            if (item) {
              selected.title = decodeHtmlEntities(item.snippet?.title || selected.title);
              selected.channel = decodeHtmlEntities(item.snippet?.channelTitle || selected.channel);
              const sec = parseIsoDuration(item.contentDetails?.duration);
              selected.duration = formatDuration(sec);
            }
          }
        } catch {}
      }

      const overrideResult: SongSearchResult = {
        success: true,
        status: 'ok',
        selected,
        candidatesCount: 1,
        candidates: [
          {
            videoId: overrideVideoId,
            title: selected.title,
            channel: selected.channel,
            duration: selected.duration,
            score: 9999,
            isPassed: true,
            reason: selected.reason,
          },
        ],
      };

      searchCache.set(cacheKey, overrideResult);
      diskCache[cacheKey] = {
        key: cacheKey,
        artist: cleanArtist,
        song: cleanSong,
        year: cleanYear,
        cachedAt: new Date().toISOString(),
        result: overrideResult,
      };
      saveDiskCache();
      return overrideResult;
    }
  }

  // 3. MusicBrainz lookup (canonical year & length)
  const mbInfo = await lookupMusicBrainz(cleanArtist, cleanSong, cleanYear);

  // 4. Validate YouTube Data API Key
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      status: 'error',
      error:
        'Missing YOUTUBE_API_KEY environment variable. Please add YOUTUBE_API_KEY to your .env file or environment to enable official YouTube Data API v3 searching.',
      canonicalInfo: mbInfo
        ? {
            year: mbInfo.canonicalYear,
            lengthSec: mbInfo.canonicalLengthSec,
            formattedLength: mbInfo.canonicalLengthSec ? formatDuration(mbInfo.canonicalLengthSec) : undefined,
          }
        : undefined,
    };
  }

  try {
    // 5. search.list: Do not put the year in the search query! (Costs 100 quota units)
    recordQuotaUse('search');
    const query = `${cleanArtist} ${cleanSong}`;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&q=${encodeURIComponent(query)}&key=${apiKey}`;

    const apiHeaders: Record<string, string> = {
      Accept: 'application/json',
      Referer: process.env.YOUTUBE_REFERER || 'http://localhost:3000/',
    };

    const searchResponse = await fetch(searchUrl, { headers: apiHeaders });
    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      if (isQuotaOrKeyError(searchResponse.status, errText)) {
        return {
          success: false,
          status: 'api_error',
          error: QUOTA_ERROR_MESSAGE,
          candidates: [],
          rejectedCandidates: [],
        };
      }
      return {
        success: false,
        status: 'error',
        error: `YouTube Data API search.list failed with HTTP ${searchResponse.status}: ${errText.substring(0, 200)}`,
      };
    }

    const searchData: any = await searchResponse.json();
    const searchItems: any[] = searchData.items || [];

    if (searchItems.length === 0) {
      return {
        success: false,
        status: 'not_found',
        error: `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
        candidates: [],
        rejectedCandidates: [],
      };
    }

    const videoIds = searchItems.map((item) => item.id?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      return {
        success: false,
        status: 'not_found',
        error: `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
        candidates: [],
        rejectedCandidates: [],
      };
    }

    // 6. videos.list: Retrieve exact contentDetails duration and snippet metadata (Costs 1 quota unit)
    recordQuotaUse('details');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`;
    const videosResponse = await fetch(videosUrl, { headers: apiHeaders });

    if (!videosResponse.ok) {
      const errText = await videosResponse.text();
      if (isQuotaOrKeyError(videosResponse.status, errText)) {
        return {
          success: false,
          status: 'api_error',
          error: QUOTA_ERROR_MESSAGE,
          candidates: [],
          rejectedCandidates: [],
        };
      }
      return {
        success: false,
        status: 'error',
        error: `YouTube Data API videos.list failed with HTTP ${videosResponse.status}: ${errText.substring(0, 200)}`,
      };
    }

    const videosData: any = await videosResponse.json();
    const videoItems: any[] = videosData.items || [];

    if (videoItems.length === 0) {
      return {
        success: false,
        status: 'not_found',
        error: `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
        candidates: [],
        rejectedCandidates: [],
      };
    }

    // 7. Evaluate and score candidates using canonical rules
    const result = evaluateCandidateVideos(videoItems, cleanArtist, cleanSong, cleanYear, mbInfo);

    // 8. Persist raw responses and evaluated result to disk cache
    diskCache[cacheKey] = {
      key: cacheKey,
      artist: cleanArtist,
      song: cleanSong,
      year: cleanYear,
      cachedAt: new Date().toISOString(),
      rawSearchData: searchData,
      rawVideosData: videosData,
      mbInfo,
      result,
    };
    saveDiskCache();
    searchCache.set(cacheKey, result);

    return result;
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (isQuotaOrKeyError(err?.status || 0, errMsg)) {
      return {
        success: false,
        status: 'api_error',
        error: QUOTA_ERROR_MESSAGE,
        candidates: [],
        rejectedCandidates: [],
      };
    }
    return {
      success: false,
      status: 'error',
      error: `Network or API exception searching YouTube: ${errMsg}`,
    };
  }
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// In-memory cache by "artist|song"
const searchCache = new Map<string, SongSearchResult>();

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
export async function lookupMusicBrainz(artist: string, song: string): Promise<MusicBrainzInfo | null> {
  try {
    await rateLimitMusicBrainz();

    const cleanArtist = artist.trim();
    const cleanSong = song.trim();
    // Query MusicBrainz with song name and artist (including prefix for groups like Prince and the Revolution)
    const artistPrefix = cleanArtist.split(/\s+/)[0];
    const query = `recording:"${cleanSong}" AND (artist:"${cleanArtist}" OR artist:${artistPrefix}*)`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&limit=50&fmt=json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'RetroFM/1.0.0 ( retrofm-applet@google-aistudio.build )',
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

    // Filter clean studio recordings (ignore live, rehearsal, remix, karaoke, tribute, dj-mix)
    // Canonical pop/rock studio recording length must fall strictly within the standard 2:00 to 9:00 window (120s to 540s)
    const cleanRecordings = recordings.filter((r) => {
      if (typeof r.length !== 'number') return false;
      const lenSec = Math.round(r.length / 1000);
      if (lenSec < 120 || lenSec > 540) return false;
      const d = (r.disambiguation || '').toLowerCase();
      if (
        d.includes('live') ||
        d.includes('rehearsal') ||
        d.includes('remix') ||
        d.includes('karaoke') ||
        d.includes('tribute') ||
        d.includes('cover') ||
        d.includes('soundcheck') ||
        d.includes('dj-mix') ||
        d.includes('instrumental')
      ) {
        return false;
      }
      return true;
    });

    let year: string | undefined = undefined;
    for (const rec of recordings) {
      if (rec['first-release-date'] && /^\d{4}/.test(rec['first-release-date'])) {
        const y = rec['first-release-date'].substring(0, 4);
        if (!year || parseInt(y, 10) < parseInt(year, 10)) {
          year = y;
        }
      }
      if (rec.releases && Array.isArray(rec.releases)) {
        for (const rel of rec.releases) {
          if (rel.date && /^\d{4}/.test(rel.date)) {
            const y = rel.date.substring(0, 4);
            if (!year || parseInt(y, 10) < parseInt(year, 10)) {
              year = y;
            }
          }
        }
      }
    }

    if (cleanRecordings.length === 0) {
      // No clean studio recordings found with known duration within standard 2:00 - 9:00 bounds.
      // Treat duration as unknown so Rule 2 standard fallback window (2:00 - 9:00) applies gracefully.
      return {
        canonicalYear: year,
        canonicalLengthSec: undefined,
        canonicalLengths: [],
        recordingTitle: recordings[0]?.title,
        artistCredit: recordings[0]?.['artist-credit']?.[0]?.name,
      };
    }

    // Sort clean recordings: prefer entries with early first-release-date or "album" in disambiguation
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
    const cleanLengths = Array.from(
      new Set(
        cleanRecordings
          .map((r) => Math.round(r.length / 1000))
          .filter((sec) => sec >= 120 && sec <= 540)
      )
    );
    const lengthSec = candidate?.length ? Math.round(candidate.length / 1000) : undefined;

    return {
      canonicalYear: year,
      canonicalLengthSec: lengthSec,
      canonicalLengths: cleanLengths.length > 0 ? cleanLengths : (lengthSec ? [lengthSec] : []),
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
 *    slowed, sped up, nightcore, 8D, mashup, tutorial, lesson, compilation, "1 hour", or loop,
 *    using whole-word matching only.
 * 4. Reject live versions unless live was requested, including "(Live)".
 *
 * Ranking the survivors:
 * 1. "Artist - Topic" channels (YouTube Music Topic channels)
 * 2. Artist's official channel or VEVO
 * 3. Other "Official Video/Audio" uploads
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

  // --- HARD REJECTION RULE 2 ---
  // Duration must be within 15 seconds of the MusicBrainz length, or between 2:00 and 9:00 if unknown
  const canonicalLengths =
    mbInfo?.canonicalLengths && mbInfo.canonicalLengths.length > 0
      ? mbInfo.canonicalLengths
      : typeof mbInfo?.canonicalLengthSec === 'number'
        ? [mbInfo.canonicalLengthSec]
        : [];

  if (canonicalLengths.length > 0) {
    const minDelta = Math.min(...canonicalLengths.map((l) => Math.abs(durSec - l)));
    if (minDelta > 15) {
      const closestLength = canonicalLengths.reduce((prev, curr) =>
        Math.abs(curr - durSec) < Math.abs(prev - durSec) ? curr : prev
      );
      return {
        videoId: video.videoId,
        title: tDecoded,
        channel: cDecoded,
        duration: durFormatted,
        durationSec: durSec,
        score: -200,
        isPassed: false,
        rejectionReason: `Duration ${durFormatted} differs by ${minDelta}s from MusicBrainz canonical length (${formatDuration(closestLength)})`,
        reason: `Rejected (Rule 2): Duration (${durFormatted}) is outside the 15-second tolerance of MusicBrainz canonical length (${formatDuration(closestLength)}). Delta: ${minDelta}s.`,
      };
    }
  } else {
    // MusicBrainz length unknown: must be between 2:00 (120s) and 9:00 (540s)
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
  }

  // --- HARD REJECTION RULE 3 ---
  // Reject titles containing cover, karaoke, reaction, interview, tribute, parody, remix,
  // slowed, sped up, nightcore, 8D, mashup, tutorial, lesson, compilation, "1 hour", or loop,
  // using whole-word matching only.
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
    reasonsList.push(`Tier 1: YouTube Music Topic channel ("${cDecoded}") providing official automated studio audio track (+1000)`);
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

  // Bonus: Song title match
  if (matchesWholeWord(tDecoded, song)) {
    score += 50;
    reasonsList.push(`Title matches song name "${song}" (+50)`);
  }

  // Bonus: MusicBrainz duration proximity
  if (mbInfo && typeof mbInfo.canonicalLengthSec === 'number') {
    const proximityBonus = Math.max(0, 15 - Math.abs(durSec - mbInfo.canonicalLengthSec));
    if (proximityBonus > 0) {
      score += proximityBonus;
      reasonsList.push(`Duration matches MusicBrainz canonical length within ${15 - proximityBonus}s (+${proximityBonus})`);
    }
  }

  // Bonus: Canonical or requested year match
  const targetYear = requestedYear || mbInfo?.canonicalYear;
  if (targetYear && matchesWholeWord(tDecoded, targetYear)) {
    score += 20;
    reasonsList.push(`Historical year match ${targetYear} in title (+20)`);
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
 * Executes YouTube Data API v3 search and duration queries.
 * Read API key from YOUTUBE_API_KEY environment variable. Never hardcoded.
 */
export async function searchYouTubeForSong(
  artist: string,
  song: string,
  year?: string,
  options?: { skipOverrides?: boolean; skipCache?: boolean }
): Promise<SongSearchResult> {
  const cleanArtist = (artist || '').trim();
  const cleanSong = (song || '').trim();
  const cleanYear = (year || '').trim();

  if (!cleanArtist || !cleanSong) {
    return {
      success: false,
      error: 'Both artist and song title are required to search for a recording.',
    };
  }

  const cacheKey = getLookupKey(cleanArtist, cleanSong);

  // 1. Check in-memory cache
  if (!options?.skipCache && searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey)!;
  }

  // 2. Check overrides.json (takes priority over searching)
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
      return overrideResult;
    }
  }

  // 3. MusicBrainz lookup (canonical year & length)
  const mbInfo = await lookupMusicBrainz(cleanArtist, cleanSong);

  // 4. Validate YouTube Data API Key
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return {
      success: false,
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
    // 5. search.list: Do not put the year in the search query!
    const query = `${cleanArtist} ${cleanSong}`;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25&q=${encodeURIComponent(query)}&key=${apiKey}`;

    const apiHeaders: Record<string, string> = {
      Accept: 'application/json',
      Referer: process.env.YOUTUBE_REFERER || 'http://localhost:3000/',
    };

    const searchResponse = await fetch(searchUrl, { headers: apiHeaders });
    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      return {
        success: false,
        error: `YouTube Data API search.list failed with HTTP ${searchResponse.status}: ${errText.substring(0, 200)}`,
      };
    }

    const searchData: any = await searchResponse.json();
    const searchItems: any[] = searchData.items || [];

    if (searchItems.length === 0) {
      return {
        success: false,
        error: `No YouTube videos found matching "${cleanArtist} - ${cleanSong}".`,
      };
    }

    const videoIds = searchItems.map((item) => item.id?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      return {
        success: false,
        error: 'YouTube search returned no valid video IDs.',
      };
    }

    // 6. videos.list: Retrieve exact contentDetails duration and snippet metadata
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`;
    const videosResponse = await fetch(videosUrl, { headers: apiHeaders });

    if (!videosResponse.ok) {
      const errText = await videosResponse.text();
      return {
        success: false,
        error: `YouTube Data API videos.list failed with HTTP ${videosResponse.status}: ${errText.substring(0, 200)}`,
      };
    }

    const videosData: any = await videosResponse.json();
    const videoItems: any[] = videosData.items || [];

    if (videoItems.length === 0) {
      return {
        success: false,
        error: 'No video details could be retrieved from YouTube Data API.',
      };
    }

    // 7. Score and evaluate every candidate
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
        mbInfo,
        cleanYear
      );
    });

    // 8. Separate survivors from rejected
    const survivors = scoredCandidates
      .filter((c) => c.isPassed)
      .sort((a, b) => b.score - a.score);

    const rejected = scoredCandidates.filter((c) => !c.isPassed);

    if (survivors.length === 0) {
      return {
        success: false,
        error: `Unable to reliably select requested song "${cleanArtist} - ${cleanSong}". All ${scoredCandidates.length} search candidates were rejected by validation rules.`,
        candidatesCount: scoredCandidates.length,
        candidates: scoredCandidates.slice(0, 5),
        rejectedCandidates: rejected.slice(0, 5),
        canonicalInfo: mbInfo
          ? {
              year: mbInfo.canonicalYear,
              lengthSec: mbInfo.canonicalLengthSec,
              formattedLength: mbInfo.canonicalLengthSec ? formatDuration(mbInfo.canonicalLengthSec) : undefined,
            }
          : undefined,
      };
    }

    const topCandidate = survivors[0];

    const result: SongSearchResult = {
      success: true,
      selected: {
        title: topCandidate.title,
        videoId: topCandidate.videoId,
        channel: topCandidate.channel,
        url: `https://www.youtube.com/watch?v=${topCandidate.videoId}`,
        duration: topCandidate.duration,
        confidenceScore: topCandidate.score,
        reason: topCandidate.reason,
      },
      canonicalInfo: mbInfo
        ? {
            year: mbInfo.canonicalYear,
            lengthSec: mbInfo.canonicalLengthSec,
            formattedLength: mbInfo.canonicalLengthSec ? formatDuration(mbInfo.canonicalLengthSec) : undefined,
          }
        : undefined,
      candidatesCount: survivors.length,
      candidates: survivors.slice(0, 5),
      rejectedCandidates: rejected.slice(0, 5),
    };

    // Cache successful result
    searchCache.set(cacheKey, result);
    return result;
  } catch (err: any) {
    return {
      success: false,
      error: `Network or API exception searching YouTube: ${err?.message || err}`,
    };
  }
}

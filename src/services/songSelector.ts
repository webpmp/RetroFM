/**
 * RetroFM song selector.
 *
 * Picks a song from the library JSON for a selected date and genre: something that was popular (or brand new)
 * on that date, released by then, with a YouTube link. No network calls and no YouTube search: the library
 * already holds the video ID, so PLAY SONG costs no YouTube API quota.
 *
 *   const library = await loadLibrary();            // once, at startup
 *   let play = newPlayState();                      // once per listening session
 *   const pick = pickSong(library, "1964-07-04", "Motown", play);
 *   if (pick) { play = pick.state; playYouTube(pick.song.streaming.youtube.id); }
 *   // SKIP is just another call to pickSong with the same date and genre.
 */

import { determinePrimaryGenre } from './music/genreFamilies.js';

export interface LibrarySong {
  id: string;
  title: string;
  artist: string;
  chart_year: number;
  release_date: string | null;
  release_date_precision: string | null;
  genres: string | null;          // comma-separated, e.g. "Motown, R&B"
  primary_genre: string | null;
  peak_position: number | null;
  first_chart_date: string | null;
  last_chart_date: string | null;
  peak_date: string | null;
  weeks_on_chart: number | null;
  streaming: { youtube: { id: string | null; url: string | null } };
}

export interface PlayState { recent: string[] }       // song ids already played this session
export const newPlayState = (): PlayState => ({ recent: [] });

export interface Pick {
  song: LibrarySong;
  /** 1 = charting on the exact date, 2 = within the last 6 months, 3 = within 2 years, 4 = any genre on the chart that day */
  tier: 1 | 2 | 3 | 4;
  genreMatched: boolean;           // false only for tier 4
  state: PlayState;
}

export function assignPrimaryGenres(library: LibrarySong[]): LibrarySong[] {
  for (const s of library) {
    s.primary_genre = determinePrimaryGenre(s.genres || s.primary_genre);
  }
  return library;
}

export async function loadLibrary(url = "/data/retrofm_library_youtube.json"): Promise<LibrarySong[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the song library (${res.status})`);
  const songs = (await res.json()) as LibrarySong[];
  return assignPrimaryGenres(songs);
}

const DAY = 86_400_000;
const shift = (date: string, days: number): string =>
  new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
const start = (d: string): string => (d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);

export const youtubeId = (s: LibrarySong): string | null => s.streaming?.youtube?.id ?? null;

export function hasGenre(s: LibrarySong, genre: string, availableStationGenres?: string[] | null): boolean {
  const want = genre.trim().toLowerCase();
  const primary = (s.primary_genre || determinePrimaryGenre(s.genres)).trim().toLowerCase();
  return primary === want;
}

/**
 * Release date eligibility cutoff:
 * Returns true if and only if the song was released on or before the broadcast date.
 * - Precision 'day' (or YYYY-MM-DD): rel <= broadcastDate
 * - Precision 'month' (or YYYY-MM): rel.slice(0, 7) <= broadcastDate.slice(0, 7)
 * - Precision 'year' (or YYYY): rel.slice(0, 4) <= broadcastDate.slice(0, 4)
 * If release date is missing or invalid, returns false.
 */
export function isReleasedOnOrBefore(s: LibrarySong | { release_date: string | null; release_date_precision?: string | null }, broadcastDate: string): boolean {
  const rel = s.release_date;
  if (!rel) return false;
  const prec = (s.release_date_precision || "").trim().toLowerCase() ||
    (rel.length === 10 ? "day" : rel.length === 7 ? "month" : "year");

  if (prec === "day" || rel.length === 10) {
    return rel <= broadcastDate;
  }
  if (prec === "month" || rel.length === 7) {
    return rel.slice(0, 7) <= broadcastDate.slice(0, 7);
  }
  // Precision 'year' or 4-digit
  return rel.slice(0, 4) <= broadcastDate.slice(0, 4);
}

/**
 * Strict historical cutoff:
 * Returns true if and only if the song was released strictly before the broadcast date.
 * - Precision 'day' (or YYYY-MM-DD): rel < broadcastDate
 * - Precision 'month' (or YYYY-MM): rel.slice(0, 7) < broadcastDate.slice(0, 7)
 * - Precision 'year' (or YYYY): rel.slice(0, 4) < broadcastDate.slice(0, 4)
 * If release date is missing or cannot be established as earlier, returns false.
 */
export function isStrictlyReleasedBefore(s: LibrarySong, broadcastDate: string): boolean {
  const rel = s.release_date;
  if (!rel) return false;
  const prec = (s.release_date_precision || "").trim().toLowerCase() ||
    (rel.length === 10 ? "day" : rel.length === 7 ? "month" : "year");

  if (prec === "day" || rel.length === 10) {
    return rel < broadcastDate;
  }
  if (prec === "month" || rel.length === 7) {
    return rel.slice(0, 7) < broadcastDate.slice(0, 7);
  }
  // Precision 'year' or 4-digit: only strictly earlier if release year is before broadcast year
  return rel.slice(0, 4) < broadcastDate.slice(0, 4);
}

/** The song existed by `date`: it was released strictly before date and had started charting by date. */
export function existedBy(s: LibrarySong, date: string): boolean {
  if (!s.first_chart_date || s.first_chart_date > date) return false;
  return isStrictlyReleasedBefore(s, date);
}

export const SUPPORTED_1960S_GENRES = new Set([
  'Baroque Pop',
  'Bossa Nova',
  'British Invasion',
  'Country',
  'Easy Listening',
  'Folk',
  'Folk Rock',
  'Garage Rock',
  'Gospel',
  'Jazz',
  'Latin',
  'Motown',
  'Pop',
  'R&B',
  'Rock',
  'Rock and Roll',
  'Ska',
  'Soul',
  'Surf Rock'
]);

export function isSongEligibleForGenre(s: LibrarySong, genre: string, broadcastDate: string, availableStationGenres?: string[] | null): boolean {
  if (!youtubeId(s) || !existedBy(s, broadcastDate) || !hasGenre(s, genre, availableStationGenres)) return false;
  return chartedBetween(s, shift(broadcastDate, -730), broadcastDate);
}

/**
 * Derives distinct available genres from library songs that are historically eligible
 * (strictly released before the broadcast date, charted within 2 years, and have a valid streaming YouTube ID).
 * For 1960s dates, filters strictly to the supported 1960s taxonomy genres.
 * Each song contributes only its single primary genre, so genre pools are completely disjoint.
 */
export function getAvailableGenres(library: LibrarySong[], broadcastDate: string): string[] {
  const is1960s = broadcastDate.startsWith("196");
  const genreSet = new Set<string>();
  for (const s of library) {
    if (youtubeId(s) && existedBy(s, broadcastDate)) {
      if (chartedBetween(s, shift(broadcastDate, -730), broadcastDate)) {
        const trimmed = (s.primary_genre || determinePrimaryGenre(s.genres)).trim();
        if (!trimmed) continue;
        if (is1960s && !SUPPORTED_1960S_GENRES.has(trimmed)) {
          continue;
        }
        genreSet.add(trimmed);
      }
    }
  }
  return Array.from(genreSet).sort((a, b) => a.localeCompare(b));
}

/**
 * Estimated end of the song's main chart run. A song that re-entered the chart years later (for example after a
 * movie) has a last_chart_date far from its first run, so the end is capped at its first date plus its total
 * weeks on the chart, with a few weeks of slack.
 */
function runEnd(s: LibrarySong): string {
  const capped = shift(s.first_chart_date!, ((s.weeks_on_chart ?? 1) + 4) * 7);
  return s.last_chart_date && s.last_chart_date < capped ? s.last_chart_date : capped;
}

/** Did the song's chart run overlap [from, to]? */
function chartedBetween(s: LibrarySong, from: string, to: string): boolean {
  if (!s.first_chart_date) return false;
  return s.first_chart_date <= to && runEnd(s) >= from;
}

/** Bigger hits are more likely: weight falls as the peak position number grows. */
const weight = (s: LibrarySong): number => 1 / (1 + (s.peak_position ?? 50) / 10);

function weightedPick<T extends LibrarySong>(items: T[], rng: () => number): T {
  const total = items.reduce((sum, s) => sum + weight(s), 0);
  let r = rng() * total;
  for (const s of items) { r -= weight(s); if (r <= 0) return s; }
  return items[items.length - 1];
}

export function pickSong(library: LibrarySong[], date: string, genre: string, state: PlayState,
                         rng: () => number = Math.random,
                         availableStationGenres?: string[] | null): Pick | null {
  const playable = library.filter((s) => youtubeId(s) && existedBy(s, date));
  const genreTiers: { tier: 1 | 2 | 3; songs: LibrarySong[]; genreMatched: true }[] = [
    { tier: 1, genreMatched: true, songs: playable.filter((s) => hasGenre(s, genre, availableStationGenres) && chartedBetween(s, date, date)) },
    { tier: 2, genreMatched: true, songs: playable.filter((s) => hasGenre(s, genre, availableStationGenres) && chartedBetween(s, shift(date, -182), date)) },
    { tier: 3, genreMatched: true, songs: playable.filter((s) => hasGenre(s, genre, availableStationGenres) && chartedBetween(s, shift(date, -730), date)) },
  ];

  const lastPlayedId = state.recent.length > 0 ? state.recent[state.recent.length - 1] : null;

  // 1. Try fresh songs in genre-matched tiers (Tier 1 -> Tier 2 -> Tier 3)
  for (const t of genreTiers) {
    const fresh = t.songs.filter((s) => !state.recent.includes(s.id));
    if (fresh.length) {
      const song = weightedPick(fresh, rng);
      return { song, tier: t.tier, genreMatched: true, state: { recent: [...state.recent, song.id].slice(-40) } };
    }
  }

  // 2. If all songs across genre tiers have been played, but genre tiers have songs:
  // Allow rotation of genre songs, but NEVER repeat the currently playing song if any other song exists!
  const allGenreSongsMap = new Map<string, { song: LibrarySong; tier: 1 | 2 | 3 }>();
  for (const t of genreTiers) {
    for (const s of t.songs) {
      if (!allGenreSongsMap.has(s.id)) {
        allGenreSongsMap.set(s.id, { song: s, tier: t.tier });
      }
    }
  }

  if (allGenreSongsMap.size > 0) {
    const allGenreList = Array.from(allGenreSongsMap.values());
    const candidates = allGenreList.filter(item => item.song.id !== lastPlayedId);
    const pool = candidates.length > 0 ? candidates : allGenreList;
    const chosen = weightedPick(pool.map(p => p.song), rng);
    const chosenMeta = pool.find(p => p.song.id === chosen.id) || pool[0];
    const newRecent = lastPlayedId ? [lastPlayedId, chosen.id] : [chosen.id];
    return {
      song: chosen,
      tier: chosenMeta.tier,
      genreMatched: true,
      state: { recent: newRecent }
    };
  }

  // 3. If no genre songs were charting within 2 years, do not substitute unrelated genres
  return null;
}

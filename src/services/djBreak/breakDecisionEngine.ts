/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Spec A: DJ Break Decision Engine & Candidate Collector.
 *
 * Rules:
 * 1. Silence is the default. Not every song gets a break.
 * 2. Break frequency is a setting, defaulting to ~0.5 (1 break per 2 songs).
 * 3. Break types, version 1:
 *    - chart_fact: computed from weekly_chart for song played or song next
 *    - song_credit: writer or producer from song_facts (writer differs from performer)
 *    - observation: cost-of-living or news observation
 *    - intro_only: short song intro only
 * 4. Selection happens in code, before any LLM call:
 *    - Collect candidates
 *    - Drop ineligible ones
 *    - Pick one
 *    - Never repeat the same fact in a session or the same type back to back.
 * 5. Single thread:
 *    - Cost-of-living and news breaks never say "coming up" and never pretend to connect to the next song.
 *    - Song intro appears only on intro_only breaks, or when the fact is about the next song.
 */

import {
  ChartFact,
  ChartFactRepository,
  computeChartFacts,
  computeNationalNumberOneFact,
  SongIdentifier,
  spokenOrdinal,
  spokenOrdinalWithArticle,
} from './chartFacts.js';
import { validateBreakOutput, ValidationContext } from './breakValidator.js';
import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

import {
  SpecABreakType,
  BreakCandidate,
  EngineSongInput,
  BreakSelectionSessionState,
  newBreakSelectionSessionState,
} from './breakDecisionTypes.js';

export type {
  SpecABreakType,
  BreakCandidate,
  EngineSongInput,
  BreakSelectionSessionState,
};
export {
  newBreakSelectionSessionState,
};

export interface SongCreditFactRow {
  song_id: string;
  fact_type: 'writer' | 'producer';
  fact_text: string;
  event_date: string | null;
  public_date: string | null;
  source: string;
  source_url: string;
}

function getArtistTokens(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function cleanDuetArtist(name: string): string {
  if (!name) return '';
  return name
    .replace(/\s*\/\s*/g, ' and ')
    .replace(/\s+A Duet With\s+/gi, ' and ')
    .replace(/\s+With\s+/gi, ' and ')
    .replace(/\s+(?:Featuring|Feat\.)\s+/gi, ' and ')
    .replace(/\s\s+/g, ' ')
    .trim();
}

export function isWriterSameAsPerformer(writer: string, performer: string): boolean {
  const wLower = (writer || '').toLowerCase().trim();
  const pLower = (performer || '').toLowerCase().trim();
  if (wLower === pLower || pLower.includes(wLower) || wLower.includes(pLower)) {
    return true;
  }
  const wTokens = getArtistTokens(writer);
  const pTokens = getArtistTokens(performer);
  for (const wt of wTokens) {
    if (pTokens.includes(wt)) return true;
  }
  return false;
}

/**
 * Repository to query song_facts, credits, band members, and aliases.
 * Reads static JSON files from public/data/ or fallback SQLite database if present.
 */
export class SongCreditRepository {
  private db: any = null;
  private dataDir: string;
  private isJsonAvailable = false;
  private songFacts: any[] = [];
  private bandMembers: any[] = [];
  private artistAliases: any[] = [];
  private songs: any[] = [];
  private chartRepo?: ChartFactRepository;

  constructor(customPathOrDir?: string, chartRepo?: ChartFactRepository) {
    this.chartRepo = chartRepo;
    const homedir = process.env.HOME || '/root';
    this.dataDir = customPathOrDir && fs.existsSync(customPathOrDir) && fs.statSync(customPathOrDir).isDirectory()
      ? customPathOrDir
      : path.resolve(process.cwd(), 'public/data');

    let songFactsFile = path.join(this.dataDir, 'song_facts.json');
    if (!fs.existsSync(songFactsFile) && fs.existsSync(path.join(this.dataDir, 'sample', 'song_facts.json'))) {
      this.dataDir = path.join(this.dataDir, 'sample');
      songFactsFile = path.join(this.dataDir, 'song_facts.json');
    }

    if (fs.existsSync(songFactsFile)) {
      this.isJsonAvailable = true;
      try {
        this.songFacts = JSON.parse(fs.readFileSync(songFactsFile, 'utf8'));
      } catch {}

      const bandMembersFile = path.join(this.dataDir, 'band_members.json');
      if (fs.existsSync(bandMembersFile)) {
        try {
          this.bandMembers = JSON.parse(fs.readFileSync(bandMembersFile, 'utf8'));
        } catch {}
      }

      const artistAliasesFile = path.join(this.dataDir, 'artist_aliases.json');
      if (fs.existsSync(artistAliasesFile)) {
        try {
          this.artistAliases = JSON.parse(fs.readFileSync(artistAliasesFile, 'utf8'));
        } catch {}
      }

      let allSongs: any[] = [];
      const mainSongsFile = path.join(this.dataDir, 'retrofm_library_youtube.json');
      if (fs.existsSync(mainSongsFile)) {
        try {
          allSongs = allSongs.concat(JSON.parse(fs.readFileSync(mainSongsFile, 'utf8')));
        } catch {}
      }
      const extraSongsFile = path.join(this.dataDir, 'songs_extra.json');
      if (fs.existsSync(extraSongsFile)) {
        try {
          allSongs = allSongs.concat(JSON.parse(fs.readFileSync(extraSongsFile, 'utf8')));
        } catch {}
      }
      this.songs = allSongs;
    } else {
      const targetPath = (customPathOrDir && fs.existsSync(customPathOrDir) && !fs.statSync(customPathOrDir).isDirectory())
        ? customPathOrDir
        : path.join(homedir, 'retrofm', 'library.sqlite');
      if (fs.existsSync(targetPath)) {
        try {
          const BunGlobal = (globalThis as any).Bun;
          if (BunGlobal && typeof BunGlobal.openDatabase === 'function') {
            this.db = BunGlobal.openDatabase(targetPath);
          } else {
            this.db = new DatabaseSync(targetPath);
          }
          if (this.db && this.db.exec) {
            this.db.exec('PRAGMA busy_timeout = 5000;');
          }
        } catch (e) {
          console.warn('[SongCreditRepository] Failed to open database:', e);
        }
      }
    }
  }

  public getBandMembers(bandName: string, broadcastDate?: string): string[] {
    if (this.isJsonAvailable) {
      if (!bandName) return [];
      const members: string[] = [];
      const bcYear = broadcastDate ? broadcastDate.slice(0, 4) : null;
      const target = bandName.toLowerCase();
      for (const r of this.bandMembers) {
        if ((r.band_name || '').toLowerCase() === target) {
          const begin = r.begin_date ? r.begin_date.slice(0, 4) : null;
          const end = r.end_date ? r.end_date.slice(0, 4) : null;
          if (bcYear) {
            if (begin && begin > bcYear) continue;
            if (end && end < bcYear) continue;
          }
          members.push(r.member_name);
        }
      }
      return members;
    }

    if (!this.db || !bandName) return [];
    try {
      const query = `
        SELECT member_name, begin_date, end_date
        FROM band_members
        WHERE LOWER(band_name) = LOWER(?)
      `;
      const rows = this.db.prepare ? this.db.prepare(query).all(bandName) : this.db.query(query).all(bandName);
      const members: string[] = [];
      const bcYear = broadcastDate ? broadcastDate.slice(0, 4) : null;
      for (const r of rows) {
        const begin = r.begin_date ? r.begin_date.slice(0, 4) : null;
        const end = r.end_date ? r.end_date.slice(0, 4) : null;
        if (bcYear) {
          if (begin && begin > bcYear) continue;
          if (end && end < bcYear) continue;
        }
        members.push(r.member_name);
      }
      return members;
    } catch {
      return [];
    }
  }

  public hasCrossArtistHit(writer: string, currentSongId: string, broadcastDate: string, performingBandName?: string): boolean {
    if (this.isJsonAvailable) {
      if (!writer) return false;
      const writerLower = writer.toLowerCase();
      const songMap = new Map(this.songs.map((s) => [s.id, s]));

      for (const sf of this.songFacts) {
        if (!sf.public_date || sf.public_date > broadcastDate) continue;
        if (sf.song_id === currentSongId) continue;
        if (!sf.fact_text || !sf.fact_text.toLowerCase().includes(writerLower)) continue;

        const song = songMap.get(sf.song_id);
        if (!song) continue;

        const match = (sf.fact_text as string).match(/(?:Written|Composed|Lyrics) by ([^;.]+)/i);
        if (!match) continue;
        const hitWriters = match[1].split(/,\s*|\s+and\s+/i).map((w: string) => w.trim());
        const isW = hitWriters.some((hw: string) => hw.toLowerCase() === writerLower);
        if (!isW) continue;

        const hitArtist = (song.artist || '').toLowerCase();
        // Cannot be the same performer
        if (isWriterSameAsPerformer(writer, song.artist || '')) {
          continue;
        }
        // Cannot be the same band
        if (performingBandName && (hitArtist === performingBandName.toLowerCase() || hitArtist.includes(performingBandName.toLowerCase()))) {
          continue;
        }
        return true;
      }
      return false;
    }

    if (!this.db || !writer) return false;
    try {
      const query = `
        SELECT s.id, s.title, s.artist, sf.fact_text, sf.public_date
        FROM songs s
        JOIN song_facts sf ON s.id = sf.song_id
        WHERE sf.public_date IS NOT NULL
          AND sf.public_date <= ?
          AND s.id != ?
          AND sf.fact_text LIKE ?
      `;
      const hits = this.db.prepare ? this.db.prepare(query).all(broadcastDate, currentSongId, `%${writer}%`) : this.db.query(query).all(broadcastDate, currentSongId, `%${writer}%`);
      const bandMembers = performingBandName ? this.getBandMembers(performingBandName, broadcastDate) : [];
      const bandMembersLower = bandMembers.map((m) => m.toLowerCase());

      for (const hit of hits) {
        const match = (hit.fact_text as string).match(/(?:Written|Composed|Lyrics) by ([^;.]+)/i);
        if (!match) continue;
        const hitWriters = match[1].split(/,\s*|\s+and\s+/i).map((w: string) => w.trim());
        const isW = hitWriters.some((hw: string) => hw.toLowerCase() === writer.toLowerCase());
        if (!isW) continue;
        const hitArtist = (hit.artist as string).toLowerCase();

        // Cannot be the same performer
        if (isWriterSameAsPerformer(writer, hit.artist as string)) {
          continue;
        }
        // Cannot be the same band (e.g. another song by The Dave Clark Five or The Beatles)
        if (performingBandName && (hitArtist === performingBandName.toLowerCase() || hitArtist.includes(performingBandName.toLowerCase()))) {
          continue;
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public getArtistAliases(artistName: string): string[] {
    if (this.isJsonAvailable) {
      if (!artistName) return [];
      const target = artistName.toLowerCase();
      return this.artistAliases
        .filter((r) => (r.artist_name || '').toLowerCase() === target)
        .map((r) => r.alias_name);
    }

    if (!this.db || !artistName) return [];
    try {
      const query = `
        SELECT alias_name
        FROM artist_aliases
        WHERE LOWER(artist_name) = LOWER(?)
      `;
      const rows = this.db.prepare ? this.db.prepare(query).all(artistName) : this.db.query(query).all(artistName);
      return rows.map((r: any) => r.alias_name);
    } catch {
      return [];
    }
  }

  public getEligibleCredits(songId: string, selectedDate: string): SongCreditFactRow[] {
    if (this.isJsonAvailable) {
      if (!songId) return [];
      return this.songFacts.filter(
        (f) => f.song_id === songId && f.public_date && f.public_date <= selectedDate && f.public_date.length >= 10
      );
    }

    if (!this.db || !songId) return [];
    try {
      const query = `
        SELECT song_id, fact_type, fact_text, event_date, public_date, source, source_url
        FROM song_facts
        WHERE song_id = ? AND public_date IS NOT NULL AND public_date <= ? AND length(public_date) >= 10
      `;
      return this.db.prepare ? this.db.prepare(query).all(songId, selectedDate) : this.db.query(query).all(songId, selectedDate);
    } catch {
      return [];
    }
  }

  public getOriginalRecordingForAdaptation(workTitle: string, broadcastDate: string): { artist: string; title: string } | null {
    if (this.isJsonAvailable) {
      if (!workTitle) return null;
      const wtLower = workTitle.toLowerCase();
      // 1. Check in songs table
      const matchingSongs = this.songs.filter((s) => {
        const tLower = (s.title || '').toLowerCase();
        if (tLower !== wtLower && !tLower.includes(wtLower)) return false;
        const fcd = s.first_chart_date;
        const rd = s.release_date;
        return (fcd && fcd <= broadcastDate) || (rd && rd <= broadcastDate);
      });

      if (matchingSongs.length > 0) {
        matchingSongs.sort((a, b) => {
          const dateA = a.first_chart_date || a.release_date || '9999';
          const dateB = b.first_chart_date || b.release_date || '9999';
          return dateA.localeCompare(dateB);
        });
        return { artist: matchingSongs[0].artist, title: matchingSongs[0].title };
      }

      // 2. Check in weekly_chart via chartRepo if available
      if (this.chartRepo && typeof (this.chartRepo as any).getSongHistory === 'function') {
        const dummyHistory = this.chartRepo.getSongHistory({ title: workTitle, artist: '' }, broadcastDate);
        if (dummyHistory.length > 0) {
          return { artist: dummyHistory[0].performer, title: dummyHistory[0].title };
        }
      }
      return null;
    }

    if (!this.db || !workTitle) return null;
    try {
      // 1. Check in songs table
      const songQuery = `
        SELECT title, artist, first_chart_date, release_date
        FROM songs
        WHERE (LOWER(title) = LOWER(?) OR LOWER(title) LIKE LOWER(?))
          AND ((first_chart_date IS NOT NULL AND first_chart_date <= ?) OR (release_date IS NOT NULL AND release_date <= ?))
        ORDER BY first_chart_date ASC, release_date ASC
        LIMIT 1
      `;
      const songRow = this.db.prepare
        ? this.db.prepare(songQuery).get(workTitle, `%${workTitle}%`, broadcastDate, broadcastDate)
        : this.db.query(songQuery).get(workTitle, `%${workTitle}%`, broadcastDate, broadcastDate);
      if (songRow) {
        return { artist: songRow.artist, title: songRow.title };
      }

      // 2. Check in weekly_chart
      const chartQuery = `
        SELECT title, performer, chart_date
        FROM weekly_chart
        WHERE LOWER(title) = LOWER(?) AND chart_date <= ?
        ORDER BY chart_date ASC
        LIMIT 1
      `;
      const chartRow = this.db.prepare
        ? this.db.prepare(chartQuery).get(workTitle, broadcastDate)
        : this.db.query(chartQuery).get(workTitle, broadcastDate);
      if (chartRow) {
        return { artist: chartRow.performer, title: chartRow.title };
      }
      return null;
    } catch {
      return null;
    }
  }
}


export interface BreakDecisionInput {
  prevSong: EngineSongInput | null;
  nextSong: EngineSongInput | null;
  selectedDate: string; // YYYY-MM-DD
  frequencySetting?: number; // e.g. 0.5 (1 break per 2 songs)
  newsObservation?: { text: string; date: string; headline?: string; topic?: string } | null;
  economyObservation?: { text: string; date: string; kind?: string } | null;
  chartRepo?: ChartFactRepository;
  creditRepo?: SongCreditRepository;
  rng?: () => number;
}

/**
 * 6-8 Rotating templates for song intros in code, ensuring balanced quotes.
 */
export const INTRO_TEMPLATES: ((title: string, artist: string) => string)[] = [
  (title, artist) => `Here is "${title}" by ${artist}.`,
  (title, artist) => `Now for "${title}" by ${artist}.`,
  (title, artist) => `On the turntable, "${title}" from ${artist}.`,
  (title, artist) => `Here is ${artist} with "${title}."`,
  (title, artist) => `Turning to "${title}" by ${artist}.`,
  (title, artist) => `Now playing "${title}" by ${artist}.`,
  (title, artist) => `From ${artist}, here is "${title}."`,
  (title, artist) => `Right now, here is "${title}" by ${artist}.`,
];

export function getNextSongIntro(title: string, artist: string, lastIndex: number = -1, rng: () => number = Math.random): { text: string; index: number } {
  let nextIdx = Math.floor(rng() * INTRO_TEMPLATES.length);
  if (nextIdx === lastIndex) {
    nextIdx = (nextIdx + 1) % INTRO_TEMPLATES.length;
  }
  let selected = INTRO_TEMPLATES[nextIdx](title, artist);
  // Clean double period on abbreviations like Jr..
  selected = selected.replace(/\.\.+/g, '.').replace(/\.\s*\./g, '.');
  return {
    text: selected,
    index: nextIdx,
  };
}

export {
  spokenOrdinal,
  spokenOrdinalWithArticle,
};
export function formatNamesList(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Parses raw fact_text into natural spoken sentences.
 * Merges composer and lyricist into "wrote", lists every writer with "and",
 * handles producers, and drops bureaucratic labels like "Credits on that track".
 */
export function parseCreditToNaturalSentence(factText: string, adaptationInfo?: { artist: string; title: string } | null): string {
  const parts = factText.split(';').map((p) => p.trim()).filter(Boolean);
  const writers: string[] = [];
  const producers: string[] = [];
  let basedOn: string | null = null;
  let cover: string | null = null;

  for (const part of parts) {
    const clean = part.replace(/\.$/, '').trim();
    const wMatch = clean.match(/^(?:Written|Composed|Lyrics)\s+by\s+(.+)$/i);
    if (wMatch) {
      const names = wMatch[1].split(/,\s*|\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
      for (const n of names) {
        if (!writers.includes(n)) writers.push(n);
      }
      continue;
    }
    const pMatch = clean.match(/^Produced\s+by\s+(.+)$/i);
    if (pMatch) {
      const names = pMatch[1].split(/,\s*|\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
      for (const n of names) {
        if (!producers.includes(n)) producers.push(n);
      }
      continue;
    }
    const bMatch = clean.match(/Based on\s+"([^"]+)"/i);
    if (bMatch) {
      basedOn = bMatch[1];
      continue;
    }
    const cMatch = clean.match(/A cover of the (\d{4}) song by (.+)/i);
    if (cMatch) {
      cover = `${cMatch[1]} song by ${cMatch[2]}`;
      continue;
    }
  }

  // Requirement: List at most three writers and at most two producers
  const spokenWriters = writers.slice(0, 3);
  const spokenProducers = producers.slice(0, 2);

  const clauses: string[] = [];
  if (spokenWriters.length > 0) {
    clauses.push(`written by ${formatNamesList(spokenWriters)}`);
  }
  if (spokenProducers.length > 0) {
    clauses.push(`produced by ${formatNamesList(spokenProducers)}`);
  }
  if (adaptationInfo) {
    const origArtist = cleanDuetArtist(adaptationInfo.artist);
    clauses.push(`built on ${origArtist}’s "${adaptationInfo.title}"`);
  } else if (basedOn) {
    clauses.push(`based on "${basedOn}"`);
  }
  if (cover) {
    clauses.push(`originally recorded by ${cover}`);
  }

  if (clauses.length === 0) {
    return factText;
  }
  return clauses.join(', ');
}

export function formatSongCreditScript(
  factText: string,
  target: { title: string; artist: string },
  position: 'prev' | 'next',
  lastIdx: number = -1,
  rng: () => number = Math.random,
  adaptationInfo?: { artist: string; title: string } | null
): { text: string; index: number } {
  const parts = factText.split(';').map((p) => p.trim()).filter(Boolean);
  const writers: string[] = [];
  const producers: string[] = [];
  let basedOn: string | null = null;
  let cover: string | null = null;

  for (const part of parts) {
    const clean = part.replace(/\.$/, '').trim();
    const wMatch = clean.match(/^(?:Written|Composed|Lyrics)\s+by\s+(.+)$/i);
    if (wMatch) {
      const names = wMatch[1].split(/,\s*|\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
      for (const n of names) {
        if (!writers.includes(n)) writers.push(n);
      }
      continue;
    }
    const pMatch = clean.match(/^Produced\s+by\s+(.+)$/i);
    if (pMatch) {
      const names = pMatch[1].split(/,\s*|\s+and\s+/i).map((n) => n.trim()).filter(Boolean);
      for (const n of names) {
        if (!producers.includes(n)) producers.push(n);
      }
      continue;
    }
    const bMatch = clean.match(/Based on\s+"([^"]+)"/i);
    if (bMatch) {
      basedOn = bMatch[1];
      continue;
    }
    const cMatch = clean.match(/A cover of the (\d{4}) song by (.+)/i);
    if (cMatch) {
      cover = `${cMatch[1]} classic by ${cMatch[2]}`;
      continue;
    }
  }

  // Requirement: List at most three writers and at most two producers in spoken credit scripts
  const spokenWriters = writers.slice(0, 3);
  const spokenProducers = producers.slice(0, 2);

  const writersStr = spokenWriters.length > 0 ? formatNamesList(spokenWriters) : '';
  const producersStr = spokenProducers.length > 0 ? formatNamesList(spokenProducers) : '';

  let prevVariants: string[] = [];
  let nextVariants: string[] = [];

  if (adaptationInfo) {
    const origArtist = cleanDuetArtist(adaptationInfo.artist);
    const origTitle = adaptationInfo.title;
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `"${target.title}" from ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `That was ${target.artist} with "${target.title}," a tune built on ${origArtist}’s "${origTitle}".`,
      `"${target.title}" by ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `Music from ${target.artist} with "${target.title}," built on ${origArtist}’s "${origTitle}".`,
      `That was "${target.title}" by ${target.artist}. The song is built on ${origArtist}’s "${origTitle}".`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `Next from ${target.artist}, "${target.title}," built on ${origArtist}’s "${origTitle}".`,
      `Turning to "${target.title}" by ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `From ${target.artist}, here is "${target.title}," built on ${origArtist}’s "${origTitle}".`,
      `Now playing "${target.title}" by ${target.artist}, built on ${origArtist}’s "${origTitle}".`,
      `Here is ${target.artist} with "${target.title}," built on ${origArtist}’s "${origTitle}".`,
    ];
  } else if (writersStr && producersStr) {
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, written by ${writersStr} and produced by ${producersStr}.`,
      `"${target.title}" from ${target.artist}, written by ${writersStr} and produced by ${producersStr}.`,
      `That was ${target.artist} with "${target.title}," a tune written by ${writersStr} and produced by ${producersStr}.`,
      `"${target.title}" by ${target.artist}, with ${writersStr} writing the track and ${producersStr} producing.`,
      `Music from ${target.artist} with "${target.title}," written by ${writersStr} and produced by ${producersStr}.`,
      `That was "${target.title}" by ${target.artist}. ${writersStr} wrote the song, with production by ${producersStr}.`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, written by ${writersStr} and produced by ${producersStr}.`,
      `Next from ${target.artist}, "${target.title}," written by ${writersStr} and produced by ${producersStr}.`,
      `Turning to "${target.title}" by ${target.artist}, written by ${writersStr} with production by ${producersStr}.`,
      `From ${target.artist}, here is "${target.title}," written by ${writersStr} and produced by ${producersStr}.`,
      `Now playing "${target.title}" by ${target.artist}, written by ${writersStr} and produced by ${producersStr}.`,
      `Here is ${target.artist} with "${target.title}," written by ${writersStr} and produced by ${producersStr}.`,
    ];
  } else if (writersStr) {
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, written by ${writersStr}.`,
      `"${target.title}" from ${target.artist}, written by ${writersStr}.`,
      `That was ${target.artist} with "${target.title}," a song written by ${writersStr}.`,
      `"${target.title}" by ${target.artist}, written by ${writersStr}.`,
      `Music from ${target.artist} with "${target.title}," penned by ${writersStr}.`,
      `That was "${target.title}" by ${target.artist}. ${writersStr} wrote the song.`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, written by ${writersStr}.`,
      `Next from ${target.artist}, "${target.title}," written by ${writersStr}.`,
      `Turning to "${target.title}" by ${target.artist}, written by ${writersStr}.`,
      `From ${target.artist}, here is "${target.title}," written by ${writersStr}.`,
      `Now playing "${target.title}" by ${target.artist}, written by ${writersStr}.`,
      `Here is ${target.artist} with "${target.title}," a song written by ${writersStr}.`,
    ];
  } else if (producersStr) {
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, produced by ${producersStr}.`,
      `"${target.title}" from ${target.artist}, produced by ${producersStr}.`,
      `That was ${target.artist} with "${target.title}," produced by ${producersStr}.`,
      `"${target.title}" by ${target.artist}, with production by ${producersStr}.`,
      `Music from ${target.artist} with "${target.title}," produced by ${producersStr}.`,
      `That was "${target.title}" by ${target.artist}. ${producersStr} produced that track.`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, produced by ${producersStr}.`,
      `Next from ${target.artist}, "${target.title}," produced by ${producersStr}.`,
      `Turning to "${target.title}" by ${target.artist}, produced by ${producersStr}.`,
      `From ${target.artist}, here is "${target.title}," produced by ${producersStr}.`,
      `Now playing "${target.title}" by ${target.artist}, produced by ${producersStr}.`,
      `Here is ${target.artist} with "${target.title}," produced by ${producersStr}.`,
    ];
  } else {
    const summary = parseCreditToNaturalSentence(factText, adaptationInfo);
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, ${summary}.`,
      `"${target.title}" from ${target.artist}, ${summary}.`,
      `That was ${target.artist} with "${target.title}," ${summary}.`,
      `"${target.title}" by ${target.artist}, ${summary}.`,
      `Music from ${target.artist} with "${target.title}," ${summary}.`,
      `That was "${target.title}" by ${target.artist}. ${summary}.`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, ${summary}.`,
      `Next from ${target.artist}, "${target.title}," ${summary}.`,
      `Turning to "${target.title}" by ${target.artist}, ${summary}.`,
      `From ${target.artist}, here is "${target.title}," ${summary}.`,
      `Now playing "${target.title}" by ${target.artist}, ${summary}.`,
      `Here is ${target.artist} with "${target.title}," ${summary}.`,
    ];
  }

  // If basedOn or cover, append naturally if not already included
  if (basedOn && !writersStr && !producersStr && !adaptationInfo) {
    prevVariants = [
      `That was "${target.title}" by ${target.artist}, based on "${basedOn}".`,
      `"${target.title}" from ${target.artist}, based on "${basedOn}".`,
      `That was ${target.artist} with "${target.title}," based on "${basedOn}".`,
      `"${target.title}" by ${target.artist}, adapted from "${basedOn}".`,
      `Music from ${target.artist} with "${target.title}," based on "${basedOn}".`,
      `That was "${target.title}" by ${target.artist}. The song is based on "${basedOn}".`,
    ];
    nextVariants = [
      `Here is "${target.title}" by ${target.artist}, based on "${basedOn}".`,
      `Next from ${target.artist}, "${target.title}," based on "${basedOn}".`,
      `Turning to "${target.title}" by ${target.artist}, based on "${basedOn}".`,
      `From ${target.artist}, here is "${target.title}," based on "${basedOn}".`,
      `Now playing "${target.title}" by ${target.artist}, based on "${basedOn}".`,
      `Here is ${target.artist} with "${target.title}," based on "${basedOn}".`,
    ];
  }

  const list = position === 'prev' ? prevVariants : nextVariants;
  let nextIdx = Math.floor(rng() * list.length);
  if (nextIdx === lastIdx) {
    nextIdx = (nextIdx + 1) % list.length;
  }
  let selected = list[nextIdx];
  // Clean double period on abbreviations like Jr..
  selected = selected.replace(/\.\.+/g, '.').replace(/\.\s*\./g, '.');
  return { text: selected, index: nextIdx };
}

export function formatChartFactScript(
  candidate: BreakCandidate,
  lastIdx: number = -1,
  rng: () => number = Math.random
): { text: string; index: number } {
  const f = (candidate as any).chartFact || {};
  const kind = f.kind || 'climb';
  const title = f.title || '';
  const artist = f.artist || '';
  const rank = f.rank || 0;
  const lastRank = f.lastRank || 0;
  const weeksAtOne = f.weeksAtOne || 1;
  const weeksInTopTen = f.weeksInTopTen || 2;
  const climbWeeks = f.climbWeeks || 1;
  const prevNumberOne = f.prevNumberOne;

  let variants: string[] = [];
  switch (kind) {
    case 'debut':
      variants = [
        `"${title}" by ${artist} is new on the Hot 100 this week at number ${rank}.`,
        `Entering the Billboard Hot 100 this week, "${title}" by ${artist} lands at number ${rank}.`,
        `A new arrival on the chart this week: "${title}" by ${artist} checks in at number ${rank}.`,
        `New on the national charts this week, "${title}" by ${artist} enters at number ${rank}.`,
        `Checking into the Hot 100 this week at number ${rank}, "${title}" by ${artist}.`,
        `"${title}" from ${artist} is brand new to the charts this week at number ${rank}.`,
      ];
      break;
    case 'first_top_ten':
      variants = [
        `"${title}" by ${artist} enters the top ten for the first time this week at number ${rank}.`,
        `Breaking into the top ten this week, "${title}" by ${artist} arrives at number ${rank}.`,
        `For the first time on the chart, "${title}" by ${artist} reaches the top ten at number ${rank}.`,
        `Reaching the top ten this week at number ${rank}, "${title}" from ${artist}.`,
        `"${title}" by ${artist} climbs into the national top ten this week, claiming number ${rank}.`,
        `A first top ten appearance this week for "${title}" by ${artist}, landing at number ${rank}.`,
      ];
      break;
    case 'weeks_in_top_ten': {
      const artOrdinal = spokenOrdinalWithArticle(weeksInTopTen);
      const ordinal = spokenOrdinal(weeksInTopTen);
      variants = [
        `"${title}" by ${artist} spends ${artOrdinal} week in the top ten.`,
        `Marking its ${ordinal} week in the top ten this week, "${title}" by ${artist}.`,
        `In the top ten for ${artOrdinal} week now, "${title}" from ${artist}.`,
        `"${title}" by ${artist} holds in the top ten this week for ${artOrdinal} week.`,
        `${artOrdinal.charAt(0).toUpperCase() + artOrdinal.slice(1)} week in the national top ten for "${title}" by ${artist}.`,
        `"${title}" from ${artist} continues inside the top ten, now in its ${ordinal} week.`,
      ];
      break;
    }
    case 'reached_number_one': {
      if (prevNumberOne && prevNumberOne.title && prevNumberOne.artist) {
        variants = [
          `"${title}" by ${artist} reaches number one on the Billboard Hot 100 this week, taking over the top spot from "${prevNumberOne.title}" by ${prevNumberOne.artist}.`,
          `Taking over number one from "${prevNumberOne.title}" by ${prevNumberOne.artist}, "${title}" by ${artist} hits the top spot this week.`,
          `"${title}" by ${artist} claims number one on the Hot 100 this week, replacing "${prevNumberOne.title}" by ${prevNumberOne.artist}.`,
          `Moving into the top spot on the Billboard chart this week, "${title}" by ${artist} takes over from "${prevNumberOne.title}" by ${prevNumberOne.artist}.`,
          `"${title}" by ${artist} captures number one in the nation this week, succeeding "${prevNumberOne.title}" by ${prevNumberOne.artist}.`,
          `At the top of the chart this week, "${title}" by ${artist} takes number one from "${prevNumberOne.title}" by ${prevNumberOne.artist}.`,
        ];
      } else {
        variants = [
          `"${title}" by ${artist} hits number one in the nation this week.`,
          `Taking the top spot on the Billboard chart this week, "${title}" by ${artist} reaches number one.`,
          `"${title}" by ${artist} moves all the way to number one this week.`,
          `Reaching the summit of the Hot 100 this week, "${title}" by ${artist} is number one.`,
          `At the very top of the chart this week, "${title}" by ${artist} takes number one.`,
          `"${title}" from ${artist} captures the number one position in the country this week.`,
        ];
      }
      break;
    }
    case 'weeks_at_number_one': {
      if (weeksAtOne === 1) {
        variants = [
          `"${title}" by ${artist} reaches number one this week.`,
          `Taking the top spot on the Billboard chart this week, "${title}" by ${artist} reaches number one.`,
          `"${title}" by ${artist} moves all the way to number one this week.`,
          `Reaching the summit of the Hot 100 this week, "${title}" by ${artist} is number one.`,
          `At the very top of the chart this week, "${title}" by ${artist} takes number one.`,
          `"${title}" from ${artist} captures the number one position in the country this week.`,
        ];
      } else {
        const ordinal = spokenOrdinal(weeksAtOne);
        const artOrdinal = spokenOrdinalWithArticle(weeksAtOne);
        variants = [
          `"${title}" by ${artist} spends ${artOrdinal} week at number one on the Hot 100.`,
          `Holding strong at number one for ${artOrdinal} week, "${title}" by ${artist}.`,
          `"${title}" by ${artist} stays on top of the Billboard chart for week number ${weeksAtOne}.`,
          `Remaining at number one in the nation this week, "${title}" by ${artist} marks ${weeksAtOne} weeks on top.`,
          `For the ${ordinal} straight week, "${title}" by ${artist} holds the number one spot.`,
          `"${title}" from ${artist} continues at number one this week, now at ${weeksAtOne} weeks.`,
        ];
      }
      break;
    }
    case 'number_one_this_week': {
      if (weeksAtOne === 1) {
        variants = [
          `Holding the number one spot in the nation, "${title}" by ${artist} reaches number one this week.`,
          `At the top of the charts this week, "${title}" by ${artist} reaches number one in the country.`,
          `The number one song in America this week is "${title}" by ${artist}, reaching number one this week.`,
          `Sitting at number one across the nation this week, "${title}" by ${artist} reaches the summit.`,
          `America's number one song this week: "${title}" by ${artist}, arriving at number one this week.`,
          `Leading the Billboard Hot 100 this week, "${title}" by ${artist} reaches number one in the nation.`,
        ];
      } else {
        const ordinal = spokenOrdinal(weeksAtOne);
        const artOrdinal = spokenOrdinalWithArticle(weeksAtOne);
        variants = [
          `Holding the number one spot in the nation this week, "${title}" by ${artist} marks its ${ordinal} week at the top of the Hot 100.`,
          `At the top of the charts this week, "${title}" by ${artist} is number one in the country for ${artOrdinal} week.`,
          `The number one song in America this week is "${title}" by ${artist}, celebrating its ${ordinal} week on top.`,
          `Sitting at number one across the nation this week, "${title}" by ${artist} enters ${artOrdinal} week at the summit.`,
          `America's number one song this week: "${title}" by ${artist}, in its ${ordinal} week at the peak.`,
          `Leading the Billboard Hot 100 this week, "${title}" by ${artist} marks week number ${weeksAtOne} at number one.`,
        ];
      }
      break;
    }
    case 'climb':
    default: {
      if (climbWeeks === 2) {
        variants = [
          `"${title}" by ${artist} has jumped from ${lastRank} up to number ${rank} over the last two weeks.`,
          `Over the last two weeks, "${title}" by ${artist} has surged from ${lastRank} to number ${rank}.`,
          `Making a big two-week move, "${title}" by ${artist} jumps up to number ${rank} from ${lastRank}.`,
          `"${title}" from ${artist} climbs from ${lastRank} up to number ${rank} over the past two weeks.`,
          `Rising quickly over the last two weeks, "${title}" by ${artist} leaps from ${lastRank} to number ${rank}.`,
          `"${title}" by ${artist} steps up to number ${rank} this week, climbing from ${lastRank} two weeks back.`,
        ];
      } else {
        variants = [
          `"${title}" by ${artist} is climbing up to number ${rank}, from ${lastRank} this week.`,
          `Moving up the charts this week, "${title}" by ${artist} jumps from ${lastRank} to number ${rank}.`,
          `On the climb this week, "${title}" by ${artist} rises from ${lastRank} up to number ${rank}.`,
          `"${title}" from ${artist} moves up the Hot 100 to number ${rank}, after sitting at ${lastRank}.`,
          `Making a jump this week, "${title}" by ${artist} moves up from ${lastRank} to number ${rank}.`,
          `Advancing on the chart this week, "${title}" by ${artist} steps up to number ${rank}, from ${lastRank}.`,
        ];
      }
      break;
    }
  }

  let nextIdx = Math.floor(rng() * variants.length);
  if (nextIdx === lastIdx) {
    nextIdx = (nextIdx + 1) % variants.length;
  }
  let selected = variants[nextIdx];
  // Clean double period on abbreviations like Jr..
  selected = selected.replace(/\.\.+/g, '.').replace(/\.\s*\./g, '.');
  return { text: selected, index: nextIdx };
}

export interface BreakDecisionResult {
  decision: 'speak' | 'silence';
  breakType: SpecABreakType | null;
  candidate: BreakCandidate | null;
  finalSpeech: string;
  targetSong: 'prev' | 'next' | 'none';
  sessionState: BreakSelectionSessionState;
}

/**
 * Decides whether to do a break and selects the exact candidate before LLM / synthesis.
 */
export function decideAndSelectBreak(
  input: BreakDecisionInput,
  state: BreakSelectionSessionState
): BreakDecisionResult {
  const rng = input.rng || Math.random;
  const chartRepo = input.chartRepo || new ChartFactRepository();
  const creditRepo = input.creditRepo || new SongCreditRepository();
  const frequency = input.frequencySetting ?? 0.5; // default roughly 1 break per 2 songs

  state.totalSongChanges++;

  // 1. Frequency check: Silence is the default
  // If random roll > frequency, return silence
  if (rng() >= frequency) {
    return {
      decision: 'silence',
      breakType: null,
      candidate: null,
      finalSpeech: '',
      targetSong: 'none',
      sessionState: state,
    };
  }

  // 2. Collect Candidates
  const candidates: BreakCandidate[] = [];

  // A. Chart facts for song played (prev) and song next
  // Single break rule: At most one spoken break per song across ALL types.
  const checkChart = (s: EngineSongInput | null, target: 'prev' | 'next') => {
    if (!s) return;
    if (state.songsWithSpokenBreak && ((s.id && state.songsWithSpokenBreak.has(s.id)) || (s.title && state.songsWithSpokenBreak.has(s.title)))) {
      return;
    }
    const facts = computeChartFacts(s, input.selectedDate, chartRepo);
    for (const f of facts) {
      const factKey = `chart:${s.title}:${f.kind}:${f.rank}:${f.date}`;
      candidates.push({
        type: 'chart_fact',
        factKey,
        factText: f.factText,
        source: f.source,
        date: f.date,
        targetSong: target,
        interestScore: f.interestScore,
        chartFact: f,
      } as any);
    }
  };
  checkChart(input.prevSong, 'prev');
  checkChart(input.nextSong, 'next');

  // A2. Station-level chart story: National number one this week
  // Deduplicate against song-level #1 facts for prev/next song
  const nationalNo1 = computeNationalNumberOneFact(input.selectedDate, chartRepo);
  if (nationalNo1) {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const natNorm = norm(nationalNo1.title);
    const prevMatches = input.prevSong && norm(input.prevSong.title) === natNorm;
    const nextMatches = input.nextSong && norm(input.nextSong.title) === natNorm;
    if (!prevMatches && !nextMatches) {
      const factKey = `chart:national_no1:${nationalNo1.title}:${nationalNo1.weeksAtOne}:${nationalNo1.date}`;
      candidates.push({
        type: 'chart_fact',
        factKey,
        factText: nationalNo1.factText,
        source: nationalNo1.source,
        date: nationalNo1.date,
        targetSong: 'none',
        interestScore: nationalNo1.interestScore, // 95
        chartFact: nationalNo1,
      } as any);
    }
  }

  // B. Song credit (writer, composer, lyricist, producer from song_facts)
  // Hook rule: Use a credit only when the writer differs from the performer,
  // or the writer wrote a library hit for another artist on or before the broadcast date.
  // Skip a performer credited as writer of their own song.
  // Band member & alias rule: Expand group credits to their members, and skip credits
  // where all writers are the performer, the group's members, or aliases of them
  // (e.g. Dwayne Carter and Lil Wayne, Antonio Romero Monge & Rafael Ruiz and Los Del Río).
  // Single break rule: At most one spoken break per song (intro or credit, not both).
  const checkCredits = (s: EngineSongInput | null, target: 'prev' | 'next') => {
    if (!s || !s.id) return;
    if (state.songsWithSpokenBreak && (state.songsWithSpokenBreak.has(s.id) || (s.title && state.songsWithSpokenBreak.has(s.title)))) {
      return;
    }
    const credits = creditRepo.getEligibleCredits(s.id, input.selectedDate);
    const bandMembers = creditRepo.getBandMembers(s.artist, input.selectedDate);
    const bandMembersLower = bandMembers.map((m) => m.toLowerCase());
    const artistAliases = creditRepo.getArtistAliases(s.artist);
    const artistAliasesLower = artistAliases.map((a) => a.toLowerCase());

    for (const c of credits) {
      let adaptationInfo: { artist: string; title: string } | null = null;
      const bMatch = c.fact_text.match(/Based on\s+"([^"]+)"/i);
      if (bMatch) {
        adaptationInfo = creditRepo.getOriginalRecordingForAdaptation(bMatch[1], input.selectedDate);
        // Requirement: For adaptations (Based on), require its date to be on or before the broadcast date.
        // If not found on or before broadcast date, skip adaptation fact.
        if (!adaptationInfo) {
          continue;
        }
      }

      const match = c.fact_text.match(/(?:Written|Composed|Lyrics) by ([^;.]+)/i);
      if (match) {
        const writers = match[1].split(/,\s*|\s+and\s+/i).map((w: string) => w.trim()).filter(Boolean);

        // Check if all writers are either the performer themselves, active band members, or known aliases
        const allWritersAreBandOrPerformer = writers.every((w: string) => {
          const wLower = w.toLowerCase();
          if (isWriterSameAsPerformer(w, s.artist)) return true;
          if (artistAliasesLower.some((al) => al === wLower || al.includes(wLower) || wLower.includes(al))) {
            return true;
          }
          if (bandMembersLower.some((bm) => bm === wLower || bm.includes(wLower) || wLower.includes(bm))) {
            return true;
          }
          return false;
        });

        if (allWritersAreBandOrPerformer) {
          // If all writers are band members / performer / aliases, check if any has a cross-artist hit
          const hasCrossHit = writers.some((w: string) => creditRepo.hasCrossArtistHit(w, s.id!, input.selectedDate, s.artist));
          if (!hasCrossHit && !adaptationInfo) {
            continue; // Skip: all writers are band members / aliases with no outside cross-artist hit
          }
        }
      }

      const factKey = `credit:${s.id}:${c.fact_type}:${c.fact_text}`;
      candidates.push({
        type: 'song_credit',
        factKey,
        factText: c.fact_text,
        source: c.source,
        date: c.public_date || input.selectedDate,
        targetSong: target,
        adaptationInfo,
      } as any);
    }
  };
  checkCredits(input.prevSong, 'prev');
  checkCredits(input.nextSong, 'next');

  // C. News observation (economy observations removed by product decision)
  if (input.newsObservation?.text) {
    // Unique headline key so a headline is NEVER reused within a session
    const headline = input.newsObservation.headline || input.newsObservation.text.split('.')[0] || input.newsObservation.text.slice(0, 50);
    const factKey = `news:${headline.trim().toLowerCase()}`;

    // Topic check: ensure two stories about the same subject (e.g. Falklands) aren't used within a session
    const topic = input.newsObservation.topic || 'general';
    const isTopicUsed = topic !== 'general' && (state.usedNewsTopics?.has(topic) ?? false);

    // Rate limit: at most one news break in every 4 breaks (breaksSinceLastNews >= 4)
    const canDoNews = (state.breaksSinceLastNews ?? 4) >= 4 && !isTopicUsed;
    if (canDoNews) {
      candidates.push({
        type: 'observation',
        factKey,
        factText: input.newsObservation.text,
        source: 'New York Times Historical Archive',
        date: input.newsObservation.date || input.selectedDate,
        targetSong: 'none',
        interestScore: 90, // Strong interest score when eligible
        topic,
      } as any);
    }
  }

  // D. Short song intro only (offered with baseline interest score 25 so substantive facts take priority)
  // Plain intros are capped to at most one in five breaks (~20%) when rich segment content is available.
  // Single break rule: At most one spoken break per song (intro or credit, not both).
  const plainCount = state.totalBreaksSpoken > 0 && (state as any).plainIntroCount !== undefined
    ? (state as any).plainIntroCount
    : 0;
  const plainRatio = state.totalBreaksSpoken > 0 ? plainCount / state.totalBreaksSpoken : 0;
  const allowIntroOnly = state.totalBreaksSpoken < 2 || plainRatio < 0.20;

  if (input.nextSong && allowIntroOnly) {
    const isSongSpoken = state.songsWithSpokenBreak && (
      (input.nextSong.id && state.songsWithSpokenBreak.has(input.nextSong.id)) ||
      (input.nextSong.title && state.songsWithSpokenBreak.has(input.nextSong.title))
    );
    if (!isSongSpoken) {
      const rawArtist = input.nextSong.primary_artist || input.nextSong.artist;
      const spokenArtist = cleanDuetArtist(rawArtist);
      const introObj = getNextSongIntro(input.nextSong.title, spokenArtist, state.lastIntroTemplateIndex ?? -1, rng);
      candidates.push({
        type: 'intro_only',
        factKey: `intro:${input.nextSong.title}:${spokenArtist}`,
        factText: introObj.text,
        source: 'Station Playlist',
        date: input.selectedDate,
        targetSong: 'next',
        interestScore: 25,
        templateIndex: introObj.index,
      } as any);
    }
  }

  // 3. Drop ineligible candidates & enforce variety rules:
  // - Never repeat the same fact in a session (factKey in state.usedFactKeys)
  // - Break up strict alternation: allow consecutive silences and consecutive intro_only,
  //   while still avoiding the same non-intro type twice in a row (e.g. chart_fact, song_credit, observation).
  const eligible = candidates.filter((c) => {
    if (state.usedFactKeys.has(c.factKey)) return false;
    if (state.lastBreakType && state.lastBreakType !== 'intro_only' && c.type === state.lastBreakType) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    // If no eligible candidates, do NOT automatically fall back to intro_only,
    // which would cause excessive speaking and flood playback. Return silence.
    return {
      decision: 'silence',
      breakType: null,
      candidate: null,
      finalSpeech: '',
      targetSong: 'none',
      sessionState: state,
    };
  }

  // 4. Pick one, respecting interest scores:
  // Sort candidates by interest score (default 50), pick highest or weighted
  eligible.sort((a: any, b: any) => (b.interestScore ?? 50) - (a.interestScore ?? 50));
  // Pick from the top tier of candidates
  const topScore = (eligible[0] as any).interestScore ?? 50;
  const topTier = eligible.filter((c: any) => ((c as any).interestScore ?? 50) >= topScore - 20);
  const chosenIndex = Math.floor(rng() * topTier.length);
  const chosen = topTier[chosenIndex];

  // 5. Build spoken output based on type
  // Rules:
  // - A fact break ends when the fact ends.
  // - Cost-of-living and news breaks never say "coming up" and never pretend to connect to the next song.
  // - A song intro appears only on intro-only breaks, or when the fact is about the next song.
  // - A chart fact names and is about the song it is attached to.
  // - song_credit, chart_fact, and intro_only use 5-8 rotating code templates each, never first-person.
  let speech = '';
  if (chosen.type === 'observation') {
    if (chosen.factKey.startsWith('news:')) {
      // Default clean news frame before LLM writing: "The Times reports: <headline>."
      const cleanHeadline = chosen.factText.replace(/^(?:in the news|from this morning's (?:new york )?times|the times reports|according to the times):\s*/i, '').split('.')[0].trim();
      speech = `The Times reports ${cleanHeadline}.`;
    } else {
      speech = chosen.factText;
    }
  } else if (chosen.type === 'intro_only') {
    speech = chosen.factText;
  } else if (chosen.type === 'chart_fact') {
    const chartRes = formatChartFactScript(chosen, state.lastChartTemplateIndex ?? -1, rng);
    speech = chartRes.text;
    state.lastChartTemplateIndex = chartRes.index;
  } else if (chosen.type === 'song_credit') {
    const target = chosen.targetSong === 'prev' ? input.prevSong : input.nextSong;
    if (target) {
      const rawArtist = target.primary_artist || target.artist;
      const spokenArtist = cleanDuetArtist(rawArtist);
      const creditRes = formatSongCreditScript(
        chosen.factText,
        { title: target.title, artist: spokenArtist },
        chosen.targetSong === 'prev' ? 'prev' : 'next',
        state.lastCreditTemplateIndex ?? -1,
        rng,
        (chosen as any).adaptationInfo
      );
      speech = creditRes.text;
      state.lastCreditTemplateIndex = creditRes.index;
    } else {
      speech = chosen.factText;
    }
  }

  // 6. Run final validation check
  const valContext: ValidationContext = {
    selectedDate: input.selectedDate,
    factPacket: {
      factText: chosen.factText,
      source: chosen.source,
      date: chosen.date,
    },
    songPlayed: input.prevSong,
    songNext: input.nextSong,
    recentBreaksTotal: state.totalBreaksSpoken,
    recentRhetoricalOpenersCount: state.recentRhetoricalOpeners,
  };

  const validation = validateBreakOutput(speech, valContext);
  if (!validation.valid) {
    console.log(`[Spec A Engine] Break rejected: ${validation.rejectedReason} -> falling back to silence.`);
    return {
      decision: 'silence',
      breakType: null,
      candidate: null,
      finalSpeech: '',
      targetSong: 'none',
      sessionState: state,
    };
  }

  // Record into session state
  state.usedFactKeys.add(chosen.factKey);
  state.lastBreakType = chosen.type;
  state.totalBreaksSpoken++;
  if (chosen.type === 'intro_only') {
    (state as any).plainIntroCount = ((state as any).plainIntroCount || 0) + 1;
  }
  if (/did you know|you remember this one/i.test(speech)) {
    state.recentRhetoricalOpeners++;
  }

  // Track songs that received a spoken break (intro, credit, or chart fact for that song)
  if (!state.songsWithSpokenBreak) {
    state.songsWithSpokenBreak = new Set<string>();
  }
  if (chosen.type === 'intro_only' && input.nextSong) {
    if (input.nextSong.id) state.songsWithSpokenBreak.add(input.nextSong.id);
    if (input.nextSong.title) state.songsWithSpokenBreak.add(input.nextSong.title);
  } else if (chosen.type === 'song_credit' || (chosen.type === 'chart_fact' && chosen.targetSong !== 'none')) {
    const s = chosen.targetSong === 'prev' ? input.prevSong : input.nextSong;
    if (s) {
      if (s.id) state.songsWithSpokenBreak.add(s.id);
      if (s.title) state.songsWithSpokenBreak.add(s.title);
    }
  }

  // Update intro template index if this was an intro_only
  if (chosen.type === 'intro_only' && typeof (chosen as any).templateIndex === 'number') {
    state.lastIntroTemplateIndex = (chosen as any).templateIndex;
  }

  // Rate limit & topic tracking: update breaksSinceLastNews and usedNewsTopics
  if (chosen.type === 'observation' && chosen.factKey.startsWith('news:')) {
    state.breaksSinceLastNews = 0;
    if ((chosen as any).topic && (chosen as any).topic !== 'general') {
      if (!state.usedNewsTopics) state.usedNewsTopics = new Set<string>();
      state.usedNewsTopics.add((chosen as any).topic);
    }
  } else {
    state.breaksSinceLastNews = (state.breaksSinceLastNews ?? 0) + 1;
  }

  return {
    decision: 'speak',
    breakType: chosen.type,
    candidate: chosen,
    finalSpeech: validation.sanitizedText,
    targetSong: chosen.targetSong,
    sessionState: state,
  };
}

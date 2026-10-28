/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Runtime Billboard Hot 100 chart fact computer.
 * Computes era-accurate facts at runtime strictly using weekly_chart rows
 * where chart_date <= selectedDate.
 *
 * NEVER reads or depends on future/static fields:
 * peak_position, peak_date, last_chart_date, or weeks_on_chart.
 */

import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';

export type ChartFactKind =
  | 'debut'
  | 'climb'
  | 'first_top_ten'
  | 'reached_number_one'
  | 'weeks_at_number_one';

export interface ChartFact {
  kind: ChartFactKind;
  factText: string;
  source: string;
  date: string;
  rank: number;
  lastRank?: number;
  weeksAtOne?: number;
  title: string;
  artist: string;
  interestScore: number;
}

export interface SongIdentifier {
  title: string;
  artist: string;
  primary_artist?: string | null;
}

/**
 * Normalizes text for matching chart titles and performers.
 */
export function normalizeChartText(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["\u201c\u201d\u2018\u2019'\.,!?:;\-\/\\&()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts primary performer name (splitting off featuring, with, and).
 */
export function primaryPerformer(performer: string): string {
  return (performer || '').split(/\s+featuring\s+|\s+with\s+|\s+and\s+/i)[0].trim();
}

interface ChartRow {
  chart_date: string;
  rank: number;
  title: string;
  performer: string;
}

/**
 * Interface for database query abstraction.
 * Works with node:sqlite (DatabaseSync) or bun:sqlite.
 */
export class ChartFactRepository {
  private db: any = null;

  constructor(dbPath?: string) {
    const homedir = process.env.HOME || '/root';
    const targetPath = dbPath || path.join(homedir, 'retrofm', 'library.sqlite');
    if (!fs.existsSync(targetPath)) {
      return;
    }

    try {
      const BunGlobal = (globalThis as any).Bun;
      if (BunGlobal && typeof BunGlobal.openDatabase === 'function') {
        this.db = BunGlobal.openDatabase(targetPath);
      } else {
        this.db = new DatabaseSync(targetPath);
      }
    } catch (e) {
      console.warn('[ChartFactRepository] Unable to open SQLite database:', e);
    }
  }

  public isAvailable(): boolean {
    return this.db !== null;
  }

  /**
   * Finds the latest chart_date on or before selectedDate.
   */
  public getChartWeekOn(selectedDate: string): string | null {
    if (!this.db) return null;
    try {
      const query = 'SELECT MAX(chart_date) AS d FROM weekly_chart WHERE chart_date <= ?';
      const row = this.db.prepare ? this.db.prepare(query).get(selectedDate) : this.db.query(query).get(selectedDate);
      return row?.d || null;
    } catch {
      return null;
    }
  }

  /**
   * Finds the previous chart_date that exists strictly before chartWeek.
   */
  public getPreviousChartWeek(chartWeek: string): string | null {
    if (!this.db) return null;
    try {
      const query = 'SELECT MAX(chart_date) AS d FROM weekly_chart WHERE chart_date < ?';
      const row = this.db.prepare ? this.db.prepare(query).get(chartWeek) : this.db.query(query).get(chartWeek);
      return row?.d || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetches all appearances of a song up to selectedDate.
   * Uses normalized title and performer matching.
   */
  public getSongHistory(song: SongIdentifier, upToDate: string): ChartRow[] {
    if (!this.db) return [];
    try {
      const normTitle = normalizeChartText(song.title);
      const normArtist = normalizeChartText(song.artist);
      const normPrimary = normalizeChartText(song.primary_artist || primaryPerformer(song.artist));

      // Query candidate rows by matching title (indexed by idx_wc_title)
      const query = 'SELECT chart_date, rank, title, performer FROM weekly_chart WHERE title = ? AND chart_date <= ? ORDER BY chart_date ASC';
      const exactRows: ChartRow[] = this.db.prepare ? this.db.prepare(query).all(song.title, upToDate) : this.db.query(query).all(song.title, upToDate);

      // If exact title gave rows, filter by performer
      let candidates = exactRows;
      if (candidates.length === 0) {
        // Fallback: search with LIKE or scan recent title matches
        const likeQuery = 'SELECT chart_date, rank, title, performer FROM weekly_chart WHERE title LIKE ? AND chart_date <= ? ORDER BY chart_date ASC';
        candidates = this.db.prepare ? this.db.prepare(likeQuery).all(`%${song.title.slice(0, 8)}%`, upToDate) : this.db.query(likeQuery).all(`%${song.title.slice(0, 8)}%`, upToDate);
      }

      return candidates.filter((r) => {
        if (normalizeChartText(r.title) !== normTitle) return false;
        const np = normalizeChartText(r.performer);
        return np === normArtist || np.includes(normPrimary) || normPrimary.includes(np);
      });
    } catch {
      return [];
    }
  }
}

/**
 * Computes all eligible era-accurate chart facts for a song on selectedDate.
 *
 * Rules:
 * 1. Only rows with chart_date <= selectedDate are considered.
 * 2. Fact kinds:
 *    - debut: First-ever appearance on the chart up to selectedDate occurs in current week.
 *    - climb: Current week rank < previous week rank (higher on chart).
 *    - first_top_ten: Current week rank <= 10, and song was NEVER in top 10 on any week prior.
 *    - reached_number_one: Current week rank == 1, and previous week rank != 1.
 *    - weeks_at_number_one: Cumulative count of weeks at rank 1 up to current week.
 * 3. Never reads peak_position, peak_date, last_chart_date, or weeks_on_chart.
 */
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

export function computeChartFacts(
  song: SongIdentifier,
  selectedDate: string,
  repo: ChartFactRepository
): ChartFact[] {
  if (!repo.isAvailable()) return [];

  const currentChartWeek = repo.getChartWeekOn(selectedDate);
  if (!currentChartWeek) return [];

  const history = repo.getSongHistory(song, selectedDate);
  if (history.length === 0) return [];

  // Check if song is on the chart this week
  const currentEntry = history.find((h) => h.chart_date === currentChartWeek);
  if (!currentEntry) return [];

  const currentRank = currentEntry.rank;
  const prevChartWeek = repo.getPreviousChartWeek(currentChartWeek);
  const prevEntry = prevChartWeek ? history.find((h) => h.chart_date === prevChartWeek) : null;
  const prevRank = prevEntry?.rank;

  const spokenArtist = cleanDuetArtist(song.primary_artist || song.artist);
  const facts: ChartFact[] = [];
  const source = 'Billboard Hot 100';

  // 1. Debut: First-ever appearance on the chart up to the selected date
  const firstAppearance = history[0];
  const isDebut = firstAppearance.chart_date === currentChartWeek;
  if (isDebut) {
    facts.push({
      kind: 'debut',
      factText: `"${song.title}" by ${spokenArtist} is new on the Hot 100 this week at number ${currentRank}.`,
      source,
      date: currentChartWeek,
      rank: currentRank,
      title: song.title,
      artist: spokenArtist,
      interestScore: 100, // debut beats plain climbs
    });
  }

  // 2. Climb: Rank now versus previous existing chart week
  // Interest rule: Only report a climb of 8 or more places, plus the existing debut, first top-10, number 1 and weeks-at-number-1 facts.
  if (prevRank !== undefined && currentRank < prevRank) {
    const jump = prevRank - currentRank;
    if (jump >= 8) {
      facts.push({
        kind: 'climb',
        factText: `"${song.title}" by ${spokenArtist} is climbing up to number ${currentRank}, from ${prevRank} this week.`,
        source,
        date: currentChartWeek,
        rank: currentRank,
        lastRank: prevRank,
        title: song.title,
        artist: spokenArtist,
        interestScore: jump >= 15 ? 60 : 40,
      });
    }
  }

  // 3. First week in the top 10
  if (currentRank <= 10) {
    const priorTopTen = history.some((h) => h.chart_date < currentChartWeek && h.rank <= 10);
    if (!priorTopTen) {
      facts.push({
        kind: 'first_top_ten',
        factText: `"${song.title}" by ${spokenArtist} enters the top ten for the first time this week at number ${currentRank}.`,
        source,
        date: currentChartWeek,
        rank: currentRank,
        lastRank: prevRank,
        title: song.title,
        artist: spokenArtist,
        interestScore: 90, // first top-10 week beats plain climbs
      });
    }
  }

  // 4. Reached number 1
  if (currentRank === 1 && prevRank !== 1) {
    facts.push({
      kind: 'reached_number_one',
      factText: `"${song.title}" by ${spokenArtist} climbs to number one on the Billboard Hot 100 this week${prevRank ? `, up from ${prevRank}` : ''}.`,
      source,
      date: currentChartWeek,
      rank: 1,
      lastRank: prevRank,
      title: song.title,
      artist: spokenArtist,
      interestScore: 110, // reaching #1 beats plain climbs
    });
  }

  // 5. Weeks at number 1 so far
  const weeksAtOneSoFar = history.filter((h) => h.rank === 1 && h.chart_date <= currentChartWeek).length;
  if (currentRank === 1 && weeksAtOneSoFar >= 1) {
    facts.push({
      kind: 'weeks_at_number_one',
      factText: `"${song.title}" by ${spokenArtist} is number one on the chart for ${weeksAtOneSoFar === 1 ? 'its first week' : `${weeksAtOneSoFar} weeks so far`}.`,
      source,
      date: currentChartWeek,
      rank: 1,
      weeksAtOne: weeksAtOneSoFar,
      title: song.title,
      artist: spokenArtist,
      interestScore: 105, // weeks at #1 beats plain climbs
    });
  }

  return facts;
}

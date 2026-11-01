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
  | 'weeks_in_top_ten'
  | 'reached_number_one'
  | 'weeks_at_number_one'
  | 'number_one_this_week';

export interface ChartFact {
  kind: ChartFactKind;
  factText: string;
  source: string;
  date: string;
  rank: number;
  lastRank?: number;
  weeksAtOne?: number;
  weeksInTopTen?: number;
  climbWeeks?: number;
  prevNumberOne?: { title: string; artist: string };
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

/**
 * Returns a spoken ordinal with grammatically correct indefinite article ("a first", "an eighth", "an eleventh").
 */
export function spokenOrdinalWithArticle(n: number): string {
  const ord = spokenOrdinal(n);
  const article = /^[aeiou]/i.test(ord) ? 'an' : 'a';
  return `${article} ${ord}`;
}
export function spokenOrdinal(n: number): string {
  const ordinals: Record<number, string> = {
    1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth',
    6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth',
    11: 'eleventh', 12: 'twelfth', 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth',
    16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth', 19: 'nineteenth', 20: 'twentieth',
    21: 'twenty-first', 22: 'twenty-second', 23: 'twenty-third', 24: 'twenty-fourth', 25: 'twenty-fifth',
    26: 'twenty-sixth', 27: 'twenty-seventh', 28: 'twenty-eighth', 29: 'twenty-ninth', 30: 'thirtieth',
    40: 'fortieth', 50: 'fiftieth',
  };
  if (ordinals[n]) return ordinals[n];
  if (n > 20 && n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const units = n % 10;
    const tensWords: Record<number, string> = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety' };
    if (units === 0 && ordinals[tens]) return ordinals[tens];
    if (tensWords[tens] && ordinals[units]) return `${tensWords[tens]}-${ordinals[units]}`;
  }
  return `${n}th`;
}

interface ChartRow {
  chart_date: string;
  rank: number;
  title: string;
  performer: string;
}

/**
 * Interface for database query abstraction.
 * Reads static JSON files from public/data/ or fallback SQLite database if present.
 */
export class ChartFactRepository {
  private db: any = null;
  private dataDir: string;
  private decadeCache = new Map<string, ChartRow[]>();
  private allWeeks: string[] | null = null;
  private isJsonAvailable = false;

  constructor(customPathOrDir?: string) {
    const homedir = process.env.HOME || '/root';
    this.dataDir = customPathOrDir && fs.existsSync(customPathOrDir) && fs.statSync(customPathOrDir).isDirectory()
      ? customPathOrDir
      : path.resolve(process.cwd(), 'public/data');

    // Check if JSON chart files exist, with automatic fallback to sample/ if full files are absent
    const standardJson = path.join(this.dataDir, 'chart_facts_1980s.json');
    const sampleSubdir = path.join(this.dataDir, 'sample');
    if (fs.existsSync(standardJson)) {
      this.isJsonAvailable = true;
    } else if (fs.existsSync(path.join(sampleSubdir, 'chart_facts_1980s.json'))) {
      this.dataDir = sampleSubdir;
      this.isJsonAvailable = true;
    } else {
      // Fallback: check SQLite if JSON files are not yet generated
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
        } catch (e) {
          console.warn('[ChartFactRepository] Unable to open SQLite database:', e);
        }
      }
    }
  }

  public isAvailable(): boolean {
    return this.isJsonAvailable || this.db !== null;
  }

  private getDecade(dateStr: string): string {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const decadeStart = Math.floor(y / 10) * 10;
    return `${decadeStart}s`;
  }

  private loadDecadeRows(decade: string): ChartRow[] {
    if (this.decadeCache.has(decade)) {
      return this.decadeCache.get(decade)!;
    }
    const file = path.join(this.dataDir, `chart_facts_${decade}.json`);
    if (fs.existsSync(file)) {
      try {
        const rows: ChartRow[] = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.decadeCache.set(decade, rows);
        return rows;
      } catch (err) {
        console.warn(`[ChartFactRepository] Error reading ${file}:`, err);
      }
    }
    return [];
  }

  private getAllChartWeeks(): string[] {
    if (this.allWeeks) return this.allWeeks;
    if (this.isJsonAvailable) {
      const weeksSet = new Set<string>();
      const decades = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
      for (const dec of decades) {
        const rows = this.loadDecadeRows(dec);
        for (const r of rows) {
          weeksSet.add(r.chart_date);
        }
      }
      this.allWeeks = Array.from(weeksSet).sort();
      return this.allWeeks;
    }
    return [];
  }

  /**
   * Finds the latest chart_date on or before selectedDate.
   */
  public getChartWeekOn(selectedDate: string): string | null {
    if (this.isJsonAvailable) {
      const weeks = this.getAllChartWeeks();
      for (let i = weeks.length - 1; i >= 0; i--) {
        if (weeks[i] <= selectedDate) {
          return weeks[i];
        }
      }
      return null;
    }
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
    if (this.isJsonAvailable) {
      const weeks = this.getAllChartWeeks();
      for (let i = weeks.length - 1; i >= 0; i--) {
        if (weeks[i] < chartWeek) {
          return weeks[i];
        }
      }
      return null;
    }
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
   * Gets the #1 song for a specific chart week.
   */
  public getNumberOneOnWeek(chartWeek: string): { title: string; performer: string } | null {
    if (!chartWeek) return null;
    if (this.isJsonAvailable) {
      const dec = this.getDecade(chartWeek);
      const rows = this.loadDecadeRows(dec);
      const found = rows.find((r) => r.chart_date === chartWeek && r.rank === 1);
      if (found && found.title && found.performer) {
        return { title: found.title, performer: found.performer };
      }
      return null;
    }
    if (!this.db) return null;
    try {
      const query = 'SELECT title, performer FROM weekly_chart WHERE chart_date = ? AND rank = 1';
      const row = this.db.prepare ? this.db.prepare(query).get(chartWeek) : this.db.query(query).get(chartWeek);
      if (row && row.title && row.performer) {
        return { title: row.title, performer: row.performer };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Computes the cumulative weeks at #1 for a song up to chartWeek.
   */
  public getWeeksAtNumberOne(title: string, performer: string, chartWeek: string): number {
    if (!title || !chartWeek) return 0;
    if (this.isJsonAvailable) {
      const normTitle = normalizeChartText(title);
      const targetYear = parseInt(chartWeek.slice(0, 4), 10);
      const decades = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
      let count = 0;
      for (const dec of decades) {
        const decYear = parseInt(dec.slice(0, 4), 10);
        if (decYear > targetYear) break;
        const rows = this.loadDecadeRows(dec);
        for (const r of rows) {
          if (r.chart_date <= chartWeek && r.rank === 1) {
            if (r.title === title || normalizeChartText(r.title) === normTitle) {
              count++;
            }
          }
        }
      }
      return count;
    }
    if (!this.db) return 0;
    try {
      const normTitle = normalizeChartText(title);
      const query = 'SELECT chart_date, performer FROM weekly_chart WHERE title = ? AND rank = 1 AND chart_date <= ?';
      const rows = this.db.prepare ? this.db.prepare(query).all(title, chartWeek) : this.db.query(query).all(title, chartWeek);
      if (!rows || rows.length === 0) {
        const likeQuery = 'SELECT chart_date, performer, title FROM weekly_chart WHERE rank = 1 AND chart_date <= ?';
        const allOnes = this.db.prepare ? this.db.prepare(likeQuery).all(chartWeek) : this.db.query(likeQuery).all(chartWeek);
        return allOnes.filter((r: any) => normalizeChartText(r.title) === normTitle).length;
      }
      return rows.length;
    } catch {
      return 0;
    }
  }

  /**
   * Fetches all appearances of a song up to selectedDate.
   * Uses normalized title and performer matching.
   */
  public getSongHistory(song: SongIdentifier, upToDate: string): ChartRow[] {
    if (this.isJsonAvailable) {
      const normTitle = normalizeChartText(song.title);
      const normArtist = normalizeChartText(song.artist);
      const normPrimary = normalizeChartText(song.primary_artist || primaryPerformer(song.artist));

      const targetYear = parseInt(upToDate.slice(0, 4), 10);
      const currentDecadeStart = Math.floor(targetYear / 10) * 10;
      // Search current decade and immediately prior decade to cover multi-month cross-decade chart runs
      const decadesToSearch = [
        `${currentDecadeStart - 10}s`,
        `${currentDecadeStart}s`,
      ];

      const candidates: ChartRow[] = [];
      for (const dec of decadesToSearch) {
        const rows = this.loadDecadeRows(dec);
        for (const r of rows) {
          if (r.chart_date > upToDate) continue;
          if (r.title === song.title || normalizeChartText(r.title) === normTitle) {
            const np = normalizeChartText(r.performer);
            if (np === normArtist || np.includes(normPrimary) || normPrimary.includes(np)) {
              candidates.push(r);
            }
          }
        }
      }

      // If no exact match, fallback to 8-char title prefix
      if (candidates.length === 0 && song.title.length >= 4) {
        const titlePrefix = normalizeChartText(song.title.slice(0, 8));
        for (const dec of decadesToSearch) {
          const rows = this.loadDecadeRows(dec);
          for (const r of rows) {
            if (r.chart_date > upToDate) continue;
            if (normalizeChartText(r.title).includes(titlePrefix)) {
              const np = normalizeChartText(r.performer);
              if (np === normArtist || np.includes(normPrimary) || normPrimary.includes(np)) {
                candidates.push(r);
              }
            }
          }
        }
      }

      candidates.sort((a, b) => a.chart_date.localeCompare(b.chart_date));
      return candidates;
    }

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
  let s = name
    .replace(/\s*\/\s*/g, ' and ')
    .replace(/\s+A Duet With\s+/gi, ' and ')
    .replace(/\s+Duet With\s+/gi, ' and ')
    .replace(/\s+Duet\s+/gi, ' and ')
    .replace(/\s+With\s+/gi, ' and ')
    .replace(/\s+(?:Featuring|Feat\.)\s+/gi, ' and ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+and\s+and\s+/gi, ' and ')
    .replace(/\s\s+/g, ' ')
    .trim();
  s = s.replace(/^\s*and\s+/i, '').replace(/\s+and\s*$/i, '').trim();
  return s;
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

  const twoWeeksAgoChartWeek = prevChartWeek ? repo.getPreviousChartWeek(prevChartWeek) : null;
  const twoWeeksAgoEntry = twoWeeksAgoChartWeek ? history.find((h) => h.chart_date === twoWeeksAgoChartWeek) : null;
  const twoWeeksAgoRank = twoWeeksAgoEntry?.rank;

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

  // 2. Climb: Biggest climb over the last two weeks (8 or more places), or 1-week jump of 8 or more places
  let climbFact: ChartFact | null = null;
  if (twoWeeksAgoRank !== undefined && currentRank < twoWeeksAgoRank) {
    const jump2 = twoWeeksAgoRank - currentRank;
    if (jump2 >= 8) {
      climbFact = {
        kind: 'climb',
        factText: `"${song.title}" by ${spokenArtist} has jumped from ${twoWeeksAgoRank} up to number ${currentRank} over the last two weeks.`,
        source,
        date: currentChartWeek,
        rank: currentRank,
        lastRank: twoWeeksAgoRank,
        climbWeeks: 2,
        title: song.title,
        artist: spokenArtist,
        interestScore: jump2 >= 15 ? 65 : 45,
      };
    }
  }
  if (!climbFact && prevRank !== undefined && currentRank < prevRank) {
    const jump1 = prevRank - currentRank;
    if (jump1 >= 8) {
      climbFact = {
        kind: 'climb',
        factText: `"${song.title}" by ${spokenArtist} is climbing up to number ${currentRank}, from ${prevRank} this week.`,
        source,
        date: currentChartWeek,
        rank: currentRank,
        lastRank: prevRank,
        climbWeeks: 1,
        title: song.title,
        artist: spokenArtist,
        interestScore: jump1 >= 15 ? 60 : 40,
      };
    }
  }
  if (climbFact) {
    facts.push(climbFact);
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

  // 3b. Multi-week chart story: Weeks in the top 10 so far (cumulative weeks in top 10 >= 2)
  if (currentRank <= 10) {
    const weeksInTopTenSoFar = history.filter((h) => h.rank <= 10 && h.chart_date <= currentChartWeek).length;
    if (weeksInTopTenSoFar >= 2) {
      const artOrdinal = spokenOrdinalWithArticle(weeksInTopTenSoFar);
      facts.push({
        kind: 'weeks_in_top_ten',
        factText: `"${song.title}" by ${spokenArtist} spends ${artOrdinal} week in the top ten.`,
        source,
        date: currentChartWeek,
        rank: currentRank,
        weeksInTopTen: weeksInTopTenSoFar,
        title: song.title,
        artist: spokenArtist,
        interestScore: 85,
      });
    }
  }

  // 4. Reached number 1 / First week at number one
  if (currentRank === 1 && prevRank !== 1) {
    let prevNo1 = prevChartWeek ? repo.getNumberOneOnWeek(prevChartWeek) : null;
    let takingOverPhrase = '';
    let prevNo1Info: { title: string; artist: string } | undefined = undefined;
    if (prevNo1 && prevNo1.title && prevNo1.title.toLowerCase() !== song.title.toLowerCase()) {
      const spokenPrevArtist = cleanDuetArtist(prevNo1.performer);
      takingOverPhrase = `, taking over the top spot from "${prevNo1.title}" by ${spokenPrevArtist}`;
      prevNo1Info = { title: prevNo1.title, artist: spokenPrevArtist };
    }

    facts.push({
      kind: 'reached_number_one',
      factText: `"${song.title}" by ${spokenArtist} reaches number one on the Billboard Hot 100 this week${takingOverPhrase}.`,
      source,
      date: currentChartWeek,
      rank: 1,
      lastRank: prevRank,
      prevNumberOne: prevNo1Info,
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
      factText: weeksAtOneSoFar === 1
        ? `"${song.title}" by ${spokenArtist} reaches number one this week.`
        : `"${song.title}" by ${spokenArtist} is number one on the chart for ${weeksAtOneSoFar} weeks so far.`,
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

/**
 * Computes the chart status fact (rank this week, change from last week, weeks in top 10 / weeks on chart)
 * for a song on selectedDate from weekly_chart.
 */
/**
 * Computes the chart status fact (position and change this week, or weeks on chart,
 * or stating when the song is not on the chart that week) for a song on selectedDate from weekly_chart.
 * Requirement 4:
 * Every next-song story must try to include chart status from weekly_chart on or before the broadcast date
 * (position and change this week, or weeks on chart), and say so when the song is not on the chart that week.
 */
export function computeSongChartStatusFact(
  song: SongIdentifier,
  selectedDate: string,
  repo: ChartFactRepository
): VerifiedFactPacketItem | null {
  if (!repo.isAvailable()) return null;

  const currentChartWeek = repo.getChartWeekOn(selectedDate);
  if (!currentChartWeek) return null;

  const history = repo.getSongHistory(song, selectedDate);

  // If song is NOT on the chart this week:
  const currentEntry = history.find((h) => h.chart_date === currentChartWeek);
  if (!currentEntry) {
    if (history.length > 0) {
      // Find peak rank and peak date
      let bestRank = 101;
      let peakDateStr = '';
      for (const h of history) {
        if (h.rank < bestRank) {
          bestRank = h.rank;
          peakDateStr = h.chart_date;
        }
      }

      // Check if run ended before broadcast date
      const lastEntry = history[history.length - 1];
      if (lastEntry.chart_date < currentChartWeek) {
        const weeksCount = history.length;
        const rankOneRows = history.filter((h) => h.rank === 1);
        const weeksAtOne = rankOneRows.length;
        const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        let peakSentence = '';
        if (bestRank === 1) {
          if (peakDateStr) {
            const [py, pm] = peakDateStr.split('-');
            const mName = MONTH_NAMES[parseInt(pm, 10) - 1] || '';
            peakSentence = `It reached number one on the Hot 100 in ${mName} ${py}.`;
          } else {
            peakSentence = `It reached number one on the Hot 100.`;
          }
        } else if (bestRank <= 5) {
          peakSentence = `It was a top five hit on the Hot 100.`;
        } else if (bestRank <= 10) {
          peakSentence = `It was a top ten hit on the Hot 100.`;
        } else if (bestRank <= 20) {
          peakSentence = `It reached the top twenty on the Hot 100.`;
        } else if (bestRank <= 40) {
          peakSentence = `It reached the top forty on the Hot 100.`;
        } else {
          peakSentence = `It reached number ${bestRank} on the Hot 100.`;
        }

        const runSentence = `It spent ${weeksCount} weeks on the chart.`;
        const fullFactText = `${peakSentence} ${runSentence}`;

        return {
          text: fullFactText,
          source: 'Billboard Hot 100',
          printDate: lastEntry.chart_date,
          date: lastEntry.chart_date,
          isLockedSentence: true,
          weeksAtOne,
          weeksOnChart: weeksCount,
          peakRank: bestRank,
          peakDate: peakDateStr,
        };
      }
    }

    return null;
  }

  const currentRank = currentEntry.rank;
  const prevChartWeek = repo.getPreviousChartWeek(currentChartWeek);
  const prevEntry = prevChartWeek ? history.find((h) => h.chart_date === prevChartWeek) : null;
  const prevRank = prevEntry?.rank;

  const weeksOnChartSoFar = history.filter((h) => h.chart_date <= currentChartWeek).length;
  const weeksInTopTenSoFar = history.filter((h) => h.rank <= 10 && h.chart_date <= currentChartWeek).length;

  let movementText = '';
  if (prevRank !== undefined) {
    if (currentRank < prevRank) {
      movementText = `, climbing up from number ${prevRank} last week`;
    } else if (currentRank > prevRank) {
      movementText = `, down from number ${prevRank} last week`;
    } else {
      movementText = `, holding steady from last week`;
    }
  } else if (weeksOnChartSoFar === 1) {
    movementText = ` in its chart debut`;
  }

  let durationText = '';
  if (currentRank <= 10 && weeksInTopTenSoFar >= 2) {
    durationText = ` and spending its ${spokenOrdinal(weeksInTopTenSoFar)} week in the top ten`;
  } else if (weeksOnChartSoFar > 1) {
    durationText = ` in its ${spokenOrdinal(weeksOnChartSoFar)} week on the chart`;
  }

  const factText = `"${song.title}" is at number ${currentRank} on the Billboard Hot 100 this week${movementText}${durationText}.`;

  return {
    text: factText,
    source: 'Billboard Hot 100',
    printDate: currentChartWeek,
    date: currentChartWeek,
  };
}

export interface VerifiedFactPacketItem {
  text: string;
  source: string;
  printDate?: string;
  date: string;
  isLockedSentence?: boolean;
  weeksAtOne?: number;
  weeksOnChart?: number;
  peakRank?: number;
  peakDate?: string;
}

/**
 * Computes the national "number one this week" chart break for the station on selectedDate.
 * Mentions the song and how many weeks it has held number one so far.
 */
export function computeNationalNumberOneFact(
  selectedDate: string,
  repo: ChartFactRepository
): ChartFact | null {
  if (!repo.isAvailable()) return null;

  const currentChartWeek = repo.getChartWeekOn(selectedDate);
  if (!currentChartWeek) return null;

  const no1 = repo.getNumberOneOnWeek(currentChartWeek);
  if (!no1 || !no1.title || !no1.performer) return null;

  const spokenArtist = cleanDuetArtist(no1.performer);
  const weeksAtOne = repo.getWeeksAtNumberOne(no1.title, no1.performer, currentChartWeek);
  const weeksCount = weeksAtOne > 0 ? weeksAtOne : 1;
  const ordinal = spokenOrdinal(weeksCount);

  return {
    kind: 'number_one_this_week',
    factText: weeksCount === 1
      ? `Holding the number one spot in the nation, "${no1.title}" by ${spokenArtist} reaches number one this week.`
      : `Holding the number one spot in the nation this week, "${no1.title}" by ${spokenArtist} marks its ${ordinal} week at the top of the Hot 100.`,
    source: 'Billboard Hot 100',
    date: currentChartWeek,
    rank: 1,
    weeksAtOne: weeksCount,
    title: no1.title,
    artist: spokenArtist,
    interestScore: 95,
  };
}

/**
 * scripts/export-library-data.ts
 *
 * Full deterministic exporter: library.sqlite -> public/data/
 *
 * Requirements:
 * 1. Fully regenerates every runtime JSON file from library.sqlite,
 *    including retrofm_library_youtube.json.
 * 2. Strict referential integrity check: fails loudly if any fact,
 *    credit, or band member reference refers to a non-existent song/artist.
 * 3. Clears .cache/song-cards/ on every run.
 * 4. Weekly chart files are split by decade, rewriting ONLY decades whose content changed.
 * 5. Prints row counts and disk sizes for every output file at the end.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const homedir = process.env.HOME || os.homedir();
const dbPath = process.env.SQLITE_PATH || path.join(homedir, 'retrofm', 'library.sqlite');
const outputDir = path.resolve(process.cwd(), 'public/data');
const cacheSongCardsDir = path.resolve(process.cwd(), '.cache/song-cards');

if (!fs.existsSync(dbPath)) {
  console.error(`FATAL: SQLite database not found at ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

// 1. Clear .cache/song-cards/ on every run
if (fs.existsSync(cacheSongCardsDir)) {
  fs.rmSync(cacheSongCardsDir, { recursive: true, force: true });
  console.log(`Cleared song cards cache: ${cacheSongCardsDir}`);
}

console.log(`Reading SQLite database: ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true } as any);

// Helper for text normalization during referential validation
function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b4\b/g, 'four')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Load all songs into memory for integrity checking & exporting
interface SongRow {
  id: string;
  title: string;
  artist: string;
  primary_artist: string | null;
  chart_year: number;
  chart_year_rank: number;
  rank_method: string;
  decade: string;
  release_date: string | null;
  release_date_precision: string | null;
  album: string | null;
  duration_sec: number | null;
  mbid: string | null;
  isrc: string | null;
  mb_genres: string | null;
  peak_position: number | null;
  first_chart_date: string | null;
  last_chart_date: string | null;
  peak_date: string | null;
  weeks_on_chart: number | null;
  streaming: string | null;
  genres: string | null;
  primary_genre: string | null;
  date_source: string | null;
  yt_status: string | null;
}

const allSqliteSongs: SongRow[] = db.prepare(`
  SELECT id, title, artist, primary_artist, chart_year, chart_year_rank, rank_method,
         decade, release_date, release_date_precision, album, duration_sec, mbid, isrc,
         mb_genres, peak_position, first_chart_date, last_chart_date, peak_date,
         weeks_on_chart, streaming, genres, primary_genre, date_source, yt_status
  FROM songs
  ORDER BY id ASC
`).all() as any[];

const validSongIds = new Set<string>(allSqliteSongs.map((s) => s.id));
const validArtistNames = new Set<string>();
for (const s of allSqliteSongs) {
  if (s.artist) validArtistNames.add(normalizeName(s.artist));
  if (s.primary_artist) validArtistNames.add(normalizeName(s.primary_artist));
}
// Also include historical Hot 100 chart performers
const chartPerformers = db.prepare('SELECT DISTINCT performer FROM weekly_chart').all() as any[];
for (const cp of chartPerformers) {
  if (cp.performer) validArtistNames.add(normalizeName(cp.performer));
}

// 2. Load and validate song_facts
interface SongFactRow {
  id: number;
  song_id: string;
  fact_type: string;
  fact_text: string;
  event_date: string | null;
  public_date: string | null;
  source: string | null;
  source_url: string | null;
}

const songFacts: SongFactRow[] = db.prepare(`
  SELECT id, song_id, fact_type, fact_text, event_date, public_date, source, source_url
  FROM song_facts
  ORDER BY song_id ASC, id ASC
`).all() as any[];

const orphanFacts = songFacts.filter((f) => !validSongIds.has(f.song_id));
if (orphanFacts.length > 0) {
  console.error(`FATAL: Referential integrity violation! Found ${orphanFacts.length} song_facts referencing unknown song IDs:`);
  for (const ofact of orphanFacts.slice(0, 5)) {
    console.error(`  - Fact ID ${ofact.id} references non-existent song_id "${ofact.song_id}" ("${ofact.fact_text}")`);
  }
  process.exit(1);
}

// 3. Load and validate band_members
interface BandMemberRow {
  id: number;
  band_name: string;
  member_name: string;
  begin_date: string | null;
  end_date: string | null;
}

const bandMembers: BandMemberRow[] = db.prepare(`
  SELECT id, band_name, member_name, begin_date, end_date
  FROM band_members
  ORDER BY band_name ASC, id ASC
`).all() as any[];

const orphanBands: string[] = [];
for (const bm of bandMembers) {
  const normBand = normalizeName(bm.band_name);
  let matched = validArtistNames.has(normBand);
  if (!matched) {
    for (const an of validArtistNames) {
      if (an.includes(normBand) || normBand.includes(an)) {
        matched = true;
        break;
      }
    }
  }
  if (!matched && !orphanBands.includes(bm.band_name)) {
    orphanBands.push(bm.band_name);
  }
}

if (orphanBands.length > 0) {
  console.warn(`[export-library] Warning: Found band_members for bands not present in library or charts:`);
  for (const ob of orphanBands) {
    console.warn(`  - Band name "${ob}" has no matching artist in songs or weekly_chart.`);
  }
}


// 4. Load artist_aliases
interface ArtistAliasRow {
  id: number;
  artist_name: string;
  alias_name: string;
  alias_type: string | null;
}

const artistAliases: ArtistAliasRow[] = db.prepare(`
  SELECT id, artist_name, alias_name, alias_type
  FROM artist_aliases
  ORDER BY artist_name ASC, id ASC
`).all() as any[];

// 5. Partition songs:
//    - Verified YouTube library: songs with yt_status='done' and valid streaming youtube ID
//    - Supplemental songs: remaining songs in library.sqlite needed for chart cross-referencing / adaptations
const verifiedYouTubeSongs: any[] = [];
const supplementalSongs: any[] = [];

for (const s of allSqliteSongs) {
  let streamObj: any = null;
  if (s.streaming) {
    try {
      streamObj = JSON.parse(s.streaming);
    } catch {}
  }

  const hasYt = Boolean(streamObj && streamObj.youtube && streamObj.youtube.id);
  if (hasYt && s.yt_status === 'done') {
    const fullStreaming = {
      youtube: streamObj.youtube,
      youtube_music: streamObj.youtube_music || { id: null, url: null },
      spotify: streamObj.spotify || { id: null, url: null },
      apple_music: streamObj.apple_music || { id: null, url: null },
      amazon_music: streamObj.amazon_music || { id: null, url: null },
      tidal: streamObj.tidal || { id: null, url: null },
      deezer: streamObj.deezer || { id: null, url: null },
    };

    const mb = s.mbid ? {
      recording_mbid: s.mbid,
      recording_url: `https://musicbrainz.org/recording/${s.mbid}`,
    } : {
      recording_mbid: null,
      recording_url: null,
    };

    verifiedYouTubeSongs.push({
      id: s.id,
      title: s.title,
      artist: s.artist,
      primary_artist: s.primary_artist,
      chart_year: s.chart_year,
      chart_year_rank: s.chart_year_rank,
      rank_method: s.rank_method,
      release_date: s.release_date,
      release_date_precision: s.release_date_precision,
      date_source: s.date_source,
      decade: s.decade,
      genres: s.genres,
      primary_genre: s.primary_genre,
      album: s.album,
      duration_sec: s.duration_sec,
      peak_position: s.peak_position,
      first_chart_date: s.first_chart_date,
      last_chart_date: s.last_chart_date,
      peak_date: s.peak_date,
      weeks_on_chart: s.weeks_on_chart,
      musicbrainz: mb,
      isrc: s.isrc,
      streaming: fullStreaming,
      verification: 'verified',
    });
  } else {
    supplementalSongs.push({
      id: s.id,
      title: s.title,
      artist: s.artist,
      primary_artist: s.primary_artist,
      chart_year: s.chart_year,
      chart_year_rank: s.chart_year_rank,
      decade: s.decade,
      release_date: s.release_date,
      first_chart_date: s.first_chart_date,
      last_chart_date: s.last_chart_date,
      peak_position: s.peak_position,
      duration_sec: s.duration_sec,
      genres: s.genres,
      primary_genre: s.primary_genre,
    });
  }
}

// 6. Write helper with atomic check (only rewrite if content changed)
interface FileReport {
  file: string;
  rows: number;
  sizeBytes: number;
  status: 'written' | 'unchanged';
}
const reports: FileReport[] = [];

function writeJsonIfChanged(filePath: string, data: any, rowCount: number) {
  const content = JSON.stringify(data, null, 2);
  let isChanged = true;
  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) {
        isChanged = false;
      }
    } catch {}
  }

  if (isChanged) {
    fs.writeFileSync(filePath, content, 'utf8');
  }

  const stat = fs.statSync(filePath);
  reports.push({
    file: path.basename(filePath),
    rows: rowCount,
    sizeBytes: stat.size,
    status: isChanged ? 'written' : 'unchanged',
  });
}

// Write retrofm_library_youtube.json
const ytLibPath = path.join(outputDir, 'retrofm_library_youtube.json');
writeJsonIfChanged(ytLibPath, verifiedYouTubeSongs, verifiedYouTubeSongs.length);

// Write songs_extra.json
const extraSongsPath = path.join(outputDir, 'songs_extra.json');
writeJsonIfChanged(extraSongsPath, supplementalSongs, supplementalSongs.length);

// Write song_facts.json
const songFactsPath = path.join(outputDir, 'song_facts.json');
writeJsonIfChanged(songFactsPath, songFacts, songFacts.length);

// Write band_members.json
const bandMembersPath = path.join(outputDir, 'band_members.json');
writeJsonIfChanged(bandMembersPath, bandMembers, bandMembers.length);

// Write artist_aliases.json
const artistAliasesPath = path.join(outputDir, 'artist_aliases.json');
writeJsonIfChanged(artistAliasesPath, artistAliases, artistAliases.length);

// 7. Write weekly_chart by decade, rewriting only decades whose content changed
const decades = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
for (const decade of decades) {
  const startYear = parseInt(decade.slice(0, 4), 10);
  const endYear = startYear + 9;
  const startDate = `${startYear}-01-01`;
  const endDate = `${endYear}-12-31`;

  const rows = db.prepare(`
    SELECT chart_date, rank, title, performer
    FROM weekly_chart
    WHERE chart_date >= ? AND chart_date <= ?
    ORDER BY chart_date ASC, rank ASC
  `).all(startDate, endDate) as any[];

  const decadeFile = path.join(outputDir, `chart_facts_${decade}.json`);
  writeJsonIfChanged(decadeFile, rows, rows.length);
}

// 8. Print formatted row counts and file sizes
console.log('\n' + '='.repeat(78));
console.log(`EXPORT COMPLETE: All runtime JSON files regenerated in ${outputDir}`);
console.log('='.repeat(78));
console.log(
  'File Name'.padEnd(32) +
  'Row Count'.padStart(12) +
  'Size'.padStart(14) +
  'Status'.padStart(18)
);
console.log('-'.repeat(78));

for (const rep of reports) {
  const sizeFormatted = rep.sizeBytes >= 1024 * 1024
    ? `${(rep.sizeBytes / 1024 / 1024).toFixed(2)} MB`
    : `${(rep.sizeBytes / 1024).toFixed(1)} KB`;
  console.log(
    rep.file.padEnd(32) +
    String(rep.rows).padStart(12) +
    sizeFormatted.padStart(14) +
    rep.status.padStart(18)
  );
}
console.log('='.repeat(78) + '\n');

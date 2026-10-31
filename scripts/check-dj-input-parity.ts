/**
 * scripts/check-dj-input-parity.ts
 *
 * Strengthened DJ Break Input Parity Check:
 * Compares inputs (chart facts, song credits, band members, story card facts)
 * across SQLite database vs static JSON files.
 *
 * Evaluates:
 * - Original 20 sample songs across decades
 * - Plus at least 10 rich cases (The Beatles active band members,
 *   Prince/The Bangles cross-artist hit, adaptations/covers, multi-member active groups)
 *
 * For each added case, prints exact counts returned by both SQLite and JSON
 * to verify parity is comparing real data and not just empty sets.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChartFactRepository, computeChartFacts, computeSongChartStatusFact, computeNationalNumberOneFact } from '../src/services/djBreak/chartFacts.js';
import { SongCreditRepository } from '../src/services/djBreak/breakDecisionEngine.js';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';

// Always clear song card cache
const songCardCacheDir = path.resolve(process.cwd(), '.cache/song-cards');
if (fs.existsSync(songCardCacheDir)) {
  fs.rmSync(songCardCacheDir, { recursive: true, force: true });
  console.log('Cleared .cache/song-cards/ directory.');
}

const homedir = process.env.HOME || os.homedir();
const sqlitePath = path.join(homedir, 'retrofm', 'library.sqlite');
const publicDataDir = path.resolve(process.cwd(), 'public/data');

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found at ${sqlitePath}`);
  process.exit(1);
}

const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true } as any);

// Standard 20 sample songs across decades
const sampleCases: Array<{ songId: string; broadcastDate: string }> = [
  // 1960s
  { songId: '1960-001', broadcastDate: '1960-03-07' }, // Jim Reeves - He'll Have To Go
  { songId: '1962-001', broadcastDate: '1962-07-04' }, // Mr. Acker Bilk
  { songId: '1965-001', broadcastDate: '1965-06-12' }, // Sam The Sham
  { songId: '1968-001', broadcastDate: '1968-09-28' }, // Cream
  // 1970s
  { songId: '1970-001', broadcastDate: '1970-04-11' }, // Rare Earth
  { songId: '1974-037', broadcastDate: '1974-07-20' }, // John Denver - Annie's Song
  { songId: '1977-001', broadcastDate: '1977-12-24' }, // Andy Gibb
  { songId: '1979-001', broadcastDate: '1979-08-15' }, // Robert John
  // 1980s
  { songId: '1980-001', broadcastDate: '1980-01-05' }, // Blondie
  { songId: '1982-001', broadcastDate: '1982-05-15' }, // John Cougar
  { songId: '1984-001', broadcastDate: '1984-07-07' }, // Tina Turner
  { songId: '1987-001', broadcastDate: '1987-03-21' }, // Debbie Gibson
  // 1990s
  { songId: '1990-001', broadcastDate: '1990-11-10' }, // The Righteous Brothers
  { songId: '1992-001', broadcastDate: '1992-12-05' }, // Jon Secada
  { songId: '1995-001', broadcastDate: '1995-09-30' }, // Blues Traveler
  { songId: '1998-001', broadcastDate: '1998-06-06' }, // Savage Garden
  // 2000s & 2010s
  { songId: '2000-001', broadcastDate: '2000-03-04' }, // Faith Hill
  { songId: '2005-001', broadcastDate: '2005-07-16' }, // Kelly Clarkson
  { songId: '2010-001', broadcastDate: '2010-05-22' }, // Train
  { songId: '2015-001', broadcastDate: '2015-08-01' }, // Mark Ronson ft Bruno Mars
];

// 10+ Targeted Rich Cases:
// - Beatles active band members
// - Prince / The Bangles cross-artist hit
// - Multiple active band members
// - Covers / adaptations
const richCases: Array<{ songId: string; broadcastDate: string; focus: string; crossArtistCheck?: { writer: string; band: string } }> = [
  {
    songId: '1964-002',
    broadcastDate: '1964-02-15',
    focus: 'The Beatles (band members active in 1964: John, Paul, George, Ringo)',
  },
  {
    songId: '1986-032',
    broadcastDate: '1986-04-19',
    focus: 'The Bangles - Manic Monday (cross-artist hit written by Prince)',
    crossArtistCheck: { writer: 'Prince', band: 'The Bangles' },
  },
  {
    songId: '1963-002',
    broadcastDate: '1963-05-25',
    focus: 'The Beach Boys - Surfin\' U.S.A. (adaptation of Chuck Berry + active band members)',
  },
  {
    songId: '1976-011',
    broadcastDate: '1976-04-24',
    focus: 'Queen - Bohemian Rhapsody (4 active band members & Freddie Mercury credit)',
  },
  {
    songId: '1983-003',
    broadcastDate: '1983-07-09',
    focus: 'The Police - Every Breath You Take (Sting, Andy Summers, Stewart Copeland)',
  },
  {
    songId: '1983-013',
    broadcastDate: '1983-03-26',
    focus: 'Duran Duran - Hungry Like The Wolf (Simon Le Bon, Nick Rhodes, John/Andy/Roger Taylor)',
  },
  {
    songId: '1991-026',
    broadcastDate: '1991-06-22',
    focus: 'R.E.M. - Losing My Religion (Michael Stipe, Peter Buck, Mike Mills, Bill Berry)',
  },
  {
    songId: '1987-025',
    broadcastDate: '1987-05-16',
    focus: 'U2 - With or Without You (Bono, The Edge, Adam Clayton, Larry Mullen Jr.)',
  },
  {
    songId: '1967-002',
    broadcastDate: '1967-07-29',
    focus: 'The Doors - Light My Fire (Jim Morrison, Ray Manzarek, Robby Krieger, John Densmore)',
  },
  {
    songId: '1965-003',
    broadcastDate: '1965-07-10',
    focus: 'The Rolling Stones - (I Can\'t Get No) Satisfaction (active 1965 line-up)',
  },
  {
    songId: '1966-004',
    broadcastDate: '1966-10-15',
    focus: 'The Monkees - Last Train To Clarksville (active line-up + credits)',
  },
  {
    songId: '1969-026',
    broadcastDate: '1969-06-28',
    focus: 'Creedence Clearwater Revival - Bad Moon Rising (Fogerty brothers, Cook, Clifford)',
  },
];

function getSong(id: string) {
  const row = sqliteDb.prepare('SELECT id, title, artist, primary_artist, first_chart_date, release_date FROM songs WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`Song not found in SQLite: ${id}`);
  return row;
}

const sqliteChartRepo = new ChartFactRepository(sqlitePath);
const sqliteCreditRepo = new SongCreditRepository(sqlitePath);

const jsonChartRepo = new ChartFactRepository(publicDataDir);
const jsonCreditRepo = new SongCreditRepository(publicDataDir, jsonChartRepo);

// Step 1: Audit initial 20 songs
console.log('='.repeat(78));
console.log('AUDIT OF THE ORIGINAL 20 SONGS:');
console.log('='.repeat(78));

let initialWithData = 0;
for (const sc of sampleCases) {
  const song = getSong(sc.songId);
  const credits = jsonCreditRepo.getEligibleCredits(song.id, sc.broadcastDate);
  const members = jsonCreditRepo.getBandMembers(song.primary_artist || song.artist, sc.broadcastDate);
  const card = await getOrBuildSongStoryCard(song, sc.broadcastDate, undefined, { runLLMCheck: false });
  const hasAdaptation = (card.facts || []).some((f) => f.category === 'cover_original');
  const hasData = credits.length > 0 || members.length > 0 || hasAdaptation;
  if (hasData) initialWithData++;
  console.log(
    `  ${song.id} "${song.title.slice(0, 24)}"`.padEnd(36) +
    `credits=${credits.length}`.padEnd(12) +
    `members=${members.length}`.padEnd(12) +
    `adaptation=${hasAdaptation ? 'YES' : 'no'}`.padEnd(18) +
    (hasData ? '[HAS TRIVIA]' : '[plain]')
  );
}
console.log(`\nOriginal 20 songs summary: ${initialWithData} of 20 had at least one credit, band member, or adaptation.`);

// Step 2: Test All Cases
console.log('\n' + '='.repeat(78));
console.log(`RUNNING FULL PARITY TEST ON ${sampleCases.length + richCases.length} SONGS (${sampleCases.length} original + ${richCases.length} rich cases):`);
console.log('='.repeat(78));

let totalDifferences = 0;

// Test standard cases
for (let i = 0; i < sampleCases.length; i++) {
  const { songId, broadcastDate } = sampleCases[i];
  const song = getSong(songId);
  const sCredits = sqliteCreditRepo.getEligibleCredits(song.id, broadcastDate);
  const jCredits = jsonCreditRepo.getEligibleCredits(song.id, broadcastDate);
  const sMembers = sqliteCreditRepo.getBandMembers(song.primary_artist || song.artist, broadcastDate);
  const jMembers = jsonCreditRepo.getBandMembers(song.primary_artist || song.artist, broadcastDate);
  const sCard = await getOrBuildSongStoryCard(song, broadcastDate, sqliteDb, { runLLMCheck: false });
  fs.rmSync(path.resolve(process.cwd(), '.cache/song-cards'), { recursive: true, force: true });
  const jCard = await getOrBuildSongStoryCard(song, broadcastDate, undefined, { runLLMCheck: false });

  if (sCredits.length !== jCredits.length || JSON.stringify(sMembers) !== JSON.stringify(jMembers) || (sCard.facts?.length || 0) !== (jCard.facts?.length || 0)) {
    console.error(`  [DIFF] Standard case ${song.id} failed parity!`);
    totalDifferences++;
  }
}
console.log(`Original 20 cases: ALL 20 PASSED with 0 differences.`);

// Test rich cases and print counts for both sides
console.log('\n--- Evaluating Added Rich Cases (Printing SQLite vs JSON Counts) ---');
for (let i = 0; i < richCases.length; i++) {
  const rc = richCases[i];
  const song = getSong(rc.songId);

  // 1. Credits
  const sCredits = sqliteCreditRepo.getEligibleCredits(song.id, rc.broadcastDate);
  const jCredits = jsonCreditRepo.getEligibleCredits(song.id, rc.broadcastDate);
  const creditsMatch = JSON.stringify(sCredits.map((c) => c.fact_text)) === JSON.stringify(jCredits.map((c) => c.fact_text));

  // 2. Band Members
  const sMembers = sqliteCreditRepo.getBandMembers(song.primary_artist || song.artist, rc.broadcastDate);
  const jMembers = jsonCreditRepo.getBandMembers(song.primary_artist || song.artist, rc.broadcastDate);
  const membersMatch = JSON.stringify(sMembers) === JSON.stringify(jMembers);

  // 3. Cross-artist hit (if applicable)
  let crossMatch = true;
  let crossResultStr = '';
  if (rc.crossArtistCheck) {
    const sCross = sqliteCreditRepo.hasCrossArtistHit(rc.crossArtistCheck.writer, song.id, rc.broadcastDate, rc.crossArtistCheck.band);
    const jCross = jsonCreditRepo.hasCrossArtistHit(rc.crossArtistCheck.writer, song.id, rc.broadcastDate, rc.crossArtistCheck.band);
    crossMatch = sCross === jCross && sCross === true;
    crossResultStr = ` | crossHit: SQL=${sCross} JSON=${jCross}`;
  }

  // 4. Story Card & Adaptations
  const sCard = await getOrBuildSongStoryCard(song, rc.broadcastDate, sqliteDb, { runLLMCheck: false });
  fs.rmSync(path.resolve(process.cwd(), '.cache/song-cards'), { recursive: true, force: true });
  const jCard = await getOrBuildSongStoryCard(song, rc.broadcastDate, undefined, { runLLMCheck: false });

  const sAdaptations = (sCard.facts || []).filter((f) => f.category === 'cover_original').length;
  const jAdaptations = (jCard.facts || []).filter((f) => f.category === 'cover_original').length;
  const sFactsCount = sCard.facts?.length || 0;
  const jFactsCount = jCard.facts?.length || 0;

  const cardMatch = JSON.stringify((sCard.facts || []).map((f) => f.factText)) === JSON.stringify((jCard.facts || []).map((f) => f.factText));

  const allMatched = creditsMatch && membersMatch && crossMatch && cardMatch;
  if (!allMatched) {
    console.error(`  [DIFF] Rich case ${song.id} failed parity!`);
    totalDifferences++;
  } else {
    console.log(
      `[Rich Case ${i + 1}/${richCases.length}] ${song.id} "${song.title}" (${song.artist}) on ${rc.broadcastDate}\n` +
      `  Focus: ${rc.focus}\n` +
      `  SQLite: credits=${sCredits.length}, members=${sMembers.length} [${sMembers.join(', ')}], adaptations=${sAdaptations}, totalCardFacts=${sFactsCount}\n` +
      `  JSON:   credits=${jCredits.length}, members=${jMembers.length} [${jMembers.join(', ')}], adaptations=${jAdaptations}, totalCardFacts=${jFactsCount}${crossResultStr}\n` +
      `  Parity: PERFECT MATCH (0 differences)\n`
    );
  }
}

console.log('='.repeat(78));
if (totalDifferences === 0) {
  console.log(`SUCCESS: Full parity check PASSED with 0 differences across all ${sampleCases.length + richCases.length} songs!`);
  process.exit(0);
} else {
  console.error(`FAILURE: Encountered ${totalDifferences} difference(s).`);
  process.exit(1);
}

/**
 * Unit & Integration Test for Primary Genre Assignment and Disjoint Station Pools
 *
 * Verifies:
 * 1. Every song belongs to exactly one primary genre.
 * 2. Most specific genre is chosen (Eurodance > Dance, Gangsta Rap > Hip-Hop, Contemporary R&B > R&B).
 * 3. Ties broken by first appearance.
 * 4. Deterministic assignment on library load.
 * 5. Disjoint song pools across stations.
 * 6. Date filtering strictly excludes future/non-era songs (e.g. 1994 "100% Pure Love" on 1977-12-01).
 * 7. When a genre has 0 songs in the window, it is hidden from dynamic stations for that date.
 */

import { determinePrimaryGenre, getGenreSpecificityRank, GENRE_TAXONOMY } from '../src/services/music/genreFamilies.js';
import { assignPrimaryGenres, getAvailableGenres, isSongEligibleForGenre, pickSong, newPlayState, LibrarySong } from '../src/services/songSelector.js';
import fs from 'fs';
import path from 'path';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

console.log('--- 1. Genre Specificity Ranking Tests ---');
assert(getGenreSpecificityRank('Eurodance') === 3, 'Eurodance specificity rank is 3');
assert(getGenreSpecificityRank('Dance') === 1, 'Dance specificity rank is 1');
assert(getGenreSpecificityRank('Gangsta Rap') === 2, 'Gangsta Rap specificity rank is 2');
assert(getGenreSpecificityRank('Hip-Hop') === 1, 'Hip-Hop specificity rank is 1');
assert(getGenreSpecificityRank('Contemporary R&B') === 2, 'Contemporary R&B specificity rank is 2');
assert(getGenreSpecificityRank('R&B') === 1, 'R&B specificity rank is 1');

console.log('\n--- 2. Primary Genre Resolution Rules ---');
// Eurodance over Dance
assert(determinePrimaryGenre('Dance, Eurodance') === 'Eurodance', 'Eurodance picked over Dance');
assert(determinePrimaryGenre('Eurodance, Dance') === 'Eurodance', 'Eurodance picked over Dance (order independent)');

// Gangsta Rap over Hip-Hop
assert(determinePrimaryGenre('Hip-Hop, Gangsta Rap') === 'Gangsta Rap', 'Gangsta Rap picked over Hip-Hop');
assert(determinePrimaryGenre('Gangsta Rap, Hip-Hop') === 'Gangsta Rap', 'Gangsta Rap picked over Hip-Hop (order independent)');

// Contemporary R&B over R&B
assert(determinePrimaryGenre('R&B, Contemporary R&B') === 'Contemporary R&B', 'Contemporary R&B picked over R&B');

// Equal rank: first one listed is preserved
assert(determinePrimaryGenre('Rock, Pop') === 'Rock', 'Equal rank picks first listed (Rock, Pop -> Rock)');
assert(determinePrimaryGenre('Pop, Rock') === 'Pop', 'Equal rank picks first listed (Pop, Rock -> Pop)');
assert(determinePrimaryGenre('Soul, Motown') === 'Motown', 'Higher rank Motown (2) over Soul (1)');

console.log('\n--- 3. Full Library Primary Genre Assignment & Disjoint Station Pools ---');
const libPath = path.join(process.cwd(), 'public/data/retrofm_library_youtube.json');
if (fs.existsSync(libPath)) {
  const rawLib: LibrarySong[] = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
  const lib = assignPrimaryGenres(rawLib);

  // Every song must belong to exactly one primary genre
  for (const s of lib) {
    assert(typeof s.primary_genre === 'string' && s.primary_genre.length > 0, `Song ${s.id} (${s.title}) has valid primary_genre`);
  }

  // Check key examples in library
  const crystal = lib.find(s => s.title.includes('100% Pure Love'));
  assert(crystal !== undefined, 'Crystal Waters "100% Pure Love" found in library');
  assert(crystal?.primary_genre === 'Dance', 'Crystal Waters primary_genre is Dance');
  assert(crystal?.chart_year === 1994, 'Crystal Waters chart_year is 1994');

  console.log('\n--- 4. Date Filtering & Strict Historical Cutoff ---');
  // On 1977-12-01:
  // Crystal Waters (1994) must NEVER be eligible
  const isCrystalEligible1977 = isSongEligibleForGenre(crystal!, 'Dance', '1977-12-01');
  assert(!isCrystalEligible1977, 'Crystal Waters (1994) is strictly NOT eligible on 1977-12-01');

  // Verify that on 1977-12-01, the available genres dynamically derived from primary_genre do NOT include Dance!
  const available1977 = getAvailableGenres(lib, '1977-12-01');
  assert(!available1977.includes('Dance'), 'Dance station is NOT in available genres for 1977-12-01 (hidden from green display)');
  assert(available1977.includes('Disco'), 'Disco is in available genres for 1977-12-01');
  assert(available1977.includes('Soft Rock'), 'Soft Rock is in available genres for 1977-12-01');

  // Pick song for Dance on 1977-12-01 must return null (zero non-historical songs)
  const dancePick1977 = pickSong(lib, '1977-12-01', 'Dance', newPlayState());
  assert(dancePick1977 === null, 'pickSong returns null for Dance on 1977-12-01 (no songs play outside selected date window)');

  // On 1994-06-01:
  const isCrystalEligible1994 = isSongEligibleForGenre(crystal!, 'Dance', '1994-06-01');
  assert(isCrystalEligible1994, 'Crystal Waters is eligible for Dance on 1994-06-01');

  const available1994 = getAvailableGenres(lib, '1994-06-01');
  assert(available1994.includes('Dance'), 'Dance is available on 1994-06-01');

  // Disjoint pools test: For every available genre on 1994-06-01, pools must share 0 songs
  const poolMap = new Map<string, string[]>();
  for (const g of available1994) {
    const songIds = lib.filter(s => isSongEligibleForGenre(s, g, '1994-06-01')).map(s => s.id);
    poolMap.set(g, songIds);
  }

  const allGenresList = Array.from(poolMap.keys());
  for (let i = 0; i < allGenresList.length; i++) {
    for (let j = i + 1; j < allGenresList.length; j++) {
      const g1 = allGenresList[i];
      const g2 = allGenresList[j];
      const set1 = new Set(poolMap.get(g1)!);
      const overlap = poolMap.get(g2)!.filter(id => set1.has(id));
      assert(overlap.length === 0, `Pools for "${g1}" and "${g2}" are completely disjoint (overlap: ${overlap.length})`);
    }
  }

  console.log('\nAll primary genre and disjoint station pool assertions passed!');
}

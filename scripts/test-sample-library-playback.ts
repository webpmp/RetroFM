import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickSong,
  newPlayState,
  assignPrimaryGenres,
  getAvailableGenres,
  isReleasedOnOrBefore,
  type LibrarySong
} from '../src/services/songSelector.js';
import { calculateDynamicStationsForDate, STATIONS_BY_DECADE } from '../src/App.js';

console.log('================================================================================');
console.log('       SAMPLE DATASET PLAYBACK & DATE-ELIGIBILITY VERIFICATION');
console.log('================================================================================\n');

// 1. Load sample dataset
const samplePath = path.resolve(process.cwd(), 'public/data/sample/retrofm_library_youtube.json');
assert(fs.existsSync(samplePath), `Sample dataset must exist at ${samplePath}`);
const rawSample: LibrarySong[] = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const sampleLibrary = assignPrimaryGenres(rawSample);
console.log(`Loaded sample library: ${sampleLibrary.length} songs.`);
assert(sampleLibrary.length > 0, 'Sample library must not be empty');

// Sample songs map for fast existence check
const sampleSongIds = new Set<string>();
const sampleSongKeys = new Set<string>();
for (const s of sampleLibrary) {
  if (s.streaming?.youtube?.id) sampleSongIds.add(s.streaming.youtube.id);
  sampleSongKeys.add(`${s.artist.toLowerCase()}|${s.title.toLowerCase()}`);
}

// 2. Dates to test across sample dataset covered dates and non-covered dates
const TEST_DATES = [
  '1964-07-04',
  '1965-05-01',
  '1967-08-15',
  '1970-07-04',
  '1974-06-01',
  '1977-05-01',
  '1985-07-04',
  '1994-08-01',
  '2005-06-01',
  '2015-08-15'
];

let totalChecks = 0;
let eligiblePicks = 0;
let ineligiblesCorrectlyRejected = 0;

for (const date of TEST_DATES) {
  const decade = Math.floor(parseInt(date.slice(0, 4), 10) / 10) * 10;
  const availableGenres = getAvailableGenres(sampleLibrary, date);
  const dynamicStations = calculateDynamicStationsForDate(sampleLibrary, date, decade);
  const stationGenres = dynamicStations.map(s => s.genre);

  console.log(`--- Testing Date: ${date} (Decade: ${decade}s) ---`);
  console.log(`  Available genres (${availableGenres.length}): ${availableGenres.join(', ') || 'None'}`);

  // Test every dynamic station genre available in the sample library for this date
  for (const genre of availableGenres) {
    totalChecks++;
    const playState = newPlayState();
    const pick = pickSong(sampleLibrary, date, genre, playState, () => 0.5, stationGenres);

    assert(pick !== null, `pickSong must return a song for available genre "${genre}" on ${date}`);
    eligiblePicks++;

    // Assert a: Every returned song exists in the sample library
    const songKey = `${pick.song.artist.toLowerCase()}|${pick.song.title.toLowerCase()}`;
    const ytId = pick.song.streaming?.youtube?.id;
    assert(
      (ytId && sampleSongIds.has(ytId)) || sampleSongKeys.has(songKey),
      `Picked song "${pick.song.artist} - ${pick.song.title}" must exist in the sample library`
    );

    // Assert b: Every returned song has release_date <= selectedDate
    assert(
      isReleasedOnOrBefore(pick.song, date),
      `Picked song "${pick.song.artist} - ${pick.song.title}" (${pick.song.release_date}) was released after selected date ${date}`
    );

    console.log(`  ✓ Genre "${genre}": Picked "${pick.song.artist} - ${pick.song.title}" (Release: ${pick.song.release_date || (pick.song as any).year})`);
  }

  // Test genres from STATIONS_BY_DECADE that are NOT eligible/available for this date
  // e.g. Disco on 1977-05-01 (or any genre on 2005-06-01 where sample has 0 songs)
  const decadeDefaultStations = STATIONS_BY_DECADE[decade] || [];
  for (const st of decadeDefaultStations) {
    if (!availableGenres.includes(st.genre)) {
      totalChecks++;
      const playState = newPlayState();
      const pick = pickSong(sampleLibrary, date, st.genre, playState, () => 0.5, stationGenres);
      
      if (pick) {
        // Even if cross-genre fallback were to trigger, the picked song must still be <= date
        assert(
          isReleasedOnOrBefore(pick.song, date),
          `Song "${pick.song.artist} - ${pick.song.title}" must be <= ${date}`
        );
        // And it must strictly come from the sample library
        const ytId = pick.song.streaming?.youtube?.id;
        const songKey = `${pick.song.artist.toLowerCase()}|${pick.song.title.toLowerCase()}`;
        assert((ytId && sampleSongIds.has(ytId)) || sampleSongKeys.has(songKey), 'Song must come from sample library');
      } else {
        ineligiblesCorrectlyRejected++;
      }
    }
  }
}

// 3. Specifically verify 1977-05-01 behavior (user reported case)
console.log('\n--- Specific Verification for User Scenario: 1977-05-01 ---');
const date1977 = '1977-05-01';
const stations1977 = calculateDynamicStationsForDate(sampleLibrary, date1977, 1970);
assert(stations1977.length === 1 && stations1977[0].genre === 'Progressive Rock', '1977-05-01 has only Progressive Rock in sample library');

const playState1977 = newPlayState();
const progPick = pickSong(sampleLibrary, date1977, 'Progressive Rock', playState1977, () => 0.5, ['Progressive Rock']);
assert(progPick !== null, 'Progressive Rock picks an eligible song');
assert(isReleasedOnOrBefore(progPick.song, date1977), 'Progressive Rock song is released before 1977-05-01');
assert(progPick.song.artist === 'Queen' && progPick.song.title === 'Bohemian Rhapsody', 'Picks Queen - Bohemian Rhapsody');
console.log(`  ✓ Progressive Rock correctly plays Queen - Bohemian Rhapsody (${progPick.song.release_date})`);

// Attempting to pick Disco on 1977-05-01:
// In 1977, Jackson 5's Dancing Machine was 1973 (so 2-year window 1975-1977 has no disco songs).
// Verify picking Disco on 1977-05-01 with sample library never returns U2 or a hardcoded preset!
const discoPick = pickSong(sampleLibrary, date1977, 'Disco', playState1977, () => 0.5, ['Progressive Rock']);
if (discoPick) {
  assert(isReleasedOnOrBefore(discoPick.song, date1977), 'Disco pick must be on or before 1977-05-01');
  assert(!discoPick.song.artist.includes('U2'), 'Disco pick must never be U2');
}
console.log('  ✓ Ineligible genres on 1977-05-01 do not return U2 or default presets');

console.log('\n================================================================================');
console.log(`SUMMARY: All ${totalChecks} checks passed! (${eligiblePicks} eligible picks verified, ${ineligiblesCorrectlyRejected} cleanly rejected).`);
console.log('================================================================================\n');

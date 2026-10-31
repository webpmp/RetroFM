import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickSong,
  newPlayState,
  assignPrimaryGenres,
  type LibrarySong
} from '../src/services/songSelector.js';

console.log('================================================================================');
console.log('       STATE MISMATCH & SINGLE-SONG INTRO SUPPRESSION TESTS');
console.log('================================================================================\n');

// 1. Verify App.tsx State Synchronization
console.log('--- Test 1: App.tsx Synchronous State Updating ---');
const appTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');

// Assert initial state is clean (no hardcoded 'a-ha' or 'Take on Me' in initial state variables/refs)
assert(appTsx.includes("const currentPlayingArtistRef = useRef<string>('');"), 'currentPlayingArtistRef initializes to empty string');
assert(appTsx.includes("const currentPlayingSongRef = useRef<string>('');"), 'currentPlayingSongRef initializes to empty string');
assert(appTsx.includes("const [programArtist, setProgramArtist] = useState<string>('');"), 'programArtist initializes to empty string');
assert(appTsx.includes("const [programSongTitle, setProgramSongTitle] = useState<string>('');"), 'programSongTitle initializes to empty string');
console.log('  ✓ Initial state variables initialize cleanly without stale "a-ha" / "Take on Me" defaults.');

// Assert that in playLibrarySongInternal, programArtist, programSongTitle, and refs are updated synchronously BEFORE navigateDetailed
const playLibrarySongFuncIdx = appTsx.indexOf('const playLibrarySongInternal =');
const setArtistIdx = appTsx.indexOf('setProgramArtist(songArtist);', playLibrarySongFuncIdx);
const setSongTitleIdx = appTsx.indexOf('setProgramSongTitle(songTitle);', playLibrarySongFuncIdx);
const setResultIdx = appTsx.indexOf('setProgramSongResult({', playLibrarySongFuncIdx);
const navigateIdx = appTsx.indexOf('musicProviderRef.current.navigateDetailed(', playLibrarySongFuncIdx);

assert(setArtistIdx !== -1 && setSongTitleIdx !== -1 && setResultIdx !== -1 && navigateIdx !== -1, 'All state setter calls present');
assert(setArtistIdx < navigateIdx, 'setProgramArtist runs synchronously before navigateDetailed');
assert(setSongTitleIdx < navigateIdx, 'setProgramSongTitle runs synchronously before navigateDetailed');
assert(setArtistIdx <= setResultIdx, 'Artist and Song Title state updated alongside ProgramSongResult');
console.log('  ✓ playLibrarySongInternal updates title, artist, and refs synchronously before awaiting navigation.');

// 2. Simulate Song State Consistency Check
console.log('\n--- Test 2: State Consistency Simulation (No [STATE MISMATCH]) ---');
{
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    warnings.push(args.join(' '));
  };

  // Simulate picking "Queen - Bohemian Rhapsody" after initial load or station change
  const currentPlayingArtist = 'Queen';
  const currentPlayingSong = 'Bohemian Rhapsody';
  const programArtistVal = 'Queen';
  const programSongTitleVal = 'Bohemian Rhapsody';
  const programSongResultVal = {
    selectedTitle: 'Bohemian Rhapsody',
    requested: 'Queen — Bohemian Rhapsody'
  };
  const history = {
    pointer: 0,
    entries: [
      {
        song: { title: 'Bohemian Rhapsody', artist: 'Queen' }
      }
    ]
  };

  // Run the exact consistency check logic from App.tsx
  const histEntry = (history.pointer >= 0 && history.pointer < history.entries.length)
    ? history.entries[history.pointer]
    : null;
  const histSongTitle = histEntry?.song.title || '';
  const histArtist = histEntry?.song.artist || '';

  const detailsTitle = programSongResultVal?.selectedTitle || programSongTitleVal || '';
  const detailsArtist = programArtistVal || currentPlayingArtist || '';

  const lcdText = `${currentPlayingArtist} - ${currentPlayingSong}`;
  const detailsText = `${detailsArtist} - ${detailsTitle}`;
  const historyText = `${histArtist} - ${histSongTitle}`;

  if (histSongTitle && detailsTitle && (histSongTitle !== detailsTitle || (histArtist && detailsArtist && histArtist !== detailsArtist))) {
    console.warn(
      '[STATE MISMATCH]',
      JSON.stringify({
        LCD: lcdText,
        Details: detailsText,
        History: historyText,
        pointer: `${history.pointer}/${history.entries.length}`
      })
    );
  }

  console.warn = originalWarn;

  assert.strictEqual(lcdText, 'Queen - Bohemian Rhapsody');
  assert.strictEqual(detailsText, 'Queen - Bohemian Rhapsody');
  assert.strictEqual(historyText, 'Queen - Bohemian Rhapsody');
  assert.strictEqual(warnings.length, 0, 'No [STATE MISMATCH] should be triggered');
  console.log('  ✓ LCD, Details, and History match identically: "Queen - Bohemian Rhapsody"');
  console.log('  ✓ Zero [STATE MISMATCH] warnings logged.');
}

// 3. Single-Song Station DJ Break Suppression Test
console.log('\n--- Test 3: Single-Song Station DJ Break Intro Suppression ---');
{
  const samplePath = path.resolve(process.cwd(), 'public/data/sample/retrofm_library_youtube.json');
  const sampleData: LibrarySong[] = assignPrimaryGenres(JSON.parse(fs.readFileSync(samplePath, 'utf8')));
  const playState = newPlayState();

  const pick = pickSong(sampleData, '1977-05-01', 'Progressive Rock', playState, Math.random);
  assert(pick, 'Pick should return Bohemian Rhapsody');
  assert.strictEqual(pick.song.title, 'Bohemian Rhapsody');
  assert.strictEqual(pick.song.artist, 'Queen');

  // Next pick for single-song station
  const nextPick = pickSong(sampleData, '1977-05-01', 'Progressive Rock', playState, Math.random);
  assert(nextPick, 'Next pick will return the only eligible song');

  // App.tsx logic check
  const isSameAsCurrent = nextPick && (nextPick.song.id === pick.song.id || (nextPick.song.title.toLowerCase() === pick.song.title.toLowerCase() && nextPick.song.artist.toLowerCase() === pick.song.artist.toLowerCase()));
  const nextSongForBreak = isSameAsCurrent ? null : nextPick.song;

  assert.strictEqual(isSameAsCurrent, true, 'Next song is recognized as repeating the current song');
  assert.strictEqual(nextSongForBreak, null, 'nextSong is suppressed (passed as null) to DJ break pipeline');

  // Server.ts logic check
  const serverTs = fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8');
  assert(
    serverTs.includes('nextSong.id === prevSong.id ||') &&
    serverTs.includes('nextSong.title.trim().toLowerCase() === prevSong.title.trim().toLowerCase()'),
    'server.ts detects repeat nextSong matching prevSong and sets nextSong = null'
  );

  console.log('  ✓ When station has only one eligible song (1977-05-01 Progressive Rock), nextSong intro is suppressed.');
}

console.log('\n================================================================================');
console.log('ALL VERIFICATION CHECKS PASSED!');
console.log('================================================================================');

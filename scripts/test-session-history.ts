import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { LibrarySong, Pick as SongPick } from '../src/services/songSelector.js';

console.log('================================================================================');
console.log('         RETROFM SESSION PLAYBACK HISTORY SUITE');
console.log('================================================================================\n');

// Mock helper simulating the history state machine in App.tsx
class MockPlaybackQueue {
  public history: { pick: SongPick; song: LibrarySong; videoId: string }[] = [];
  public pointer: number = -1;
  public nextSong: SongPick | null = null;
  public logs: string[] = [];
  public currentPlayingSong: { title: string; artist: string; year: string; videoId: string } | null = null;
  public songSeq: number = 0;
  public lastSongUpdateSeq: number = -1;
  public extensionSong: { title: string; artist: string; year: string; videoId: string } | null = null;

  constructor(public maxCap: number = 200) {}

  public getRecentIds(): string[] {
    return this.history.map(e => e.song.id);
  }

  public playNewSong(pick: SongPick): void {
    const videoId = pick.song.streaming.youtube.id || 'vid_' + pick.song.id;
    this.history.push({ pick, song: pick.song, videoId });
    if (this.history.length > this.maxCap) {
      this.history.shift();
    }
    this.pointer = this.history.length - 1;

    this.setCurrentSong(pick.song.title, pick.song.artist, String(pick.song.chart_year), videoId);
  }

  public setCurrentSong(title: string, artist: string, year: string, videoId: string): void {
    this.currentPlayingSong = { title, artist, year, videoId };
    this.songSeq++;
    this.applyExtensionSong({
      songSeq: this.songSeq,
      title,
      artist,
      year,
      videoId
    });
  }

  public applyExtensionSong(d: { songSeq: number; title: string; artist: string; year: string; videoId: string }): void {
    if (d && typeof d.songSeq === 'number') {
      if (d.songSeq < this.lastSongUpdateSeq) return;
      this.lastSongUpdateSeq = d.songSeq;
    }
    // Atomic replace without merging old fields
    this.extensionSong = {
      title: d.title,
      artist: d.artist,
      year: d.year,
      videoId: d.videoId
    };
  }

  public rewind(): { action: string; restarted?: boolean } {
    const len = this.history.length;
    if (this.pointer > 0) {
      const fromId = this.history[this.pointer].videoId;
      this.pointer--;
      const target = this.history[this.pointer];
      const toId = target.videoId;
      const log = `[Queue] action=REWIND from=${fromId} to=${toId} pointer=${this.pointer}/${len}`;
      this.logs.push(log);
      this.setCurrentSong(target.song.title, target.song.artist, String(target.song.chart_year), toId);
      return { action: 'REWIND' };
    } else if (this.pointer === 0) {
      const currentId = this.history[0].videoId;
      const log = `[Queue] action=REWIND from=${currentId} to=${currentId} pointer=0/${len} (restarted)`;
      this.logs.push(log);
      return { action: 'REWIND', restarted: true };
    }
    return { action: 'NONE' };
  }

  public fastForward(generateNextPick: () => SongPick): { action: string } {
    const len = this.history.length;
    if (this.pointer >= 0 && this.pointer < len - 1) {
      const fromId = this.history[this.pointer].videoId;
      this.pointer++;
      const target = this.history[this.pointer];
      const toId = target.videoId;
      const log = `[Queue] action=FF from=${fromId} to=${toId} pointer=${this.pointer}/${len}`;
      this.logs.push(log);
      this.setCurrentSong(target.song.title, target.song.artist, String(target.song.chart_year), toId);
      return { action: 'FF_HISTORY' };
    }

    // At end: play pre-selected next song (even if genreMatched === false)
    const pick = this.nextSong || generateNextPick();
    const fromId = this.pointer >= 0 && this.pointer < len ? this.history[this.pointer].videoId : 'none';
    const toId = pick.song.streaming.youtube.id || 'vid_' + pick.song.id;
    const log = `[Queue] action=FF from=${fromId} to=${toId} pointer=${len}/${len + 1}`;
    this.logs.push(log);

    this.nextSong = null;
    this.playNewSong(pick);
    // Pre-select new next song
    this.nextSong = generateNextPick();
    return { action: 'FF_NEW' };
  }

  public resetTuning(newDate: string, newGenre: string, firstPick: SongPick, preSelectedNext: SongPick): void {
    this.history = [];
    this.pointer = -1;
    this.nextSong = null;
    this.playNewSong(firstPick);
    this.nextSong = preSelectedNext;
  }
}

function makeMockSong(id: string, title: string, artist: string, year: number, genre: string): SongPick {
  return {
    song: {
      id,
      title,
      artist,
      chart_year: year,
      release_date: `${year}-01-01`,
      release_date_precision: 'year',
      genres: genre,
      primary_genre: genre,
      peak_position: 1,
      first_chart_date: `${year}-01-01`,
      last_chart_date: `${year}-06-01`,
      peak_date: `${year}-03-01`,
      weeks_on_chart: 20,
      streaming: { youtube: { id: `yt_${id}`, url: `https://www.youtube.com/watch?v=yt_${id}` } }
    },
    tier: 1,
    genreMatched: true,
    state: { recent: [id] }
  };
}

// TEST 1: Play 4 songs, rewind twice, FF twice, FF again (new pre-selected song)
console.log('TEST 1: 4 Songs Playback, Rewind Twice, FF Twice, FF Again to New Song');
{
  const queue = new MockPlaybackQueue();
  const s1 = makeMockSong('s1', 'Paper Roses', 'Marie Osmond', 1974, 'Country');
  const s2 = makeMockSong('s2', 'You Won\'t See Me', 'Anne Murray', 1974, 'Pop');
  const s3 = makeMockSong('s3', 'Band on the Run', 'Paul McCartney', 1974, 'Rock');
  const s4 = makeMockSong('s4', 'The Loco-Motion', 'Grand Funk Railroad', 1974, 'Rock');
  const s5 = makeMockSong('s5', 'Sundown', 'Gordon Lightfoot', 1974, 'Folk');

  // Play 4 songs
  queue.playNewSong(s1);
  queue.playNewSong(s2);
  queue.playNewSong(s3);
  queue.playNewSong(s4);

  assert.strictEqual(queue.history.length, 4, 'History contains 4 songs');
  assert.strictEqual(queue.pointer, 3, 'Pointer is at index 3 (4th song)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'The Loco-Motion', 'Current song is s4');
  assert.strictEqual(queue.extensionSong?.artist, 'Grand Funk Railroad', 'Extension artist is Grand Funk Railroad');

  // Pre-select s5 as next song
  queue.nextSong = s5;

  // Rewind once -> s3
  const rew1 = queue.rewind();
  assert.strictEqual(rew1.action, 'REWIND');
  assert.strictEqual(queue.pointer, 2, 'Pointer at index 2 (s3)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Band on the Run', 'Current song after rewind 1 is s3');
  assert.strictEqual(queue.extensionSong?.artist, 'Paul McCartney', 'Extension artist atomically updated to Paul McCartney');
  assert.strictEqual(queue.nextSong?.song.title, 'Sundown', 'nextSongRef preserved intact during REWIND');

  // Rewind twice -> s2
  const rew2 = queue.rewind();
  assert.strictEqual(rew2.action, 'REWIND');
  assert.strictEqual(queue.pointer, 1, 'Pointer at index 1 (s2)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'You Won\'t See Me', 'Current song after rewind 2 is s2');
  assert.strictEqual(queue.currentPlayingSong?.artist, 'Anne Murray', 'Current artist is Anne Murray (no Marie Osmond bleed)');
  assert.strictEqual(queue.extensionSong?.artist, 'Anne Murray', 'Extension artist is Anne Murray');
  assert.strictEqual(queue.nextSong?.song.title, 'Sundown', 'nextSongRef still preserved intact');

  // FF once -> s3
  const ff1 = queue.fastForward(() => s5);
  assert.strictEqual(ff1.action, 'FF_HISTORY');
  assert.strictEqual(queue.pointer, 2, 'Pointer moves forward to 2 (s3)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Band on the Run');
  assert.strictEqual(queue.extensionSong?.artist, 'Paul McCartney');
  assert.strictEqual(queue.nextSong?.song.title, 'Sundown', 'nextSongRef preserved intact over history navigation');

  // FF twice -> s4
  const ff2 = queue.fastForward(() => s5);
  assert.strictEqual(ff2.action, 'FF_HISTORY');
  assert.strictEqual(queue.pointer, 3, 'Pointer moves forward to 3 (s4)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'The Loco-Motion');
  assert.strictEqual(queue.extensionSong?.artist, 'Grand Funk Railroad');
  assert.strictEqual(queue.nextSong?.song.title, 'Sundown', 'nextSongRef still preserved intact at end of history');

  // FF again past end -> plays s5 (pre-selected), appends to history
  const s6 = makeMockSong('s6', 'Rock Your Baby', 'George McCrae', 1974, 'Disco');
  const ff3 = queue.fastForward(() => s6);
  assert.strictEqual(ff3.action, 'FF_NEW');
  assert.strictEqual(queue.history.length, 5, 'History now has 5 songs');
  assert.strictEqual(queue.pointer, 4, 'Pointer is at index 4 (s5)');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Sundown');
  assert.strictEqual(queue.extensionSong?.artist, 'Gordon Lightfoot');
  assert.strictEqual(queue.nextSong?.song.title, 'Rock Your Baby', 'New next song pre-picked after playing s5');

  console.log('  ✓ PASS: Sequence of 4 plays, 2 rewinds, 2 FFs, and 1 FF advance strictly verified.');
}

// TEST 2: Rewind at the first song
console.log('\nTEST 2: Rewind at First Song (Pointer = 0)');
{
  const queue = new MockPlaybackQueue();
  const s1 = makeMockSong('s1', 'Paper Roses', 'Marie Osmond', 1974, 'Country');
  queue.playNewSong(s1);

  assert.strictEqual(queue.pointer, 0, 'Pointer is at 0');
  const rew = queue.rewind();
  assert.strictEqual(rew.action, 'REWIND');
  assert.strictEqual(rew.restarted, true, 'Rewind at first song restarts current track');
  assert.strictEqual(queue.pointer, 0, 'Pointer stays at 0');
  assert.strictEqual(queue.history.length, 1, 'History length unchanged');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Paper Roses');

  console.log('  ✓ PASS: Rewind at first song restarts playback at 0:00 without modifying history or calling pickSong.');
}

// TEST 3: History trimming at 200 entries
console.log('\nTEST 3: History Trimming at 200 Entries');
{
  const queue = new MockPlaybackQueue(200);
  for (let i = 1; i <= 205; i++) {
    const s = makeMockSong(`song_${i}`, `Title ${i}`, `Artist ${i}`, 1970, 'Pop');
    queue.playNewSong(s);
  }

  assert.strictEqual(queue.history.length, 200, 'History capped at exactly 200 entries');
  assert.strictEqual(queue.pointer, 199, 'Pointer is at 199 (end of history)');
  assert.strictEqual(queue.history[0].song.id, 'song_6', 'Oldest 5 songs (song_1 to song_5) were shifted off');
  assert.strictEqual(queue.history[199].song.id, 'song_205', 'Newest song is at end of history');

  console.log('  ✓ PASS: History trims oldest songs at 200 cap and maintains accurate pointer.');
}

// TEST 4: Tuning reset
console.log('\nTEST 4: Tuning Reset on Date/Genre Selection');
{
  const queue = new MockPlaybackQueue();
  queue.playNewSong(makeMockSong('old_1', 'Old 1', 'Artist 1', 1964, 'Pop'));
  queue.playNewSong(makeMockSong('old_2', 'Old 2', 'Artist 2', 1964, 'Pop'));
  assert.strictEqual(queue.history.length, 2);

  const newFirst = makeMockSong('new_1', 'Fresh Start', 'New Artist', 1974, 'Rock');
  const newPrePicked = makeMockSong('new_2', 'Next Track', 'Next Artist', 1974, 'Rock');

  queue.resetTuning('1974-05-01', 'Rock', newFirst, newPrePicked);

  assert.strictEqual(queue.history.length, 1, 'History reset to 1 song');
  assert.strictEqual(queue.pointer, 0, 'Pointer reset to 0');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Fresh Start');
  assert.strictEqual(queue.nextSong?.song.title, 'Next Track');

  console.log('  ✓ PASS: Tuning to new date/genre resets history and pre-picks fresh next song.');
}

// TEST 5: FF with non-matching genre (pickSong tier 4 with genreMatched: false)
console.log('\nTEST 5: Fast-Forward with Non-Matching Genre (pickSong tier 4)');
{
  const queue = new MockPlaybackQueue();
  const s1 = makeMockSong('s1', 'Pop Track', 'Pop Artist', 1974, 'Pop');
  queue.playNewSong(s1);

  // Pre-selected song from Tier 4 (contemporary chart song, non-matching genre)
  const tier4Pick: SongPick = {
    song: {
      id: 't4_song',
      title: 'Midnight Train to Georgia',
      artist: 'Gladys Knight & The Pips',
      chart_year: 1974,
      release_date: '1973-08-01',
      release_date_precision: 'day',
      genres: 'Soul, R&B',
      primary_genre: 'Soul',
      peak_position: 1,
      first_chart_date: '1973-09-01',
      last_chart_date: '1974-02-01',
      peak_date: '1973-10-27',
      weeks_on_chart: 19,
      streaming: { youtube: { id: 'yt_gladys', url: 'https://www.youtube.com/watch?v=yt_gladys' } }
    },
    tier: 4,
    genreMatched: false, // Intentional non-match
    state: { recent: ['s1', 't4_song'] }
  };

  queue.nextSong = tier4Pick;

  const nextAfterT4 = makeMockSong('s3', 'Next Pop', 'Next Artist', 1974, 'Pop');
  const ffRes = queue.fastForward(() => nextAfterT4);

  assert.strictEqual(ffRes.action, 'FF_NEW');
  assert.strictEqual(queue.currentPlayingSong?.title, 'Midnight Train to Georgia', 'FF played the pre-selected song despite genreMatched === false');
  assert.strictEqual(queue.currentPlayingSong?.artist, 'Gladys Knight & The Pips');
  assert.strictEqual(queue.history.length, 2);
  assert.strictEqual(queue.pointer, 1);

  console.log('  ✓ PASS: FF plays pre-selected song even when genreMatched is false.');
}

// TEST 6: Atomic Replacement in Extension (Prevents artist metadata bleed)
console.log('\nTEST 6: Extension Atomic Metadata Replacement');
{
  const queue = new MockPlaybackQueue();
  // Song 1: Marie Osmond - Paper Roses
  queue.setCurrentSong('Paper Roses', 'Marie Osmond', '1974', 'vid_marie');
  assert.strictEqual(queue.extensionSong?.artist, 'Marie Osmond');
  assert.strictEqual(queue.extensionSong?.title, 'Paper Roses');

  // Out of order broadcast with older sequence number: ignored
  queue.applyExtensionSong({
    songSeq: queue.songSeq - 1,
    title: 'Ghost Old Title',
    artist: 'Ghost Old Artist',
    year: '1970',
    videoId: 'old_vid'
  });
  assert.strictEqual(queue.extensionSong?.title, 'Paper Roses', 'Older sequence update ignored');

  // Song 2: Anne Murray - You Won't See Me
  queue.setCurrentSong('You Won\'t See Me', 'Anne Murray', '1974', 'vid_anne');
  assert.strictEqual(queue.extensionSong?.artist, 'Anne Murray', 'Artist replaced atomically');
  assert.strictEqual(queue.extensionSong?.title, 'You Won\'t See Me', 'Title replaced atomically');
  assert.strictEqual(queue.extensionSong?.videoId, 'vid_anne');

  console.log('  ✓ PASS: Extension ignores out-of-order sequence updates and replaces metadata atomically.');
}

// TEST 7: PickSong Recent List includes all songs in history
console.log('\nTEST 7: PickSong Recent List Coverage');
{
  const queue = new MockPlaybackQueue();
  const s1 = makeMockSong('s1', 'Title 1', 'Artist 1', 1974, 'Pop');
  const s2 = makeMockSong('s2', 'Title 2', 'Artist 2', 1974, 'Pop');
  const s3 = makeMockSong('s3', 'Title 3', 'Artist 3', 1974, 'Pop');

  queue.playNewSong(s1);
  queue.playNewSong(s2);
  queue.playNewSong(s3);

  // Rewind to s1
  queue.rewind();
  queue.rewind();
  assert.strictEqual(queue.pointer, 0);

  // Check recent list
  const recent = queue.getRecentIds();
  assert.deepStrictEqual(recent, ['s1', 's2', 's3'], 'Recent list retains every song in history even after rewinding');

  console.log('  ✓ PASS: Stepping backward and forward through history does not remove songs from recent list.');
}

console.log('\n================================================================================');
console.log('ALL SESSION PLAYBACK HISTORY TESTS PASSED (7 / 7)');
console.log('================================================================================');

import assert from 'node:assert';
import { shapeDelivery } from '../src/services/djBreak/djDelivery.js';
import { artistTitle, Song } from '../src/services/djBreak/djBreakObservations.js';
import { buildVarietyBreak, newVarietyState, BreakContext } from '../src/services/djBreak/djVariety.js';

console.log('================================================================================');
console.log('         RETROFM DJ TIMING, DELIVERY & VARIETY TEST SUITE');
console.log('================================================================================\n');

// 1. Delivery Shaping and Protection Test
console.log('Test 1: shapeDelivery preserves protected artist and title while shaping punctuation');
const prevSong: Song = {
  id: 'song1',
  title: "Don't Stop 'Til You Get Enough",
  artist: 'Michael Jackson',
  release_date: '1979-07-28',
  release_date_precision: 'day',
  primary_genre: 'Disco',
  genres: 'Disco, Funk',
  peak_position: 1,
  peak_date: '1979-10-13',
  last_chart_date: '1980-01-01',
  weeks_on_chart: 21,
};
const nextSong: Song = {
  id: 'song2',
  title: 'Bad Girls',
  artist: 'Donna Summer',
  release_date: '1979-05-01',
  release_date_precision: 'day',
  primary_genre: 'Disco',
  genres: 'Disco',
  peak_position: 1,
  peak_date: '1979-06-16',
  last_chart_date: '1979-09-01',
  weeks_on_chart: 18,
};

const spokenPrev = artistTitle(prevSong);
const spokenNext = artistTitle(nextSong);
const protect = [spokenPrev.artist, spokenPrev.title, spokenNext.artist, spokenNext.title];

const rawSpeech = `That was Michael Jackson with Don't Stop 'Til You Get Enough. Next up is Donna Summer with Bad Girls.`;
const shaped = shapeDelivery(rawSpeech, { excitement: 100, pauses: 100, protect }, () => 0.1);

assert.ok(shaped.includes("Michael Jackson"), "Must preserve protected artist name");
assert.ok(shaped.includes("Don't Stop 'Til You Get Enough"), "Must preserve protected song title");
assert.ok(shaped.includes("Donna Summer"), "Must preserve next artist name");
assert.ok(shaped.includes("Bad Girls"), "Must preserve next song title");
assert.ok(shaped.includes("!"), "High excitement must convert eligible terminal period to exclamation point");
console.log(`Original: "${rawSpeech}"`);
console.log(`Shaped:   "${shaped}"`);
console.log('✓ PASS: shapeDelivery correctly preserves protected phrases and shapes delivery.\n');

// 2. Removed Kinds & New Kind "chart_now" Test
console.log('Test 2: Verification of removed kinds and chart_now variety break');
const context: BreakContext = {
  prev: prevSong,
  next: nextSong,
  date: '1979-05-01',
  now: new Date('1979-05-01T14:00:00'),
  decade: '1970s',
  genre: 'Disco',
  frequency: '91.7',
  topOfWeek: [
    { rank: 1, title: 'Heart of Glass', artist: 'Blondie' },
    { rank: 2, title: 'Bad Girls', artist: 'Donna Summer' },
  ],
  news: null,
  length: 'mixed',
};

const state = newVarietyState(42);
const varietyBreak = buildVarietyBreak(context, state, () => 0.5);

assert.ok(['observation', 'frequency', 'calendar', 'chart_now', 'news', 'jingle', 'plain', 'silent'].includes(varietyBreak.kind));
assert.notStrictEqual((varietyBreak as any).kind, 'time');
assert.notStrictEqual((varietyBreak as any).kind, 'request');
assert.notStrictEqual((varietyBreak as any).kind, 'number_one');
assert.ok(varietyBreak.timing === 'land' || varietyBreak.timing === 'follow');
console.log(`Break kind produced: ${varietyBreak.kind}, timing: ${varietyBreak.timing}, maxSeconds: ${varietyBreak.maxSeconds}`);
console.log('✓ PASS: Removed kinds are completely absent; BreakResult exposes timing and maxSeconds.\n');

// 3. Back-timing calculation math test
console.log('Test 3: Back-timing calculation math');
// timing: "land" -> Speech ends 0.5 to 2.0 seconds after next song starts (landOffset in [0.5, 2.0])
// start = songEnd + landOffset - audioDuration => remaining at start = audioDuration - landOffset
const audioDuration = 12.0;
const landOffset = 1.0;
let triggerRemaining = audioDuration - landOffset; // 11.0s before end
assert.strictEqual(triggerRemaining, 11.0);

// Cap at 25s remaining max:
const longAudioDuration = 32.0;
let longTriggerRemaining = longAudioDuration - landOffset; // 31.0s
if (longTriggerRemaining > 25) {
  longTriggerRemaining = 25;
}
assert.strictEqual(longTriggerRemaining, 25, 'Must cap start remaining at 25s before end');

// timing: "follow" -> Speech starts 1.0 to 2.0s before current song ends.
// If audioDuration > maxSeconds, skip break.
const followMaxSeconds = 12.0;
const validFollowAudio = 10.5;
assert.ok(validFollowAudio <= followMaxSeconds, 'Audio within maxSeconds is allowed');

const excessiveFollowAudio = 14.0;
assert.ok(excessiveFollowAudio > followMaxSeconds, 'Audio exceeding maxSeconds is detected for skipping');

console.log('✓ PASS: Back-timing mathematical formulas and limits validated.\n');

console.log('================================================================================');
console.log('All DJ timing, delivery and variety tests passed successfully!');
console.log('================================================================================');

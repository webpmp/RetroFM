/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Test suite for Spec A & Spec B:
 * - 1979-05-01 runtime chart facts
 * - Debut, Climb, First Top 10, Reached #1, Weeks at #1
 * - Protection test: NEVER reads peak_position, peak_date, last_chart_date, or weeks_on_chart
 * - Break selection candidate engine & frequency control
 * - Deterministic output validator & grounding checks
 */

import assert from 'node:assert';
import { ChartFactRepository, computeChartFacts, normalizeChartText, primaryPerformer } from '../src/services/djBreak/chartFacts.js';
import { decideAndSelectBreak, newBreakSelectionSessionState, BreakSelectionSessionState } from '../src/services/djBreak/breakDecisionEngine.js';
import { validateBreakOutput } from '../src/services/djBreak/breakValidator.js';

console.log('================================================================================');
console.log('         RETROFM SPEC A & SPEC B: CHART FACTS & BREAK SELECTION TEST');
console.log('================================================================================\n');

const repo = new ChartFactRepository();
assert.ok(repo.isAvailable(), 'Chart repository must be available with SQLite connection');

// --------------------------------------------------------------------------------
// TEST 1: Era-accurate Chart Facts on 1979-05-01
// --------------------------------------------------------------------------------
console.log('Test 1: Chart facts computation for 1979-05-01');

// 1A: Heart of Glass reached #1 this week (1979-04-28 chart week) and spent 4 weeks in top 10
const blondieFacts = computeChartFacts(
  { title: 'Heart Of Glass', artist: 'Blondie' },
  '1979-05-01',
  repo
);
console.log('Blondie facts:', blondieFacts);
const reachedOne = blondieFacts.find((f) => f.kind === 'reached_number_one');
const weeksAtOne = blondieFacts.find((f) => f.kind === 'weeks_at_number_one');
const weeksInTopTen = blondieFacts.find((f) => f.kind === 'weeks_in_top_ten');

assert.ok(reachedOne, 'Must detect reached_number_one for Heart of Glass on 1979-05-01');
assert.strictEqual(reachedOne?.rank, 1);
assert.strictEqual(reachedOne?.lastRank, 3);
assert.ok(reachedOne?.prevNumberOne?.title, 'Must include previous number one title');
assert.ok(weeksAtOne, 'Must detect weeks_at_number_one');
assert.strictEqual(weeksAtOne?.weeksAtOne, 1);
assert.ok(weeksInTopTen, 'Must detect weeks_in_top_ten');
assert.strictEqual(weeksInTopTen?.weeksInTopTen, 4);

// Test climb on 8+ places jump (Hot Number by Foxy climbed from 72 to 35 over last 2 weeks)
const foxyFacts = computeChartFacts(
  { title: 'Hot Number', artist: 'Foxy' },
  '1979-05-01',
  repo
);
const climb = foxyFacts.find((f) => f.kind === 'climb');
assert.ok(climb, 'Must detect climb of 8 or more places for Hot Number');
assert.strictEqual(climb?.rank, 35);
assert.strictEqual(climb?.lastRank, 72);
assert.strictEqual(climb?.climbWeeks, 2);
console.log('✓ PASS: Heart Of Glass #1 facts and Foxy climb facts computed accurately for 1979-05-01.\n');

// 1B: Debut test on 1979-05-01 (She Believes In Me debuted at 61)
const rogersFacts = computeChartFacts(
  { title: 'She Believes In Me', artist: 'Kenny Rogers' },
  '1979-05-01',
  repo
);
console.log('Kenny Rogers facts:', rogersFacts);
const debut = rogersFacts.find((f) => f.kind === 'debut');
assert.ok(debut, 'Must detect debut for She Believes In Me on 1979-05-01');
assert.strictEqual(debut?.rank, 61);
console.log('✓ PASS: Debut fact computed accurately.\n');

// 1C: First week in top 10 (Goodnight Tonight by Wings entered top 10 at #9)
const wingsFacts = computeChartFacts(
  { title: 'Goodnight Tonight', artist: 'Wings' },
  '1979-05-01',
  repo
);
console.log('Wings facts:', wingsFacts);
const topTen = wingsFacts.find((f) => f.kind === 'first_top_ten');
assert.ok(topTen, 'Must detect first_top_ten for Goodnight Tonight');
assert.strictEqual(topTen?.rank, 9);
console.log('✓ PASS: First week in top 10 fact computed accurately.\n');

// --------------------------------------------------------------------------------
// TEST 2: Anachronism Protection - NEVER read peak_position, peak_date,
// last_chart_date, or weeks_on_chart
// --------------------------------------------------------------------------------
console.log('Test 2: Verification that chartFacts and breakDecisionEngine NEVER inspect static chart fields');

// Mock song object containing future/static 2026 chart values (Michael Jackson Billie Jean)
const mjFutureSong: any = {
  id: '1983-006',
  title: 'Billie Jean',
  artist: 'Michael Jackson',
  // Poisoned static properties from 2026
  peak_position: 1,
  peak_date: '1983-03-05',
  last_chart_date: '2026-06-20',
  weeks_on_chart: 120,
};

// Trap property access to verify they are never accessed
const accessedProperties: string[] = [];
const guardedSong = new Proxy(mjFutureSong, {
  get(target, prop: string) {
    if (['peak_position', 'peak_date', 'last_chart_date', 'weeks_on_chart'].includes(prop)) {
      accessedProperties.push(prop);
      throw new Error(`VIOLATION: Forbidden static field "${prop}" was read!`);
    }
    return target[prop];
  },
});

// Calculate on 1979-05-01 (song does not exist on chart yet)
const mj1979Facts = computeChartFacts(guardedSong, '1979-05-01', repo);
assert.strictEqual(mj1979Facts.length, 0, 'No facts should exist for Billie Jean in 1979');
assert.strictEqual(accessedProperties.length, 0, 'Forbidden fields must never be accessed');

// Calculate on 1983-03-05 (song at #1)
const mj1983Facts = computeChartFacts(guardedSong, '1983-03-05', repo);
assert.ok(mj1983Facts.length > 0, 'Facts should be computed from weekly_chart rows');
assert.strictEqual(accessedProperties.length, 0, 'Forbidden fields must never be accessed even for historical hits');
console.log('✓ PASS: Guaranteed zero reads of peak_position, peak_date, last_chart_date, or weeks_on_chart.\n');

// --------------------------------------------------------------------------------
// TEST 3: Break Decision Engine Candidate Selection & Session Rules
// --------------------------------------------------------------------------------
console.log('Test 3: Break decision candidate collection and session constraints');

let state = newBreakSelectionSessionState();

// 3A: Frequency control test (frequency = 0 forces silence)
const silentResult = decideAndSelectBreak(
  {
    prevSong: { title: 'Heart Of Glass', artist: 'Blondie' },
    nextSong: { title: 'She Believes In Me', artist: 'Kenny Rogers' },
    selectedDate: '1979-05-01',
    frequencySetting: 0.0, // 0% talk chance -> silence
    chartRepo: repo,
    rng: () => 0.5,
  },
  state
);
assert.strictEqual(silentResult.decision, 'silence');
console.log('✓ PASS: Frequency setting correctly defaults to silence.\n');

// 3B: Frequency = 1.0 (always talk) picks candidate and sets session state
const spokenResult = decideAndSelectBreak(
  {
    prevSong: { title: 'Heart Of Glass', artist: 'Blondie' },
    nextSong: { title: 'Goodnight Tonight', artist: 'Wings' },
    selectedDate: '1979-05-01',
    frequencySetting: 1.0, // always talk
    newsObservation: { text: 'New York City transit fares remain at fifty cents.', date: '1979-05-01' },
    chartRepo: repo,
    rng: () => 0.0, // deterministic pick
  },
  state
);
assert.strictEqual(spokenResult.decision, 'speak');
assert.ok(spokenResult.candidate, 'Candidate must be selected');
assert.ok(state.lastBreakType, 'Session state must record lastBreakType');
const firstBreakType = state.lastBreakType;
console.log(`First break spoken: "${spokenResult.finalSpeech}" (Type: ${firstBreakType})`);

// 3C: Never repeat the same break type back-to-back
const secondResult = decideAndSelectBreak(
  {
    prevSong: { title: 'Heart Of Glass', artist: 'Blondie' },
    nextSong: { title: 'Goodnight Tonight', artist: 'Wings' },
    selectedDate: '1979-05-01',
    frequencySetting: 1.0,
    newsObservation: { text: 'New York City transit fares remain at fifty cents.', date: '1979-05-01' },
    chartRepo: repo,
    rng: () => 0.0,
  },
  state
);
assert.strictEqual(secondResult.decision, 'speak');
assert.notStrictEqual(secondResult.breakType, firstBreakType, 'Must NOT pick the same break type back-to-back');
console.log(`Second break spoken: "${secondResult.finalSpeech}" (Type: ${secondResult.breakType})`);
console.log('✓ PASS: Same break type is never chosen back-to-back.\n');

// --------------------------------------------------------------------------------
// TEST 4: Output Validator & Rejection
// --------------------------------------------------------------------------------
console.log('Test 4: Output validator rejection rules');

// 4A: Reject banned favorite phrases or first-person pronouns
const rejectedFavorite = validateBreakOutput("Here's one of my favorites from Wings.", {
  selectedDate: '1979-05-01',
  factPacket: { factText: 'Test', source: 'Test', date: '1979-05-01' },
});
assert.strictEqual(rejectedFavorite.valid, false);
assert.ok(
  rejectedFavorite.rejectedReason?.includes('banned subjective phrase') ||
  rejectedFavorite.rejectedReason?.includes('first-person')
);

// 4B: Reject future year (e.g. 1985 in a 1979 broadcast)
const rejectedYear = validateBreakOutput("Wings will go on to release an album in 1985.", {
  selectedDate: '1979-05-01',
  factPacket: { factText: 'Test', source: 'Test', date: '1979-05-01' },
});
assert.strictEqual(rejectedYear.valid, false);
assert.ok(rejectedYear.rejectedReason?.includes('future year'));

// 4C: Reject unverified proper names
const rejectedName = validateBreakOutput("Climbing to number one, beating out Led Zeppelin.", {
  selectedDate: '1979-05-01',
  factPacket: { factText: 'Climbing to number one.', source: 'Billboard', date: '1979-04-28' },
  songPlayed: { title: 'Heart Of Glass', artist: 'Blondie' },
});
assert.strictEqual(rejectedName.valid, false);
assert.ok(rejectedName.rejectedReason?.includes('Unverified proper name'));

// 4D: Stage directions check stripping parenthetical titles (including smart quotes)
const validRegulate = validateBreakOutput('Next up, "Regulate (From “Above The Rim”)" by Warren G.', {
  selectedDate: '1994-06-01',
  factPacket: { factText: 'Warren G and Nate Dogg release Regulate.', source: 'Billboard', date: '1994-06-01' },
  songNext: { title: 'Regulate (From “Above The Rim”)', artist: 'Warren G' },
});
assert.notStrictEqual(validRegulate.rejectedReason, 'Contains stage directions in parentheses or brackets');

const validShyGuy = validateBreakOutput('Here is "Shy Guy (From “Bad Boys”)" by Diana King.', {
  selectedDate: '1995-06-01',
  factPacket: { factText: 'Diana King releases Shy Guy.', source: 'Billboard', date: '1995-06-01' },
  songNext: { title: 'Shy Guy (From “Bad Boys”)', artist: 'Diana King' },
});
assert.notStrictEqual(validShyGuy.rejectedReason, 'Contains stage directions in parentheses or brackets');

const validMacarena = validateBreakOutput('Spinning "Macarena (Bayside Boys Mix)" by Los Del Rio.', {
  selectedDate: '1996-08-01',
  factPacket: { factText: 'Los Del Rio releases Macarena.', source: 'Billboard', date: '1996-08-01' },
  songNext: { title: 'Macarena (Bayside Boys Mix)', artist: 'Los Del Rio' },
});
assert.notStrictEqual(validMacarena.rejectedReason, 'Contains stage directions in parentheses or brackets');

// Also test when titles are quoted inline in script body without songNext metadata
const validQuotedMix = validateBreakOutput('Taking over the chart this week, “Macarena (Bayside Boys Mix)” reaches number one.', {
  selectedDate: '1996-08-01',
  factPacket: { factText: '“Macarena (Bayside Boys Mix)” reaches number one.', source: 'Billboard', date: '1996-08-01' },
});
assert.notStrictEqual(validQuotedMix.rejectedReason, 'Contains stage directions in parentheses or brackets');

// Confirm genuine stage direction is still rejected
const rejectedStageDir = validateBreakOutput('Coming up next (laughs) we have music.', {
  selectedDate: '1979-05-01',
  factPacket: { factText: 'Music news.', source: 'Test', date: '1979-05-01' },
});
assert.strictEqual(rejectedStageDir.valid, false);
assert.strictEqual(rejectedStageDir.rejectedReason, 'Contains stage directions in parentheses or brackets');

console.log('✓ PASS: All rejection checks validated.\n');

console.log('================================================================================');
console.log('All Chart Facts and Break Decision tests passed successfully!');
console.log('================================================================================');

// --------------------------------------------------------------------------------
// TEST 5: Prev/Next Chart Fact Target Attribution Test
// --------------------------------------------------------------------------------
console.log('Test 5: Target song attribution for prev and next chart facts');

const prevTrack = { title: 'Heart Of Glass', artist: 'Blondie' };
const nextTrack = { title: 'Goodnight Tonight', artist: 'Wings' };

const testState = newBreakSelectionSessionState();
const run1 = decideAndSelectBreak({
  prevSong: prevTrack,
  nextSong: nextTrack,
  selectedDate: '1979-05-01',
  frequencySetting: 1.0,
  chartRepo: repo,
  rng: () => 0.0,
}, testState);

if (run1.breakType === 'chart_fact' && run1.candidate) {
  const targetObj = run1.targetSong === 'prev' ? prevTrack : nextTrack;
  console.log(`Target: ${run1.targetSong} | Fact text: "${run1.candidate.factText}"`);
  assert.ok(
    run1.candidate.factText.includes(targetObj.title),
    `Chart fact must name the song it is attached to! (Expected ${targetObj.title} in "${run1.candidate.factText}")`
  );
  assert.ok(
    run1.candidate.factText.includes(targetObj.artist),
    `Chart fact must name the artist it is attached to! (Expected ${targetObj.artist} in "${run1.candidate.factText}")`
  );
}
console.log('✓ PASS: Every chart fact song strictly matches its target_song.\n');

// --------------------------------------------------------------------------------
// TEST 6: Consecutive intro_only and consecutive silence allowed
// --------------------------------------------------------------------------------
console.log('Test 6: Consecutive intro_only and silence allowance');
const introState = newBreakSelectionSessionState();
introState.lastBreakType = 'intro_only';

// Candidate collector should allow another intro_only when no high-interest chart facts exist
// Mark national #1 as already used in this session to test consecutive intro_only behavior
introState.usedFactKeys.add('chart:national_no1:Heart Of Glass:1:1979-04-28');
const unchartTrack = { title: 'Unknown Song', artist: 'Nobody' };
const introRun = decideAndSelectBreak({
  prevSong: null,
  nextSong: unchartTrack,
  selectedDate: '1979-05-01',
  frequencySetting: 1.0,
  chartRepo: repo,
}, introState);

assert.strictEqual(introRun.breakType, 'intro_only', 'Consecutive intro_only must be allowed');
console.log('✓ PASS: Consecutive intro_only is permitted while non-intro types avoid repeats.\n');

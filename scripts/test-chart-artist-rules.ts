import assert from 'node:assert';
import { ChartFactRepository, computeSongChartStatusFact } from '../src/services/djBreak/chartFacts.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';

console.log('Running tests for Part 2 & Part 3 (chart sentences & artist metadata)...');

const repo = new ChartFactRepository();
assert(repo.isAvailable(), 'ChartFactRepository must be available');

// --- TEST PART 2 (a): Before The Next Teardrop Falls on 1975-07-01 ---
const freddySong = { id: '1975-006', title: 'Before The Next Teardrop Falls', artist: 'Freddy Fender' };
const freddyFact = computeSongChartStatusFact(freddySong, '1975-07-01', repo);

console.log('Freddy Fender chart fact (1975-07-01):', freddyFact);
assert(freddyFact !== null, 'Freddy Fender chart fact should exist');
assert.strictEqual(freddyFact.weeksAtOne, 1, 'weeks_at_1 must equal 1');
assert.strictEqual(freddyFact.weeksOnChart, 21, 'weeks_on_chart must equal 21');
assert.strictEqual(freddyFact.peakRank, 1, 'peakRank must equal 1');
assert(freddyFact.text.includes('It reached number one on the Hot 100 in May 1975.'), 'Peak sentence must mention May 1975');
assert(freddyFact.text.includes('It spent 21 weeks on the chart.'), 'Run sentence must state 21 weeks on the chart');
assert(!freddyFact.text.includes('topped the charts'), 'Must never use "topped the charts"');
assert(!freddyFact.text.includes('staying there'), 'Must never use "staying there"');

// --- TEST PART 2 (b): Let Your Love Flow on 1976-07-01 ---
const bellamySong = { id: '1976-045', title: 'Let Your Love Flow', artist: 'Bellamy Brothers' };
const bellamyFact = computeSongChartStatusFact(bellamySong, '1976-07-01', repo);

console.log('Bellamy Brothers chart fact (1976-07-01):', bellamyFact);
assert(bellamyFact !== null, 'Bellamy Brothers chart fact should exist');
assert.strictEqual(bellamyFact.weeksAtOne, 1, 'weeks_at_1 must equal 1');
assert.strictEqual(bellamyFact.weeksOnChart, 19, 'weeks_on_chart must equal 19');
assert.strictEqual(bellamyFact.peakRank, 1, 'peakRank must equal 1');
assert(bellamyFact.text.includes('It reached number one on the Hot 100 in May 1976.'), 'Peak sentence must mention May 1976');
assert(bellamyFact.text.includes('It spent 19 weeks on the chart.'), 'Run sentence must state 19 weeks on the chart');
assert(!bellamyFact.text.includes('topped the charts'), 'Must never use "topped the charts"');
assert(!bellamyFact.text.includes('staying there'), 'Must never use "staying there"');

// --- TEST PART 2 (c): Validator rejects pairing "number one" or "topped the charts" with 21 or 19 ---
const invalidScript1 = 'Before The Next Teardrop Falls topped the charts in May 1975, staying there for 21 weeks. Now let\'s hear Freddy Fender.';
const val1 = validateSegmentBreakOutput(invalidScript1, {
  selectedDate: '1975-07-01',
  factPacket: {
    targetSongTitle: 'Before The Next Teardrop Falls',
    facts: [freddyFact as any],
  },
});
console.log('Validator test 1 (mismatched weeks):', val1);
assert(!val1.valid, 'Validator must reject pairing "staying there" or "topped the charts" with 21 weeks when weeksAtOne=1');

const invalidScript2 = 'Let Your Love Flow topped the charts in May 1976, staying there for nineteen weeks. Here is Bellamy Brothers.';
const val2 = validateSegmentBreakOutput(invalidScript2, {
  selectedDate: '1976-07-01',
  factPacket: {
    targetSongTitle: 'Let Your Love Flow',
    facts: [bellamyFact as any],
  },
});
console.log('Validator test 2 (mismatched weeks):', val2);
assert(!val2.valid, 'Validator must reject pairing "staying there" or "topped the charts" with 19 weeks when weeksAtOne=1');

// Valid script that uses locked sentences verbatim passes:
const validScript = 'It reached number one on the Hot 100 in May 1976. It spent 19 weeks on the chart. Now on RetroFM, here is "Let Your Love Flow" by Bellamy Brothers.';
const valValid = validateSegmentBreakOutput(validScript, {
  selectedDate: '1976-07-01',
  factPacket: {
    targetSongTitle: 'Let Your Love Flow',
    targetSongArtist: 'Bellamy Brothers',
    facts: [bellamyFact as any],
  },
});
console.log('Validator test valid script:', valValid);
assert(valValid.valid, `Valid script must pass validator: ${valValid.rejectedReason}`);

// --- TEST PART 2 (d): Broadcast date before 1976-05-01 gets no "reached number one" claim ---
const bellamyAprilFact = computeSongChartStatusFact(bellamySong, '1976-04-15', repo);
console.log('Bellamy April Fact (1976-04-15):', bellamyAprilFact);
assert(bellamyAprilFact !== null, 'April fact must exist');
assert(!bellamyAprilFact.text.includes('reached number one'), 'April 1976 must NOT make a "reached number one" claim');
assert(!bellamyAprilFact.text.includes('number-one hit'), 'April 1976 must NOT claim number-one hit');

const futureClaimScript = 'Let Your Love Flow reached number one on the Billboard Hot 100. Right now, here is Bellamy Brothers.';
const valFuture = validateSegmentBreakOutput(futureClaimScript, {
  selectedDate: '1976-04-15',
  factPacket: {
    targetSongTitle: 'Let Your Love Flow',
    facts: [bellamyAprilFact as any],
  },
});
console.log('Validator test future claim on 1976-04-15:', valFuture);
assert(!valFuture.valid, 'Validator must reject "reached number one" claim before 1976-05-01');

// --- TEST PART 3: Artist Metadata Wording ---
console.log('\nTesting Artist Metadata Wording (Freddy Fender, Robin S., Duran Duran)...');

// 1. Freddy Fender: Person, beginYear 1937
const cardFreddy = await getOrBuildSongStoryCard({
  id: '1975-006',
  title: 'Before The Next Teardrop Falls',
  artist: 'Freddy Fender',
  first_chart_date: '1975-02-01',
}, '1975-06-15');

console.log('Freddy Fender facts:', cardFreddy.facts.map(f => f.factText));
for (const f of cardFreddy.facts) {
  assert(!f.factText.includes('making music since'), 'Must never say "making music since" for Freddy Fender');
  assert(!f.factText.includes('active since'), 'Must never say "active since" for Freddy Fender');
  assert(!f.factText.includes('formed in'), 'Must never say "formed in" for Freddy Fender');
  assert(!f.factText.includes('started their career in 1937'), 'Must not say "started their career in 1937" (1937 is birth year)');
}

// 2. Robin S.: Person, beginYear 1962
const cardRobin = await getOrBuildSongStoryCard({
  id: '1993-020',
  title: 'Show Me Love',
  artist: 'Robin S.',
  first_chart_date: '1993-04-10',
}, '1993-05-01');

console.log('Robin S. facts:', cardRobin.facts.map(f => f.factText));
for (const f of cardRobin.facts) {
  assert(!f.factText.includes('making music since'), 'Must never say "making music since" for Robin S.');
  assert(!f.factText.includes('active since'), 'Must never say "active since" for Robin S.');
  assert(!f.factText.includes('formed in'), 'Must never say "formed in" for Robin S.');
}

// 3. Duran Duran: Group, beginYear 1978
const cardDuran = await getOrBuildSongStoryCard({
  id: '1993-028',
  title: 'Come Undone',
  artist: 'Duran Duran',
  first_chart_date: '1993-04-17',
}, '1993-05-01');

console.log('Duran Duran facts:', cardDuran.facts.map(f => f.factText));
const hasFormed = cardDuran.facts.some(f => f.factText.includes('formed in 1978'));
console.log('Duran Duran has "formed in 1978":', hasFormed);
assert(hasFormed, 'Group Duran Duran must use "formed in 1978"');

console.log('\nAll Part 2 & Part 3 unit tests passed successfully!');

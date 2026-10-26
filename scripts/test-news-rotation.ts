import assert from 'node:assert';
import { selectNewsPackets, getDateNDaysBefore, ReducedNYTArticle } from '../src/services/news/nytArchiveService.js';
import { isSensitive, auditNewsLine, NewsPacket } from '../src/services/djBreak/newsAudit.js';
import { NewsQueueManager } from '../src/services/news/newsQueueManager.js';

console.log('================================================================================');
console.log('         RETROFM NEWS ROTATION & PIPELINE TEST SUITE');
console.log('================================================================================\n');

// 1. Date Calculation Test
console.log('Test 1: getDateNDaysBefore calculation');
assert.strictEqual(getDateNDaysBefore('1985-07-13', 1), '1985-07-12');
assert.strictEqual(getDateNDaysBefore('1985-07-13', 2), '1985-07-11');
assert.strictEqual(getDateNDaysBefore('1985-07-13', 3), '1985-07-10');
assert.strictEqual(getDateNDaysBefore('1985-03-01', 1), '1985-02-28');
console.log('✓ PASS: Calendar date calculations accurate.\n');

// 2. Selection Window (Never later than target date)
console.log('Test 2: Selection window never includes dates after target date');
const targetDate = '1985-07-13';
const sampleArticles: ReducedNYTArticle[] = [
  {
    pubDate: '1985-07-14', // LATER
    headline: 'Future Event Tomorrow',
    abstract: 'Report of an event that will happen tomorrow exceeding sixty characters.',
    section: 'National',
    desk: 'National',
    typeOfMaterial: 'News',
    printPage: '1',
    printSection: 'A',
  },
  {
    pubDate: '1985-07-13', // On Date
    headline: 'Concert Begins In London And Philadelphia',
    abstract: 'Major musical benefit draws historic worldwide audience today across stadiums.',
    section: 'National',
    desk: 'National',
    typeOfMaterial: 'News',
    printPage: '1',
    printSection: 'A',
  },
  {
    pubDate: '1985-07-12', // 1 day before
    headline: 'Preparations Underway Across Two Continents',
    abstract: 'Organizers finalize satellite broadcast links and sound stages for the weekend.',
    section: 'National',
    desk: 'National',
    typeOfMaterial: 'News',
    printPage: '1',
    printSection: 'A',
  },
];

const selected = selectNewsPackets(sampleArticles, targetDate);
assert.strictEqual(
  selected.some((p) => p.headline.includes('Future Event')),
  false,
  'Selected articles must NEVER include items published after targetDate'
);
assert.ok(selected.length > 0, 'Must select valid articles on or before target date');
for (const p of selected) {
  assert.strictEqual(p.date, targetDate, 'Returned packet date must be normalized to targetDate');
}
console.log('✓ PASS: Articles published after target date are strictly excluded.\n');

// 3. Fallback to previous 1 to 3 days only if fewer than 5 on targetDate
console.log('Test 3: Fallback window to prior 1-3 days when < 5 on targetDate');
const sparseArticles: ReducedNYTArticle[] = [
  {
    pubDate: '1985-07-13',
    headline: 'Article On Exact Date',
    abstract: 'Valid national news report from the exact target day with detailed reporting that exceeds sixty characters.',
    section: 'National',
    desk: 'National',
    typeOfMaterial: 'News',
    printPage: '1',
    printSection: 'A',
  },
  {
    pubDate: '1985-07-12',
    headline: 'Article From Yesterday',
    abstract: 'Valid national news report from one day prior to broadcast with full information exceeding sixty characters.',
    section: 'National',
    desk: 'National',
    typeOfMaterial: 'News',
    printPage: '1',
    printSection: 'A',
  },
];
const fallbackSelected = selectNewsPackets(sparseArticles, targetDate);
assert.ok(
  fallbackSelected.map((p) => p.headline).includes('Article On Exact Date'),
  'Should include exact date article'
);
assert.ok(
  fallbackSelected.map((p) => p.headline).includes('Article From Yesterday'),
  'Should include yesterday article when < 5 articles on target date'
);
console.log('✓ PASS: Fallback to previous days works when < 5 articles on target date.\n');

// 4. isSensitive Filter
console.log('Test 4: isSensitive filter correctly flags tragic/disaster headlines');
const safePacket: NewsPacket = {
  date: '1985-07-13',
  headline: 'Live Aid Concert Launches In London and Philadelphia',
  abstract: 'Rock musicians perform to raise funds for humanitarian aid.',
};
assert.strictEqual(isSensitive(safePacket), false);

const tragic1: NewsPacket = {
  date: '1985-07-13',
  headline: 'Five Dead in Highway Crash in New Jersey',
  abstract: 'Authorities investigate collision involving three vehicles.',
};
assert.strictEqual(isSensitive(tragic1), true);

const tragic2: NewsPacket = {
  date: '1985-07-13',
  headline: 'Hostages Released After Airport Siege',
  abstract: 'Negotiations end without casualties after standoff.',
};
assert.strictEqual(isSensitive(tragic2), true);
console.log('✓ PASS: isSensitive correctly flags tragedies, fatalities, and disasters.\n');

// 5. Queue behavior: Line marked used ONLY when break actually plays
console.log('Test 5: Queue behavior - mark used only when break plays');
const qm = new NewsQueueManager();
qm.resetSession();
const qmInternal = qm as any;
qmInternal.queue = [
  {
    id: 'item_1',
    text: 'The morning paper reports great weather for the weekend.',
    packet: { date: '1985-07-13', headline: 'Sunny Weekend', abstract: '' },
    used: false,
  },
];

const next1 = qm.getNextNewsLine();
assert.ok(next1 !== null);
assert.strictEqual(next1?.id, 'item_1');

// When simply inspecting or preparing ahead, item remains unused
const next2 = qm.getNextNewsLine();
assert.strictEqual(next2?.id, 'item_1');

// Break plays -> mark used
qm.markLineUsed(next1!.id);
const next3 = qm.getNextNewsLine();
assert.strictEqual(next3, null, 'Queue should have no available lines after being marked used');
console.log('✓ PASS: Queue item remains available until marked used upon actual playback.\n');

// 6. Discarded break returns line to queue (REWIND / FF / SKIP)
console.log('Test 6: Discarded break returns unplayed line to queue');
const discardText = 'Space Shuttle launches successfully into orbit.';
qmInternal.queue = [
  {
    id: 'item_space',
    text: discardText,
    packet: { date: '1985-07-13', headline: 'Space Launch', abstract: '' },
    used: false,
  },
];

const itemToPrep = qm.getNextNewsLine();
assert.ok(itemToPrep !== null);
qm.markLineUsed(itemToPrep!.id);
assert.strictEqual(qm.getNextNewsLine(), null);

// REWIND / SKIP transport action discards prepared break
qm.returnLineToQueue(itemToPrep!.id);
const restored = qm.getNextNewsLine();
assert.ok(restored !== null);
assert.strictEqual(restored?.text, discardText);
console.log('✓ PASS: Unplayed news line returned to queue upon break discard.\n');

// 7. Cancellation on date change
console.log('Test 7: Date change cancels ongoing prefetch job');
qm.prefetchNews('1985-07-13');
const controller1 = qmInternal.abortController;
assert.ok(controller1 !== null);
assert.strictEqual(controller1.signal.aborted, false);

qm.prefetchNews('1964-07-04');
assert.strictEqual(controller1.signal.aborted, true, 'Previous abort controller must be aborted');
const controller2 = qmInternal.abortController;
assert.notStrictEqual(controller1, controller2);
qm.cancel();
console.log('✓ PASS: Previous prefetch job cancelled cleanly when date changes.\n');

// 8. auditNewsLine rejects greetings and hype phrases (including folks, listeners, everybody)
console.log('Test 8: auditNewsLine greeting and hype rejection');
const docPacket: NewsPacket = {
  date: '1977-05-01',
  headline: 'Talk About Doctors Instead of Athletes',
  abstract: 'Walt Frazier article on Arthur Ashe open lr urging black parents to see that their children receive formal educ; holds many black children are influenced by lifestyles of athletes and movie stars that are glamorized by media; says black parents should stress reading and educ to their children and that media should also write about successful black drs, teachers and businessmen; illus (M)',
  keywords: ['Arthur Ashe', 'Walt Frazier', 'Education'],
};
const validNewsLine = "Arthur Ashe and Walt Frazier want parents to urge reading and education rather than just focusing on professional sports.";
const auditValid = auditNewsLine(validNewsLine, docPacket);
assert.strictEqual(auditValid.ok, true, `Expected valid news line to pass, but failed: ${auditValid.reasons.join(', ')}`);

const invalidGreetingLine = 'Good morning listeners, maybe we should be shining a light on education.';
const auditGreeting = auditNewsLine(invalidGreetingLine, docPacket);
assert.strictEqual(auditGreeting.ok, false, 'Expected line with "Good morning listeners" to be rejected');
assert.ok(auditGreeting.reasons.includes('greeting, time-of-day or hype phrase'));

const invalidFolksLine = 'Hey folks, check out what the paper says today about sports.';
const auditFolks = auditNewsLine(invalidFolksLine, docPacket);
assert.strictEqual(auditFolks.ok, false, 'Expected line with "folks" to be rejected');
assert.ok(auditFolks.reasons.includes('greeting, time-of-day or hype phrase'));
console.log('✓ PASS: auditNewsLine accepts valid factual commentary and rejects greeting/hype phrases.\n');

console.log('================================================================================');
console.log('All 8 news rotation & pipeline tests passed successfully!');
console.log('================================================================================');

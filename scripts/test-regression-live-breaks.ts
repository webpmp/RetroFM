/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Regression unit tests for live aired breaks:
 * 1. Duplicate & mangled hand-off (repeated sentences, duplicate title hand-offs, banned intensifiers/transitions, feelings)
 * 2. "Annie's Song" casing preservation
 * 3. Orphan pronoun detection
 * 4. Copying exemption for titles, chart phrases, numbers
 */

import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, extra?: any) {
    if (condition) {
      console.log(`✓ PASS: ${name}`);
      passed++;
    } else {
      console.error(`✗ FAIL: ${name}`, extra || '');
      failed++;
    }
  }

  console.log('--- 1. Library Title Casing for Annie\'s Song ---');
  try {
    const dbPath = path.join(os.homedir(), 'retrofm', 'library.sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true } as any);
    const row = db.prepare('SELECT id, title, artist FROM songs WHERE id = ?').get('1974-037') as any;
    assert('Annie\'s Song is correctly capitalized in songs table', row?.title === "Annie's Song", row);
    const upperChartRows = db.prepare('SELECT title FROM weekly_chart WHERE title = ?').all("ANNIE's SONG") as any[];
    assert('No uppercase "ANNIE\'s SONG" remains in weekly_chart', upperChartRows.length === 0, upperChartRows);
  } catch (err) {
    console.warn('Could not read library.sqlite directly:', err);
  }

  console.log('\n--- 2. Duplicate & Mangled Hand-off Validation ---');

  // Test: repeated sentences
  const repeatedSentenceRes = validateSegmentBreakOutput(
    'John Denver wrote this song in 1974. John Denver wrote this song in 1974. Here is "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'John Denver wrote this song in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
    }
  );
  assert('Rejects repeated sentence in segment', !repeatedSentenceRes.valid && /Repeated sentence/i.test(repeatedSentenceRes.rejectedReason || ''), repeatedSentenceRes);

  // Test: duplicate hand-off containing title
  const duplicateHandoffRes = validateSegmentBreakOutput(
    'John Denver wrote this song in 1974. Now on RetroFM, here is "Annie\'s Song" by John Denver. Let\'s hear "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'John Denver wrote this song in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
    }
  );
  assert('Rejects target song title in multiple hand-off sentences', !duplicateHandoffRes.valid && /Target song title appears in 2 hand-off/i.test(duplicateHandoffRes.rejectedReason || ''), duplicateHandoffRes);

  // Test: banned intensifiers & transitions
  const bannedIntensifiers = ['astonishing', 'amazing', 'incredible', 'unique', 'remarkable', 'stunning', 'surprising', 'fresh', 'pretty unique', 'next up', 'switching gears'];
  for (const b of bannedIntensifiers) {
    const res = validateSegmentBreakOutput(
      `John Denver had an ${b} performance in 1974. Here is "Annie's Song" by John Denver.`,
      {
        selectedDate: '1975-05-01',
        factPacket: {
          facts: [{ text: 'John Denver had a concert in 1974.' }],
          targetSongTitle: "Annie's Song",
          targetSongArtist: 'John Denver',
        },
      }
    );
    assert(`Rejects banned intensifier/transition: "${b}"`, !res.valid && /Contains banned/i.test(res.rejectedReason || ''), res);
  }

  // Test: exclamation marks
  const exclamationRes = validateSegmentBreakOutput(
    'John Denver wrote this song in 1974! Here is "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'John Denver wrote this song in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
    }
  );
  assert('Rejects exclamation marks', !exclamationRes.valid && /exclamation mark/i.test(exclamationRes.rejectedReason || ''), exclamationRes);

  // Test: feelings attributed to subject without packet grounding
  const feelingRes = validateSegmentBreakOutput(
    'John Denver wrote this track about the mountains that he loves. Here is "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'John Denver wrote this track about the Colorado mountains in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
    }
  );
  assert('Rejects feelings attributed to subject ("that he loves") not in packet', !feelingRes.valid && /Attributed unverified feelings/i.test(feelingRes.rejectedReason || ''), feelingRes);

  console.log('\n--- 3. Orphan Pronoun Detection ---');
  // Test: orphan pronoun after first sentence
  const orphanPronounRes = validateSegmentBreakOutput(
    'Their three concerts sold out in four hours. Here on RetroFM, let\'s hear "Why Me" by Kris Kristofferson.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'Three concerts sold out in four hours.' }],
        targetSongTitle: 'Why Me',
        targetSongArtist: 'Kris Kristofferson',
      },
    }
  );
  assert('Rejects orphan pronoun starting sentence ("Their three concerts...")', !orphanPronounRes.valid && /Orphan pronoun/i.test(orphanPronounRes.rejectedReason || ''), orphanPronounRes);

  const namedSubjectRes = validateSegmentBreakOutput(
    'Led Zeppelin sold out three historic concerts in four hours. Here on RetroFM, let\'s hear "Why Me" by Kris Kristofferson.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'Led Zeppelin performed three concerts in New York that sold out quickly in 1975.' }],
        targetSongTitle: 'Why Me',
        targetSongArtist: 'Kris Kristofferson',
      },
    }
  );
  assert('Accepts sentence when subject entity is explicitly named', namedSubjectRes.valid, namedSubjectRes);

  console.log('\n--- 4. Copying Exemption for Titles, Chart Phrases, Dates ---');
  const chartPhraseRes = validateSegmentBreakOutput(
    'It was a top five hit on the Billboard Hot 100 in 1974. Here is "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'It was a top five hit on the Billboard Hot 100 in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
    }
  );
  assert('Exempts standard chart phrases from narrative copying penalty', chartPhraseRes.valid, chartPhraseRes);

  console.log('\n--- 5. Hand-off Bank, Alternation, and Orphan Pronoun Resolution ---');
  const { buildHandoff, resolveOrphanPronounOpening, isSongOld } = await import('../src/services/djBreak/handoffBank.js');

  // Test: Spice Girls orphan pronoun exact sentence
  const spiceDraft = "They co-wrote the track alongside Matt Rowe and Richard Biff Stannard.";
  const resolvedSpice = resolveOrphanPronounOpening(spiceDraft, "Wannabe", "Spice Girls");
  assert(
    'Replaces orphan pronoun "They" with artist name "Spice Girls"',
    resolvedSpice.replaced && resolvedSpice.resolvedText === "Spice Girls co-wrote the track alongside Matt Rowe and Richard Biff Stannard.",
    resolvedSpice
  );

  // Test: Finished segment contains song title exactly once and preserves capitalization
  const handoff1 = buildHandoff({
    songTitle: "Annie's Song",
    artistName: "John Denver",
    broadcastDate: "1975-05-01",
    lastHandoffGroup: null,
  });
  const finishedSegment = `John Denver recorded this track in 1974. ${handoff1.text}`;
  const titleOccurrences = (finishedSegment.match(/"Annie's Song"/g) || []).length;
  assert('Finished segment contains "Annie\'s Song" exactly once', titleOccurrences === 1, { finishedSegment, titleOccurrences });
  assert('Song title preserves capitalization (never uppercase ANNIE\'s SONG)', finishedSegment.includes('"Annie\'s Song"') && !finishedSegment.includes("ANNIE's SONG"));

  // Test: No two consecutive breaks use the same group
  let lastGroup: number | null = null;
  let noConsecutiveSameGroup = true;
  const recentTemplates: string[] = [];
  for (let i = 0; i < 30; i++) {
    const h = buildHandoff({
      songTitle: `Song ${i}`,
      artistName: `Artist ${i}`,
      broadcastDate: "1975-05-01",
      lastHandoffGroup: lastGroup,
      recentTemplates,
    });
    if (h.chosenGroup === lastGroup) {
      noConsecutiveSameGroup = false;
      break;
    }
    lastGroup = h.chosenGroup;
    recentTemplates.push(h.chosenTemplate);
    if (recentTemplates.length > 12) recentTemplates.shift();
  }
  assert('No two consecutive breaks use the same group across 30 selections', noConsecutiveSameGroup);

  // Test: OLD SONGS ONLY condition
  const oldSongCheck = isSongOld("1970-01-01", "1975-05-01"); // > 12 months
  const newSongCheck = isSongOld("1975-03-01", "1975-05-01"); // 2 months
  assert('isSongOld returns true for > 12 months', oldSongCheck === true);
  assert('isSongOld returns false for < 12 months', newSongCheck === false);

  // Test: Validator rejects model draft containing next song's title or hand-off
  const modelDraftWithTitle = validateSegmentBreakOutput(
    'John Denver wrote this track in 1974, and here is "Annie\'s Song" by John Denver.',
    {
      selectedDate: '1975-05-01',
      factPacket: {
        facts: [{ text: 'John Denver wrote this track in 1974.' }],
        targetSongTitle: "Annie's Song",
        targetSongArtist: 'John Denver',
      },
      isModelDraft: true,
    }
  );
  assert('Validator rejects model draft containing next song\'s title', !modelDraftWithTitle.valid && /only code adds hand-offs/i.test(modelDraftWithTitle.rejectedReason || ''), modelDraftWithTitle);

  console.log(`\n========================================`);
  console.log(`Total tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`========================================`);
  if (failed > 0) process.exit(1);
}

runTests();

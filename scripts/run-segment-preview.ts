/**
 * Preview script to run 6 full segments for 1982-05-01 and 1964-05-01
 */
import { getOrBuildAlmanac } from '../src/services/news/almanacService.js';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';
import { planSegmentBreak, newSegmentPlannerState } from '../src/services/djBreak/segmentPlanner.js';
import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

async function previewDate(date: string, sampleSongs: any[]) {
  console.log('================================================================================');
  console.log(`HISTORICAL PREVIEW FOR: ${date}`);
  console.log('================================================================================');

  const almanac = await getOrBuildAlmanac(date);
  console.log(`Almanac Items Found: ${almanac.totalEntries}`);
  console.log('Count by Category:', JSON.stringify(almanac.byCategory, null, 2));

  const writer = new LMStudioScriptWriterProvider({
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen2.5-14b-instruct-1m',
  });

  const homedir = process.env.HOME || '/root';
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));
  const state = newSegmentPlannerState();

  console.log('\n--------------------------------------------------------------------------------');
  console.log(`6 FULL SEGMENTS FOR ${date}`);
  console.log('--------------------------------------------------------------------------------');

  for (let i = 0; i < 6; i++) {
    const song = sampleSongs[i % sampleSongs.length];
    const card = await getOrBuildSongStoryCard(song, date, db);
    const packet = planSegmentBreak({
      broadcastDate: date,
      nextSong: song,
      songCard: card,
      almanac,
      state,
    });

    console.log(`\n[Segment ${i + 1}] Topic: ${packet.topic.toUpperCase()} - "${packet.topicTitle}"`);
    console.log('Verified Fact Packet:');
    packet.facts.forEach((f, idx) => {
      console.log(`  ${idx + 1}. [${f.source}] (${f.date}): ${f.text}`);
    });

    const scriptRes = await writer.writeSegmentBreakScript({
      targetDate: date,
      topic: packet.topic,
      topicTitle: packet.topicTitle,
      targetSongTitle: packet.targetSongTitle,
      targetSongArtist: packet.targetSongArtist,
      facts: packet.facts,
    });

    const script = scriptRes.scriptText || '(Generation failed: ' + scriptRes.error + ')';
    const words = script.split(/\s+/).filter(Boolean).length;
    const val = validateSegmentBreakOutput(script, {
      selectedDate: date,
      factPacket: packet,
    });

    console.log(`\nSpoken DJ Script (${words} words, Validation: ${val.valid ? 'PASS' : 'FAIL: ' + val.rejectedReason}):`);
    console.log(`"${script}"`);
  }
}

async function run() {
  const songs82 = [
    { id: '1982-050', title: 'Caught Up In You', artist: '38 Special', first_chart_date: '1982-05-01' },
    { id: '1982-051', title: 'Hurts So Good', artist: 'John Cougar', first_chart_date: '1982-04-24' },
    { id: '1982-052', title: 'Rosanna', artist: 'Toto', first_chart_date: '1982-04-17' },
    { id: '1982-053', title: 'Ebony And Ivory', artist: 'Paul McCartney And Stevie Wonder', first_chart_date: '1982-04-10' },
    { id: '1982-054', title: "Don't You Want Me", artist: 'The Human League', first_chart_date: '1982-03-06' },
    { id: '1982-055', title: 'Always On My Mind', artist: 'Willie Nelson', first_chart_date: '1982-03-06' },
  ];

  await previewDate('1982-05-01', songs82);

  const songs64 = [
    { id: '1964-001', title: 'Walk On By', artist: 'Dionne Warwick', first_chart_date: '1964-04-25' },
    { id: '1964-002', title: 'Love Me Do', artist: 'The Beatles', first_chart_date: '1964-04-11' },
    { id: '1964-003', title: 'My Guy', artist: 'Mary Wells', first_chart_date: '1964-04-04' },
    { id: '1964-004', title: 'Hello, Dolly!', artist: 'Louis Armstrong', first_chart_date: '1964-02-15' },
    { id: '1964-005', title: 'Twist And Shout', artist: 'The Beatles', first_chart_date: '1964-03-14' },
    { id: '1964-006', title: 'Glad All Over', artist: 'The Dave Clark Five', first_chart_date: '1964-02-15' },
  ];

  await previewDate('1964-05-01', songs64);
}

run();

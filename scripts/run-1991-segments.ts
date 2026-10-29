import { getOrBuildAlmanac } from '../src/services/news/almanacService.js';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';
import { planSegmentBreak, newSegmentPlannerState } from '../src/services/djBreak/segmentPlanner.js';
import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

async function run() {
  const date = '1991-05-11';
  console.log('================================================================================');
  console.log(`RUNNING 1991-05-11 AT --freq 1 ON 14B MODEL`);
  console.log('================================================================================');

  const almanac = await getOrBuildAlmanac(date);
  console.log(`Almanac total entries: ${almanac.totalEntries}`);
  console.log('Categories:', JSON.stringify(almanac.byCategory, null, 2));

  const homedir = process.env.HOME || '/root';
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

  const writer = new LMStudioScriptWriterProvider({
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen2.5-14b-instruct-1m',
  });

  const state = newSegmentPlannerState();

  // Top songs from library around 1991-05-11
  const songs = [
    { id: '1991-021', title: 'Rush Rush', artist: 'Paula Abdul', first_chart_date: '1991-05-11' },
    { id: '1991-008', title: 'Unbelievable', artist: 'EMF', first_chart_date: '1991-04-13' },
    { id: '1991-011', title: 'Right Here, Right Now', artist: 'Jesus Jones', first_chart_date: '1991-04-13' },
    { id: '1991-007', title: 'I Wanna Sex You Up (From "New Jack City")', artist: 'Color Me Badd', first_chart_date: '1991-04-06' },
    { id: '1991-026', title: 'Losing My Religion', artist: 'R.E.M.', first_chart_date: '1991-04-06' },
    { id: '1991-037', title: "I Don't Wanna Cry", artist: 'Mariah Carey', first_chart_date: '1991-04-06' },
  ];

  console.log('\n--- GENERATING 6 SEGMENTS (AT --freq 1) ---');

  for (let i = 0; i < 6; i++) {
    const song = songs[i];
    const card = await getOrBuildSongStoryCard(song, date, db);
    const packet = planSegmentBreak({
      broadcastDate: date,
      nextSong: song,
      songCard: card,
      almanac,
      state,
    });

    console.log(`\n================================================================================`);
    console.log(`BREAK #${i + 1}: [${packet.topic.toUpperCase()}] "${packet.topicTitle}"`);
    console.log(`Target Song: "${packet.targetSongTitle}" by ${packet.targetSongArtist}`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log('PACKET FACTS:');
    packet.facts.forEach((f, idx) => {
      console.log(`  ${idx + 1}. [${f.source}] (Event Date: ${f.date}, Print Date: ${date}):`);
      console.log(`     ${f.text}`);
    });

    const scriptRes = await writer.writeSegmentBreakScript({
      targetDate: date,
      personality: 'mike',
      topic: packet.topic,
      topicTitle: packet.topicTitle,
      targetSongTitle: packet.targetSongTitle,
      targetSongArtist: packet.targetSongArtist,
      facts: packet.facts,
    });

    const script = scriptRes.scriptText;
    const words = script ? script.split(/\s+/).filter(Boolean).length : 0;
    const val = validateSegmentBreakOutput(script, {
      selectedDate: date,
      factPacket: packet,
    });

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`SPOKEN 14B monlogue (${words} words, Validation: ${val.valid ? 'PASS' : 'FAIL: ' + val.rejectedReason}):`);
    console.log(`"${script}"`);
  }
}

run();

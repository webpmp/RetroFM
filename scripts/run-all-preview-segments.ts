import { getOrBuildAlmanac } from '../src/services/news/almanacService.js';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';
import { planSegmentBreak, newSegmentPlannerState } from '../src/services/djBreak/segmentPlanner.js';
import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { GeminiScriptWriterProvider } from '../src/services/djBreak/GeminiScriptWriterProvider.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { ChartFactRepository, computeChartFacts } from '../src/services/djBreak/chartFacts.js';
import { resolveRelativeTimeWords } from '../src/services/news/almanacService.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

function formatSpokenHeadline(headline: string): string {
  if (!headline) return '';
  const trimmed = headline.trim();
  if (trimmed.length > 4 && trimmed === trimmed.toUpperCase()) {
    return trimmed
      .toLowerCase()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return trimmed;
}

function buildNaturalExtractiveScript(packet: any, broadcastDate: string): string {
  const sentences = (packet.facts || []).map((f: any) => {
    let t = f.text.trim();
    // Natural spoken templates: "Written by X" -> "X wrote this one"
    const writtenMatch = t.match(/^Written by (.+)\.$/i);
    if (writtenMatch) {
      t = `${writtenMatch[1]} wrote this one.`;
    }
    const producedMatch = t.match(/^Produced by (.+)\.$/i);
    if (producedMatch) {
      t = `${producedMatch[1]} produced this track.`;
    }
    // Never read all-caps headlines
    t = formatSpokenHeadline(t);
    // Relative-time conversion
    const resolved = resolveRelativeTimeWords(t, f.printDate || broadcastDate);
    return resolved.text;
  });

  if (sentences.length === 0) return '';
  const body = sentences.join(' ');
  if (packet.targetSongTitle && packet.targetSongArtist) {
    return `${body} Now, here is "${packet.targetSongTitle}" by ${packet.targetSongArtist}.`;
  }
  return body;
}

function buildFallbackMusicNote(song: any, broadcastDate: string, db: any, chartRepo: ChartFactRepository): string {
  // 1. Try Billboard weekly_chart fact on or before broadcastDate
  const facts = computeChartFacts(song, broadcastDate, chartRepo);
  if (facts.length > 0) {
    return facts[0].factText;
  }

  // 2. Try verified credit from song_facts table
  const row: any = db.prepare('SELECT fact_text FROM song_facts WHERE song_id = ? AND (public_date IS NULL OR public_date <= ?) LIMIT 1').get(song.id, broadcastDate);
  if (row?.fact_text) {
    let credit = row.fact_text.trim();
    const m = credit.match(/^Written by (.+)\.$/i);
    if (m) {
      credit = `${m[1]} wrote this one.`;
    }
    return `Here is "${song.title}" by ${song.artist}. ${credit}`;
  }

  // 3. Fallback to silence
  return '';
}

async function runDate(
  date: string,
  sampleSongs: any[],
  db: any,
  writer: any,
  chartRepo: ChartFactRepository,
  providerLabel: string
) {
  console.log('================================================================================');
  console.log(`BROADCAST DATE: ${date} (${providerLabel})`);
  console.log('================================================================================');

  const almanac = await getOrBuildAlmanac(date);
  console.log(`Almanac total entries: ${almanac.totalEntries}`);
  console.log('Categories:', JSON.stringify(almanac.byCategory, null, 2));

  const state = newSegmentPlannerState();
  let unsupportedCount = 0;

  for (let i = 0; i < 6; i++) {
    const song = sampleSongs[i % sampleSongs.length];
    const card = await getOrBuildSongStoryCard(song, date, db, {
      runLLMCheck: true,
      llmEndpoint: 'http://localhost:1234/v1',
      model: 'qwen2.5-14b-instruct-1m',
    });

    const packet = planSegmentBreak({
      broadcastDate: date,
      nextSong: song,
      songCard: card,
      almanac,
      chartRepo,
      state,
    });

    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`SEGMENT #${i + 1} [${providerLabel}]`);
    console.log(`Category / Topic: [${packet.topic.toUpperCase()}] "${packet.topicTitle}"`);
    console.log(`Target Song: "${packet.targetSongTitle}" by ${packet.targetSongArtist}`);
    if (card.artistMetadata) {
      console.log(`MusicBrainz Artist Metadata: Country: ${card.artistMetadata.country || 'N/A'}, Area: ${card.artistMetadata.area || 'N/A'}, Begin: ${card.artistMetadata.beginYear || 'N/A'}, Type: ${card.artistMetadata.type || 'N/A'}`);
    }
    
    console.log(`\nPacket Facts (Single Thread):`);
    packet.facts.forEach((f, idx) => {
      console.log(`  Fact ${idx + 1}:`);
      console.log(`    Source Sentence: "${f.text}"`);
      console.log(`    Source:          ${f.source}`);
      console.log(`    Print Date:      ${f.printDate || f.date}`);
      console.log(`    Event Date:      ${f.date}`);
    });

    if (card.droppedFacts && card.droppedFacts.length > 0) {
      console.log(`Dropped Facts for Target Song (${card.droppedFacts.length}):`);
      card.droppedFacts.forEach((df) => {
        console.log(`  - [REASON: ${df.reason}] "${df.text}"`);
      });
    }

    const scriptRes = await writer.writeSegmentBreakScript({
      targetDate: date,
      personality: 'mike',
      topic: packet.topic,
      topicTitle: packet.topicTitle,
      targetSongTitle: packet.targetSongTitle,
      targetSongArtist: packet.targetSongArtist,
      facts: packet.facts,
    });

    console.log(`\n[Prompt & Raw Response Debug]`);
    console.log(scriptRes.rawResponse || 'N/A');

    console.log(`\n[Per-Sentence Claim Verification Audit]`);
    if (scriptRes.unsupportedClaims && scriptRes.unsupportedClaims.length > 0) {
      unsupportedCount += scriptRes.unsupportedClaims.length;
      scriptRes.unsupportedClaims.forEach((uc: any) => console.log(`  - ${uc}`));
    } else {
      console.log(`  All claims verified and supported by fact sheet.`);
    }

    console.log(`\n[Assembled Script Text]:`);
    console.log(`"${scriptRes.scriptText}"`);

    const val = validateSegmentBreakOutput(scriptRes.scriptText, {
      selectedDate: date,
      factPacket: packet,
    });

    console.log(`\nValidator Result: ${val.valid ? 'PASS' : 'FAIL (' + val.rejectedReason + ')'}`);

    let actualAirText = '';
    let airType = '';

    if (val.valid) {
      actualAirText = scriptRes.scriptText;
      airType = `${providerLabel} Monologue`;
    } else {
      // Fallback goes through same validator & natural templates
      if (packet.facts.length >= 2) {
        const extractive = buildNaturalExtractiveScript(packet, date);
        const extractiveVal = validateSegmentBreakOutput(extractive, {
          selectedDate: date,
          factPacket: packet,
        });
        actualAirText = extractive;
        airType = `Extractive Fallback Monologue (${extractiveVal.valid ? 'PASS' : 'Sanitized'})`;
      } else {
        const fallbackNote = buildFallbackMusicNote(song, date, db, chartRepo);
        if (fallbackNote) {
          actualAirText = fallbackNote;
          airType = 'Fallback Template Music Note';
        } else {
          actualAirText = '[SILENCE - No spoken words]';
          airType = 'Fallback Silence';
        }
      }
    }

    const words = actualAirText && actualAirText !== '[SILENCE - No spoken words]'
      ? actualAirText.split(/\s+/).filter(Boolean).length
      : 0;

    console.log(`\nActually Aired (${airType}${words > 0 ? `, ${words} words` : ''}):`);
    console.log(`"${actualAirText}"`);
  }

  console.log(`\n>>> [TOTAL UNSUPPORTED SENTENCES CAUGHT FOR ${providerLabel} ON ${date}]: ${unsupportedCount}`);
  return unsupportedCount;
}

async function run() {
  const homedir = process.env.HOME || '/root';
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));
  const chartRepo = new ChartFactRepository();

  const lmWriter = new LMStudioScriptWriterProvider({
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen2.5-14b-instruct-1m',
  });

  const geminiWriter = new GeminiScriptWriterProvider();

  const songs1991 = [
    { id: '1991-021', title: 'Rush Rush', artist: 'Paula Abdul', first_chart_date: '1991-05-11' },
    { id: '1991-008', title: 'Unbelievable', artist: 'EMF', first_chart_date: '1991-04-13' },
    { id: '1991-011', title: 'Right Here, Right Now', artist: 'Jesus Jones', first_chart_date: '1991-04-13' },
    { id: '1991-007', title: 'I Wanna Sex You Up (From "New Jack City")', artist: 'Color Me Badd', first_chart_date: '1991-04-06' },
    { id: '1991-026', title: 'Losing My Religion', artist: 'R.E.M.', first_chart_date: '1991-04-06' },
    { id: '1991-037', title: "I Don't Wanna Cry", artist: 'Mariah Carey', first_chart_date: '1991-04-06' },
  ];

  const songs1982 = [
    { id: '1982-050', title: 'Caught Up In You', artist: '38 Special', first_chart_date: '1982-05-01' },
    { id: '1982-001', title: 'Hurts So Good', artist: 'John Cougar', first_chart_date: '1982-04-24' },
    { id: '1982-009', title: 'Rosanna', artist: 'Toto', first_chart_date: '1982-04-17' },
    { id: '1982-020', title: 'Ebony And Ivory', artist: 'Paul McCartney And Stevie Wonder', first_chart_date: '1982-04-10' },
    { id: '1982-002', title: "Don't You Want Me", artist: 'The Human League', first_chart_date: '1982-03-06' },
    { id: '1982-017', title: 'Always On My Mind', artist: 'Willie Nelson', first_chart_date: '1982-03-06' },
  ];

  const songs1964 = [
    { id: '1964-036', title: 'Walk On By', artist: 'Dionne Warwick', first_chart_date: '1964-04-25' },
    { id: '1964-021', title: 'Love Me Do', artist: 'The Beatles', first_chart_date: '1964-04-11' },
    { id: '1964-005', title: 'My Guy', artist: 'Mary Wells', first_chart_date: '1964-04-04' },
    { id: '1964-001', title: 'Hello, Dolly!', artist: 'Louis Armstrong And The All Stars', first_chart_date: '1964-02-15' },
    { id: '1964-040', title: 'Twist And Shout', artist: 'The Beatles', first_chart_date: '1964-03-14' },
    { id: '1964-025', title: 'Glad All Over', artist: 'The Dave Clark Five', first_chart_date: '1964-02-15' },
  ];

  console.log('\n================================================================================');
  console.log('PART 1: LOCAL 14B MODEL (LM STUDIO)');
  console.log('================================================================================');
  let lmTotalUnsupported = 0;
  lmTotalUnsupported += await runDate('1991-05-11', songs1991, db, lmWriter, chartRepo, 'LM Studio 14B');
  lmTotalUnsupported += await runDate('1982-05-01', songs1982, db, lmWriter, chartRepo, 'LM Studio 14B');
  lmTotalUnsupported += await runDate('1964-05-01', songs1964, db, lmWriter, chartRepo, 'LM Studio 14B');

  console.log('\n================================================================================');
  console.log('PART 2: GEMINI PROVIDER (SIDE-BY-SIDE)');
  console.log('================================================================================');
  let geminiTotalUnsupported = 0;
  geminiTotalUnsupported += await runDate('1991-05-11', songs1991, db, geminiWriter, chartRepo, 'Gemini Provider');
  geminiTotalUnsupported += await runDate('1982-05-01', songs1982, db, geminiWriter, chartRepo, 'Gemini Provider');
  geminiTotalUnsupported += await runDate('1964-05-01', songs1964, db, geminiWriter, chartRepo, 'Gemini Provider');

  console.log('\n================================================================================');
  console.log(`GRAND TOTAL UNSUPPORTED SENTENCES CAUGHT:`);
  console.log(`  - Local 14B Model (LM Studio): ${lmTotalUnsupported}`);
  console.log(`  - Gemini Provider:             ${geminiTotalUnsupported}`);
  console.log('================================================================================');
}

run();

/**
 * Script to run 10 song changes at frequency "every" (1.0):
 * - 1976-06-01 (post-peak for Let Your Love Flow)
 * - 1975-06-15 (post-peak for Before The Next Teardrop Falls)
 * - 1976-04-15 (pre-peak for Let Your Love Flow)
 *
 * For each aired break:
 * Prints break id, facts, aired text, and the Prepared, Queued, Aired, Discarded lifecycle lines.
 * Verifies that:
 * 1. None of the aired texts contain a week count tied to number one.
 * 2. The April 1976 run makes no "reached number one" claim for Let Your Love Flow.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

interface SessionStats {
  prepared: number;
  queued: number;
  aired: number;
  discarded: Array<{ id: string; reason: string }>;
}

async function runSession(targetDate: string, songOffset = 0): Promise<void> {
  const homedir = os.homedir();
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

  console.log(`\n================================================================================`);
  console.log(`RUNNING 10 SONG CHANGES FOR DATE: ${targetDate} (offset: ${songOffset})`);
  console.log(`================================================================================\n`);

  const playlist = db.prepare(`
    SELECT id, title, artist, primary_artist, first_chart_date
    FROM songs
    WHERE first_chart_date <= ?
    ORDER BY first_chart_date DESC
    LIMIT 25
  `).all(targetDate) as any[];

  const usedFactKeys: string[] = [];
  const blacklistedFactKeys: string[] = [];
  let lastTopic: string | null = null;
  let breaksSinceLastRetroFm = 4;
  let breaksSinceLastNowOnRetroFm = 5;

  const stats: SessionStats = {
    prepared: 0,
    queued: 0,
    aired: 0,
    discarded: [],
  };

  for (let i = 0; i < 10; i++) {
    const prev = playlist[i + songOffset];
    const next = playlist[i + songOffset + 1];
    if (!prev || !next) break;

    const res = await fetch('http://localhost:3003/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: targetDate,
        prevSong: { title: prev.title, artist: prev.artist, id: prev.id, first_chart_date: prev.first_chart_date },
        nextSong: { title: next.title, artist: next.artist, id: next.id, first_chart_date: next.first_chart_date },
        frequencySetting: 1.0,
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        breaksSinceLastRetroFm,
        breaksSinceLastNowOnRetroFm,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1',
        model: 'qwen2.5-14b-instruct-1m',
      }),
    });

    const data: any = await res.json();
    const breakId = data.breakId;
    const finalSpeech = data.finalSpeech || '';
    const facts = data.candidate?.facts || [];

    if (data.decision === 'speak' && finalSpeech) {
      stats.prepared++;
      console.log(`[Segment Prepared] id=${breakId}`);

      // Client simulates queuing
      stats.queued++;
      console.log(`[Segment Queued] id=${breakId}`);
      await fetch('http://localhost:3003/api/dj/segment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId, event: 'queued' }),
      });

      // Simulate TTS call tracing break id
      await fetch('http://localhost:3003/api/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: finalSpeech,
          engine: 'KOKORO',
          speed: 1.15,
          breakId,
        }),
      });

      // Client simulates playback start
      stats.aired++;
      console.log(`[Segment Aired] id=${breakId}`);
      await fetch('http://localhost:3003/api/dj/segment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId, event: 'aired' }),
      });
    } else {
      // Discarded or silence
      const reason = data.decision === 'silence' ? 'all candidates failed' : 'no speech';
      stats.discarded.push({ id: breakId, reason });
      console.log(`[Segment Discarded] id=${breakId} reason="${reason}"`);
      await fetch('http://localhost:3003/api/dj/segment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId, event: 'discarded', reason }),
      });
    }

    if (data.usedKeys && Array.isArray(data.usedKeys)) {
      usedFactKeys.push(...data.usedKeys);
    }
    if (data.blacklistedKeys && Array.isArray(data.blacklistedKeys)) {
      blacklistedFactKeys.push(...data.blacklistedKeys);
    }
    if (data.breakType) {
      lastTopic = data.breakType;
    }

    // Check week count tied to number one in aired speech
    const badWeekMatch = finalSpeech.match(/(?:number one|topped|top spot|stayed at the top|staying there)[^.!?]{0,40}?\b(\d+|nineteen|twenty-one|twenty)\s+weeks?\b/i)
      || finalSpeech.match(/\b(\d+|nineteen|twenty-one|twenty)\s+weeks?[^.!?]{0,40}?(?:number one|topped|top spot|stayed at the top|staying there)\b/i);

    if (badWeekMatch) {
      console.error(`ERROR: Aired text pairs week count with number one / topped: "${badWeekMatch[0]}"`);
    }

    // Check April 1976 run makes no "reached number one" claim for Let Your Love Flow
    if (targetDate.startsWith('1976-04') && next.title.includes('Let Your Love Flow')) {
      if (/reached number one|number-one hit|topped the charts/i.test(finalSpeech)) {
        console.error(`ERROR: April 1976 run claimed "reached number one" for Let Your Love Flow! Speech: "${finalSpeech}"`);
      }
    }

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`[Song Change ${i + 1}] "${prev.title}" -> "${next.title}"`);
    console.log(`Break ID:             ${breakId}`);
    console.log(`Break Type:           ${data.breakType}`);
    console.log(`Facts Used (${facts.length}):`);
    facts.forEach((f: any, idx: number) => {
      console.log(`  [Fact ${idx + 1}] (${f.source}): ${f.text}`);
    });
    console.log(`Aired Text:`);
    console.log(`  "${finalSpeech}"`);
    console.log(`Lifecycle: Prepared -> Queued -> Aired`);
    console.log(`Week count tied to #1: ${badWeekMatch ? 'VIOLATION DETECTED' : 'NONE (CLEAN)'}`);
    console.log('');
  }

  console.log(`\n================================================================================`);
  console.log(`SESSION SUMMARY REPORT FOR ${targetDate}`);
  console.log(`================================================================================`);
  console.log(`Breaks Prepared:   ${stats.prepared}`);
  console.log(`Breaks Queued:     ${stats.queued}`);
  console.log(`Breaks Aired:      ${stats.aired}`);
  console.log(`Breaks Discarded:  ${stats.discarded.length}`);
  if (stats.discarded.length > 0) {
    stats.discarded.forEach(d => console.log(`  - id=${d.id} reason="${d.reason}"`));
  }
  console.log(`================================================================================\n`);
}

async function main() {
  // Run 1: 1976-06-01 (post-peak for Let Your Love Flow, offset 10 to include Let Your Love Flow at index 18->19)
  await runSession('1976-06-01', 10);

  // Run 2: 1975-06-15 (post-peak for Before The Next Teardrop Falls, offset 15 to include Before The Next Teardrop Falls at index 24->25)
  await runSession('1975-06-15', 15);

  // Run 3: 1976-04-15 (pre-peak for Let Your Love Flow, offset 5 to include Let Your Love Flow at index 12->13)
  await runSession('1976-04-15', 5);
}

main().catch(console.error);

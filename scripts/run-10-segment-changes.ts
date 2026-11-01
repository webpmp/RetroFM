/**
 * RetroFM 10-Song-Change Verification Runner for 1993-05-01 and 1982-05-01
 * Uses the updated Segment Break Pipeline (/api/dj/segment-break) over LM Studio qwen2.5-14b-instruct-1m.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

interface RunResult {
  date: string;
  breaks: Array<{
    songChangeIndex: number;
    prevSong: string;
    nextSong: string;
    breakType: string;
    factCount: number;
    usedChart: boolean;
    usedCredits: boolean;
    isIntro: boolean;
    spokenText: string;
    elapsedMs: number;
  }>;
  totalSongChanges: number;
  totalSpoken: number;
  totalIntros: number;
  totalUsedChart: number;
  totalUsedCredits: number;
  totalNextSongStories: number;
  totalMusicNews: number;
  totalMajorNews: number;
}

async function runDateVerification(date: string): Promise<RunResult> {
  const homedir = os.homedir();
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

  // Fetch 11 songs on or before this date to create 10 transitions
  const playlist = db.prepare(`
    SELECT id, title, artist, primary_artist, first_chart_date
    FROM songs
    WHERE first_chart_date <= ?
    ORDER BY first_chart_date DESC
    LIMIT 11
  `).all(date) as any[];

  const usedFactKeys: string[] = [];
  const blacklistedFactKeys: string[] = [];
  let lastTopic: string | null = null;

  const result: RunResult = {
    date,
    breaks: [],
    totalSongChanges: 10,
    totalSpoken: 0,
    totalIntros: 0,
    totalUsedChart: 0,
    totalUsedCredits: 0,
    totalNextSongStories: 0,
    totalMusicNews: 0,
    totalMajorNews: 0,
  };

  console.log(`================================================================================`);
  console.log(`STARTING 10-SONG-CHANGE RUN FOR ${date}`);
  console.log(`================================================================================\n`);

  for (let i = 0; i < 10; i++) {
    const prev = playlist[i];
    const next = playlist[i + 1];
    const songChangeStart = Date.now();

    const response: Response = await fetch('http://localhost:3003/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: date,
        prevSong: prev ? { title: prev.title, artist: prev.artist, id: prev.id, first_chart_date: prev.first_chart_date } : null,
        nextSong: next ? { title: next.title, artist: next.artist, id: next.id, first_chart_date: next.first_chart_date } : null,
        frequencySetting: 1.0,
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1',
        model: 'qwen2.5-14b-instruct-1m',
      }),
    });

    const readyRelSongChangeMs = Date.now() - songChangeStart;
    const data: any = await response.json();

    if (data.usedKeys && Array.isArray(data.usedKeys)) {
      usedFactKeys.push(...data.usedKeys);
    }
    if (data.blacklistedKeys && Array.isArray(data.blacklistedKeys)) {
      blacklistedFactKeys.push(...data.blacklistedKeys);
    }
    if (data.breakType) {
      lastTopic = data.breakType;
    }

    const breakType = data.breakType || 'silence';
    const factCount = data.candidate?.facts?.length || (data.usedKeys?.length || (breakType === 'plain_intro' ? 1 : 0));
    const spokenText = data.finalSpeech || '';

    // Track whether chart or credits were used
    const keysStr = JSON.stringify(data.usedKeys || []);
    const usedChart = keysStr.includes('chart:');
    const usedCredits = keysStr.includes('credit:');
    const isIntro = breakType === 'plain_intro';

    if (breakType !== 'silence') {
      result.totalSpoken++;
      if (isIntro) result.totalIntros++;
      if (usedChart) result.totalUsedChart++;
      if (usedCredits) result.totalUsedCredits++;
      if (breakType === 'next_song_story') result.totalNextSongStories++;
      if (breakType === 'music_news') result.totalMusicNews++;
      if (breakType === 'major_news') result.totalMajorNews++;
    }

    result.breaks.push({
      songChangeIndex: i + 1,
      prevSong: prev.title,
      nextSong: next.title,
      breakType,
      factCount,
      usedChart,
      usedCredits,
      isIntro,
      spokenText,
      elapsedMs: readyRelSongChangeMs,
    });

    console.log(`[Song Change ${i + 1}] "${prev.title}" -> "${next.title}"`);
    console.log(`  Break Type: ${breakType} | Facts: ${factCount} | Ready in: ${(readyRelSongChangeMs / 1000).toFixed(1)}s`);
    console.log(`  Used Chart: ${usedChart ? 'YES' : 'NO'} | Used Credits: ${usedCredits ? 'YES' : 'NO'} | Is Intro: ${isIntro ? 'YES' : 'NO'}`);
    console.log(`  Aired Text: "${spokenText}"\n`);
  }

  return result;
}

async function main() {
  const res1993 = await runDateVerification('1993-05-01');
  const res1982 = await runDateVerification('1982-05-01');

  console.log(`================================================================================`);
  console.log(`FINAL REPORT SUMMARY`);
  console.log(`================================================================================`);

  for (const r of [res1993, res1982]) {
    console.log(`\nDate: ${r.date}`);
    console.log(`  Total Song Changes:      ${r.totalSongChanges}`);
    console.log(`  Total Spoken Breaks:     ${r.totalSpoken}`);
    console.log(`  Next Song Stories:       ${r.totalNextSongStories}`);
    console.log(`  Music News:              ${r.totalMusicNews}`);
    console.log(`  Major News:              ${r.totalMajorNews}`);
    console.log(`  Plain Intros:            ${r.totalIntros}`);
    console.log(`  Breaks with Chart Fact:  ${r.totalUsedChart}`);
    console.log(`  Breaks with Credits:     ${r.totalUsedCredits}`);
    console.log(`  Fact Counts Per Break:   [${r.breaks.map(b => b.factCount).join(', ')}]`);
  }
}

main().catch(console.error);

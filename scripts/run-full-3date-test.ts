import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

interface BreakResult {
  breakIndex: number;
  prevSong: string;
  nextSong: string;
  breakType: string;
  headline?: string;
  articleDate?: string;
  spokenText: string;
  elapsedMs: number;
}

interface DateTestResult {
  date: string;
  breaks: BreakResult[];
  counts: {
    next_song_story: number;
    major_news: number;
    music_news: number;
    plain_intro: number;
    other: number;
  };
}

async function runSessionForDate(date: string): Promise<DateTestResult> {
  const homedir = os.homedir();
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

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
  let lastHandoffGroup: number | null = null;
  let recentHandoffTemplates: string[] = [];
  let breaksSinceLastRetroFm = 4;
  let breaksSinceLastMusicNews = 8;
  let lastShortCloser: string | null = null;

  const result: DateTestResult = {
    date,
    breaks: [],
    counts: {
      next_song_story: 0,
      major_news: 0,
      music_news: 0,
      plain_intro: 0,
      other: 0,
    },
  };

  console.log(`\n================================================================================`);
  console.log(`RUNNING 10-BREAK TEST FOR ${date}`);
  console.log(`================================================================================`);

  for (let i = 0; i < 10; i++) {
    const prev = playlist[i];
    const next = playlist[i + 1];
    const t0 = Date.now();

    const response = await fetch('http://localhost:3003/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: date,
        prevSong: prev ? { title: prev.title, artist: prev.artist, id: prev.id, first_chart_date: prev.first_chart_date } : null,
        nextSong: next ? { title: next.title, artist: next.artist, id: next.id, first_chart_date: next.first_chart_date } : null,
        frequencySetting: 1.0,
        frequencyPreset: 'every',
        frequencySource: 'test',
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        breaksSinceLastRetroFm,
        breaksSinceLastMusicNews,
        lastShortCloser,
        totalBreaksSession: i,
        lastHandoffGroup,
        recentHandoffTemplates,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1',
        model: 'qwen2.5-14b-instruct-1m',
      }),
    });

    const elapsedMs = Date.now() - t0;
    const data: any = await response.json();

    if (Array.isArray(data.usedKeys)) usedFactKeys.push(...data.usedKeys);
    if (Array.isArray(data.blacklistedKeys)) blacklistedFactKeys.push(...data.blacklistedKeys);
    if (data.breakType) lastTopic = data.breakType;
    if (typeof data.handoffGroup === 'number') lastHandoffGroup = data.handoffGroup;
    if (data.handoffTemplate) {
      recentHandoffTemplates.push(data.handoffTemplate);
      if (recentHandoffTemplates.length > 12) recentHandoffTemplates.shift();
    }
    if (data.shortCloser) lastShortCloser = data.shortCloser;

    if (data.finalSpeech && data.finalSpeech.toLowerCase().includes('retrofm')) {
      breaksSinceLastRetroFm = 0;
    } else {
      breaksSinceLastRetroFm++;
    }

    if (data.breakType === 'music_news') {
      breaksSinceLastMusicNews = 0;
    } else {
      breaksSinceLastMusicNews++;
    }

    const bType = data.breakType || 'silence';
    if (bType === 'next_song_story') result.counts.next_song_story++;
    else if (bType === 'major_news') result.counts.major_news++;
    else if (bType === 'music_news') result.counts.music_news++;
    else if (bType === 'plain_intro') result.counts.plain_intro++;
    else result.counts.other++;

    const pkt = data.candidate?.packet || {};
    const headline = pkt.headline || pkt.topicTitle || (data.candidate?.topicTitle || '');
    const artDate = pkt.printDate || pkt.articleDate || '';

    result.breaks.push({
      breakIndex: i + 1,
      prevSong: prev?.title || 'none',
      nextSong: next?.title || 'none',
      breakType: bType,
      headline,
      articleDate: artDate,
      spokenText: data.finalSpeech || '',
      elapsedMs,
    });

    console.log(`[Break ${i + 1}] type=${bType} (${(elapsedMs / 1000).toFixed(1)}s) headline="${headline}" artDate=${artDate}`);
    console.log(`  Spoken: "${data.finalSpeech}"\n`);
  }

  return result;
}

async function main() {
  const dates = ['1964-05-01', '1977-05-11', '1985-07-13'];
  const results: DateTestResult[] = [];

  for (const d of dates) {
    const res = await runSessionForDate(d);
    results.push(res);
  }

  console.log(`\n================================================================================`);
  console.log(`SUMMARY ACROSS ALL TEST DATES`);
  console.log(`================================================================================`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);

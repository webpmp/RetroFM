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
  timePhrase?: string;
  hook?: string;
  spokenText: string;
  hasExclamation: boolean;
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

const testDates = ['1964-05-01', '1977-05-11', '1985-07-13', '1995-05-15', '2008-10-15'];

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
        lastHandoffGroup,
        recentHandoffTemplates,
        breaksSinceLastRetroFm,
        breaksSinceLastMusicNews,
        lastShortCloser,
      }),
    });

    const elapsedMs = Date.now() - t0;
    const data = await response.json() as any;

    const breakType = data.topic || 'unknown';
    const spokenText = data.text || '';
    const headline = data.evalDiagnostics?.chosenHeadline || data.chosenHeadline || undefined;
    const articleDate = data.evalDiagnostics?.chosenArticleDate || data.chosenArticleDate || undefined;
    const timePhrase = data.evalDiagnostics?.chosenTimePhrase || data.chosenTimePhrase || undefined;
    const hook = data.evalDiagnostics?.chosenHook || data.chosenHook || undefined;
    const hasExclamation = spokenText.includes('!');

    if (breakType === 'next_song_story') result.counts.next_song_story++;
    else if (breakType === 'major_news') result.counts.major_news++;
    else if (breakType === 'music_news') result.counts.music_news++;
    else if (breakType === 'plain_intro') result.counts.plain_intro++;
    else result.counts.other++;

    if (data.consumedFactKeys && Array.isArray(data.consumedFactKeys)) {
      usedFactKeys.push(...data.consumedFactKeys);
    }
    lastTopic = breakType;
    if (data.handoffGroup !== undefined) lastHandoffGroup = data.handoffGroup;
    if (data.handoffTemplate) {
      recentHandoffTemplates.push(data.handoffTemplate);
      if (recentHandoffTemplates.length > 5) recentHandoffTemplates.shift();
    }
    if (breakType === 'music_news') breaksSinceLastMusicNews = 0;
    else breaksSinceLastMusicNews++;
    breaksSinceLastRetroFm++;

    const bRes: BreakResult = {
      breakIndex: i + 1,
      prevSong: prev ? `${prev.artist} - ${prev.title}` : 'None',
      nextSong: next ? `${next.artist} - ${next.title}` : 'None',
      breakType,
      headline,
      articleDate,
      timePhrase,
      hook,
      spokenText,
      hasExclamation,
      elapsedMs,
    };
    result.breaks.push(bRes);

    console.log(`[Break ${i + 1}/10] Type: ${breakType} (${elapsedMs}ms)${hasExclamation ? ' [!] EXCLAMATION FOUND' : ''}`);
    if (headline) console.log(`   Headline: "${headline}"`);
    console.log(`   Spoken: "${spokenText}"`);
  }

  return result;
}

async function run() {
  const allResults: DateTestResult[] = [];
  for (const date of testDates) {
    const res = await runSessionForDate(date);
    allResults.push(res);
  }

  console.log(`\n\n================================================================================`);
  console.log(`FINAL 5-DATE SUMMARY RESULTS`);
  console.log(`================================================================================`);

  let totalExclamations = 0;

  for (const r of allResults) {
    console.log(`\nDate: ${r.date}`);
    console.log(`  next_song_story: ${r.counts.next_song_story}`);
    console.log(`  major_news:      ${r.counts.major_news}`);
    console.log(`  music_news:      ${r.counts.music_news}`);
    console.log(`  plain_intro:     ${r.counts.plain_intro}`);
    console.log(`  other:           ${r.counts.other}`);

    const dateExclamations = r.breaks.filter(b => b.hasExclamation).length;
    totalExclamations += dateExclamations;
    console.log(`  Exclamation count: ${dateExclamations}`);

    const newsBreaks = r.breaks.filter(b => b.breakType === 'major_news' || b.breakType === 'music_news');
    console.log(`  Aired news items (${newsBreaks.length}):`);
    for (const nb of newsBreaks) {
      console.log(`    - [${nb.breakType}] "${nb.headline || 'Unknown'}" | Spoken: "${nb.spokenText}"`);
    }
  }

  console.log(`\nTOTAL EXCLAMATION MARKS ACROSS ALL 50 BREAKS: ${totalExclamations}`);
}

run().catch(console.error);

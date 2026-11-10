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
  section?: string;
  rawPrintPage?: string;
  rawPrintSection?: string;
  rawDesk?: string;
  materialType?: string;
  isFrontPage?: boolean;
  timePhrase?: string;
  leadIn?: string;
  spokenText: string;
  wordCount: number;
  rawExclamations: number;
  spokenExclamations: number;
  elapsedMs: number;
  fellThroughReasons: string[];
  checks: {
    c1: boolean;
    c2: boolean;
    c3: boolean;
    c4: boolean;
    c5: boolean;
    c6: boolean;
    c7: boolean;
    c8: boolean;
    c9: boolean;
  };
  checkFailures: string[];
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

const testDates = [
  '1985-07-13',
  '1964-05-01',
];

const BANNED_HEADLINES = [
  'music: works by serly',
  'a composer who made her timely choice',
  '2 new works played in a concert',
  'pro musica gives elizabethan bill',
  'topics',
  'music in our time winds up season',
  'cabaret: wallowitch and ross',
  'preventing economic chaos',
  'the sound of folk music',
  'the. sound of folk music',
];

const TIME_PUB_PATTERNS = [
  /today['’]s times/i,
  /yesterday['’]s times/i,
  /front pages? of (?:the )?times/i,
  /front pages? of today['’]s times/i,
  /in the news/i,
  /in the headlines/i,
  /last week in the times/i,
  /a couple of days ago in the times/i,
  /last week, the times reported/i,
  /a couple of days ago, the times reported/i,
  /the times reported/i,
  /according to (?:the |today['’]s )?times/i,
  /from today['’]s times/i,
  /from yesterday['’]s times/i,
];

function stripStationIdPrefix(spoken: string): string {
  return spoken.replace(/^(?:(?:It['’]s [^.]+ on RetroFM\.)|(?:You['’]re listening to RetroFM\.)|(?:RetroFM\.))\s*/i, '');
}

function extractLeadIn(spoken: string, openerUsed?: string): string {
  if (openerUsed && openerUsed !== 'None') return openerUsed;
  const stripped = stripStationIdPrefix(spoken);
  const m = stripped.match(/^(?:On the front page of today's Times,|In today's Times,|In yesterday's Times,|A couple of days ago in The Times,|Last week in The Times,|From today's Times,|From the front pages of The Times,|In the news,|In the headlines,)/i);
  return m ? m[0] : '';
}

function splitProtectedSentences(text: string): string[] {
  let s = text;
  s = s.replace(/\bU\.S\.(A\.)?/g, (m) => m.replace(/\./g, '§D§'));
  s = s.replace(/\b(Col|Gen|Sen|Rep|Gov|Dr|Mr|Mrs|Ms|St|Jr|Sr|Lt|Capt|Prof|Rev|No|Nos|Vol|Op|Inc|Corp|Co|Mt|Ft)\./gi, '$1§D§');
  s = s.replace(/\b([A-Z])\./g, '$1§D§');
  s = s.replace(/\b(\d+)\.(?=\s)/g, '$1§D§');
  const raw = s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  return raw.map((p) => p.replace(/§D§/g, '.').trim()).filter(Boolean);
}

function computeChecksForBreak(
  b: {
    breakType: string;
    spokenText: string;
    headline?: string;
    articleDate?: string;
    broadcastDate: string;
    rawPrintPage?: string;
    rawPrintSection?: string;
    isFrontPage?: boolean;
    previousBreakType?: string;
    runningNewsCount: number;
    runningTotalBreaks: number;
    openerUsed?: string;
  }
): { checks: BreakResult['checks']; checkFailures: string[] } {
  const isNews = b.breakType === 'major_news' || b.breakType === 'music_news';
  const spoken = b.spokenText.trim();
  const words = spoken.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const failures: string[] = [];
  const checks = {
    c1: true,
    c2: true,
    c3: true,
    c4: true,
    c5: true,
    c6: true,
    c7: true,
    c8: true,
    c9: true,
  };

  if (!isNews) {
    return { checks, checkFailures: [] };
  }

  // C1: Exactly one time/publication phrase in the whole script
  const COMBINED_TIME_PUB_PATTERN = /(?:front pages? of (?:today['’]s )?times|today['’]s times|yesterday['’]s times|in the news|in the headlines|last week, the times reported|last week in the times|a couple of days ago, the times reported|a couple of days ago in the times|the times reported|according to (?:the |today['’]s )?times|from today['’]s times|from yesterday['’]s times)/gi;
  const pubMatches = spoken.match(COMBINED_TIME_PUB_PATTERN) || [];
  const pubPhraseMatches = pubMatches.length;
  if (pubPhraseMatches !== 1) {
    checks.c1 = false;
    failures.push(`C1 FAIL: Found ${pubPhraseMatches} time/publication phrase(s) in script (expected exactly 1) [matches: ${JSON.stringify(pubMatches)}]`);
  }

  // C2: The lead-in matches the article's age
  if (b.articleDate) {
    const bD = new Date(b.broadcastDate + 'T00:00:00Z');
    const aD = new Date(b.articleDate + 'T00:00:00Z');
    const diffDays = Math.round((bD.getTime() - aD.getTime()) / (1000 * 60 * 60 * 24));
    const leadIn = extractLeadIn(spoken, b.openerUsed).toLowerCase();

    let expectedLeadIn = '';
    if (diffDays <= 0) {
      expectedLeadIn = b.isFrontPage ? "on the front page of today's times," : "in today's times,";
    } else if (diffDays === 1) {
      expectedLeadIn = "in yesterday's times,";
    } else if (diffDays <= 3) {
      expectedLeadIn = "a couple of days ago in the times,";
    } else {
      expectedLeadIn = "last week in the times,";
    }

    if (!leadIn.startsWith(expectedLeadIn.slice(0, 15))) {
      checks.c2 = false;
      failures.push(`C2 FAIL: Lead-in "${leadIn}" does not match age diffDays=${diffDays} expected="${expectedLeadIn}"`);
    }
  }

  // C3: No relative-day words in the body
  if (b.articleDate && b.articleDate !== b.broadcastDate) {
    const stripped = stripStationIdPrefix(spoken);
    const lead = extractLeadIn(spoken, b.openerUsed);
    const body = lead && stripped.startsWith(lead) ? stripped.slice(lead.length).trim() : stripped;
    const REL_DAY_WORDS = /\b(?:tomorrow|tonight|today|yesterday|this\s+week|next\s+week|last\s+week|this\s+weekend|this\s+morning|this\s+afternoon|this\s+evening|last\s+night|later\s+today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
    const matchRel = body.match(REL_DAY_WORDS);
    if (matchRel) {
      checks.c3 = false;
      failures.push(`C3 FAIL: Found relative-day word "${matchRel[0]}" in body when article date (${b.articleDate}) != broadcast date (${b.broadcastDate})`);
    }
  }

  // C4: Body of at least 30 words and 2 complete sentences
  const strippedForBody = stripStationIdPrefix(spoken);
  const leadForBody = extractLeadIn(spoken, b.openerUsed);
  const bodyForSentences = leadForBody && strippedForBody.startsWith(leadForBody) ? strippedForBody.slice(leadForBody.length).trim() : strippedForBody;
  const sentences = splitProtectedSentences(bodyForSentences).filter(s => s.trim().length > 10);
  if (wordCount < 30 || sentences.length < 2) {
    checks.c4 = false;
    failures.push(`C4 FAIL: Script has ${wordCount} words and ${sentences.length} sentence(s) (expected >= 30 words and >= 2 sentences)`);
  }

  // C5: No sentence ends on an abbreviation fragment
  const rawSentences = splitProtectedSentences(spoken);
  for (const s of rawSentences) {
    const sw = s.trim().split(/\s+/).filter(Boolean);
    const lastWord = sw[sw.length - 1] || '';
    if (/\b(?:No|Nos|Vol|Op|Mr|Mrs|Ms|Dr|Jr|Sr|St|Lt|Capt|Prof|Rev|Gov|Col|Gen|Sen|Rep|U\.S|Inc|Corp|Co)\.?$/i.test(lastWord)) {
      checks.c5 = false;
      failures.push(`C5 FAIL: Sentence ends on abbreviation fragment "${lastWord}": "${s}"`);
      break;
    }
  }

  // C6: No headline from banned list
  if (b.headline) {
    const hLower = b.headline.toLowerCase().trim();
    for (const bh of BANNED_HEADLINES) {
      if (hLower.includes(bh) || hLower === bh) {
        checks.c6 = false;
        failures.push(`C6 FAIL: Headline matches banned list: "${b.headline}"`);
        break;
      }
    }
  }

  // C7: Never two news breaks in a row
  if (b.previousBreakType === 'major_news' || b.previousBreakType === 'music_news') {
    checks.c7 = false;
    failures.push(`C7 FAIL: Two news breaks in a row (previous was ${b.previousBreakType})`);
  }

  // C8: "Front page" lead-in only if raw print_page == 1 AND section is A or 1
  const strippedLeadInCheck = stripStationIdPrefix(spoken);
  const hasFrontPageLeadIn = /front page/i.test(strippedLeadInCheck.slice(0, 45));
  if (hasFrontPageLeadIn) {
    const isEarly = parseInt(b.broadcastDate.slice(0, 4), 10) < 1980;
    const page1 = b.rawPrintPage === '1' || b.rawPrintPage === '01' || b.rawPrintPage === 'A1';
    const secValid = b.rawPrintSection === 'A' || b.rawPrintSection === '1' || (isEarly && (!b.rawPrintSection || b.rawPrintSection === ''));
    if (!page1 || !secValid) {
      checks.c8 = false;
      failures.push(`C8 FAIL: "Front page" lead-in used when raw print_page="${b.rawPrintPage}" section="${b.rawPrintSection}"`);
    }
  }

  // C9: First sentence not echoing headline (Fix 8e / 11b)
  if (b.headline && sentences.length > 0) {
    const normH = b.headline.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normS0 = (sentences[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normH.length > 10 && (normS0 === normH || (normH.length > 20 && normS0.includes(normH)))) {
      checks.c9 = false;
      failures.push(`C9 FAIL: First sentence echoes headline nearly verbatim: "${sentences[0]}" vs "${b.headline}"`);
    } else {
      const hlWords = b.headline.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const fsWords = (sentences[0] || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      const fsStr = fsWords.join(' ');

      for (let i = 0; i <= hlWords.length - 5; i++) {
        const fiveWords = hlWords.slice(i, i + 5).join(' ');
        if (fsStr.includes(fiveWords)) {
          checks.c9 = false;
          failures.push(`C9 FAIL: First sentence reuses 5+ consecutive words from headline ("${fiveWords}")`);
          break;
        }
      }

      const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'as', 'it', 'its']);
      const contentHlWords = hlWords.filter((w) => !STOPWORDS.has(w) && w.length > 2);
      if (checks.c9 && contentHlWords.length >= 3) {
        const matchedWords = contentHlWords.filter((w) => fsWords.includes(w));
        const ratio = matchedWords.length / contentHlWords.length;
        if (ratio >= 0.60) {
          checks.c9 = false;
          failures.push(`C9 FAIL: First sentence echoes headline content words (${matchedWords.length}/${contentHlWords.length} words: "${matchedWords.join(' ')}")`);
        }
      }
    }
  }

  return { checks, checkFailures: failures };
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
  let breaksSinceLastRetroFm = 0;
  let breaksSinceLastMusicNews = 8;
  let lastShortCloser: string | null = null;
  let totalBreaksSession = 0;

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
  console.log(`RUNNING 10-BREAK TEST FOR ${date} (LM Studio: qwen2.5-14b-instruct-1m)`);
  console.log(`================================================================================`);

  let previousBreakType: string | undefined = undefined;
  let runningNewsCount = 0;

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
        provider: 'lmstudio',
        model: 'qwen2.5-14b-instruct-1m',
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        lastHandoffGroup,
        recentHandoffTemplates,
        breaksSinceLastRetroFm,
        breaksSinceLastMusicNews,
        lastShortCloser,
        totalBreaksSession,
      }),
    });

    const elapsedMs = Date.now() - t0;
    const data = await response.json() as any;

    const breakType = data.breakType || data.topic || 'unknown';
    const spokenText = data.finalSpeech || data.text || '';
    const headline = data.candidate?.topicTitle || data.candidate?.headline || undefined;
    const articleDate = data.candidate?.printDate || data.candidate?.facts?.[0]?.printDate || data.candidate?.facts?.[0]?.date || undefined;
    const section = data.candidate?.section || data.candidate?.packet?.section || undefined;
    const rawPrintPage = data.candidate?.printPage || data.candidate?.packet?.printPage || undefined;
    const rawPrintSection = data.candidate?.printSection || data.candidate?.packet?.printSection || undefined;
    const rawDesk = data.candidate?.newsDesk || data.candidate?.packet?.newsDesk || undefined;
    const materialType = data.candidate?.typeOfMaterial || data.candidate?.packet?.typeOfMaterial || undefined;
    const isFrontPage = data.candidate?.isFrontPage !== undefined ? data.candidate?.isFrontPage : (data.candidate?.packet?.isFrontPage !== undefined ? data.candidate?.packet?.isFrontPage : undefined);
    const timePhrase = data.candidate?.timePhrase || data.candidate?.packet?.timePhrase || undefined;
    const openerUsed = data.openerUsed || undefined;
    const fellThroughReasons = data.evalSummary?.fellThroughReasons || [];

    const rawModelDraft = data.evalSummary?.newsDraftAttempts?.[0]?.rawDraft || '';
    const rawExclamations = (rawModelDraft || '').split('!').length - 1;
    const spokenExclamations = (spokenText || '').split('!').length - 1;
    const words = spokenText.split(/\s+/).filter(Boolean);
    const leadIn = extractLeadIn(spokenText, openerUsed);

    if (breakType === 'next_song_story') result.counts.next_song_story++;
    else if (breakType === 'major_news') { result.counts.major_news++; runningNewsCount++; }
    else if (breakType === 'music_news') { result.counts.music_news++; runningNewsCount++; }
    else if (breakType === 'plain_intro') result.counts.plain_intro++;
    else result.counts.other++;

    if (data.usedKeys && Array.isArray(data.usedKeys)) {
      usedFactKeys.push(...data.usedKeys);
    }
    if (data.blacklistedKeys && Array.isArray(data.blacklistedKeys)) {
      blacklistedFactKeys.push(...data.blacklistedKeys);
    }
    lastTopic = breakType;
    if (data.handoffGroup !== undefined) lastHandoffGroup = data.handoffGroup;
    if (data.handoffTemplate) {
      recentHandoffTemplates.push(data.handoffTemplate);
      if (recentHandoffTemplates.length > 5) recentHandoffTemplates.shift();
    }
    if (breakType === 'music_news') breaksSinceLastMusicNews = 0;
    else breaksSinceLastMusicNews++;
    if (typeof data.breaksSinceLastRetroFm === 'number') {
      breaksSinceLastRetroFm = data.breaksSinceLastRetroFm;
    } else {
      breaksSinceLastRetroFm = /RetroFM/i.test(spokenText) ? 0 : breaksSinceLastRetroFm + 1;
    }
    totalBreaksSession++;

    const checkEval = computeChecksForBreak({
      breakType,
      spokenText,
      headline,
      articleDate,
      broadcastDate: date,
      rawPrintPage,
      rawPrintSection,
      isFrontPage,
      previousBreakType,
      runningNewsCount,
      runningTotalBreaks: i + 1,
      openerUsed,
    });

    previousBreakType = breakType;

    const bRes: BreakResult = {
      breakIndex: i + 1,
      prevSong: prev ? `${prev.artist} - ${prev.title}` : 'None',
      nextSong: next ? `${next.artist} - ${next.title}` : 'None',
      breakType,
      headline,
      articleDate,
      section,
      rawPrintPage,
      rawPrintSection,
      rawDesk,
      materialType,
      isFrontPage,
      timePhrase,
      leadIn,
      spokenText,
      wordCount: words.length,
      rawExclamations,
      spokenExclamations,
      elapsedMs,
      fellThroughReasons,
      checks: checkEval.checks,
      checkFailures: checkEval.checkFailures,
    };
    result.breaks.push(bRes);

    const checkStatus = checkEval.checkFailures.length === 0 ? 'ALL CHECKS PASS' : `FAIL: [${checkFailuresFormatted(checkEval.checkFailures)}]`;
    console.log(`[Break ${i + 1}/10] Type: ${breakType} (${elapsedMs}ms) - ${checkStatus}`);
    if (headline) console.log(`   Headline: "${headline}" [date: ${articleDate || 'n/a'}, page: ${rawPrintPage || 'n/a'}, sec: ${rawPrintSection || 'n/a'}, desk: ${rawDesk || 'n/a'}, mat: ${materialType || 'n/a'}]`);
    console.log(`   LeadIn: "${leadIn || 'none'}"`);
    console.log(`   Spoken: "${spokenText}"`);
    if (spokenExclamations > 0) console.log(`   [!] Warning: ${spokenExclamations} exclamation(s) in spoken text!`);
  }

  return result;
}

function checkFailuresFormatted(failures: string[]): string {
  return failures.join('; ');
}

async function run() {
  const allResults: DateTestResult[] = [];
  for (const date of testDates) {
    const res = await runSessionForDate(date);
    allResults.push(res);
  }

  console.log(`\n\n================================================================================`);
  console.log(`FINAL 2-DATE SUMMARY RESULTS & AUTOMATED CHECK AUDIT (10d)`);
  console.log(`================================================================================`);

  let totalRawExclamations = 0;
  let totalSpokenExclamations = 0;
  let totalElapsed = 0;
  let totalBreaks = 0;
  const allRejectionReasons: Record<string, number> = {};

  for (const r of allResults) {
    const totalNews = r.counts.major_news + r.counts.music_news;
    const newsShare = (totalNews / 10) * 100;
    const sharePass = totalNews <= 4;

    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`Date: ${r.date} | Total News: ${totalNews}/10 (${newsShare}%) [C7 Date Share ${sharePass ? 'PASS' : 'FAIL'}]`);
    console.log(`  next_song_story: ${r.counts.next_song_story}`);
    console.log(`  major_news:      ${r.counts.major_news}`);
    console.log(`  music_news:      ${r.counts.music_news}`);
    console.log(`  plain_intro:     ${r.counts.plain_intro}`);
    console.log(`  other:           ${r.counts.other}`);

    console.log(`\n  Per-break table:`);
    console.log(`  #  | Type             | Lead-In                        | Words | Checks C1-C9`);
    console.log(`  ---+------------------+--------------------------------+-------+-------------`);
    for (const b of r.breaks) {
      totalBreaks++;
      totalElapsed += b.elapsedMs;
      totalRawExclamations += b.rawExclamations;
      totalSpokenExclamations += b.spokenExclamations;
      for (const reason of b.fellThroughReasons) {
        const key = reason.replace(/almanac:[^)]+/g, 'almanac:...').trim();
        allRejectionReasons[key] = (allRejectionReasons[key] || 0) + 1;
      }
      const cList = [
        b.checks.c1 ? 'C1:P' : 'C1:F',
        b.checks.c2 ? 'C2:P' : 'C2:F',
        b.checks.c3 ? 'C3:P' : 'C3:F',
        b.checks.c4 ? 'C4:P' : 'C4:F',
        b.checks.c5 ? 'C5:P' : 'C5:F',
        b.checks.c6 ? 'C6:P' : 'C6:F',
        b.checks.c7 ? 'C7:P' : 'C7:F',
        b.checks.c8 ? 'C8:P' : 'C8:F',
        b.checks.c9 ? 'C9:P' : 'C9:F',
      ].join(' ');
      const leadPad = (b.leadIn || '-').padEnd(30).slice(0, 30);
      const typePad = b.breakType.padEnd(16).slice(0, 16);
      console.log(`  ${String(b.breakIndex).padStart(2)} | ${typePad} | ${leadPad} | ${String(b.wordCount).padStart(5)} | ${cList}`);
    }

    const failedBreaks = r.breaks.filter(b => b.checkFailures.length > 0);
    const minNewsFailed = totalNews < 2;
    const maxPlainIntroFailed = (r.counts.plain_intro / 10) > 0.20;

    console.log(`\n  Per-break table (with full spoken text and archive metadata):`);
    for (const b of r.breaks) {
      const isNews = b.breakType === 'major_news' || b.breakType === 'music_news';
      const cList = [
        b.checks.c1 ? 'C1:P' : 'C1:F',
        b.checks.c2 ? 'C2:P' : 'C2:F',
        b.checks.c3 ? 'C3:P' : 'C3:F',
        b.checks.c4 ? 'C4:P' : 'C4:F',
        b.checks.c5 ? 'C5:P' : 'C5:F',
        b.checks.c6 ? 'C6:P' : 'C6:F',
        b.checks.c7 ? 'C7:P' : 'C7:F',
        b.checks.c8 ? 'C8:P' : 'C8:F',
        b.checks.c9 ? 'C9:P' : 'C9:F',
      ].join(' ');

      console.log(`  --------------------------------------------------------------------------------`);
      console.log(`  Break #${b.breakIndex} | Type: ${b.breakType} | Words: ${b.wordCount} | Checks: ${cList}`);
      if (isNews) {
        console.log(`    Article: "${b.headline || 'Unknown'}" (pubDate: ${b.articleDate || 'Unknown'})`);
        console.log(`    Raw Archive Fields: print_page="${b.rawPrintPage || ''}", print_section="${b.rawPrintSection || ''}", desk="${b.rawDesk || ''}", material="${b.materialType || ''}", isFrontPage=${Boolean(b.isFrontPage)}`);
        console.log(`    Lead-In: "${b.leadIn || extractLeadIn(b.spokenText, b.leadIn)}"`);
      } else {
        console.log(`    Lead-In: "${b.leadIn || 'none'}"`);
      }
      console.log(`    Spoken Text: "${b.spokenText}"`);
      if (b.checkFailures.length > 0) {
        console.log(`    CHECK FAILURES: ${b.checkFailures.join(' | ')}`);
      }
    }

    if (minNewsFailed) {
      console.log(`\n  [FAIL] 9a Gate Failed: Date ${r.date} aired only ${totalNews} news breaks in 10 (minimum required: 2)`);
    }
    if (maxPlainIntroFailed) {
      console.log(`\n  [FAIL] 9a Gate Failed: Date ${r.date} aired ${r.counts.plain_intro} plain_intro breaks in 10 (maximum allowed: 20%, i.e. 2 breaks)`);
    }
    if (failedBreaks.length > 0) {
      console.log(`\n  [FAIL] Checks C1-C9 Failed on ${r.date} for ${failedBreaks.length} break(s).`);
    } else if (!minNewsFailed && !maxPlainIntroFailed) {
      console.log(`\n  [PASS] ALL GATES & CHECKS C1-C9 PASSED ON ${r.date}!`);
    }
  }

  console.log(`\n================================================================================`);
  console.log(`OVERALL STATS`);
  console.log(`Total breaks: ${totalBreaks}`);
  console.log(`Average prep time: ${Math.round(totalElapsed / totalBreaks)}ms`);
  console.log(`Raw model drafts exclamation marks: ${totalRawExclamations}`);
  console.log(`Final spoken text exclamation marks: ${totalSpokenExclamations}`);
  console.log(`\nGrouped Rejection Reasons:`);
  for (const [reason, count] of Object.entries(allRejectionReasons)) {
    console.log(`  - [${count}] ${reason}`);
  }
}

run().catch(console.error);

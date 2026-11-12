import fs from 'fs';
import path from 'path';
import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService.js';
import { ChartFactRepository, computeNationalNumberOneFact } from '../src/services/djBreak/chartFacts.js';
import { lintReadAloudScript } from '../src/services/djBreak/breakValidator.js';

const chartRepo = new ChartFactRepository();

const YEAR_FALLBACK_SONGS: Record<number, { title: string; artist: string; firstChartDate: string }> = {
  1962: { title: 'Sherry', artist: 'The Four Seasons', firstChartDate: '1962-08-25' },
  1963: { title: 'Be My Baby', artist: 'The Ronettes', firstChartDate: '1963-08-31' },
  1964: { title: 'Where Did Our Love Go', artist: 'The Supremes', firstChartDate: '1964-07-11' },
  1965: { title: 'My Girl', artist: 'The Temptations', firstChartDate: '1965-01-16' },
  1967: { title: 'Respect', artist: 'Aretha Franklin', firstChartDate: '1967-04-29' },
  1968: { title: 'Mrs. Robinson', artist: 'Simon & Garfunkel', firstChartDate: '1968-04-20' },
  1969: { title: 'Honky Tonk Women', artist: 'The Rolling Stones', firstChartDate: '1969-07-19' },
  1970: { title: 'American Woman', artist: 'The Guess Who', firstChartDate: '1970-03-21' },
  1971: { title: 'Joy to the World', artist: 'Three Dog Night', firstChartDate: '1971-03-13' },
  1972: { title: 'Lean on Me', artist: 'Bill Withers', firstChartDate: '1972-04-22' },
  1973: { title: 'Keep On Truckin\'', artist: 'Eddie Kendricks', firstChartDate: '1973-08-25' },
  1974: { title: 'Feel Like Makin\' Love', artist: 'Roberta Flack', firstChartDate: '1974-06-22' },
  1975: { title: 'He Don\'t Love You (Like I Love You)', artist: 'Tony Orlando and Dawn', firstChartDate: '1975-03-22' },
  1976: { title: 'Afternoon Delight', artist: 'Starland Vocal Band', firstChartDate: '1976-05-15' },
  1977: { title: 'Best of My Love', artist: 'The Emotions', firstChartDate: '1977-06-18' },
  1978: { title: 'MacArthur Park', artist: 'Donna Summer', firstChartDate: '1978-09-16' },
  1979: { title: 'What a Fool Believes', artist: 'The Doobie Brothers', firstChartDate: '1979-02-03' },
  1980: { title: 'Call Me', artist: 'Blondie', firstChartDate: '1980-03-01' },
  1981: { title: 'Rapture', artist: 'Blondie', firstChartDate: '1981-01-31' },
  1982: { title: 'Ebony and Ivory', artist: 'Paul McCartney and Stevie Wonder', firstChartDate: '1982-04-10' },
  1984: { title: 'Caribbean Queen', artist: 'Billy Ocean', firstChartDate: '1984-08-25' },
  1985: { title: 'A View to a Kill', artist: 'Duran Duran', firstChartDate: '1985-05-18' },
  1986: { title: 'That\'s What Friends Are For', artist: 'Dionne and Friends', firstChartDate: '1985-11-16' },
  1988: { title: 'The Flame', artist: 'Cheap Trick', firstChartDate: '1988-04-23' },
  1989: { title: 'Listen to Your Heart', artist: 'Roxette', firstChartDate: '1989-09-02' },
  1990: { title: 'Opposites Attract', artist: 'Paula Abdul', firstChartDate: '1989-12-16' },
  1991: { title: 'Black or White', artist: 'Michael Jackson', firstChartDate: '1991-11-23' },
  1993: { title: 'I Will Always Love You', artist: 'Whitney Houston', firstChartDate: '1992-11-14' },
  1994: { title: 'I Swear', artist: 'All-4-One', firstChartDate: '1994-04-23' },
  1995: { title: 'This Is How We Do It', artist: 'Montell Jordan', firstChartDate: '1995-02-25' },
};

export function selectEraSongForDate(broadcastDate: string) {
  const no1 = computeNationalNumberOneFact(broadcastDate, chartRepo);
  if (no1 && no1.title && no1.artist) {
    return {
      id: `song-${broadcastDate}-${no1.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      title: no1.title,
      artist: no1.artist,
      primary_artist: no1.artist,
      first_chart_date: no1.date || broadcastDate,
    };
  }
  const year = parseInt(broadcastDate.slice(0, 4), 10);
  const fallback = YEAR_FALLBACK_SONGS[year] || {
    title: 'Good Vibrations',
    artist: 'The Beach Boys',
    firstChartDate: `${year}-01-01`,
  };
  return {
    id: `song-${year}-${fallback.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    title: fallback.title,
    artist: fallback.artist,
    primary_artist: fallback.artist,
    first_chart_date: fallback.firstChartDate,
  };
}

// All Round 3-5 dates + Round 6 Item 1/2/3/4/5/6 dates
const VERIFICATION_DATES = [
  // Item 1 bad-script dates
  '1962-10-23',
  '1968-06-06',
  '1970-05-05',
  '1975-04-30',
  '1988-07-04',
  // Item 2 & 6 dates
  '1965-02-22',
  '1976-07-05',
  '1980-11-05',
  // Item 4 dates
  '1971-06-13',
  '1971-06-14',
  '1993-02-27',
  // Other Round 3-5 dates
  '1963-08-29',
  '1963-11-22',
  '1967-06-06',
  '1968-04-04',
  '1969-07-21',
  '1969-08-15',
  '1971-05-01',
  '1972-06-17',
  '1973-10-20',
  '1974-08-09',
  '1976-03-10',
  '1977-08-17',
  '1979-03-30',
  '1979-11-05',
  '1980-05-18',
  '1981-03-30',
  '1985-07-13',
  '1986-01-29',
  '1989-11-09',
  '1991-12-26',
  '1995-04-19',
];

async function main() {
  const lines: string[] = [];
  const log = (s = '') => {
    console.log(s);
    lines.push(s);
  };

  log('================================================================================');
  log(`ROUND 6 VERIFICATION RUN (Generated ${new Date().toISOString()})`);
  log('================================================================================');

  interface DateSummaryRow {
    date: string;
    rankAired: number | string;
    attempts: number;
    finalPath: string;
    lintPass: boolean;
    songUsed: string;
    headline: string;
    rejectionReasons: string[];
  }
  const summaryRows: DateSummaryRow[] = [];

  for (const date of VERIFICATION_DATES) {
    log(`\n--------------------------------------------------------------------------------`);
    log(`DATE: ${date}`);
    log(`--------------------------------------------------------------------------------`);

    const prom = await getProminentStoryPackets(date);
    log(`Top 10 Ranked Clusters for ${date}:`);
    prom.allRankedStories.slice(0, 10).forEach((st, i) => {
      const minDate = st.dates[0] || '';
      const maxDate = st.dates[st.dates.length - 1] || '';
      const dateSpan = minDate === maxDate ? minDate : `${minDate}..${maxDate}`;
      log(
        `  #${i + 1} [Score ${st.prominenceScore}] "${st.topicTitle}" (articles: ${st.articles.length}, fp: ${st.frontPageCount}, dates: ${dateSpan})`
      );
    });

    const nextSong = selectEraSongForDate(date);
    log(`Next Song Selected (Era-Matched): "${nextSong.title}" by ${nextSong.artist} (${nextSong.first_chart_date})`);

    const apiBase = process.env.API_BASE_URL || (fs.existsSync('/.dockerenv') ? 'http://localhost:3000' : 'http://localhost:3003');
    const res = await fetch(`${apiBase}/api/dj/segment-break`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: date,
        prevSong: null,
        nextSong,
        frequencySetting: 1.0,
        usedFactKeys: [],
        blacklistedFactKeys: [],
        lastTopic: 'next_song_story',
        breaksSinceLastRetroFm: 1,
        breaksSinceLastMusicNews: 8,
        totalBreaksSession: 1,
        provider: 'lmstudio',
      }),
    });

    const data: any = await res.json();
    const evals: any[] = data?.evalSummary?.candidateEvaluations || [];
    log(`Candidate Evaluations (No Silent Skipping):`);
    let airedEval: any = null;
    for (const ev of evals) {
      if (ev.outcome === 'not_reached') continue;
      if (ev.outcome === 'aired') airedEval = ev;
      const reasonsStr = (ev.rejectionReasons || []).length > 0 ? ` | reasons: ${ev.rejectionReasons.join(' ;; ')}` : '';
      const pathStr = ev.finalPath ? ` | path=${ev.finalPath}` : '';
      log(
        `  - Rank #${ev.rank} [${ev.outcome.toUpperCase()}] (attempts=${ev.attempts}${pathStr}) [Score ${ev.prominenceScore}, pubDate=${ev.leadPubDate}] "${ev.headline}"${reasonsStr}`
      );
    }

    const finalSpeech = data?.finalSpeech || '';
    const lintCheck = lintReadAloudScript(finalSpeech);
    log(`Break Type: ${data?.breakType} | Lint Pass: ${lintCheck.valid}${lintCheck.rejectedReason ? ` (${lintCheck.rejectedReason})` : ''}`);
    log(`Full Aired Script:\n  "${finalSpeech}"`);

    summaryRows.push({
      date,
      rankAired: airedEval ? airedEval.rank : 'N/A',
      attempts: airedEval ? airedEval.attempts : 0,
      finalPath: airedEval?.finalPath || 'N/A',
      lintPass: lintCheck.valid,
      songUsed: `${nextSong.title} - ${nextSong.artist}`,
      headline: data?.candidate?.topicTitle || '',
      rejectionReasons: airedEval?.rejectionReasons || [],
    });
  }

  log('\n================================================================================');
  log('ROUND 6 ITEM 8 SUMMARY: FALLBACK RATE & CANDIDATE OUTCOMES');
  log('================================================================================');
  let modelCount = 0;
  let geminiFallbackCount = 0;
  let extractiveCount = 0;
  let allLintPass = true;

  for (const r of summaryRows) {
    if (r.finalPath === 'model') modelCount++;
    else if (r.finalPath === 'gemini_fallback') geminiFallbackCount++;
    else if (r.finalPath === 'extractive') extractiveCount++;
    if (!r.lintPass) allLintPass = false;
    log(
      `${r.date} | Rank #${r.rankAired} | Attempts: ${r.attempts} | Path: ${r.finalPath} | Lint: ${r.lintPass ? 'PASS' : 'FAIL'} | Song: ${r.songUsed} | Rejections: ${r.rejectionReasons.length > 0 ? r.rejectionReasons.join(' ;; ') : 'None'}`
    );
  }

  const total = summaryRows.length;
  log(`\nTotal Dates Tested: ${total}`);
  log(`  Local Model Passed: ${modelCount}/${total} (${((modelCount / total) * 100).toFixed(1)}%)`);
  log(`  Gemini Fallback Passed: ${geminiFallbackCount}/${total} (${((geminiFallbackCount / total) * 100).toFixed(1)}%)`);
  log(`  Extractive Fallback Used: ${extractiveCount}/${total} (${((extractiveCount / total) * 100).toFixed(1)}%)`);
  log(`  Read-Aloud Lint Pass Rate: ${allLintPass ? '100%' : 'FAILED SOME'}`);

  const resultsDir = path.join(process.cwd(), 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `round6-verification-${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nWrote verification output to ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import fs from 'fs';
import path from 'path';
import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService.js';
import { selectEraSongForDate } from './round6-verification.js';
import { lintReadAloudScript } from '../src/services/djBreak/breakValidator.js';

const BLIND_TEST_DATES = [
  '1964-08-05',
  '1972-02-22',
  '1978-11-20',
  '1982-06-07',
  '1984-11-07',
  '1990-02-12',
  '1994-06-18',
];

async function main() {
  const lines: string[] = [];
  const log = (s = '') => {
    console.log(s);
    lines.push(s);
  };

  log('================================================================================');
  log(`ROUND 6 FRESH BLIND TEST (Generated ${new Date().toISOString()})`);
  log('================================================================================');

  for (const date of BLIND_TEST_DATES) {
    log(`\n--------------------------------------------------------------------------------`);
    log(`BLIND TEST DATE: ${date}`);
    log(`--------------------------------------------------------------------------------`);

    const prom = await getProminentStoryPackets(date);
    log(`Top 10 Ranked Clusters for ${date} (Total Clusters: ${prom.allRankedStories.length}):`);
    prom.allRankedStories.slice(0, 10).forEach((st, i) => {
      log(
        `  #${i + 1} [Score ${st.prominenceScore}] "${st.topicTitle}" (articles: ${st.articles.length}, fp: ${st.frontPageCount}, dates: [${st.dates.join(', ')}])`
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
    log(`Candidate Evaluations:`);
    for (const ev of evals) {
      if (ev.outcome === 'not_reached') continue;
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
  }

  const resultsDir = path.join(process.cwd(), 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `round6-blind-test-${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nWrote blind test output to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

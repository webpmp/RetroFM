import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';

const BLIND_DATES = [
  '1963-11-22',
  '1972-06-17',
  '1977-08-16',
  '1980-05-18',
  '1987-10-19',
  '1991-01-17',
  '1995-04-19',
  '1969-08-15',
];

async function runRound2BlindTest() {
  console.log('Starting Round 2 Blind Test across 8 historical dates...\n');

  for (const date of BLIND_DATES) {
    console.log(`================================================================`);
    console.log(`BLIND TEST DATE: ${date}`);
    console.log(`================================================================`);

    // 1. Get Prominence Ranking
    const { allRankedStories, selectedPackets } = await getProminentStoryPackets(date);
    console.log(`\nTOP 10 STORIES FOR ${date}:`);
    allRankedStories.slice(0, 10).forEach((s, idx) => {
      const isTop3 = idx < 3 ? ' *** TOP 3 ***' : '';
      console.log(`[${idx + 1}] Score: ${s.prominenceScore} | FP: ${s.frontPageCount} | MostRecentFP: ${s.mostRecentFpDate || 'none'} | Arts: ${s.articles.length} | Lead: "${s.leadArticle.headline}"${isTop3}`);
    });

    // 2. Call real server endpoint
    console.log(`\nCALLING /api/dj/segment-break for ${date}...`);
    try {
      const resp = await fetch('http://localhost:3003/api/dj/segment-break', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedDate: date,
          format: 'top40',
          provider: 'lmstudio',
        }),
      });

      const data = await resp.json();
      console.log(`Decision: ${data.decision} | Type: ${data.breakType || 'none'}`);
      if (data.candidate) {
        console.log(`Selected Story Topic: "${data.candidate.topicTitle}"`);
        console.log(`Article PubDate: ${data.candidate.printDate} | TimePhrase: "${data.candidate.timePhrase}"`);
      }
      console.log(`Generated DJ Speech:\n"${data.finalSpeech || ''}"`);

      // 3. Validator Result
      if (data.candidate && data.candidate.facts) {
        const valRes = validateSegmentBreakOutput(data.finalSpeech || '', {
          selectedDate: date,
          factPacket: {
            topic: data.candidate.topic || 'major_news',
            topicTitle: data.candidate.topicTitle,
            headline: data.candidate.topicTitle,
            facts: data.candidate.facts,
            targetSongTitle: undefined,
            printDate: data.candidate.printDate,
            timePhrase: data.candidate.timePhrase,
          },
          isModelDraft: false,
        });
        console.log(`Validator Result (End-to-end Final Speech): ${valRes.valid ? 'PASS' : 'FAIL'} (${valRes.rejectedReason || 'OK'})`);
      }
    } catch (err: any) {
      console.error(`Error requesting /api/dj/segment-break:`, err.message);
    }
    console.log('\n');
  }
}

runRound2BlindTest().catch(console.error);

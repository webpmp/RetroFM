import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService';

async function callSegmentBreak(date: string) {
  const url = 'http://localhost:3003/api/dj/segment-break';
  const body = {
    selectedDate: date,
    frequencySetting: 1.0,
    allowRetroFm: true,
    provider: 'lmstudio',
    model: 'qwen2.5-14b-instruct-1m',
    nextSong: {
      title: 'Every Breath You Take',
      artist: 'The Police',
      primary_artist: 'The Police',
      first_chart_date: `${date.slice(0, 4)}-01-01`,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function run() {
  const blindDates = [
    '1963-08-29',
    '1967-06-06',
    '1971-06-14',
    '1976-07-05',
    '1980-11-05',
    '1988-07-04',
    '1991-12-26',
    '1993-02-27',
  ];

  for (const d of blindDates) {
    console.log(`\n================================================================================`);
    console.log(`BLIND TEST ROUND 5: ${d}`);
    console.log(`================================================================================`);
    
    // 1. Prominence ranking top 10
    try {
      const { allRankedStories } = await getProminentStoryPackets(d);
      console.log(`\nTop 10 Clusters for ${d} (total clusters: ${allRankedStories.length}):`);
      for (let i = 0; i < Math.min(10, allRankedStories.length); i++) {
        const c = allRankedStories[i];
        const pubDates = Array.from(new Set(c.articles.map(a => a.pubDate))).sort().join(', ');
        console.log(`  ${i + 1}. [Score ${c.prominenceScore.toFixed(1)}] "${c.topicTitle}" (Articles: ${c.articles.length}, Days: [${pubDates}], Front Page: ${c.frontPageCount})`);
      }
    } catch (err: any) {
      console.error(`Error ranking clusters for ${d}:`, err?.message);
    }

    // 2. Aired break via /api/dj/segment-break
    try {
      const result = await callSegmentBreak(d);
      console.log(`\nAired Break Decision: ${result.decision}`);
      console.log(`Break Type: ${result.breakType}`);
      console.log(`Aired Speech:\n"${result.finalSpeech}"`);
    } catch (err: any) {
      console.error(`Error generating break for ${d}:`, err?.message);
    }
  }
}

run().catch(console.error);

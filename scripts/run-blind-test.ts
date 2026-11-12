import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService.js';
import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { validateSegmentBreakOutput } from '../src/services/djBreak/breakValidator.js';

const BLIND_DATES = [
  '1968-04-04',
  '1974-08-08',
  '1981-03-30',
  '1989-11-09',
  '1969-07-21'
];

async function runBlindTest() {
  const writer = new LMStudioScriptWriterProvider({
    endpoint: process.env.LM_STUDIO_ENDPOINT || 'http://localhost:1234/v1',
    model: 'qwen2.5-14b-instruct-1m',
    timeoutMs: 35000,
  });

  for (const date of BLIND_DATES) {
    console.log(`\n======================================================`);
    console.log(`BLIND TEST DATE: ${date}`);
    console.log(`======================================================`);

    const { allRankedStories, selectedPackets } = await getProminentStoryPackets(date);

    console.log(`\nTOP 10 STORIES FOR ${date}:`);
    allRankedStories.slice(0, 10).forEach((s, idx) => {
      const isTop3 = idx < 3 ? ' *** TOP 3 ***' : '';
      console.log(`[${idx+1}] Score: ${s.prominenceScore} | FP: ${s.frontPageCount} | MostRecentFP: ${s.mostRecentFpDate || 'none'} | Arts: ${s.articles.length} | Lead: "${s.leadArticle.headline}"${isTop3}`);
    });

    const topStory = selectedPackets[0] || (allRankedStories[0] ? {
      topicTitle: allRankedStories[0].leadArticle.headline,
      headline: allRankedStories[0].leadArticle.headline,
      section: allRankedStories[0].leadArticle.section || 'National',
      facts: allRankedStories[0].facts.map(f => ({ text: f, source: 'The New York Times', date })),
      timePhrase: "in today's paper",
      status: allRankedStories[0].status,
      unresolved: allRankedStories[0].unresolved
    } : null);

    if (!topStory) {
      console.log('No eligible story packet generated for date.');
      continue;
    }

    console.log(`\nGENERATING DJ BREAK SCRIPT FOR TOP STORY: "${topStory.headline}"`);
    console.log(`Source Facts in Packet:`);
    topStory.facts.forEach((f, fi) => console.log(`  [${fi+1}] ${f.text}`));

    try {
      const breakRes = await writer.writeSegmentBreakScript({
        topic: 'major_news',
        topicTitle: topStory.topicTitle,
        headline: topStory.headline,
        section: topStory.section,
        facts: topStory.facts,
        timePhrase: topStory.timePhrase,
        storyStatus: topStory.status,
        unresolved: topStory.unresolved,
        targetDate: date,
        personality: 'mike',
      });

      console.log(`\nGENERATED DJ SCRIPT:`);
      console.log(`"${breakRes.scriptText}"`);

      // Run validator
      const validation = validateSegmentBreakOutput(breakRes.scriptText, {
        selectedDate: date,
        factPacket: {
          topic: 'major_news',
          headline: topStory.headline,
          topicTitle: topStory.topicTitle,
          facts: topStory.facts,
        },
        isModelDraft: false,
      });

      console.log(`\nVALIDATOR RESULT:`);
      console.log(`Valid: ${validation.valid}`);
      if (!validation.valid) {
        console.log(`Rejected Reason: ${validation.rejectedReason}`);
      }
    } catch (err: any) {
      console.log(`Error generating script:`, err?.message);
    }
  }
}

runBlindTest().catch(console.error);

import { getProminentStoryPackets, RankedStoryCluster } from '../src/services/news/prominenceStoryService.js';

const TEST_DATES = ['1971-05-01', '1985-07-13', '1964-07-04'];

async function run() {
  for (const date of TEST_DATES) {
    console.log(`\n========================================================================================`);
    console.log(`ACCEPTANCE TEST RESULTS FOR: ${date}`);
    console.log(`========================================================================================`);
    
    const { allRankedStories, selectedPackets } = await getProminentStoryPackets(date);
    
    console.log(`Total eligible story clusters: ${allRankedStories.length}`);
    console.log(`Selected Top Packets for DJ: ${selectedPackets.length}`);
    
    console.log(`\n--- TOP 10 RANKED STORIES ---`);
    allRankedStories.slice(0, 10).forEach((story, idx) => {
      console.log(`\n[Rank ${idx + 1}] Score: ${story.prominenceScore} | Title: "${story.topicTitle}"`);
      console.log(`  Lead Headline: "${story.leadArticle.headline}"`);
      console.log(`  Source Dates (${story.dayCount} days, ${story.articles.length} articles): ${story.dates.join(', ')}`);
      console.log(`  Front Page Articles: ${story.frontPageCount} | Status: ${story.status}`);
      console.log(`  Unresolved: ${story.unresolved}`);
      if (story.facts.length > 0) {
        console.log(`  Key Verified Facts:`);
        story.facts.slice(0, 3).forEach((f, fIdx) => console.log(`    ${fIdx + 1}. ${f}`));
      }
    });

    console.log(`\n--- SELECTED STORY PACKETS (GIVEN TO DJ) ---`);
    selectedPackets.forEach((pkt, idx) => {
      console.log(`\nPacket #${idx + 1}: [Score: ${pkt.prominenceScore}] "${pkt.headline}"`);
      console.log(`  Topic: ${pkt.topicTitle}`);
      console.log(`  Dates: ${pkt.sourceArticleDates.join(', ')}`);
      console.log(`  Status: ${pkt.status}`);
      console.log(`  Unresolved: ${pkt.unresolved}`);
      console.log(`  Verified Facts (${pkt.facts.length}):`);
      pkt.facts.forEach((f, fIdx) => console.log(`    • ${f.text}`));
    });
  }
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});

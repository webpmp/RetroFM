import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService.ts';

async function run() {
  console.log('================================================================================');
  console.log('ITEM 4: 1962-10-23 (Cuba blockade), 1968-06-06 (RFK), 1970-05-05 (Kent State)');
  console.log('================================================================================');

  for (const date of ['1962-10-23', '1968-06-06', '1970-05-05']) {
    console.log(`\n--- RANKING FOR ${date} ---`);
    const { allRankedStories, selectedPackets } = await getProminentStoryPackets(date);
    allRankedStories.slice(0, 5).forEach((st, idx) => {
      console.log(`  #${idx + 1} [Score ${st.prominenceScore}] "${st.topicTitle}" (${st.articles.length} arts, ${st.dayCount} days, fp=${st.frontPageCount})`);
    });
    console.log(`Selected Packet #1 for ${date}: "${selectedPackets[0]?.headline}"`);
  }

  console.log('\n================================================================================');
  console.log('ITEM 5: 1981-01-21 (Hostage release story airs instead of Jan 19 story)');
  console.log('================================================================================');
  const { allRankedStories: r1981, selectedPackets: p1981 } = await getProminentStoryPackets('1981-01-21');
  console.log('Top 5 Ranked Stories for 1981-01-21:');
  r1981.slice(0, 5).forEach((st, idx) => {
    console.log(`  #${idx + 1} [Score ${st.prominenceScore}] "${st.topicTitle}" (leadDate=${st.leadArticle.pubDate}, arts=${st.articles.length}, fp=${st.frontPageCount})`);
  });
  console.log(`\nSelected Packet for 1981-01-21: "${p1981[0]?.headline}" (date=${p1981[0]?.leadArticle?.pubDate})`);

  console.log('\n================================================================================');
  console.log('ITEM 6: 1986-01-29 (Challenger disaster merged and ranked #1)');
  console.log('================================================================================');
  const { allRankedStories: r1986, selectedPackets: p1986 } = await getProminentStoryPackets('1986-01-29');
  console.log('Top 10 Ranked Stories for 1986-01-29:');
  r1986.slice(0, 10).forEach((st, idx) => {
    console.log(`  #${idx + 1} [Score ${st.prominenceScore}] "${st.topicTitle}" (${st.articles.length} arts, ${st.dayCount} days, fp=${st.frontPageCount}, leadDate=${st.leadArticle.pubDate})`);
  });
  console.log(`\nSelected Packet #1 for 1986-01-29: "${p1986[0]?.headline}"`);
}

run().catch(console.error);

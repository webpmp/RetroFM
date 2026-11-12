import { getProminentStoryPackets } from "../src/services/news/prominenceStoryService";

const freshDates = [
  "1962-10-23", // Cuban Missile Crisis
  "1968-06-06", // RFK Assassination
  "1973-01-23", // LBJ Dies / Vietnam Peace Accords
  "1975-04-30", // Fall of Saigon
  "1978-09-17", // Camp David Accords
  "1983-10-24", // Beirut Barracks Bombing
  "1990-08-03"  // Iraq Invades Kuwait
];

async function main() {
  console.log("================================================================================");
  console.log("ROUND 3 FRESH BLIND TEST: PROMINENCE RANKING ACROSS 7 HISTORICAL DATES");
  console.log("================================================================================\n");

  for (const d of freshDates) {
    const res = await getProminentStoryPackets(d);
    console.log(`\n================================================================================`);
    console.log(`DATE: ${d} | Eligible Total Evaluated Stories: ${res.allRankedStories.length}`);
    console.log(`================================================================================`);
    const top10 = res.allRankedStories.slice(0, 10);
    top10.forEach((st, idx) => {
      const topFlag = idx < 3 ? " [TOP 3 SELECTED]" : "";
      const over40 = st.articles.length > 40 ? " *** OVER 40 ARTICLES ***" : "";
      console.log(`  #${idx + 1}: (Score: ${st.prominenceScore}, Articles: ${st.articles.length}, FrontPages: ${st.frontPageCount}, Days: ${st.dayCount})${topFlag}${over40}`);
      console.log(`      Headline: "${st.leadArticle.headline}" [${st.leadArticle.pubDate}]`);
    });

    // Run end-to-end segment break generation via /api/dj/segment-break
    try {
      const songPayload = {
        selectedDate: d,
        currentSong: { title: "Current Track", artist: "Artist A" },
        nextSong: { title: "Next Track", artist: "Artist B", primary_artist: "Artist B", first_chart_date: d },
        isFirstBreak: false,
        breakCount: 2,
        provider: "lmstudio",
        endpoint: "http://host.docker.internal:1234/v1",
        model: "qwen2.5-14b-instruct-1m"
      };

      const resp = await fetch("http://localhost:3003/api/dj/segment-break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(songPayload)
      });
      const data = await resp.json();
      console.log(`\n  --- End-to-End DJ Segment Break for ${d} ---`);
      console.log(`  Break Type: ${data.breakType}`);
      console.log(`  Selected Story: "${data.candidate?.topicTitle || data.candidate?.headline}" (Score: ${data.candidate?.prominenceScore || 'N/A'})`);
      console.log(`  Lead / Article Date: ${data.candidate?.printDate || data.candidate?.date}`);
      console.log(`  Generated Speech: "${data.finalSpeech}"`);
      console.log(`  Attempts / Validator:`, JSON.stringify(data.evalSummary?.newsDraftAttempts || []));
    } catch (err: any) {
      console.error(`  Error running segment break for ${d}:`, err?.message);
    }
  }
}

main().catch(console.error);

import { getProminentStoryPackets } from "../src/services/news/prominenceStoryService";

const freshDates = [
  "1965-02-22",
  "1970-05-05",
  "1974-08-09",
  "1979-11-05",
  "1981-01-21",
  "1986-01-29",
  "1989-06-05"
];

async function main() {
  console.log("================================================================================");
  console.log("ROUND 4 FRESH BLIND TEST: PROMINENCE RANKING ACROSS 7 HISTORICAL DATES");
  console.log("================================================================================\n");

  for (const d of freshDates) {
    console.log(`\n================================================================================`);
    console.log(`DATE: ${d}`);
    console.log(`================================================================================`);
    const res = await getProminentStoryPackets(d);
    console.log(`Eligible Total Evaluated Stories: ${res.allRankedStories.length}`);
    const top10 = res.allRankedStories.slice(0, 10);
    top10.forEach((st, idx) => {
      const topFlag = idx < 3 ? " [TOP 3 SELECTED]" : "";
      console.log(`  #${idx + 1}: (Score: ${st.prominenceScore}, Articles: ${st.articles.length}, FrontPages: ${st.frontPageCount}, Days: ${st.dayCount})${topFlag}`);
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

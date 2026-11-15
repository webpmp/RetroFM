const dates = ["1962-10-23", "1968-06-06", "1975-04-30", "1983-10-24"];

async function main() {
  console.log("================================================================================");
  console.log("TASK 2 RE-RUN: /api/dj/segment-break ACROSS 4 HISTORICAL DATES");
  console.log("================================================================================\n");

  for (const d of dates) {
    console.log(`\n================================================================================`);
    console.log(`TESTING DATE: ${d}`);
    console.log(`================================================================================`);
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
    console.log(`  Break Type: ${data.breakType}`);
    console.log(`  Selected Story: "${data.candidate?.topicTitle || data.candidate?.headline}"`);
    console.log(`  Lead / Article Date: ${data.candidate?.printDate || data.candidate?.date}`);
    console.log(`  Aired Script: "${data.finalSpeech}"`);
    console.log(`  Validator / Draft Attempts:`, JSON.stringify(data.evalSummary?.newsDraftAttempts || []));
  }
}

main().catch(console.error);

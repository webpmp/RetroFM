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
  const dates = [
    '1965-02-22',
    '1970-05-05',
    '1974-08-09',
    '1979-11-05',
    '1981-01-21',
    '1986-01-29',
    '1989-06-05',
    '1962-10-23',
    '1968-06-06',
    '1975-04-30',
    '1983-10-24',
  ];

  for (const d of dates) {
    console.log(`\n================================================================================`);
    console.log(`AIRED BREAK TEST FOR: ${d}`);
    console.log(`================================================================================`);
    try {
      const result = await callSegmentBreak(d);
      console.log(`Decision: ${result.decision}`);
      console.log(`Break Type: ${result.breakType}`);
      console.log(`Aired Speech:\n"${result.finalSpeech}"`);
      if (result.evalSummary) {
        console.log(`Selected candidate: ${result.breakType}`);
      }
    } catch (err: any) {
      console.error(`Error on ${d}:`, err?.message);
    }
  }
}

run().catch(console.error);

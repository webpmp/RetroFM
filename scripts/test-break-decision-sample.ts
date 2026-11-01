import fs from 'fs';
import assert from 'node:assert';

async function run() {
  console.log('--- Running DJ Break Decision Test on Sample Library (talkSetting = every) ---');
  const samplePath = './public/data/sample/retrofm_library_youtube.json';
  if (!fs.existsSync(samplePath)) {
    throw new Error(`Sample library not found at ${samplePath}`);
  }
  const sampleSongs = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

  const testCases = [
    { date: '1977-05-01', genre: 'Progressive Rock', title: 'Bohemian Rhapsody', isSingleSong: true },
    { date: '1964-05-01', genre: 'Pop', isSingleSong: false },
    { date: '1984-05-01', genre: 'Pop', isSingleSong: false },
    { date: '1995-05-01', genre: 'Alternative', isSingleSong: false },
  ];

  for (const tc of testCases) {
    let prevSong: any = null;
    let nextSong: any = null;

    if (tc.isSingleSong) {
      const q = sampleSongs.find((s: any) => s.title.includes(tc.title!));
      if (!q) throw new Error(`Song ${tc.title} not found in sample dataset`);
      prevSong = q;
      nextSong = q; // Repeat/single-song station condition
    } else {
      const eligible = sampleSongs.filter((s: any) => s.release_date <= tc.date && (s.genres || '').includes(tc.genre));
      const pool = eligible.length >= 2 ? eligible : sampleSongs.filter((s: any) => s.release_date <= tc.date);
      prevSong = pool[0];
      nextSong = pool[1] || pool[0];
    }

    const res = await fetch('http://localhost:3000/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: tc.date,
        prevSong: prevSong ? { title: prevSong.title, artist: prevSong.artist, id: prevSong.id } : null,
        nextSong: nextSong ? { title: nextSong.title, artist: nextSong.artist, id: nextSong.id } : null,
        frequencySetting: 1.0, // 'every'
        usedFactKeys: [],
        blacklistedFactKeys: [],
        breaksSinceLastRetroFm: 4,
        breaksSinceLastMusicNews: 8,
        totalBreaksSession: 0,
        provider: 'gemini',
      }),
    });

    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }

    const data: any = await res.json();
    console.log(`[Date: ${tc.date}] [Genre: ${tc.genre}] [Type: ${data.breakType}] Decision: ${data.decision} | Spoken: "${data.finalSpeech}"`);

    if (data.decision !== 'speak') {
      throw new Error(`Expected decision 'speak' on date ${tc.date} (${tc.genre}), but got '${data.decision}'`);
    }
    if (!data.finalSpeech || data.finalSpeech.trim().length === 0) {
      throw new Error(`Expected non-empty speech on date ${tc.date} (${tc.genre})`);
    }
  }

  console.log('\n✓ PASS: All break decisions with talkSetting at "every" produced speech and never silence.');
}

run().catch((err) => {
  console.error('\n✗ TEST FAILED:', err);
  process.exit(1);
});

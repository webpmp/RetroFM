import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const homedir = process.env.HOME || '/root';
const dbPath = path.join(homedir, 'retrofm', 'library.sqlite');
const db = new DatabaseSync(dbPath);

interface SongRow {
  id: string;
  title: string;
  artist: string;
  mbid: string;
  first_chart_date: string | null;
}

const stmt = db.prepare('SELECT id, title, artist, mbid, first_chart_date FROM songs WHERE mbid IS NOT NULL ORDER BY id ASC LIMIT 50');
const songs: SongRow[] = stmt.all() as any[];

console.log(`Processing ${songs.length} songs for MusicBrainz credits sample...`);

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'RetroFM/1.0 ( webpmp@gmail.com )',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return await res.json();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FactRecord {
  song_id: string;
  fact_type: 'writer' | 'producer';
  fact_text: string;
  event_date: string | null;
  public_date: string | null;
  source: string;
  source_url: string;
}

async function run() {
  const insertStmt = db.prepare(`
    INSERT INTO song_facts (song_id, fact_type, fact_text, event_date, public_date, source, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const results: { song: SongRow; facts: FactRecord[] }[] = [];

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    console.log(`[${i + 1}/${songs.length}] Fetching ${song.title} by ${song.artist} (${song.mbid})...`);
    const facts: FactRecord[] = [];

    // Credit facts use first_chart_date as their public_date.
    // Must be valid YYYY-MM-DD. No public_date, no use. Year-only release dates don't count as dates.
    const publicDate = song.first_chart_date && song.first_chart_date.length >= 10 ? song.first_chart_date : null;

    if (!publicDate) {
      console.log(`  -> Skipping credits: No valid public_date for ${song.title}`);
      results.push({ song, facts });
      continue;
    }

    try {
      // 1. Fetch recording details including artist-rels and work-rels
      await delay(1100); // Respect MusicBrainz 1 req/sec rate limit
      const recUrl = `https://musicbrainz.org/ws/2/recording/${song.mbid}?inc=artist-rels+work-rels&fmt=json`;
      const recData = await fetchJson(recUrl);

      // Check producer in recording artist relations
      const relations = recData.relations || [];
      for (const rel of relations) {
        if (rel.type === 'producer' && rel.artist?.name) {
          const producerName = rel.artist.name;
          const factRecord: FactRecord = {
            song_id: song.id,
            fact_type: 'producer',
            fact_text: `Produced by ${producerName}.`,
            event_date: rel.begin || null,
            public_date: publicDate,
            source: 'MusicBrainz',
            source_url: `https://musicbrainz.org/recording/${song.mbid}`,
          };
          facts.push(factRecord);
        }
      }

      // Check work relations for writers
      const workRel = relations.find((r: any) => r.type === 'performance' && r.work?.id);
      if (workRel && workRel.work?.id) {
        await delay(1100); // Respect MusicBrainz 1 req/sec
        const workUrl = `https://musicbrainz.org/ws/2/work/${workRel.work.id}?inc=artist-rels&fmt=json`;
        const workData = await fetchJson(workUrl);
        const workRelations = workData.relations || [];

        for (const wRel of workRelations) {
          if (['writer', 'composer', 'lyricist'].includes(wRel.type) && wRel.artist?.name) {
            const writerName = wRel.artist.name;
            // Filter: writer credits only when writer differs from performer
            const artistLower = song.artist.toLowerCase();
            const writerLower = writerName.toLowerCase();
            if (!artistLower.includes(writerLower) && !writerLower.includes(artistLower)) {
              // Avoid duplicate writer entries
              if (!facts.some((f) => f.fact_type === 'writer' && f.fact_text.includes(writerName))) {
                const factRecord: FactRecord = {
                  song_id: song.id,
                  fact_type: 'writer',
                  fact_text: `Written by ${writerName}.`,
                  event_date: wRel.begin || null,
                  public_date: publicDate,
                  source: 'MusicBrainz',
                  source_url: `https://musicbrainz.org/work/${workRel.work.id}`,
                };
                facts.push(factRecord);
              }
            }
          }
        }
      }

      // Save into DB
      for (const f of facts) {
        insertStmt.run(f.song_id, f.fact_type, f.fact_text, f.event_date, f.public_date, f.source, f.source_url);
      }
      console.log(`  -> Found ${facts.length} facts:`, facts.map((f) => `${f.fact_type}: ${f.fact_text}`).join(' | '));
      results.push({ song, facts });
    } catch (err: any) {
      console.error(`  -> Error fetching MBID ${song.mbid}:`, err.message);
      results.push({ song, facts });
    }
  }

  // Write sample report
  fs.writeFileSync('song_facts_50_sample.json', JSON.stringify(results, null, 2));
  console.log('Sample saved to song_facts_50_sample.json.');
}

run().catch(console.error);

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
  chart_year: number;
  mbid: string;
  first_chart_date: string | null;
}

// Select ~60 songs evenly spread across 1960s, 1970s, 1980s, 1990s, 2000s (12 each)
const decades = [
  [1960, 1969],
  [1970, 1979],
  [1980, 1989],
  [1990, 1999],
  [2000, 2009],
];

const selectedSongs: SongRow[] = [];
for (const [startYear, endYear] of decades) {
  const stmt = db.prepare(`
    SELECT id, title, artist, chart_year, mbid, first_chart_date
    FROM songs
    WHERE mbid IS NOT NULL AND chart_year >= ? AND chart_year <= ?
    ORDER BY chart_year_rank ASC, chart_year ASC
    LIMIT 12
  `);
  const rows = stmt.all(startYear, endYear) as unknown as SongRow[];
  selectedSongs.push(...rows);
}

console.log(`Selected ${selectedSongs.length} songs across 1960s to 2000s.`);

// Load all library songs to check:
// Hook 1: The writer also performs (writer has a song in the library as artist/primary_artist)
// Hook 2: The writer has more than 1 song in the library (multi-hit writer)
// Hook 3: Performer covered someone else's song
const allLibrarySongs = db.prepare('SELECT id, title, artist, primary_artist FROM songs').all() as any[];

const libraryArtistsSet = new Set<string>();
for (const s of allLibrarySongs) {
  if (s.artist) libraryArtistsSet.add(s.artist.toLowerCase());
  if (s.primary_artist) libraryArtistsSet.add(s.primary_artist.toLowerCase());
}

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

interface ProcessedSong {
  id: string;
  title: string;
  artist: string;
  chart_year: number;
  public_date: string | null;
  combinedPacket: string | null;
  hooks: string[];
  isUsable: boolean;
  notes?: string;
}

async function run() {
  const results: ProcessedSong[] = [];
  let usableCount = 0;

  for (let i = 0; i < selectedSongs.length; i++) {
    const song = selectedSongs[i];
    console.log(`[${i + 1}/${selectedSongs.length}] (${song.chart_year}) ${song.title} by ${song.artist}...`);
    const publicDate = song.first_chart_date && song.first_chart_date.length >= 10 ? song.first_chart_date : null;

    if (!publicDate) {
      results.push({
        id: song.id,
        title: song.title,
        artist: song.artist,
        chart_year: song.chart_year,
        public_date: null,
        combinedPacket: null,
        hooks: [],
        isUsable: false,
        notes: 'No valid public_date (first_chart_date)',
      });
      continue;
    }

    try {
      await delay(1100);
      const recUrl = `https://musicbrainz.org/ws/2/recording/${song.mbid}?inc=artist-rels+work-rels&fmt=json`;
      const recData = await fetchJson(recUrl);

      const roles: { person: string; role: string }[] = [];
      let isCover = false;
      let isTranslated = false;
      let originalTitle: string | null = null;
      let originalArtist: string | null = null;

      // Check recording relations
      for (const rel of recData.relations || []) {
        if (rel.type === 'producer' && rel.artist?.name) {
          roles.push({ person: rel.artist.name, role: 'producer' });
        }
        if (rel.type === 'performance' && Array.isArray(rel.attributes) && rel.attributes.includes('cover')) {
          isCover = true;
        }
      }

      // Check work relations
      const perfRel = (recData.relations || []).find((r: any) => r.type === 'performance' && r.work?.id);
      if (perfRel?.work?.id) {
        await delay(1100);
        const workUrl = `https://musicbrainz.org/ws/2/work/${perfRel.work.id}?inc=artist-rels+work-rels&fmt=json`;
        const workData = await fetchJson(workUrl);

        for (const wRel of workData.relations || []) {
          if (wRel.type === 'translator') {
            isTranslated = true;
          }
          if (wRel.type === 'other version' && Array.isArray(wRel.attributes) && wRel.attributes.includes('translated')) {
            isTranslated = true;
            if (wRel.work?.title) originalTitle = wRel.work.title;
          }
          if (['writer', 'composer', 'lyricist'].includes(wRel.type) && wRel.artist?.name) {
            const name = wRel.artist.name;
            const artistLower = song.artist.toLowerCase();
            const writerLower = name.toLowerCase();
            // Skip writer credit if identical to performer
            if (!artistLower.includes(writerLower) && !writerLower.includes(artistLower)) {
              if (!roles.some((r) => r.person === name && r.role === wRel.type)) {
                roles.push({ person: name, role: wRel.type });
              }
            }
          }
        }
      }

      // Check hooks:
      // Hook 1: The writer also performs (writer is in library as artist)
      // Hook 2: The writer has more than 1 song in the library (we can count across database or known credits)
      // Hook 3: The performer covered someone else's song
      const hooks: string[] = [];
      const writers = roles.filter((r) => ['writer', 'composer', 'lyricist'].includes(r.role));

      for (const w of writers) {
        const wLower = w.person.toLowerCase();
        // Hook 1: Does this writer also perform their own songs in the library?
        const isLibraryArtist = Array.from(libraryArtistsSet).some((art) => art.includes(wLower) || wLower.includes(art));
        if (isLibraryArtist) {
          hooks.push(`Writer also performs: ${w.person} has records as an artist in the library`);
        }

        // Hook 2: Writer has multiple songs in library
        const librarySongsByWriter = allLibrarySongs.filter((s) => (s.artist || '').toLowerCase().includes(wLower));
        if (librarySongsByWriter.length > 0) {
          hooks.push(`Writer prolific in library: ${w.person}`);
        }
      }

      if (isCover) {
        hooks.push(`Cover version: Performer covered an earlier recording`);
      }

      // Combine credits into one packet per song with each person's role
      let combinedPacket: string | null = null;
      if (roles.length > 0) {
        // Group by role
        const byRole: Record<string, string[]> = {};
        for (const r of roles) {
          if (!byRole[r.role]) byRole[r.role] = [];
          if (!byRole[r.role].includes(r.person)) byRole[r.role].push(r.person);
        }

        const roleParts: string[] = [];
        if (byRole['producer']) roleParts.push(`Produced by ${byRole['producer'].join(', ')}`);
        if (byRole['writer']) roleParts.push(`Written by ${byRole['writer'].join(', ')}`);
        if (byRole['composer']) roleParts.push(`Composed by ${byRole['composer'].join(', ')}`);
        if (byRole['lyricist']) roleParts.push(`Lyrics by ${byRole['lyricist'].join(', ')}`);

        let creditText = roleParts.join('; ') + '.';
        if (isCover) {
          creditText += ' A cover of the earlier classic.';
        }
        if (isTranslated) {
          creditText += originalTitle
            ? ` English adaptation of the original song "${originalTitle}".`
            : ' An English adaptation of the original foreign-language song.';
        }
        combinedPacket = creditText;
      }

      const isUsable = (hooks.length > 0 || isCover) && Boolean(combinedPacket);
      if (isUsable) usableCount++;

      console.log(`  -> Usable: ${isUsable} | Hooks: ${hooks.length} | Packet: ${combinedPacket}`);

      results.push({
        id: song.id,
        title: song.title,
        artist: song.artist,
        chart_year: song.chart_year,
        public_date: publicDate,
        combinedPacket,
        hooks,
        isUsable,
        notes: isTranslated ? 'Translated/adapted song reworded' : undefined,
      });
    } catch (err: any) {
      console.error(`  -> Error fetching ${song.title}:`, err.message);
      results.push({
        id: song.id,
        title: song.title,
        artist: song.artist,
        chart_year: song.chart_year,
        public_date: publicDate,
        combinedPacket: null,
        hooks: [],
        isUsable: false,
        notes: `Fetch error: ${err.message}`,
      });
    }
  }

  console.log('\n======================================================');
  console.log(`Sample Summary: ${usableCount} of ${selectedSongs.length} songs have a usable fact with a hook.`);
  console.log('======================================================\n');

  fs.writeFileSync('song_credits_60_sample.json', JSON.stringify(results, null, 2));
}

run().catch(console.error);

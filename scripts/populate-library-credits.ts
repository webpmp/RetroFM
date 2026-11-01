/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Full Library Credit Population Pipeline
 * Processes all songs in library.sqlite with an mbid, queries MusicBrainz
 * respecting rate limits, extracts combined credits (producers, writers,
 * composers, lyricists, based on / adaptation, verified covers),
 * validates public_date >= 10 chars, calculates hook interest score,
 * and stores facts in song_facts.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const homedir = process.env.HOME || '/root';
const dbPath = path.join(homedir, 'retrofm', 'library.sqlite');
const db = new DatabaseSync(dbPath);

// Ensure song_facts table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS song_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT,
    fact_type TEXT,
    fact_text TEXT,
    event_date TEXT,
    public_date TEXT,
    source TEXT,
    source_url TEXT,
    times_used INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_song_facts_song_id ON song_facts(song_id);
  CREATE INDEX IF NOT EXISTS idx_song_facts_public_date ON song_facts(public_date);
`);

interface SongRow {
  id: string;
  title: string;
  artist: string;
  primary_artist: string | null;
  mbid: string;
  first_chart_date: string | null;
}

// Load all songs that don't already have facts in song_facts
const query = `
  SELECT id, title, artist, primary_artist, mbid, first_chart_date
  FROM songs
  WHERE mbid IS NOT NULL AND length(mbid) = 36
    AND id NOT IN (SELECT DISTINCT song_id FROM song_facts)
  ORDER BY chart_year ASC, chart_year_rank ASC
`;
const songs: SongRow[] = db.prepare(query).all() as any[];

console.log(`Starting full-library credit run for ${songs.length} remaining songs...`);

// Pre-load all artists for Hook 1 & 2
const allLibrarySongs = db.prepare('SELECT id, title, artist, primary_artist FROM songs').all() as any[];
const libraryArtistsSet = new Set<string>();
for (const s of allLibrarySongs) {
  if (s.artist) libraryArtistsSet.add(s.artist.toLowerCase());
  if (s.primary_artist) libraryArtistsSet.add(s.primary_artist.toLowerCase());
}

async function fetchJson(url: string, retries = 3): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'RetroFM/1.0 ( webpmp@gmail.com )',
          'Accept': 'application/json',
        },
      });
      if (res.status === 503 || res.status === 429) {
        await delay(3000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.json();
    } catch (err: any) {
      if (attempt >= retries) throw err;
      await delay(2000 * (attempt + 1));
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processSongCredit(song: SongRow): Promise<{
  creditText: string;
  hooks: string[];
  publicDate: string;
} | null> {
  const publicDate = song.first_chart_date && song.first_chart_date.length >= 10 ? song.first_chart_date : null;
  if (!publicDate) return null;

  await delay(1100); // Respect MusicBrainz 1 req/sec rate limit
  const recUrl = `https://musicbrainz.org/ws/2/recording/${song.mbid}?inc=artist-rels+work-rels+recording-rels&fmt=json`;
  const recData = await fetchJson(recUrl);

  const roles: { person: string; role: string }[] = [];
  let basedOnTitle: string | null = null;
  let coverInfo: { originalArtist: string; originalYear: string } | null = null;

  // 1. Check recording relations
  for (const rel of recData.relations || []) {
    if (rel.type === 'producer' && rel.artist?.name) {
      roles.push({ person: rel.artist.name, role: 'producer' });
    }
    // Only claim a cover when a recording-level cover relation specifically names the original recording
    if (
      rel.target_type === 'recording' ||
      rel['target-type'] === 'recording'
    ) {
      if (rel.type === 'cover' || (Array.isArray(rel.attributes) && rel.attributes.includes('cover'))) {
        const origRec = rel.recording;
        const origArtist = origRec?.['artist-credit']?.[0]?.artist?.name || origRec?.['artist-credit']?.[0]?.name;
        const origDate = rel.begin || rel.end || origRec?.['first-release-date'];
        const origYear = origDate ? origDate.slice(0, 4) : null;
        if (origArtist && origYear && origDate <= publicDate) {
          coverInfo = { originalArtist: origArtist, originalYear: origYear };
        }
      }
    }
  }

  // 2. Check work relations
  const perfRel = (recData.relations || []).find((r: any) => r.type === 'performance' && r.work?.id);
  if (perfRel?.work?.id) {
    await delay(1100);
    const workUrl = `https://musicbrainz.org/ws/2/work/${perfRel.work.id}?inc=artist-rels+work-rels&fmt=json`;
    const workData = await fetchJson(workUrl);

    for (const wRel of workData.relations || []) {
      // Backward adaptation only: our work is based on an earlier work, or is an adaptation of an earlier work
      if (wRel.direction === 'backward' && wRel.work?.title) {
        if (
          wRel.type === 'based on' ||
          (wRel.type === 'other version' && Array.isArray(wRel.attributes) && wRel.attributes.includes('translated'))
        ) {
          basedOnTitle = wRel.work.title;
        }
      }

      // Collect writers, composers, lyricists (differing from performer)
      if (['writer', 'composer', 'lyricist'].includes(wRel.type) && wRel.artist?.name) {
        const name = wRel.artist.name;
        const artistLower = song.artist.toLowerCase();
        const writerLower = name.toLowerCase();
        if (!artistLower.includes(writerLower) && !writerLower.includes(artistLower)) {
          if (!roles.some((r) => r.person === name && r.role === wRel.type)) {
            roles.push({ person: name, role: wRel.type });
          }
        }
      }
    }
  }

  // Check interest hooks
  const hooks: string[] = [];
  const writers = roles.filter((r) => ['writer', 'composer', 'lyricist'].includes(r.role));
  for (const w of writers) {
    const wLower = w.person.toLowerCase();
    const isLibraryArtist = Array.from(libraryArtistsSet).some((art) => art.includes(wLower) || wLower.includes(art));
    if (isLibraryArtist) hooks.push('writer_performs');
    const countInLib = allLibrarySongs.filter((s) => (s.artist || '').toLowerCase().includes(wLower)).length;
    if (countInLib > 0) hooks.push('prolific_writer');
  }
  if (coverInfo) hooks.push('cover');
  if (basedOnTitle) hooks.push('adaptation');

  // Must have a hook and some content to store
  if (hooks.length > 0 && (roles.length > 0 || basedOnTitle || coverInfo)) {
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

    let creditText = roleParts.length > 0 ? roleParts.join('; ') + '.' : '';
    if (basedOnTitle) {
      creditText += (creditText ? ' ' : '') + `Based on "${basedOnTitle}".`;
    }
    if (coverInfo) {
      creditText += (creditText ? ' ' : '') + `A cover of the ${coverInfo.originalYear} song by ${coverInfo.originalArtist}.`;
    }

    return {
      creditText,
      hooks,
      publicDate,
    };
  }

  return null;
}

async function run() {
  const insertStmt = db.prepare(`
    INSERT INTO song_facts (song_id, fact_type, fact_text, event_date, public_date, source, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let processedCount = 0;
  let usableFactCount = 0;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    processedCount++;

    try {
      const result = await processSongCredit(song);
      if (result) {
        insertStmt.run(
          song.id,
          'credit',
          result.creditText,
          null,
          result.publicDate,
          'MusicBrainz',
          `https://musicbrainz.org/recording/${song.mbid}`
        );
        usableFactCount++;
      }

      if (processedCount % 25 === 0) {
        console.log(`[Progress] Processed ${processedCount}/${songs.length} songs (${usableFactCount} usable facts saved)...`);
      }
    } catch (err: any) {
      // Continue on intermittent errors
    }
  }

  console.log(`[Full Library Credit Run Finished] Completed ${processedCount} songs. Added ${usableFactCount} credit facts.`);
}

if (import.meta.main) {
  run().catch(console.error);
}

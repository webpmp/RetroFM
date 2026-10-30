/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Song Story Card Service:
 * Builds and caches per-song story cards from MusicBrainz, Wikipedia, and SQLite database.
 * Topics covered:
 * - Origins and recording background
 * - Songwriters' stories and inspirations
 * - Band-member history & collaborations
 * - Verified original versions & covers
 *
 * Every fact is stored with a publicDate and usable ONLY when publicDate <= broadcastDate.
 * Caches story cards in cache/song_cards/song-<songId>.json
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { splitVerbatimSentences } from '../news/almanacService.js';

export interface SongFactItem {
  factText: string;
  category: 'origin' | 'writer_story' | 'band_history' | 'cover_original' | 'chart_history';
  source: string; // 'Wikipedia' | 'MusicBrainz' | 'Billboard'
  publicDate: string; // YYYY-MM-DD
  eventDate?: string;
}

export interface SongStoryCard {
  songId: string;
  title: string;
  artist: string;
  primaryArtist: string;
  releaseDate: string | null;
  facts: SongFactItem[];
  droppedFacts?: Array<{ text: string; reason: string }>;
  wikiPageTitle?: string;
  artistMetadata?: {
    country?: string;
    area?: string;
    beginYear?: string;
    type?: string;
    genres?: string[];
  };
}

const SONG_CARD_CACHE_DIR = path.join(process.cwd(), 'cache', 'song_cards');

/**
 * Hindsight language that implies post-broadcast knowledge or retrospective evaluations.
 */
export const HINDSIGHT_REGEX = /\b(peaked|peaking|peaks|reached number|reached no|topped|topping|went on to|later|eventually|since|would|won|winning|nominated|nominating|certified|certification|platinum|gold record|multi-platinum|riaa|year-end|best-selling|best selling|has earned|sold over|covered by|regarded as|regarded for|one of the best of all time|one of the best mastered|signature song|signature sound|acclaim|acclaimed|posthumous|inducted|hall of fame|grammy|most commercially successful|highest-grossing|greatest songs?)\b/i;

/**
 * Filter facts to strictly those knowable on or before broadcastDate.
 * Rejects any sentence containing hindsight terms or dates/years in the future of broadcastDate.
 * Never edits a fact to strip a hindsight word; strictly drops it.
 */
export function filterHindsightAndFutureFacts<
  T extends string | { text?: string; factText?: string; date?: string; publicDate?: string }
>(
  facts: T[],
  broadcastDate: string
): T[] {
  const [bYearStr, bMonthStr, bDayStr] = broadcastDate.split('-');
  const bYear = parseInt(bYearStr, 10);
  const bMonth = parseInt(bMonthStr, 10);
  const bDay = parseInt(bDayStr, 10);

  return facts.filter((item) => {
    const text = typeof item === 'string' ? item : (item.text || item.factText || '');
    if (!text) return false;

    // 1. Check hindsight regex
    if (HINDSIGHT_REGEX.test(text)) {
      return false;
    }

    // 2. Check explicitly future years (> broadcastYear)
    const years = text.match(/\b(19\d\d|20\d\d)\b/g);
    if (years) {
      for (const yStr of years) {
        const y = parseInt(yStr, 10);
        if (y > bYear) return false;
      }
    }

    // 3. Check for specific album release references in the same year that occurred after the broadcast date
    // E.g., for broadcastDate 1964-05-01, a reference to "1964 album" when the album released later in 1964 (Hello, Dolly! album was released in June 1964)
    if (text.includes(`${bYear} album`) || text.includes(`album in ${bYear}`)) {
      // If item has a specific date and that date > broadcastDate, or generic album reference for that year
      const itemDate = typeof item === 'string' ? null : (item.date || item.publicDate);
      if (!itemDate || itemDate > broadcastDate || (bMonth < 7 && text.includes(`${bYear} album`))) {
        return false;
      }
    }

    // 4. Check explicit item publicDate / eventDate if present
    if (typeof item !== 'string') {
      const pDate = item.publicDate || item.date;
      if (pDate && pDate > broadcastDate) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Strips wikitext syntax into clean sentences.
 */
function cleanWikiSentences(rawText: string): string[] {
  const clean = rawText
    .replace(/<ref[^>]*>.*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return splitVerbatimSentences(clean)
    .filter((s) => s.length > 20 && !s.includes('==') && !s.includes('Track listing'));
}

/**
 * Searches and fetches Wikipedia summary extract and page title for a song.
 * Requirement 1:
 * - Print the Wikipedia page title that was matched.
 * - Accept a page only if its lead sentence contains both the song title and the artist (or a known alias);
 *   otherwise discard the page.
 */
async function fetchWikiSongExtract(
  title: string,
  artist: string,
  aliases: string[] = []
): Promise<{ extract: string; pageTitle: string } | null> {
  try {
    const query = `${title} ${artist} song`;
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
    const sRes = await fetch(searchUrl, { headers: { 'User-Agent': 'RetroFM/1.0 (historical radio simulator)' } });
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    const top = sData.query?.search?.[0];
    if (!top || !top.title) return null;

    const extUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&titles=${encodeURIComponent(top.title)}&format=json`;
    const eRes = await fetch(extUrl, { headers: { 'User-Agent': 'RetroFM/1.0 (historical radio simulator)' } });
    if (!eRes.ok) return null;
    const eData = await eRes.json();
    const pages = eData.query?.pages || {};
    const firstPage = Object.values(pages)[0] as { extract?: string } | undefined;
    const extract = firstPage?.extract || '';
    if (!extract) return null;

    // Requirement 1: Accept a page only if its lead sentence contains both the song title and the artist (or a known alias)
    const sentences = splitVerbatimSentences(extract);
    const leadSentence = (sentences[0] || '').toLowerCase();
    const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanLead = leadSentence.replace(/[^a-z0-9]/g, '');

    const hasTitle = cleanLead.includes(normTitle);

    const artistTerms = [artist, ...aliases].map((a) => a.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const hasArtist = artistTerms.some((term) => cleanLead.includes(term) || term.split(/\s+/).some((w) => w.length > 3 && cleanLead.includes(w)));

    if (!hasTitle || !hasArtist) {
      console.log(`[SongStoryCard] Discarding Wikipedia page "${top.title}" for "${title}" by ${artist}: lead sentence failed title/artist match.`);
      return null;
    }

    console.log(`[SongStoryCard] Wikipedia page matched for "${title}": "${top.title}"`);
    return { extract, pageTitle: top.title };
  } catch (err) {
    console.warn(`[SongStoryCard] Failed to fetch wiki extract for ${title}:`, err);
    return null;
  }
}

/**
 * Uses LLM to check if a sentence could have been known by a radio listener on the broadcast date.
 * Defaults to DROP (returns false) if anything is questionable or on error.
 */
export async function checkSentenceKnowableWithLLM(
  sentence: string,
  broadcastDate: string,
  llmEndpoint: string = 'http://localhost:1234/v1',
  model: string = 'qwen2.5-14b-instruct-1m'
): Promise<{ knowable: boolean; reason: string }> {
  try {
    const res = await fetch(`${llmEndpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a historical radio broadcast fact auditor. For a given broadcast date and sentence, answer [YES] if a radio listener on that date could have known this fact, or [NO] if it involves future events, hindsight, future awards, later years, or is not knowable on that date. Default to [NO] if in doubt. Format: [YES] <brief reason> or [NO] <brief reason>',
          },
          {
            role: 'user',
            content: `Broadcast Date: ${broadcastDate}\nSentence: ${JSON.stringify(sentence)}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 50,
      }),
    });

    if (!res.ok) {
      return { knowable: false, reason: `LLM audit failed (HTTP ${res.status}) - defaulted to drop` };
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    if (reply.startsWith('[YES]')) {
      return { knowable: true, reason: reply.replace(/^\[YES\]:?\s*/i, '') };
    } else {
      return { knowable: false, reason: reply.replace(/^\[NO\]:?\s*/i, '') || 'LLM judged sentence unverified or hindsight' };
    }
  } catch (err: any) {
    return { knowable: false, reason: `LLM audit error (${err?.message}) - defaulted to drop` };
  }
}

/**
 * Builds or retrieves a verified song story card.
 */
export async function getOrBuildSongStoryCard(
  song: { id: string; title: string; artist: string; primary_artist?: string | null; first_chart_date?: string | null },
  broadcastDate: string,
  db?: DatabaseSync,
  options?: { runLLMCheck?: boolean; llmEndpoint?: string; model?: string }
): Promise<SongStoryCard> {
  fs.mkdirSync(SONG_CARD_CACHE_DIR, { recursive: true });
  const cachePath = path.join(SONG_CARD_CACHE_DIR, `song-${song.id}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached: SongStoryCard = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return cached;
    } catch {}
  }

  const homedir = process.env.HOME || '/root';
  const database = db || new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));
  const facts: SongFactItem[] = [];
  const droppedFacts: Array<{ text: string; reason: string }> = [];
  const primaryArtist = song.primary_artist || song.artist;
  const releaseDate = song.first_chart_date || null;
  const bYear = parseInt(broadcastDate.slice(0, 4), 10);

  // Helper to extract year/date from sentence
  const checkSentenceEligibility = (sentence: string): { eligible: boolean; reason?: string; eventDate?: string } => {
    // 1. Check hindsight words
    const hindsightMatch = sentence.match(HINDSIGHT_REGEX);
    if (hindsightMatch) {
      return { eligible: false, reason: `Contains hindsight term: "${hindsightMatch[0]}"` };
    }

    // 2. Check year mentions
    const years = sentence.match(/\b(19\d\d|20\d\d)\b/g);
    if (years) {
      for (const yStr of years) {
        const y = parseInt(yStr, 10);
        if (y > bYear) {
          return { eligible: false, reason: `Contains future year ${y} (> ${bYear})` };
        }
      }
    }

    return { eligible: true, eventDate: song.first_chart_date || '1960-01-01' };
  };

  // 1. Ingest existing verified song_facts from database (credits, producers, writers, adaptations)
  try {
    const rows = database.prepare(`
      SELECT fact_type, fact_text, event_date, public_date, source
      FROM song_facts
      WHERE song_id = ?
    `).all(song.id) as any[];

    for (const r of rows) {
      const pubDate = r.public_date || song.first_chart_date || '1960-01-01';
      if (pubDate > broadcastDate) {
        droppedFacts.push({ text: r.fact_text, reason: `Public date ${pubDate} > broadcast date ${broadcastDate}` });
        continue;
      }

      let cat: SongFactItem['category'] = 'writer_story';
      if (r.fact_text.includes('Based on') || r.fact_text.includes('Cover of') || r.fact_text.includes('built on') || r.fact_text.includes('samples')) {
        cat = 'cover_original';
      } else if (r.fact_type === 'producer') {
        cat = 'origin';
      }

      facts.push({
        factText: r.fact_text,
        category: cat,
        source: r.source || 'MusicBrainz',
        publicDate: pubDate,
        eventDate: r.event_date || pubDate,
      });

      // Requirement 1: If MusicBrainz or Wikipedia says a song samples, covers, or is built on another,
      // state that relation explicitly ("X is built on Y by Z") and only then add facts about the original,
      // with dates on or before the broadcast date.
      const matchAdaptation = r.fact_text.match(/(?:Based on|Cover of)\s+"([^"]+)"/i);
      if (matchAdaptation) {
        const origTitle = matchAdaptation[1];
        try {
          const origSongRow = database.prepare(`
            SELECT id, title, artist, release_date, first_chart_date
            FROM songs
            WHERE title = ?
            LIMIT 1
          `).get(origTitle) as any;

          if (origSongRow) {
            const origReleaseDate = origSongRow.release_date || origSongRow.first_chart_date || '1960-01-01';
            if (origReleaseDate <= broadcastDate) {
              facts.push({
                factText: `"${song.title}" is built on "${origSongRow.title}" by ${origSongRow.artist}.`,
                category: 'cover_original',
                source: 'MusicBrainz',
                publicDate: song.first_chart_date || broadcastDate,
                eventDate: origReleaseDate,
              });

              // Add facts about the original, with dates on or before broadcastDate
              const origFacts = database.prepare(`
                SELECT fact_text, public_date, event_date, source
                FROM song_facts
                WHERE song_id = ?
              `).all(origSongRow.id) as any[];

              for (const ofact of origFacts) {
                const opDate = ofact.public_date || origReleaseDate;
                if (opDate <= broadcastDate && !HINDSIGHT_REGEX.test(ofact.fact_text)) {
                  facts.push({
                    factText: ofact.fact_text,
                    category: 'cover_original',
                    source: ofact.source || 'MusicBrainz',
                    publicDate: opDate,
                    eventDate: ofact.event_date || opDate,
                  });
                }
              }
            }
          }
        } catch (origErr) {
          console.warn(`[SongStoryCard] Error resolving original song for ${origTitle}:`, origErr);
        }
      }
    }
  } catch (err) {
    console.warn(`[SongStoryCard] Error querying song_facts for ${song.id}:`, err);
  }

  // 2. Query band_members for artist history (strictly members active on broadcastDate)
  try {
    const memberRows = database.prepare(`
      SELECT member_name, begin_date, end_date
      FROM band_members
      WHERE band_name = ?
    `).all(primaryArtist) as any[];

    if (memberRows.length > 0) {
      const activeMembers = memberRows.filter((m) => {
        // Strip quotes or whitespace
        const b = (m.begin_date || '').replace(/['"]/g, '').trim();
        const e = (m.end_date || '').replace(/['"]/g, '').trim();

        // Check begin date: must not start after broadcast year/date
        if (b) {
          const bVal = b.length === 4 ? `${b}-12-31` : b;
          if (bVal > broadcastDate) return false;
        }

        // Check end date: must not end before broadcast year/date
        if (e) {
          const eVal = e.length === 4 ? `${e}-01-01` : e;
          if (eVal < broadcastDate) return false;
        }

        return true;
      });

      if (activeMembers.length > 1) {
        const memberNames = activeMembers.map((m) => m.member_name).join(', ');
        facts.push({
          factText: `${primaryArtist} features members ${memberNames}.`,
          category: 'band_history',
          source: 'MusicBrainz Band Archive',
          publicDate: song.first_chart_date || '1960-01-01',
          eventDate: song.first_chart_date || '1960-01-01',
        });
      }
    }
  } catch (err) {
    console.warn(`[SongStoryCard] Error querying band_members for ${primaryArtist}:`, err);
  }

  // Fetch artist aliases from artist_aliases table for Wikipedia verification
  const artistAliases: string[] = [];
  try {
    const aliasRows = database.prepare(`
      SELECT alias_name FROM artist_aliases WHERE LOWER(artist_name) = LOWER(?)
    `).all(primaryArtist) as any[];
    for (const ar of aliasRows) {
      if (ar.alias_name) artistAliases.push(ar.alias_name);
    }
  } catch {}

  // 3. Query Wikipedia extract for origins and background
  let wikiPageTitle: string | undefined = undefined;
  const wikiResult = await fetchWikiSongExtract(song.title, primaryArtist, artistAliases);
  if (wikiResult && wikiResult.extract) {
    wikiPageTitle = wikiResult.pageTitle;
    const sentences = cleanWikiSentences(wikiResult.extract);
    for (const s of sentences) {
      const eligibility = checkSentenceEligibility(s);
      if (!eligibility.eligible) {
        droppedFacts.push({ text: s, reason: eligibility.reason || 'Not knowable at broadcast date' });
        continue;
      }

      // Classify topic
      let cat: SongFactItem['category'] = 'origin';
      const sLower = s.toLowerCase();
      if (sLower.includes('written') || sLower.includes('composed') || sLower.includes('wrote') || sLower.includes('inspiration')) {
        cat = 'writer_story';
      } else if (sLower.includes('band') || sLower.includes('group') || sLower.includes('member') || sLower.includes('vocal')) {
        cat = 'band_history';
      } else if (sLower.includes('cover') || sLower.includes('original') || sLower.includes('recorded first') || sLower.includes('built on') || sLower.includes('samples')) {
        cat = 'cover_original';
      } else if (sLower.includes('chart') || sLower.includes('billboard') || sLower.includes('number one') || sLower.includes('top 10')) {
        // Drop any chart text from wikipedia - chart status must strictly come from weekly_chart
        droppedFacts.push({ text: s, reason: 'Chart claim from Wikipedia extract (chart facts come strictly from weekly_chart)' });
        continue;
      }

      // Optional LLM check if enabled
      if (options?.runLLMCheck) {
        const llmCheck = await checkSentenceKnowableWithLLM(
          s,
          broadcastDate,
          options.llmEndpoint,
          options.model
        );
        if (!llmCheck.knowable) {
          droppedFacts.push({ text: s, reason: `LLM judgment: ${llmCheck.reason}` });
          continue;
        }
      }

      facts.push({
        factText: s,
        category: cat,
        source: 'Wikipedia',
        publicDate: song.first_chart_date || '1960-01-01',
        eventDate: eligibility.eventDate || song.first_chart_date || '1960-01-01',
      });

      // Requirement 1: If Wikipedia says a song samples, covers, or is built on another,
      // state that relation explicitly ("X is built on Y by Z") and only then add facts about the original,
      // with dates on or before the broadcast date.
      if (s.toLowerCase().includes('sample') || s.toLowerCase().includes('cover') || s.toLowerCase().includes('interpolat') || s.toLowerCase().includes('based on') || s.toLowerCase().includes('built on')) {
        const quotedMatches = s.match(/"([^"]+)"/g);
        if (quotedMatches) {
          for (const qm of quotedMatches) {
            const candidateTitle = qm.replace(/"/g, '').trim();
            if (candidateTitle.toLowerCase() === song.title.toLowerCase()) continue;
            try {
              const origRow = database.prepare(`
                SELECT id, title, artist, release_date, first_chart_date
                FROM songs
                WHERE title = ?
                LIMIT 1
              `).get(candidateTitle) as any;

              if (origRow) {
                const origDate = origRow.release_date || origRow.first_chart_date || '1960-01-01';
                if (origDate <= broadcastDate) {
                  facts.push({
                    factText: `"${song.title}" is built on "${origRow.title}" by ${origRow.artist}.`,
                    category: 'cover_original',
                    source: 'Wikipedia',
                    publicDate: song.first_chart_date || broadcastDate,
                    eventDate: origDate,
                  });

                  const origFacts = database.prepare(`
                    SELECT fact_text, public_date, event_date, source
                    FROM song_facts
                    WHERE song_id = ?
                  `).all(origRow.id) as any[];

                  for (const ofact of origFacts) {
                    const opDate = ofact.public_date || origDate;
                    if (opDate <= broadcastDate && !HINDSIGHT_REGEX.test(ofact.fact_text)) {
                      facts.push({
                        factText: ofact.fact_text,
                        category: 'cover_original',
                        source: ofact.source || 'MusicBrainz',
                        publicDate: opDate,
                        eventDate: ofact.event_date || opDate,
                      });
                    }
                  }
                }
              }
            } catch (wErr) {
              console.warn(`[SongStoryCard] Error matching original song from wiki sentence for ${candidateTitle}:`, wErr);
            }
          }
        }
      }
    }
  }

  // 4. Contemporaneous NYT archive pieces about the artist or song from the 4 weeks before broadcastDate
  try {
    const [bYearStr, bMonthStr] = broadcastDate.split('-');
    const nytFilePath = path.join(process.cwd(), 'cache', 'nyt', `${bYearStr}-${bMonthStr}.json`);
    if (fs.existsSync(nytFilePath)) {
      const nytRaw = JSON.parse(fs.readFileSync(nytFilePath, 'utf8'));
      const articles = nytRaw.articles || [];
      const searchTerms = [song.title.toLowerCase(), primaryArtist.toLowerCase()];

      for (const a of articles) {
        if (!a.pubDate || a.pubDate > broadcastDate) continue;
        const textToSearch = `${a.headline || ''} ${a.abstract || ''} ${a.leadParagraph || ''}`.toLowerCase();
        const matchesTerm = searchTerms.some((t) => t.length > 3 && textToSearch.includes(t));
        if (!matchesTerm) continue;

        // Skip letters, corrections, business earnings
        if (a.typeOfMaterial === 'Letter' || a.typeOfMaterial === 'Correction') continue;

        const rawSummary = a.abstract || a.leadParagraph || a.headline;
        if (!rawSummary || rawSummary.length < 25) continue;

        const sentences = splitVerbatimSentences(rawSummary);
        for (const s of sentences) {
          const eligibility = checkSentenceEligibility(s);
          if (!eligibility.eligible) continue;
          if (facts.length >= 8) break; // Don't overwhelm packet

          facts.push({
            factText: s,
            category: 'origin',
            source: 'New York Times Archive',
            publicDate: a.pubDate,
            eventDate: a.pubDate,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[SongStoryCard] Error querying contemporaneous NYT articles for ${song.title}:`, err);
  }

  // 4b. MusicBrainz Artist Metadata (country, area, begin year, type, genres)
  let artistMetadata: SongStoryCard['artistMetadata'] = undefined;
  try {
    const artistCacheFile = path.join(SONG_CARD_CACHE_DIR, `artist-${encodeURIComponent(primaryArtist)}.json`);
    if (fs.existsSync(artistCacheFile)) {
      artistMetadata = JSON.parse(fs.readFileSync(artistCacheFile, 'utf8'));
    } else {
      const searchUrl = `https://musicbrainz.org/ws/2/artist?query=artist:%22${encodeURIComponent(primaryArtist)}%22&fmt=json`;
      const mbRes = await fetch(searchUrl, { headers: { 'User-Agent': 'RetroFM/1.0 (historical radio simulator)' } });
      if (mbRes.ok) {
        const mbData = await mbRes.json();
        const topArtist = mbData?.artists?.[0];
        if (topArtist) {
          const beginYear = topArtist['life-span']?.begin?.slice(0, 4);
          const genres = (topArtist.genres || []).map((g: any) => g.name);
          artistMetadata = {
            country: topArtist.country,
            area: topArtist.area?.name,
            beginYear,
            type: topArtist.type,
            genres,
          };
          fs.writeFileSync(artistCacheFile, JSON.stringify(artistMetadata, null, 2), 'utf8');
        }
      }
    }

    if (artistMetadata) {
      const metaParts: string[] = [];
      const isGroup = (artistMetadata.type || '').toLowerCase() === 'group';
      if (artistMetadata.type && artistMetadata.area) {
        metaParts.push(`${primaryArtist} is an American ${isGroup ? 'group' : 'artist'}`.replace('American', artistMetadata.country === 'GB' ? 'British' : artistMetadata.country === 'US' ? 'American' : artistMetadata.area));
      }
      if (artistMetadata.beginYear && artistMetadata.beginYear <= broadcastDate.slice(0, 4)) {
        // Part 3: For Person, beginYear is a birth date. Never say "making music since", "active since", or "formed in".
        // Use "formed in" ONLY for Group.
        if (isGroup) {
          metaParts.push(`formed in ${artistMetadata.beginYear}`);
        }
      }
      if (metaParts.length > 0) {
        const metaFact = `${metaParts.join(', ')}.`;
        facts.push({
          factText: metaFact,
          category: 'band_history',
          source: 'MusicBrainz',
          publicDate: artistMetadata.beginYear ? `${artistMetadata.beginYear}-01-01` : '1960-01-01',
          eventDate: artistMetadata.beginYear ? `${artistMetadata.beginYear}-01-01` : '1960-01-01',
        });
      }
    }
  } catch (err) {
    console.warn(`[SongStoryCard] Error querying MusicBrainz artist metadata for ${primaryArtist}:`, err);
  }

  // 5. Final Date-Eligibility Choke Point:
  // Re-verify every fact across all sources through filterHindsightAndFutureFacts
  const verifiedFacts = filterHindsightAndFutureFacts(facts, broadcastDate);

  // Requirement 10: Remove duplicate facts from packets
  const uniqueFacts: SongFactItem[] = [];
  const seenFactTexts = new Set<string>();
  for (const f of verifiedFacts) {
    const norm = f.factText.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!seenFactTexts.has(norm)) {
      seenFactTexts.add(norm);
      uniqueFacts.push(f);
    }
  }

  const card: SongStoryCard = {
    songId: song.id,
    title: song.title,
    artist: song.artist,
    primaryArtist,
    releaseDate,
    facts: uniqueFacts,
    droppedFacts,
    wikiPageTitle,
    artistMetadata,
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(card, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[SongStoryCard] Failed caching card for ${song.id}:`, err);
  }

  return card;
}

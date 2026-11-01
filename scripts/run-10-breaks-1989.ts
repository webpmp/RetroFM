/**
 * Verification Script for 10 breaks on 1989-05-01:
 * Prints for each break:
 * - facts used (with source)
 * - the Wikipedia page matched (or None)
 * - aired text
 * - 6-word source run overlap audit (any 6+ consecutive words matching source sentences)
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

function findConsecutiveWordOverlap(strA: string, strB: string, minWords = 6): string | null {
  const wordsA = strA.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const wordsB = strB.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

  if (wordsA.length < minWords || wordsB.length < minWords) {
    return null;
  }

  for (let len = minWords; len <= wordsA.length; len++) {
    for (let i = 0; i <= wordsA.length - len; i++) {
      const slice = wordsA.slice(i, i + len).join(' ');
      const strBSearch = ' ' + wordsB.join(' ') + ' ';
      if (strBSearch.includes(' ' + slice + ' ')) {
        // Found an overlap of length len. See if it can extend further or return it
        let longest = slice;
        let extendedLen = len + 1;
        while (i + extendedLen <= wordsA.length) {
          const extSlice = wordsA.slice(i, i + extendedLen).join(' ');
          if (strBSearch.includes(' ' + extSlice + ' ')) {
            longest = extSlice;
            extendedLen++;
          } else {
            break;
          }
        }
        return longest;
      }
    }
  }
  return null;
}

async function main() {
  const homedir = os.homedir();
  const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

  const date = '1989-05-01';

  // Fetch playlist on or before this date
  const playlist = db.prepare(`
    SELECT id, title, artist, primary_artist, first_chart_date
    FROM songs
    WHERE first_chart_date <= ?
    ORDER BY first_chart_date DESC
    LIMIT 11
  `).all(date) as any[];

  const usedFactKeys: string[] = [];
  const blacklistedFactKeys: string[] = [];
  let lastTopic: string | null = null;
  let breaksSinceLastRetroFm = 4;
  let breaksSinceLastNowOnRetroFm = 5;

  console.log(`================================================================================`);
  console.log(`RUNNING 10 BREAKS FOR ${date}`);
  console.log(`================================================================================\n`);

  for (let i = 0; i < 10; i++) {
    const prev = playlist[i];
    const next = playlist[i + 1];

    const response: Response = await fetch('http://localhost:3003/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedDate: date,
        prevSong: prev ? { title: prev.title, artist: prev.artist, id: prev.id, first_chart_date: prev.first_chart_date } : null,
        nextSong: next ? { title: next.title, artist: next.artist, id: next.id, first_chart_date: next.first_chart_date } : null,
        frequencySetting: 1.0,
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        breaksSinceLastRetroFm,
        breaksSinceLastNowOnRetroFm,
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1',
        model: 'qwen2.5-14b-instruct-1m',
      }),
    });

    const data: any = await response.json();

    if (data.usedKeys && Array.isArray(data.usedKeys)) {
      usedFactKeys.push(...data.usedKeys);
    }
    if (data.blacklistedKeys && Array.isArray(data.blacklistedKeys)) {
      blacklistedFactKeys.push(...data.blacklistedKeys);
    }
    if (data.breakType) {
      lastTopic = data.breakType;
    }

    const airedText: string = data.finalSpeech || '';

    // Update retrofm session counters
    if (/Now on RetroFM, here is/i.test(airedText)) {
      breaksSinceLastNowOnRetroFm = 0;
      breaksSinceLastRetroFm = 0;
    } else if (/RetroFM/i.test(airedText)) {
      breaksSinceLastRetroFm = 0;
      breaksSinceLastNowOnRetroFm++;
    } else {
      breaksSinceLastRetroFm++;
      breaksSinceLastNowOnRetroFm++;
    }

    const breakType = data.breakType || 'silence';
    const wikiPageMatched = data.candidate?.wikiPageTitle || 'None';
    const factsUsed: Array<{ text: string; source: string }> = data.candidate?.facts || [];

    // Check for 6-word source run overlaps between airedText and any fact
    const sourceRunMatches: string[] = [];
    for (const fact of factsUsed) {
      const match = findConsecutiveWordOverlap(airedText, fact.text, 6);
      if (match) {
        // If it's a short factual phrase like title/artist/credits, check threshold
        sourceRunMatches.push(`"${match}" (from fact: "${fact.text}")`);
      }
    }

    console.log(`--------------------------------------------------------------------------------`);
    console.log(`[Break ${i + 1}] "${prev.title}" -> "${next.title}"`);
    console.log(`Break Type:           ${breakType}`);
    console.log(`Wikipedia Page:       ${wikiPageMatched}`);
    console.log(`Facts Used (${factsUsed.length}):`);
    factsUsed.forEach((f, idx) => {
      console.log(`  [Fact ${idx + 1}] (${f.source || 'Unknown'}): ${f.text}`);
    });
    console.log(`Aired Text:`);
    console.log(`  "${airedText}"`);
    if (sourceRunMatches.length > 0) {
      console.log(`6-WORD SOURCE RUNS FOUND: ${sourceRunMatches.join('; ')}`);
    } else {
      console.log(`6-WORD SOURCE RUNS FOUND: None (clean paraphrasing)`);
    }
    console.log('');
  }
}

main().catch(console.error);

/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Runs a live 10-song-change session through the running app server on 1996-11-15
 * with frequency 1.0 ('every') using LM Studio (qwen2.5-14b-instruct-1m).
 * Gathers and displays Segment Prepared, Queued, Aired, Discarded lines, hand-off template and group, and aired texts.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';

interface ServerSong {
  id: string;
  title: string;
  artist: string;
  primary_artist?: string | null;
  first_chart_date?: string | null;
}

async function runLive1996Session() {
  const dbPath = path.join(os.homedir(), 'retrofm', 'library.sqlite');
  const db = new DatabaseSync(dbPath);

  const targetDate = '1996-11-15';
  const rawRows = db.prepare(`
    SELECT s.id, s.title, s.artist, s.primary_artist, s.first_chart_date
    FROM songs s
    WHERE s.first_chart_date <= ? AND (s.last_chart_date >= ? OR s.last_chart_date IS NULL)
    ORDER BY s.peak_position ASC
    LIMIT 15
  `).all(targetDate, '1996-01-01');

  const rows: ServerSong[] = (rawRows as unknown as ServerSong[]);
  console.log(`Loaded ${rows.length} charting songs for ${targetDate}`);

  let usedKeys: string[] = [];
  let blacklistedKeys: string[] = [];
  let breaksSinceRetroFm = 4;
  let lastTopic: string | null = null;
  let lastHandoffGroup: number | null = null;
  let recentHandoffTemplates: string[] = [];
  let plainIntroCount = 0;

  for (let i = 0; i < 10; i++) {
    const prev = rows[i];
    const next = rows[i + 1];
    console.log(`\n======================================================`);
    console.log(`SONG CHANGE #${i + 1}: "${prev.title}" by ${prev.artist} -> "${next.title}" by ${next.artist}`);
    console.log(`======================================================`);

    const reqPayload = {
      selectedDate: targetDate,
      prevSong: prev,
      nextSong: next,
      frequencySetting: 1.0, // 'every'
      usedFactKeys: usedKeys,
      blacklistedFactKeys: blacklistedKeys,
      lastTopic,
      breaksSinceLastRetroFm: breaksSinceRetroFm,
      lastHandoffGroup,
      recentHandoffTemplates,
      provider: 'lmstudio',
      endpoint: 'http://localhost:1234/v1',
      model: 'qwen2.5-14b-instruct-1m',
    };

    const res = await fetch('http://localhost:3003/api/dj/segment-break', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload),
    });

    if (!res.ok) {
      console.error(`HTTP error: ${res.status}`);
      continue;
    }

    const data: any = await res.json();
    const breakId = data.breakId;
    console.log(`Decision: ${data.decision} | Type: ${data.breakType} | breakId: ${breakId}`);
    console.log(`Handoff Group: ${data.handoffGroup} | Template: "${data.handoffTemplate}"`);

    // Update keys and handoff history
    if (Array.isArray(data.blacklistedKeys)) {
      blacklistedKeys.push(...data.blacklistedKeys);
    }
    if (Array.isArray(data.usedKeys)) {
      usedKeys.push(...data.usedKeys);
    }
    lastTopic = data.breakType;
    if (typeof data.handoffGroup === 'number') {
      lastHandoffGroup = data.handoffGroup;
    }
    if (typeof data.handoffTemplate === 'string') {
      recentHandoffTemplates.push(data.handoffTemplate);
      if (recentHandoffTemplates.length > 12) recentHandoffTemplates.shift();
    }

    if (data.decision === 'speak' && data.finalSpeech) {
      // Simulate client queueing
      await fetch('http://localhost:3003/api/dj/segment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId, event: 'queued' }),
      });

      // Simulate client playback start (aired)
      await fetch('http://localhost:3003/api/dj/segment-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ breakId, event: 'aired' }),
      });

      console.log(`[Aired Text]: "${data.finalSpeech}"`);
      if (data.breakType === 'plain_intro') {
        plainIntroCount++;
      }

      // Track RetroFM recurrence
      if (/RetroFM/i.test(data.finalSpeech)) {
        breaksSinceRetroFm = 0;
      } else {
        breaksSinceRetroFm++;
      }
    } else {
      console.log(`[Silence]: No speech chosen.`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`SUMMARY: 10 song changes completed. Plain intros: ${plainIntroCount}`);
  console.log(`======================================================`);
}

runLive1996Session().catch(console.error);

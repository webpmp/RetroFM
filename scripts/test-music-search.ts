/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Test script for RetroFM Music Programming:
 * Evaluates candidate selection for:
 * 1. a-ha / Take on Me / 1985
 * 2. Michael Jackson / Billie Jean / 1983
 * 3. Prince / When Doves Cry / 1984
 * 4. U2 / With or Without You / 1987
 * 5. Peter Gabriel / Sledgehammer / 1986
 */

import dotenv from 'dotenv';
dotenv.config();

import {
  searchYouTubeForSong,
  lookupMusicBrainz,
  scoreCandidateVideo,
  loadOverrides,
  formatDuration,
  clearSearchCache,
  CandidateVideo,
} from '../src/services/music/songSearch.js';

interface TestCase {
  artist: string;
  song: string;
  year: string;
}

const TEST_CASES: TestCase[] = [
  { artist: 'a-ha', song: 'Take on Me', year: '1985' },
  { artist: 'Michael Jackson', song: 'Billie Jean', year: '1983' },
  { artist: 'Prince', song: 'When Doves Cry', year: '1984' },
  { artist: 'U2', song: 'With or Without You', year: '1987' },
  { artist: 'Peter Gabriel', song: 'Sledgehammer', year: '1986' },
];

// Offline realistic candidate fixtures to verify rule enforcement when YOUTUBE_API_KEY is not set
const CANDIDATE_FIXTURES: Record<string, Array<{ videoId: string; title: string; channel: string; durationSec: number }>> = {
  'a-ha|take on me': [
    { videoId: 'N6GZ-2x1uFE', title: 'Take On Me', channel: 'a-ha - Topic', durationSec: 227 },
    { videoId: 'djV11Xbc914', title: 'a-ha - Take On Me (Official Video) [4K]', channel: 'a-ha', durationSec: 244 },
    { videoId: 'cv1m7vS08Qk', title: 'Take on Me (Single Version)', channel: 'Rhino', durationSec: 220 },
    { videoId: 'AkqGvhQp_0I', title: 'a-ha - Take On Me (Live at MTV Unplugged)', channel: 'a-ha', durationSec: 275 }, // Rejected: Rule 4 (live)
    { videoId: 'cover_123456', title: 'Take On Me (Acoustic Cover by Sarah)', channel: 'Acoustic Covers', durationSec: 215 }, // Rejected: Rule 1 & Rule 3 (cover)
    { videoId: 'short_snippet', title: 'a-ha - Take on Me 10-second ringtone', channel: 'a-ha', durationSec: 45 }, // Rejected: Rule 2 (< 2:00)
  ],
  'michael jackson|billie jean': [
    { videoId: 'H_p_9sYV6i4', title: 'Billie Jean', channel: 'Michael Jackson - Topic', durationSec: 294 },
    { videoId: 'Zi_XLOBDo_Y', title: 'Michael Jackson - Billie Jean (Official Video)', channel: 'Michael Jackson', durationSec: 296 },
    { videoId: 'vevo_mj_bj01', title: 'Michael Jackson - Billie Jean (Audio)', channel: 'MichaelJacksonVEVO', durationSec: 294 },
    { videoId: 'mj_live_munich', title: 'Michael Jackson - Billie Jean (Live in Munich 1997)', channel: 'Michael Jackson', durationSec: 360 }, // Rejected: Rule 4 (live)
    { videoId: 'mj_remix_club', title: 'Michael Jackson - Billie Jean (Club Remix 2020)', channel: 'DJ Mixes', durationSec: 320 }, // Rejected: Rule 3 (remix)
  ],
  'prince|when doves cry': [
    { videoId: 'topic_prince_wdc', title: 'When Doves Cry', channel: 'Prince - Topic', durationSec: 352 },
    { videoId: 'UG3VcCAlUgE', title: 'Prince - When Doves Cry (Official Music Video)', channel: 'Prince', durationSec: 353 },
    { videoId: 'prince_wdc_audio', title: 'Prince - When Doves Cry (Official Audio)', channel: 'Prince', durationSec: 352 },
    { videoId: 'wdc_slowed_reverb', title: 'Prince - When Doves Cry (slowed + reverb)', channel: 'Vibe Audio', durationSec: 390 }, // Rejected: Rule 3 (slowed)
    { videoId: 'wdc_reaction_vid', title: 'Vocal Coach reacts to Prince - When Doves Cry', channel: 'Reacts Channel', durationSec: 480 }, // Rejected: Rule 3 (reaction)
  ],
  'u2|with or without you': [
    { videoId: 'topic_u2_wowy', title: 'With or Without You', channel: 'U2 - Topic', durationSec: 296 },
    { videoId: 'ujNeHIo7oTE', title: 'U2 - With Or Without You (Official Music Video)', channel: 'U2', durationSec: 295 },
    { videoId: 'u2_vevo_upload', title: 'U2 - With Or Without You', channel: 'U2VEVO', durationSec: 296 },
    { videoId: 'wowy_karaoke_ver', title: 'With or Without You (Karaoke Version)', channel: 'Sing King Karaoke', durationSec: 295 }, // Rejected: Rule 3 (karaoke)
    { videoId: 'u2_live_slane', title: 'U2 - With Or Without You (Live at Slane Castle)', channel: 'U2', durationSec: 330 }, // Rejected: Rule 4 (live)
  ],
  'peter gabriel|sledgehammer': [
    { videoId: 'topic_pg_sledge', title: 'Sledgehammer', channel: 'Peter Gabriel - Topic', durationSec: 312 },
    { videoId: 'OJWJE0x7T4Q', title: 'Peter Gabriel - Sledgehammer (Official HD Video)', channel: 'Peter Gabriel', durationSec: 315 },
    { videoId: 'pg_vevo_sledge', title: 'Peter Gabriel - Sledgehammer', channel: 'PeterGabrielVEVO', durationSec: 312 },
    { videoId: 'sledge_1hour_loop', title: 'Peter Gabriel - Sledgehammer 1 hour loop', channel: 'Loop Station', durationSec: 3600 }, // Rejected: Rule 2 & 3 (1 hour, loop)
    { videoId: 'sledge_parody_vid', title: 'Sledgehammer Funny Parody', channel: 'Comedy Tube', durationSec: 240 }, // Rejected: Rule 3 (parody)
  ],
};

function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

function padRight(str: string, width: number): string {
  const s = truncate(str, width);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function padLeft(str: string, width: number): string {
  const s = truncate(str, width);
  return ' '.repeat(Math.max(0, width - s.length)) + s;
}

function printDivider(char = '-', len = 130) {
  console.log(char.repeat(len));
}

async function runTest() {
  console.log('\n==================================================================================================');
  console.log('               RETRO FM: HISTORICAL SONG PROGRAMMING VALIDATION TEST');
  console.log('==================================================================================================');

  const hasApiKey = Boolean(process.env.YOUTUBE_API_KEY);
  if (hasApiKey) {
    console.log('✓ YOUTUBE_API_KEY detected. Running live searches via YouTube Data API v3 + MusicBrainz.');
  } else {
    console.log('ℹ Notice: YOUTUBE_API_KEY is not set in environment.');
    console.log('  Testing live MusicBrainz queries + candidate ranking & hard rejection rule validation.');
    console.log('  (To run against live YouTube API, set YOUTUBE_API_KEY in .env or run: YOUTUBE_API_KEY=... npm run test:music)');
  }
  console.log('==================================================================================================\n');

  const overrides = loadOverrides();
  clearSearchCache();
  console.log('✓ In-memory search cache cleared.');

  for (let i = 0; i < TEST_CASES.length; i++) {
    const { artist, song, year } = TEST_CASES[i];
    const key = `${artist.toLowerCase()}|${song.toLowerCase()}`;

    console.log(`\n--------------------------------------------------------------------------------------------------`);
    console.log(`TEST SONG #${i + 1}: ${artist} — "${song}" (${year})`);
    console.log(`--------------------------------------------------------------------------------------------------`);

    // 1. MusicBrainz Lookup
    process.stdout.write(`Fetching MusicBrainz canonical data for "${artist} - ${song}" (${year})... `);
    const mbInfo = await lookupMusicBrainz(artist, song, year);
    if (mbInfo && mbInfo.canonicalLengthSec) {
      console.log(`✓ Found! Canonical Year: ${mbInfo.canonicalYear || 'N/A'}, Canonical Length: ${formatDuration(mbInfo.canonicalLengthSec)} (${mbInfo.canonicalLengthSec}s)`);
    } else {
      console.log(`(No exact MusicBrainz duration found within +/-1 yr, using 2:00 - 9:00 window constraint)`);
    }

    // 2. Overrides check
    if (overrides[key]) {
      console.log(`Override Configured: videoId = "${overrides[key]}" (src/services/music/overrides.json)`);
    }

    // 3. Candidates Gathering & Scoring
    let topCandidates: CandidateVideo[] = [];
    let chosenVideo: CandidateVideo | null = null;
    let notFoundMessage: string | null = null;

    if (hasApiKey) {
      // Execute live YouTube Data API search (bypassing overrides to test the search algorithm directly)
      const searchRes = await searchYouTubeForSong(artist, song, year, { skipOverrides: true, skipCache: true });
      if (searchRes.success && searchRes.selected) {
        chosenVideo = {
          ...searchRes.selected,
          score: (searchRes.selected as any).confidenceScore ?? 1200,
        } as any;
        topCandidates = searchRes.candidates && searchRes.candidates.length > 0 ? [...searchRes.candidates] : [];
        if (searchRes.rejectedCandidates && topCandidates.length < 5) {
          topCandidates = [...topCandidates, ...searchRes.rejectedCandidates].slice(0, 5);
        }
      } else if (searchRes.status === 'error' && (searchRes.error?.includes('429') || searchRes.error?.includes('Quota exceeded'))) {
        console.log(`YouTube Data API quota exceeded (HTTP 429). Evaluating fixture candidates to demonstrate rule enforcement...`);
        const fixtures = CANDIDATE_FIXTURES[key] || [];
        const scoredList = fixtures.map((v) =>
          scoreCandidateVideo(
            {
              videoId: v.videoId,
              title: v.title,
              channel: v.channel,
              durationSec: v.durationSec,
              durationStr: formatDuration(v.durationSec),
            },
            artist,
            song,
            mbInfo,
            year
          )
        );

        const survivors = scoredList.filter((c) => c.isPassed).sort((a, b) => b.score - a.score);
        const rejected = scoredList.filter((c) => !c.isPassed);
        const officialSurvivors = survivors.filter(
          (c) => c.rankCategory === 'TOPIC' || c.rankCategory === 'OFFICIAL_CHANNEL_OR_VEVO'
        );

        if (officialSurvivors.length === 0) {
          const lowerTierRejected: CandidateVideo[] = survivors.map((c) => ({
            ...c,
            isPassed: false,
            rejectionReason: `Lower-tier upload (${c.rankCategory}); only Tier 1 (Topic) and Tier 2 (Official / VEVO) qualify for automatic selection`,
            reason: `Rejected: Channel "${c.channel}" is a lower-tier upload (${c.rankCategory}). Only Tier 1 (Topic) and Tier 2 (Official / VEVO) qualify for automatic selection.`,
          }));
          const allRejected = [...rejected, ...lowerTierRejected];
          topCandidates = allRejected.slice(0, 5);
          chosenVideo = null;
          notFoundMessage = `No trustworthy recording found for ${artist} - ${song}. Nothing was played.`;
        } else {
          chosenVideo = officialSurvivors[0];
          topCandidates = [...officialSurvivors, ...rejected].slice(0, 5);
        }
      } else {
        notFoundMessage = searchRes.error || `No trustworthy recording found for ${artist} - ${song}. Nothing was played.`;
        console.log(`Search result status: ${searchRes.status.toUpperCase()}`);
        console.log(`Notice: ${notFoundMessage}`);
        if (searchRes.rejectedCandidates && searchRes.rejectedCandidates.length > 0) {
          topCandidates = searchRes.rejectedCandidates.slice(0, 5);
        } else if (searchRes.candidates) {
          topCandidates = searchRes.candidates.slice(0, 5);
        }
      }
    } else {
      // Use candidate fixtures to demonstrate scoring & rule enforcement
      const fixtures = CANDIDATE_FIXTURES[key] || [];
      const scoredList = fixtures.map((v) =>
        scoreCandidateVideo(
          {
            videoId: v.videoId,
            title: v.title,
            channel: v.channel,
            durationSec: v.durationSec,
            durationStr: formatDuration(v.durationSec),
          },
          artist,
          song,
          mbInfo,
          year
        )
      );

      const survivors = scoredList.filter((c) => c.isPassed).sort((a, b) => b.score - a.score);
      const rejected = scoredList.filter((c) => !c.isPassed);

      topCandidates = [...survivors, ...rejected].slice(0, 5);
      chosenVideo = survivors.length > 0 ? survivors[0] : null;
    }

    // 4. Print Candidates Table
    printDivider('-', 130);
    console.log(
      `${padRight('Status', 10)} | ${padRight('Title', 38)} | ${padRight('Channel', 24)} | ${padRight('Dur', 6)} | ${padLeft('Score', 6)} | ${padRight('Evaluation Reason', 36)}`
    );
    printDivider('-', 130);

    for (let cIdx = 0; cIdx < topCandidates.length; cIdx++) {
      const c = topCandidates[cIdx];
      const isChosen = chosenVideo && chosenVideo.videoId === c.videoId;
      const statusStr = isChosen ? '★ CHOSEN' : (c.isPassed && chosenVideo) ? `#${cIdx + 1} PASS` : 'REJECTED';

      console.log(
        `${padRight(statusStr, 10)} | ${padRight(c.title, 38)} | ${padRight(c.channel, 24)} | ${padRight(c.duration || '--:--', 6)} | ${padLeft(c.score.toString(), 6)} | ${truncate(c.reason, 36)}`
      );
    }
    printDivider('-', 130);

    // 5. Print Result Summary
    if (chosenVideo) {
      console.log(`\nRESULT FOR ${artist} — "${song}":`);
      console.log(`  ▶ Status         : VERIFIED CHOSEN`);
      console.log(`  ▶ Selected Title : "${chosenVideo.title}"`);
      console.log(`  ▶ Channel        : "${chosenVideo.channel}"`);
      console.log(`  ▶ Video ID       : ${chosenVideo.videoId}`);
      console.log(`  ▶ URL            : https://www.youtube.com/watch?v=${chosenVideo.videoId}`);
      console.log(`  ▶ Score          : ${chosenVideo.score}`);
      console.log(`  ▶ Full Reason    : ${chosenVideo.reason}`);
    } else {
      console.log(`\nRESULT FOR ${artist} — "${song}":`);
      console.log(`  ▶ Status         : NOT FOUND`);
      console.log(`  ▶ Notice         : ${notFoundMessage || `No trustworthy recording found for ${artist} - ${song}. Nothing was played.`}`);
    }

    // Delay between iterations to respect MusicBrainz 1 req/sec rate limit
    await new Promise((resolve) => setTimeout(resolve, 1300));
  }

  console.log('\n==================================================================================================');
  console.log('                                ALL 5 TEST CASES COMPLETED');
  console.log('==================================================================================================\n');
}

runTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

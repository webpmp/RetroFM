/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CandidateVideo {
  videoId: string;
  title: string;
  channel: string;
  badges: string[];
  duration?: string;
  score: number;
  reason: string;
  disqualified?: string;
}

export interface SongSearchResult {
  success: boolean;
  selected?: {
    title: string;
    videoId: string;
    channel: string;
    url: string;
    duration?: string;
    confidenceScore: number;
    reason: string;
  };
  candidatesCount?: number;
  candidates?: CandidateVideo[];
  error?: string;
}

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Scores a YouTube video candidate according to historical music programming rules:
 * - Prefers official studio/original release
 * - Strongly penalizes covers, karaoke, reactions, interviews, news clips
 * - Penalizes live recordings when studio version is requested
 * - Evaluates channel match and official artist badges
 */
export function scoreCandidate(
  video: { title: string; channel: string; badges: string[]; duration?: string },
  artist: string,
  song: string,
  year?: string
): { score: number; reason: string; disqualified?: string } {
  const tLower = (video.title || '').toLowerCase();
  const cLower = (video.channel || '').toLowerCase();
  const aNorm = normalize(artist);
  const sNorm = normalize(song);
  const tNorm = normalize(video.title || '');
  const cNorm = normalize(video.channel || '');

  let score = 0;
  const reasons: string[] = [];

  // 1. Disqualification and heavy penalty terms
  const negativeTerms = [
    'cover',
    'karaoke',
    'reaction',
    'reacts',
    'reacting',
    'interview',
    'news',
    'tribute',
    'parody',
    'acoustic cover',
    'guitar cover',
    'drum cover',
    'dance cover',
    'review',
    'lesson',
    'tutorial',
    'how to play',
    'behind the scenes',
    'making of',
    'documentary',
    '1 hour',
    '1hour',
    '10 hours',
    'loop',
    'synthesia',
    'midi tutorial',
    'instrumental cover',
    'soundtrack review',
  ];

  for (const term of negativeTerms) {
    if (tLower.includes(term) && !song.toLowerCase().includes(term)) {
      return {
        score: -999,
        reason: `Disqualified: contains non-recording keyword "${term}"`,
        disqualified: term,
      };
    }
  }

  // 2. Live recording penalty (unless user explicitly asked for a live track)
  const isLiveRequested = song.toLowerCase().includes('live');
  if (!isLiveRequested) {
    const liveTerms = [
      'live at',
      'live in',
      'live from',
      'live concert',
      'live performance',
      'live 19',
      'live 20',
      'live tour',
      'live on',
      'live show',
    ];
    for (const term of liveTerms) {
      if (tLower.includes(term)) {
        score -= 160;
        reasons.push(`Live recording penalty ("${term}")`);
        break;
      }
    }
  }

  // 3. Official Artist Channel / Verification Badges
  if (video.badges && video.badges.some((b) => b.includes('Official Artist Channel'))) {
    score += 110;
    reasons.push('Official Artist Channel badge (+110)');
  } else if (video.badges && video.badges.some((b) => b.includes('Verified'))) {
    score += 45;
    reasons.push('Verified channel badge (+45)');
  }

  // 4. Channel Name Match
  if (cNorm === aNorm || cNorm.includes(aNorm) || aNorm.includes(cNorm)) {
    score += 85;
    reasons.push('Channel matches artist (+85)');
  } else if (cLower.includes('vevo') || cLower.includes('topic') || cLower.includes('records') || cLower.includes('music')) {
    score += 55;
    reasons.push('Record label / VEVO / Topic channel (+55)');
  }

  // 5. Title Match (Song & Artist)
  if (tNorm.includes(sNorm)) {
    score += 70;
    reasons.push('Title contains song name (+70)');
  }
  if (tNorm.includes(aNorm)) {
    score += 45;
    reasons.push('Title contains artist name (+45)');
  }

  // 6. Keywords indicating official audio/video recording
  const officialKeywords = [
    'official video',
    'official music video',
    'official audio',
    'remastered',
    'single version',
    'original version',
    'hd version',
    '4k',
  ];
  for (const kw of officialKeywords) {
    if (tLower.includes(kw)) {
      score += 35;
      reasons.push(`Official release indicator "${kw}" (+35)`);
      break;
    }
  }

  // 7. Historical Year validation / boost
  if (year && year.trim()) {
    const y = year.trim();
    if (tLower.includes(y)) {
      score += 25;
      reasons.push(`Historical year match ${y} (+25)`);
    }
  }

  return {
    score,
    reason: reasons.length > 0 ? reasons.join('; ') : 'Basic match',
  };
}

/**
 * Searches YouTube for official song recording matching the criteria
 */
export async function searchYouTubeForSong(
  artist: string,
  song: string,
  year?: string
): Promise<SongSearchResult> {
  const cleanArtist = artist.trim();
  const cleanSong = song.trim();
  const cleanYear = year ? year.trim() : '';

  if (!cleanArtist || !cleanSong) {
    return {
      success: false,
      error: 'Both artist and song are required to search for a recording.',
    };
  }

  // Build query designed to locate original release
  const query = `${cleanArtist} ${cleanSong} ${cleanYear} official music video audio`.trim();

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `YouTube search request returned HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/);

    if (!match) {
      return {
        success: false,
        error: 'Unable to parse YouTube search response data structure.',
      };
    }

    const data = JSON.parse(match[1]);
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]
        ?.itemSectionRenderer?.contents;

    if (!contents || !Array.isArray(contents)) {
      return {
        success: false,
        error: 'No video results returned by YouTube for this query.',
      };
    }

    const rawVideos: Array<{
      videoId: string;
      title: string;
      channel: string;
      badges: string[];
      duration?: string;
    }> = [];

    for (const item of contents) {
      const v = item.videoRenderer;
      if (v && v.videoId) {
        rawVideos.push({
          videoId: v.videoId,
          title: v.title?.runs?.[0]?.text || '',
          channel: v.ownerText?.runs?.[0]?.text || '',
          badges: v.ownerBadges?.map((b: any) => b.metadataBadgeRenderer?.tooltip).filter(Boolean) || [],
          duration: v.lengthText?.simpleText || '',
        });
      }
    }

    if (rawVideos.length === 0) {
      return {
        success: false,
        error: `No playable videos found on YouTube for "${cleanArtist} - ${cleanSong}".`,
      };
    }

    // Score and rank candidates
    const scoredCandidates: CandidateVideo[] = rawVideos
      .map((v) => {
        const { score, reason, disqualified } = scoreCandidate(v, cleanArtist, cleanSong, cleanYear);
        return {
          ...v,
          score,
          reason,
          disqualified,
        };
      })
      .filter((c) => !c.disqualified && c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scoredCandidates.length === 0) {
      return {
        success: false,
        error: `No suitable official recording found for "${cleanArtist} - ${cleanSong}". All search results were covers, karaoke, or non-recordings.`,
      };
    }

    const topMatch = scoredCandidates[0];

    // Verify confidence threshold
    if (topMatch.score < 50) {
      return {
        success: false,
        error: `Match confidence too low (score: ${topMatch.score}) to guarantee authentic recording of "${cleanArtist} - ${cleanSong}".`,
      };
    }

    return {
      success: true,
      selected: {
        title: topMatch.title,
        videoId: topMatch.videoId,
        channel: topMatch.channel,
        url: `https://www.youtube.com/watch?v=${topMatch.videoId}`,
        duration: topMatch.duration,
        confidenceScore: topMatch.score,
        reason: topMatch.reason,
      },
      candidatesCount: scoredCandidates.length,
      candidates: scoredCandidates.slice(0, 5),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Error searching YouTube: ${err?.message || 'Network exception'}`,
    };
  }
}

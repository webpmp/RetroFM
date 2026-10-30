/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Hand-off bank with group-based variety and selection rules.
 *
 * Rules:
 * - Pick a group at random (1-6), then a template in it.
 * - Never use the same group twice in a row.
 * - Never repeat a template within the last 12 breaks of the session.
 * - Items marked [OLD SONGS ONLY] are used only when the song first charted
 *   at least 12 months before the broadcast date (use first_chart_date).
 * - Never use the phrase "let's hear" anywhere in a hand-off, except the exact
 *   template "Let's hear it for ArtistName with SongTitle."
 * - SongTitle is the title exactly as stored in the library (never uppercased or reformatted).
 * - ArtistName is the spoken artist name (primary_artist, with duets cleaned to "and").
 * - Station name (RetroFM) is NOT part of hand-offs. It is added optionally as a separate station ID.
 */

import { cleanDuetArtist } from './chartFacts.js';

export interface HandoffTemplate {
  template: string;
  oldSongsOnly?: boolean;
}

export interface HandoffGroup {
  id: number;
  name: string;
  templates: HandoffTemplate[];
}

export const HANDOFF_GROUPS: HandoffGroup[] = [
  {
    id: 1,
    name: 'Classic Radio DJ',
    templates: [
      { template: "Coming up, it's SongTitle by ArtistName." },
      { template: "This one's from ArtistName, SongTitle." },
      { template: "Up next, ArtistName with SongTitle." },
      { template: "Here's a good one, SongTitle by ArtistName." },
      { template: "Time for SongTitle by ArtistName." },
      { template: "Let's get back to the music with SongTitle by ArtistName." },
      { template: "Check this one out, SongTitle by ArtistName." },
    ],
  },
  {
    id: 2,
    name: 'Casual and Conversational',
    templates: [
      { template: "We've got ArtistName coming up with SongTitle." },
      { template: "Let's give SongTitle by ArtistName a spin." },
      { template: "Turn it up for ArtistName and SongTitle." },
      { template: "Got a great track for you from ArtistName, SongTitle." },
      { template: "Let's take a listen to SongTitle by ArtistName." },
      { template: "This is ArtistName with SongTitle." },
      { template: "This one's always worth another listen, SongTitle by ArtistName.", oldSongsOnly: true },
      { template: "I think you'll recognize this one, SongTitle by ArtistName.", oldSongsOnly: true },
    ],
  },
  {
    id: 3,
    name: 'Enthusiastic DJ',
    templates: [
      { template: "Turn it up! ArtistName with SongTitle." },
      { template: "Get ready for SongTitle by ArtistName." },
      { template: "Coming your way, ArtistName and SongTitle." },
      { template: "Don't touch that dial. Here's ArtistName with SongTitle." },
      { template: "Let's crank it up with SongTitle by ArtistName." },
      { template: "This one's got some energy. ArtistName with SongTitle." },
    ],
  },
  {
    id: 4,
    name: 'Smooth, Laid-Back DJ',
    templates: [
      { template: "Let's ease into this one with ArtistName and SongTitle." },
      { template: "Enjoy SongTitle by ArtistName." },
      { template: "Settling in with SongTitle by ArtistName." },
      { template: "A little something from ArtistName, SongTitle." },
      { template: "Let's spend a few minutes with ArtistName and SongTitle." },
      { template: "Coming through the speakers, SongTitle by ArtistName." },
      { template: "Take a listen to ArtistName with SongTitle." },
    ],
  },
  {
    id: 5,
    name: 'Short Introductions',
    templates: [
      { template: "ArtistName, SongTitle." },
      { template: "This is SongTitle by ArtistName." },
      { template: "Here's ArtistName with SongTitle." },
      { template: "ArtistName coming at you with SongTitle." },
      { template: "Listen to SongTitle by ArtistName." },
      { template: "Let's hear it for ArtistName with SongTitle." },
    ],
  },
  {
    id: 6,
    name: 'Distinctive Radio Phrasing',
    templates: [
      { template: "Straight from ArtistName, it's SongTitle." },
      { template: "On the turntable, ArtistName with SongTitle." },
      { template: "Making its way onto the playlist, SongTitle by ArtistName." },
      { template: "Let's roll with ArtistName and SongTitle." },
      { template: "Another great track from ArtistName, SongTitle.", oldSongsOnly: true },
      { template: "Taking us back with SongTitle by ArtistName.", oldSongsOnly: true },
    ],
  },
];

/**
 * Checks if a song is an "old song" (first charted at least 12 months before broadcastDate).
 */
export function isSongOld(firstChartDate: string | null | undefined, broadcastDate: string): boolean {
  if (!firstChartDate || !/^\d{4}-\d{2}-\d{2}$/.test(firstChartDate)) return false;
  if (!broadcastDate || !/^\d{4}-\d{2}-\d{2}$/.test(broadcastDate)) return false;

  const [by, bm, bd] = broadcastDate.split('-').map(Number);
  const [cy, cm, cd] = firstChartDate.split('-').map(Number);

  const monthsDiff = (by - cy) * 12 + (bm - cm) + (bd < cd ? -1 : 0);
  return monthsDiff >= 12;
}

export interface BuildHandoffOptions {
  songTitle: string;
  artistName: string;
  primaryArtist?: string | null;
  firstChartDate?: string | null;
  broadcastDate: string;
  lastHandoffGroup?: number | null;
  recentTemplates?: string[]; // Last up to 12 templates
}

export interface HandoffResult {
  text: string;
  chosenGroup: number;
  chosenTemplate: string;
}

/**
 * Builds a single hand-off string obeying group alternation and 12-break template recency.
 */
export function buildHandoff(options: BuildHandoffOptions): HandoffResult {
  const {
    songTitle,
    artistName,
    primaryArtist,
    firstChartDate,
    broadcastDate,
    lastHandoffGroup,
    recentTemplates = [],
  } = options;

  const cleanArtist = cleanDuetArtist(primaryArtist || artistName || 'Unknown');
  const isOld = isSongOld(firstChartDate, broadcastDate);

  // Eligible groups: all groups except lastHandoffGroup (1-6)
  const availableGroups = HANDOFF_GROUPS.filter((g) => g.id !== lastHandoffGroup);
  // Pick group randomly (or cycle if shuffled)
  const candidateGroups = availableGroups.length > 0 ? availableGroups : HANDOFF_GROUPS;

  // Shuffle candidate groups to pick at random
  const shuffledGroups = [...candidateGroups].sort(() => Math.random() - 0.5);

  let selectedGroup = shuffledGroups[0];
  let selectedTemplate: HandoffTemplate | null = null;

  for (const group of shuffledGroups) {
    // Filter templates in this group: check oldSongsOnly and 12-break recency
    const validTemplates = group.templates.filter((t) => {
      if (t.oldSongsOnly && !isOld) return false;
      if (recentTemplates.includes(t.template)) return false;
      return true;
    });

    if (validTemplates.length > 0) {
      selectedGroup = group;
      selectedTemplate = validTemplates[Math.floor(Math.random() * validTemplates.length)];
      break;
    }
  }

  // Fallback if all templates in all other groups were recently used
  if (!selectedTemplate) {
    for (const group of shuffledGroups) {
      const validTemplates = group.templates.filter((t) => {
        if (t.oldSongsOnly && !isOld) return false;
        return true;
      });
      if (validTemplates.length > 0) {
        selectedGroup = group;
        selectedTemplate = validTemplates[Math.floor(Math.random() * validTemplates.length)];
        break;
      }
    }
  }

  // Absolute fallback
  if (!selectedTemplate) {
    selectedGroup = HANDOFF_GROUPS[0];
    selectedTemplate = HANDOFF_GROUPS[0].templates[0];
  }

  // Substitute SongTitle and ArtistName
  const rendered = selectedTemplate.template
    .replace(/SongTitle/g, `"${songTitle}"`)
    .replace(/ArtistName/g, cleanArtist);

  return {
    text: rendered,
    chosenGroup: selectedGroup.id,
    chosenTemplate: selectedTemplate.template,
  };
}

/**
 * Resolves orphan pronoun opening in a draft script:
 * "If a break's first sentence starts with They, He, She, It, Their, His, Her, Its, This or These,
 * and the antecedent is the next song's artist or title, replace the pronoun in code with the artist name or song title
 * (for example "Spice Girls co-wrote the track alongside Matt Rowe and Richard Biff Stannard.").
 * If the antecedent is not clear, return null so it can be regenerated or dropped."
 */
export function resolveOrphanPronounOpening(
  scriptText: string,
  targetSongTitle?: string | null,
  targetSongArtist?: string | null
): { resolvedText: string; replaced: boolean; reason?: string } {
  if (!scriptText || typeof scriptText !== 'string') {
    return { resolvedText: scriptText, replaced: false };
  }

  const sentences = scriptText.split(/(?<=[.!?])\s+/);
  if (sentences.length === 0) return { resolvedText: scriptText, replaced: false };

  const firstSent = sentences[0].trim();
  const ORPHAN_MATCH = firstSent.match(/^(They|He|She|It|Their|His|Her|Its|This|These)\b/i);

  if (!ORPHAN_MATCH) {
    return { resolvedText: scriptText, replaced: false };
  }

  const pronoun = ORPHAN_MATCH[1];
  const pronounLower = pronoun.toLowerCase();

  // Determine if antecedent is clearly artist or song
  const artist = (targetSongArtist || '').trim();
  const title = (targetSongTitle || '').trim();

  // If both are missing, antecedent cannot be resolved
  if (!artist && !title) {
    return { resolvedText: scriptText, replaced: false, reason: `Orphan pronoun "${pronoun}" with no target song metadata` };
  }

  let replacement = '';
  // Pronouns referring to musical acts / artists: They, He, She, Their, His, Her
  if (['they', 'he', 'she'].includes(pronounLower)) {
    if (artist) {
      replacement = cleanDuetArtist(artist);
    }
  } else if (['their', 'his', 'her'].includes(pronounLower)) {
    if (artist) {
      const cleaned = cleanDuetArtist(artist);
      replacement = cleaned.endsWith('s') ? `${cleaned}'` : `${cleaned}'s`;
    }
  } else if (['it', 'this', 'these', 'its'].includes(pronounLower)) {
    // If first sentence talks about track/song/cut or album, antecedent is the song
    if (/\b(?:track|song|single|cut|album|record)\b/i.test(firstSent)) {
      if (pronounLower === 'its') {
        replacement = title ? `"${title}"'s` : (artist ? `${artist}'s` : '');
      } else {
        replacement = title ? `"${title}"` : (artist ? cleanDuetArtist(artist) : '');
      }
    } else if (artist) {
      // e.g. band referred to as "This" or "It"
      replacement = cleanDuetArtist(artist);
    } else if (title) {
      replacement = `"${title}"`;
    }
  }

  if (!replacement) {
    return { resolvedText: scriptText, replaced: false, reason: `Antecedent not clear for orphan pronoun "${pronoun}"` };
  }

  // Replace leading pronoun in first sentence
  const newFirstSent = firstSent.replace(/^(They|He|She|It|Their|His|Her|Its|This|These)\b/i, replacement);
  sentences[0] = newFirstSent;
  const resolvedText = sentences.join(' ');

  return { resolvedText, replaced: true };
}


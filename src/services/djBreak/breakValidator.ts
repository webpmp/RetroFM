/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Deterministic break output validator and rejection check.
 * Rules:
 * 1. Banned patterns:
 *    - "one of my favorites"
 *    - "gets me every time"
 *    - Rhetorical openers: "did you know" and "you remember this one"
 *      must not appear on more than ~1 break in 5 (20%).
 * 2. Personal feelings or favorites:
 *    - Rejects subjective feelings ("I love", "my favorite", "can't help it", "gets me").
 * 3. Dates after selected broadcast date:
 *    - Rejects any 4-digit year > selectedDate.year.
 * 4. Grounding verification:
 *    - Every number, year, and proper name in the output MUST appear in the
 *      fact packet or song metadata.
 * 5. A rejected break becomes SILENCE, never a retry loop.
 */

export function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface FactPacketData {
  factText: string;
  source: string;
  date: string;
}

export interface SegmentValidationContext {
  selectedDate: string; // YYYY-MM-DD
  factPacket: {
    facts: Array<{ text: string; source?: string; date?: string }>;
    targetSongTitle?: string;
    targetSongArtist?: string;
  };
  isModelDraft?: boolean; // When true, model script must not contain hand-offs or target song title
}

/**
 * Loosened validator for rich 30-60 second DJ segments (80-150 words):
 * 1. Every year, number, and proper name must appear in the packet or target song metadata.
 * 2. No date/year after the broadcast date.
 * 3. No first-person feelings, nostalgia, or personal memories (e.g. "I love", "my favorite", "takes me back").
 * 4. No banned hype words or artificial transitions ("smash hit", "absolute banger", "stay tuned", "coming up next").
 * 5. Does NOT require every content word to match the packet (allows natural conversational connective tissue).
 */
export function validateSegmentBreakOutput(
  scriptText: string,
  context: SegmentValidationContext
): ValidationResult {
  if (!scriptText || typeof scriptText !== 'string') {
    return {
      valid: false,
      rejectedReason: 'Empty script text',
      sanitizedText: '',
    };
  }

  const trimmed = scriptText.trim().replace(/^["']|["']$/g, '');

  // 1. Length check: Scaled to fact packet size (~20-25 words per fact, max +35% padding)
  const factCount = Math.max(1, (context.factPacket.facts || []).length);
  const minExpectedWords = Math.max(25, factCount * 18);
  const maxExpectedWords = Math.round(factCount * 25 * 1.35) + 15;
  const words = trimmed.split(/\s+/).filter(Boolean);

  if (words.length > maxExpectedWords) {
    return {
      valid: false,
      rejectedReason: `Segment padded / too long: ${words.length} words (packet with ${factCount} facts supports at most ~${maxExpectedWords} words)`,
      sanitizedText: '',
    };
  }

  // 3a. Check repeated sentences in segment
  const sentencesInSegment = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 5);
  const seenSentences = new Set<string>();
  for (const s of sentencesInSegment) {
    if (seenSentences.has(s)) {
      return {
        valid: false,
        rejectedReason: `Repeated sentence found in segment: "${s}"`,
        sanitizedText: '',
      };
    }
    seenSentences.add(s);
  }

  // 3a2. Model draft check & target song title in hand-offs:
  // "The validator must reject any model script that contains the next song's title or a hand-off phrase,
  // because only code adds hand-offs."
  const HANDOFF_PHRASE_PATTERNS = [
    /\b(?:coming up|this one's from|up next|here's a good one|time for|let's get back to the music|check this one out)\b/i,
    /\b(?:we've got|let's give|turn it up|got a great track|let's take a listen|this is)\b/i,
    /\b(?:get ready for|coming your way|don't touch that dial|let's crank it up|this one's got some energy)\b/i,
    /\b(?:let's ease into|enjoy|settling in with|a little something from|let's spend a few minutes|coming through the speakers|take a listen to)\b/i,
    /\b(?:coming at you with|listen to|let's hear it for)\b/i,
    /\b(?:straight from|on the turntable|making its way onto the playlist|let's roll with|another great track from|taking us back with)\b/i,
    /\b(?:now on retrofm|here on retrofm|spinning now|let's hear|here is|right now|playing now|switching gears|turning to)\b/i,
  ];

  if (context.isModelDraft) {
    // If the topic is next_song_story, the fact packet itself is about the song, so mentioning the song title
    // in commentary (e.g. "Michael Jackson released 'Don't Stop 'Til You Get Enough' in 1979") is natural,
    // but hand-off phrases or placing the title at the end as an intro must be rejected.
    // For other break types (music_news, major_news, sports), the model must never mention the next song's title.
    if (context.factPacket.targetSongTitle) {
      const titleRegex = new RegExp(escapeRegex(context.factPacket.targetSongTitle), 'i');
      if (context.factPacket.facts && !(context as any).factPacket.topic?.includes('next_song_story')) {
        if (titleRegex.test(trimmed)) {
          return {
            valid: false,
            rejectedReason: `Model draft contains next song's title ("${context.factPacket.targetSongTitle}"); only code adds hand-offs`,
            sanitizedText: '',
          };
        }
      }
    }
    for (const hp of HANDOFF_PHRASE_PATTERNS) {
      if (hp.test(trimmed)) {
        return {
          valid: false,
          rejectedReason: `Model draft contains hand-off phrase (${hp}); only code adds hand-offs`,
          sanitizedText: '',
        };
      }
    }
  }

  // Check if target song title appears in more than one hand-off or ending sentence
  if (context.factPacket.targetSongTitle) {
    const titleRegex = new RegExp(escapeRegex(context.factPacket.targetSongTitle), 'i');
    const handoffSentencesWithTitle = sentencesInSegment.filter((s) => {
      const isHandoffStyle = /\b(?:now on retrofm|here on retrofm|spinning now|let's hear|here is|right now|playing now)\b/i.test(s) ||
        HANDOFF_PHRASE_PATTERNS.some((pat) => pat.test(s));
      return isHandoffStyle && titleRegex.test(s);
    });
    if (handoffSentencesWithTitle.length > 1) {
      return {
        valid: false,
        rejectedReason: `Target song title appears in ${handoffSentencesWithTitle.length} hand-off sentences`,
        sanitizedText: '',
      };
    }
  }

  // 1b. Weekday check: Validate spoken weekday against calendar date or article event dates
  // Requirement 4: accept a weekday that matches the weekday of the event date resolved from the article
  // or appears in the packet consistently; reject only a weekday that contradicts the packet.
  const [y, m, d] = context.selectedDate.split('-').map(Number);
  const calDate = new Date(Date.UTC(y, m - 1, d));
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const expectedBroadcastWeekday = WEEKDAY_NAMES[calDate.getUTCDay()];

  // Collect permissible weekdays from packet dates and fact text
  const permissibleWeekdays = new Set<string>([expectedBroadcastWeekday.toLowerCase()]);
  for (const f of context.factPacket.facts || []) {
    const fDate = (f as any).printDate || (f as any).date || (f as any).eventDate;
    if (fDate && /^\d{4}-\d{2}-\d{2}$/.test(fDate)) {
      const [fy, fm, fd] = fDate.split('-').map(Number);
      const factCal = new Date(Date.UTC(fy, fm - 1, fd));
      const fDay = WEEKDAY_NAMES[factCal.getUTCDay()];
      if (fDay) permissibleWeekdays.add(fDay.toLowerCase());
    }
    // Also check if any weekday is explicitly mentioned in the fact text
    for (const wd of WEEKDAY_NAMES) {
      if (new RegExp(`\\b${wd}\\b`, 'i').test(f.text)) {
        permissibleWeekdays.add(wd.toLowerCase());
      }
    }
  }

  const forbiddenWeekdays = WEEKDAY_NAMES.filter((w) => !permissibleWeekdays.has(w.toLowerCase()));

  for (const other of forbiddenWeekdays) {
    const wdRegex = new RegExp(`\\b${other}\\b`, 'i');
    const match = trimmed.match(wdRegex);
    if (match) {
      return {
        valid: false,
        rejectedReason: `Contradictory weekday: found "${match[0]}" which contradicts the packet event dates and broadcast date ${context.selectedDate}`,
        sanitizedText: '',
      };
    }
  }

  // 2. First-person feelings, nostalgia, or personal memories check
  // Also reject feelings attributed to a subject ("that he loves", "loves", "he loves") unless in fact packet
  // Strip all song titles and artist names before personal-feeling check (e.g. "P.S. I Love You")
  let textForFeelingCheck = trimmed;
  if (context.factPacket.targetSongTitle) {
    textForFeelingCheck = textForFeelingCheck.replace(new RegExp(escapeRegex(context.factPacket.targetSongTitle), 'gi'), ' ');
  }
  for (const f of context.factPacket.facts || []) {
    const quotedTitles = f.text.match(/"([^"]+)"/g);
    if (quotedTitles) {
      for (const qt of quotedTitles) {
        textForFeelingCheck = textForFeelingCheck.replace(new RegExp(escapeRegex(qt.replace(/"/g, '')), 'gi'), ' ');
      }
    }
  }

  const PERSONAL_FEELING_PATTERNS = [
    /\b(?:one of my favorites?|my (?:absolute )?favorite)\b/i,
    /\b(?:i (?:always )?loved?|i really love|i just love)\b/i,
    /\b(?:takes? me back|brings? back memories)\b/i,
    /\b(?:i remember when|i recall when)\b/i,
    /\b(?:gets me every time|can't get enough)\b/i,
    /\b(?:i was thinking|my personal opinion)\b/i,
  ];
  for (const pat of PERSONAL_FEELING_PATTERNS) {
    if (pat.test(textForFeelingCheck)) {
      return {
        valid: false,
        rejectedReason: `Contains personal feeling or memory: ${pat}`,
        sanitizedText: '',
      };
    }
  }

  // Reject feelings attributed to a subject ("that he loves", "loves", "she loves") unless that exact claim is in the packet
  const SUBJECT_FEELING_PATTERNS = [
    /\b(?:that (?:he|she|they) loves?|(?:he|she|they) (?:really )?loves?)\b/i,
  ];
  const packetHasLove = (context.factPacket.facts || []).some((f) => /\bloves?\b/i.test(f.text));
  if (!packetHasLove) {
    for (const pat of SUBJECT_FEELING_PATTERNS) {
      if (pat.test(textForFeelingCheck)) {
        return {
          valid: false,
          rejectedReason: `Attributed unverified feelings to subject ("${textForFeelingCheck.match(pat)?.[0]}") not in fact packet`,
          sanitizedText: '',
        };
      }
    }
  }

  // 3. Check banned hype words, cliches, and intensifiers
  // Reject: astonishing, amazing, incredible, unique, remarkable, stunning, surprising, fresh, pretty unique
  const BANNED_HYPE = [
    /\b(?:absolute banger|banger|total bop)\b/i,
    /\b(?:smash hit|chart topper|chart-topper)\b/i,
    /\b(?:iconic|legendary|masterpiece)\b/i,
    /\b(?:epic|insane|mind-blowing)\b/i,
    /\b(?:total vibe|good vibes)\b/i,
    /\b(?:astonishing|amazing|incredible|unique|remarkable|stunning|surprising)\b/i,
    /\b(?:fresh|pretty unique)\b/i,
  ];
  for (const pat of BANNED_HYPE) {
    if (pat.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains banned hype or intensifier: ${pat}`,
        sanitizedText: '',
      };
    }
  }

  // 3b. Check unconverted relative time words from newspaper reporting
  // Note: "this week" is legitimate for radio DJs referring to the weekly chart ("Hot 100 this week");
  // unconverted news-report relative time terms are "last night", "yesterday", "this morning", "today", "tomorrow".
  const RELATIVE_TIME_WORDS = [
    /\b(?:last night|yesterday|this morning|today|tomorrow)\b/i,
  ];
  for (const pat of RELATIVE_TIME_WORDS) {
    if (pat.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains unconverted relative time word: ${pat}`,
        sanitizedText: '',
      };
    }
  }

  // 3c. Check evaluative language, journalistic opinion, and subjective adjectives
  const EVALUATIVE_WORDS = [
    /\b(?:unexpected grace|scandals?|publicity stunts?|bizarre|controversial|notorious)\b/i,
  ];
  for (const pat of EVALUATIVE_WORDS) {
    if (pat.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains evaluative or opinion language: ${pat}`,
        sanitizedText: '',
      };
    }
  }

  // 3d. Check exclamation points
  if (trimmed.includes('!')) {
    return {
      valid: false,
      rejectedReason: 'Contains exclamation mark (!)',
      sanitizedText: '',
    };
  }

  // 3e. Check banned transitions and openers (strictly bans "diving into", "coming up", "next up", "switching gears", etc.)
  const BANNED_SEGMENT_TRANSITIONS = [
    /\b(?:coming up|up next|next up|right after this|dive into|diving into|stay tuned|switching gears)\b/i,
    /\b(?:alright folks|here we go|welcome back|hey there)\b/i,
  ];
  for (const pat of BANNED_SEGMENT_TRANSITIONS) {
    if (pat.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains banned transition or opener: ${pat}`,
        sanitizedText: '',
      };
    }
  }

  // 3f. Check invented station frequency or format (only "RetroFM" is permitted)
  if (/\b(?:\d{2,3}(?:\.\d)?\s*fm|\d{2,3}[a-z]+|top 40)\b/i.test(trimmed)) {
    return {
      valid: false,
      rejectedReason: 'Contains invented station frequency, call letters, or format (only "RetroFM" is permitted)',
      sanitizedText: '',
    };
  }

  // 3g. Check wholesale copying from source sentences
  // The copying rule applies to narrative prose only. Exempt titles, names, dates, numbers, and common phrases
  // (e.g. "it was a top five hit on", "it reached number one on the").
  // Max allowed consecutive words is 8 for ordinary narrative sentences (12 for short factual sentences like credits).
  // Note: Locked chart sentences (isLockedSentence) are mandated to be included verbatim or omitted, so they are exempt from wholesale copying penalty.
  const COMMON_CHART_PHRASES = [
    'it was a top five hit on',
    'was a top five hit on',
    'a top five hit on the',
    'top five hit on the billboard',
    'hit on the billboard hot 100',
    'it reached number one on the',
    'reached number one on the hot',
    'it spent weeks on the chart',
    'on the billboard hot 100',
    'on the billboard hot 100 chart',
    'number one on the hot 100',
    'hot 100 in',
    'billboard hot 100 in',
  ];

  // Helper to check if a phrase is exempt (consists largely of titles, names, numbers, dates, or common chart phrases)
  const isExemptCopyPhrase = (phrase: string): boolean => {
    // Check if covered by or overlapping with common chart phrases
    if (COMMON_CHART_PHRASES.some((cp) => phrase.includes(cp) || cp.includes(phrase))) {
      return true;
    }
    // Check if phrase contains the target song title or artist
    if (context.factPacket.targetSongTitle && phrase.includes(context.factPacket.targetSongTitle.toLowerCase())) {
      return true;
    }
    if (context.factPacket.targetSongArtist && phrase.includes(context.factPacket.targetSongArtist.toLowerCase())) {
      return true;
    }
    // Check if tokens are mostly numbers, dates, or months
    const tokens = phrase.split(' ');
    const nonContentCount = tokens.filter((tok) => {
      return /^\d+$/.test(tok) ||
        ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].includes(tok) ||
        ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].includes(tok);
    }).length;
    if (nonContentCount >= tokens.length - 2 && tokens.length > 5) {
      return true;
    }
    return false;
  };

  const scriptNorm = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  for (const f of context.factPacket.facts || []) {
    if ((f as any).isLockedSentence) continue;
    const isShortFactual = /written by|produced by|composed by|released in|album/i.test(f.text);
    const maxAllowedConsecutive = isShortFactual ? 12 : 8;
    const srcNorm = f.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    const srcStr = srcNorm.join(' ');

    for (let i = 0; i < scriptNorm.length; i++) {
      for (let len = maxAllowedConsecutive + 1; i + len <= scriptNorm.length; len++) {
        const phrase = scriptNorm.slice(i, i + len).join(' ');
        if (srcStr.includes(phrase)) {
          if (!isExemptCopyPhrase(phrase)) {
            return {
              valid: false,
              rejectedReason: `Wholesale copying: reproduces ${len} consecutive words ("${phrase}") from source sentence (max allowed: ${maxAllowedConsecutive})`,
              sanitizedText: '',
            };
          }
        } else {
          break;
        }
      }
    }
  }

  // 3h. Part 2 Validator Rule: Check number one / week count alignment and future #1 claims
  // (a) Reject any script where a week count appears next to "number one", "topped", "top spot" or "stayed at the top"
  // unless it matches the rank-1 count in the packet.
  // (b) Also reject a "reached number one" claim whose chart date is after the broadcast date.
  let allowedWeeksAtOne = 0;
  let hasEligibleRankOne = false;
  let packetRankOneDate: string | null = null;
  for (const f of context.factPacket.facts || []) {
    if ((f as any).weeksAtOne !== undefined) {
      allowedWeeksAtOne = Math.max(allowedWeeksAtOne, (f as any).weeksAtOne);
      if ((f as any).weeksAtOne > 0) hasEligibleRankOne = true;
    }
    if ((f as any).peakRank === 1) {
      hasEligibleRankOne = true;
      if ((f as any).peakDate) {
        packetRankOneDate = (f as any).peakDate;
      }
    }
    if ((f as any).rank === 1) {
      hasEligibleRankOne = true;
    }
    if (/reached number one|number-one hit/i.test(f.text)) {
      hasEligibleRankOne = true;
    }
  }

  // Check for week count paired with number one / topped / top spot / stayed at the top
  // e.g. "staying there for nineteen weeks", "topped the charts for 21 weeks", "nineteen weeks at number one"
  const WORD_TO_NUM: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty one': 21
  };

  const TOP_SPOT_PATTERNS = [
    /(?:number one|topped|top spot|stayed at the top|staying there|at the top)[^.!?]{0,50}?\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty-one)\s+weeks?\b/i,
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty-one)\s+weeks?[^.!?]{0,50}?(?:number one|topped|top spot|stayed at the top|staying there|at the top)\b/i,
  ];

  for (const pat of TOP_SPOT_PATTERNS) {
    const m = trimmed.match(pat);
    if (m) {
      const rawCount = m[1].toLowerCase();
      const numCount = parseInt(rawCount, 10) || WORD_TO_NUM[rawCount] || 0;
      if (numCount > 0 && numCount !== allowedWeeksAtOne) {
        return {
          valid: false,
          rejectedReason: `Mismatched weeks at number one: script paired ${numCount} weeks with number one / top spot, but packet allows ${allowedWeeksAtOne} weeks`,
          sanitizedText: '',
        };
      }
    }
  }

  // Check if "reached number one" or "number one hit" is claimed when no rank-1 row exists on/before broadcast date
  if (/reached number one|number-one hit|topped the charts/i.test(trimmed)) {
    if (!hasEligibleRankOne) {
      return {
        valid: false,
        rejectedReason: `Claimed reached number one, but no rank-1 row exists on or before broadcast date ${context.selectedDate}`,
        sanitizedText: '',
      };
    }
    if (packetRankOneDate && packetRankOneDate > context.selectedDate) {
      return {
        valid: false,
        rejectedReason: `Claimed reached number one, but rank-1 chart date ${packetRankOneDate} is after broadcast date ${context.selectedDate}`,
        sanitizedText: '',
      };
    }
  }

  // 3i. Orphan pronoun check:
  // The first sentence of the segment must name its subject (person, band, or event).
  // Reject a first sentence beginning with Their, They, He, She, It, This, These, Those, or "the band/group"
  // unless the antecedent is named in that same first sentence.
  const rawSegmentSentences = trimmed.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 5);
  if (rawSegmentSentences.length > 0) {
    const firstSent = rawSegmentSentences[0];
    const ORPHAN_START_REGEX = /^(?:Their|They|He|She|It|This|These|Those|The band|The group)\b/i;
    const match = firstSent.match(ORPHAN_START_REGEX);
    if (match) {
      // Check if an antecedent proper name appears elsewhere in that first sentence
      // e.g. "He, Paul McCartney, ..." or "Their guitarist Jimmy Page..."
      const namesInFirstSent = extractProperNames(firstSent);
      if (namesInFirstSent.length === 0) {
        return {
          valid: false,
          rejectedReason: `Orphan pronoun: first sentence begins with "${match[0]}" without naming its subject in the same sentence`,
          sanitizedText: '',
        };
      }
    }
  }

  // 4. Check stage directions or bracketed cues
  if (/\[.*?\]|\(.*?\)/.test(trimmed)) {
    // Strip permissible parenthetical year if clean, else reject if stage cue
    if (/\[(?:music|applause|intro|pause|break)\]/i.test(trimmed) || /\((?:laughs|pause|sighs)\)/i.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: 'Contains bracketed or parenthetical stage directions',
        sanitizedText: '',
      };
    }
  }

  // 5. Year constraint: No date or year after the broadcast date
  const targetYear = parseInt(context.selectedDate.slice(0, 4), 10);
  const yearsInText = extractYears(trimmed);
  for (const y of yearsInText) {
    if (y > targetYear) {
      return {
        valid: false,
        rejectedReason: `Contains future year ${y} after broadcast date ${context.selectedDate}`,
        sanitizedText: '',
      };
    }
  }

  // 6. Grounding: Build permissible corpus from packet facts, song metadata, and artist metadata
  const packetFactTexts = context.factPacket.facts.map((f) => `${f.text} ${f.source || ''}`).join(' ');
  const corpus = [
    packetFactTexts,
    context.factPacket.targetSongTitle || '',
    context.factPacket.targetSongArtist || '',
    context.selectedDate,
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'first', 'second', 'third', 'fourth', 'fifth',
    'billboard', 'hot 100', 'top 40', 'radio', 'times', 'news',
    'us', 'u.s.', 'usa', 'u.s.a.', 'uk', 'u.k.', 'britain', 'british', 'america', 'american', 'england', 'english'
  ].join(' ').toLowerCase();

  // 6a. Verify numbers
  const numbersInText = extractNumbers(trimmed);
  for (const num of numbersInText) {
    if (!corpus.includes(num.toLowerCase())) {
      const numVal = parseInt(num, 10);
      const wordMap: Record<number, string> = {
        1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten'
      };
      if (!wordMap[numVal] || !corpus.includes(wordMap[numVal])) {
        return {
          valid: false,
          rejectedReason: `Unverified number "${num}" not present in fact packet`,
          sanitizedText: '',
        };
      }
    }
  }

  // 6b. Verify proper names
  const properNames = extractProperNames(trimmed);
  for (const name of properNames) {
    const nameLower = name.toLowerCase();
    // Allow standard radio phrasing words that might be capitalized at beginning of sentences
    const commonRadioWords = new Set([
      'the', 'this', 'that', 'here', 'now', 'well', 'and', 'right', 'so', 'from', 'stay', 'coming', 'next',
      'billboard', 'hot', 'rock', 'music', 'album', 'single', 'song', 'chart', 'times', 'records', 'studio',
      'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
      'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'
    ]);
    if (commonRadioWords.has(nameLower)) continue;

    if (!corpus.includes(nameLower)) {
      return {
        valid: false,
        rejectedReason: `Unverified proper name "${name}" not found in fact packet`,
        sanitizedText: '',
      };
    }
  }

  return {
    valid: true,
    sanitizedText: trimmed,
  };
}

export interface SongMetadataContext {
  title: string;
  artist: string;
  primary_artist?: string | null;
}

export interface ValidationContext {
  selectedDate: string; // YYYY-MM-DD
  breakType?: string | null;
  factPacket?: FactPacketData | null;
  songPlayed?: SongMetadataContext | null;
  songNext?: SongMetadataContext | null;
  recentRhetoricalOpenersCount?: number;
  recentBreaksTotal?: number;
  fullHeadline?: string;
  fullLead?: string;
}

export interface ValidationResult {
  valid: boolean;
  rejectedReason?: string;
  sanitizedText: string;
}

const COMMON_IRREGULAR_VERB_LEMMAS: Record<string, string> = {
  // says / said / say
  says: 'say', said: 'say', say: 'say', saying: 'say',
  // rises / rose / risen / rise
  rises: 'rise', rose: 'rise', risen: 'rise', rise: 'rise', rising: 'rise',
  // meets / met / meet
  meets: 'meet', met: 'meet', meet: 'meet', meeting: 'meet',
  // begins / began / begun / begin
  begins: 'begin', began: 'begin', begun: 'begin', begin: 'begin', beginning: 'begin',
  // leads / led / lead
  leads: 'lead', led: 'lead', lead: 'lead', leading: 'lead',
  // leaves / left / leave
  leaves: 'leave', left: 'leave', leave: 'leave', leaving: 'leave',
  // takes / took / taken / take
  takes: 'take', took: 'take', taken: 'take', take: 'take', taking: 'take',
  // holds / held / hold
  holds: 'hold', held: 'hold', hold: 'hold', holding: 'hold',
  // chooses / chose / chosen / choose
  chooses: 'choose', chose: 'choose', chosen: 'choose', choose: 'choose', choosing: 'choose',
  // sees / saw / seen / see
  sees: 'see', saw: 'see', seen: 'see', see: 'see', seeing: 'see',
  // speaks / spoke / spoken / speak
  speaks: 'speak', spoke: 'speak', spoken: 'speak', speak: 'speak', speaking: 'speak',
  // tells / told / tell
  tells: 'tell', told: 'tell', tell: 'tell', telling: 'tell',
  // finds / found / find
  finds: 'find', found: 'find', find: 'find', finding: 'find',
  // wins / won / win
  wins: 'win', won: 'win', win: 'win', winning: 'win',
  // loses / lost / lose
  loses: 'lose', lost: 'lose', lose: 'lose', losing: 'lose',
  // comes / came / come
  comes: 'come', came: 'come', come: 'come', coming: 'come',
  // goes / went / gone / go
  goes: 'go', went: 'go', gone: 'go', go: 'go', going: 'go',
  // gives / gave / given / give
  gives: 'give', gave: 'give', given: 'give', give: 'give', giving: 'give',
  // makes / made / make
  makes: 'make', made: 'make', make: 'make', making: 'make',
  // knows / knew / known / know
  knows: 'know', knew: 'know', known: 'know', know: 'know', knowing: 'know',
  // writes / wrote / written / write
  writes: 'write', wrote: 'write', written: 'write', write: 'write', writing: 'write',
  // falls / fell / fallen / fall
  falls: 'fall', fell: 'fall', fallen: 'fall', fall: 'fall', falling: 'fall',
  // breaks / broke / broken / break
  breaks: 'break', broke: 'break', broken: 'break', break: 'break', breaking: 'break',
  // flies / flew / flown / fly
  flies: 'fly', flew: 'fly', flown: 'fly', fly: 'fly', flying: 'fly',
  // seeks / sought / seek
  seeks: 'seek', sought: 'seek', seek: 'seek', seeking: 'seek',
  // brings / brought / bring
  brings: 'bring', brought: 'bring', bring: 'bring', bringing: 'bring',
  // buys / bought / buy
  buys: 'buy', bought: 'buy', buy: 'buy', buying: 'buy',
  // fights / fought / fight
  fights: 'fight', fought: 'fight', fight: 'fight', fighting: 'fight',
  // thinks / thought / think
  thinks: 'think', thought: 'think', think: 'think', thinking: 'think',
  // runs / ran / run
  runs: 'run', ran: 'run', run: 'run', running: 'run',
  // stands / stood / stand
  stands: 'stand', stood: 'stand', stand: 'stand', standing: 'stand',
  // strikes / struck / strike
  strikes: 'strike', struck: 'strike', strike: 'strike', striking: 'strike',
  // sends / sent / send
  sends: 'send', sent: 'send', send: 'send', sending: 'send',
  // cuts / cut
  cuts: 'cut', cut: 'cut', cutting: 'cut',
  // puts / put
  puts: 'put', put: 'put', putting: 'put',
  // sets / set
  sets: 'set', set: 'set', setting: 'set',
  // reads / read
  reads: 'read', read: 'read', reading: 'read',
  // hears / heard
  hears: 'hear', heard: 'hear', hear: 'hear', hearing: 'hear',
};

const BANNED_PHRASES = [
  /one of my favorites/i,
  /gets me every time/i,
  /my favorite/i,
  /my favorites/i,
  /i love this/i,
  /i love that/i,
  /i always loved/i,
  /favorite song of mine/i,
  /personal favorite/i,
  /coming up/i,
  /up next/i,
  /\bdebut\b/i,
];

// First-person words (must be strictly absent from LLM scripts)
const FIRST_PERSON_WORDS = [
  /\bI\b/,
  /\bI['’]ll\b/i,
  /\bI['’]ve\b/i,
  /\bI['’]m\b/i,
  /\bmy\b/i,
  /\bwe\b/i,
  /\bwe['’]re\b/i,
  /\bwe['’]ve\b/i,
  /\bwe['’]ll\b/i,
  /\bour\b/i,
  /\bme\b/i,
  /(?<![A-Za-z0-9\-])us(?![A-Za-z0-9\-])/, // strictly lowercase 'us', avoiding 'US' or 'anti-US'
];

// Hedges
const HEDGE_PHRASES = [
  /\bi believe\b/i,
  /\bperhaps\b/i,
  /\bmaybe\b/i,
  /\bpossibly\b/i,
  /\bi think\b/i,
  /\bi suppose\b/i,
  /\bi guess\b/i,
];

const INTERJECTIONS = [
  /\bwow\b/i,
  /\bwhoa\b/i,
  /\bhey\b/i,
  /\boh\b/i,
  /\bwell\b/i,
  /\bgosh\b/i,
  /\bgee\b/i,
  /\byikes\b/i,
  /\boops\b/i,
];

const SPECULATION_WORDS = [
  /\blooks like\b/i,
  /\bseems\b/i,
  /\bprobably\b/i,
  /\bgetting ready\b/i,
  /\bsounds like\b/i,
  /\bfeels like\b/i,
  /\bappears to\b/i,
];

const HYPE_WORDS = [
  /\bfresh\b/i,
  /\bamazing\b/i,
  /\bincredible\b/i,
  /\bawesome\b/i,
  /\bunbelievable\b/i,
  /\bmust-hear\b/i,
  /\bsizzling\b/i,
  /\bon fire\b/i,
  /\bbanger\b/i,
  /\bsmash\b/i,
  /\bjaw-dropping\b/i,
];

const RHETORICAL_OPENERS = [
  /^did you know/i,
  /\bdid you know\b/i,
  /^you remember this one/i,
  /\byou remember this one\b/i,
];

/**
 * Extracts all 4-digit years (1900-2099) from text.
 */
export function extractYears(text: string): number[] {
  const matches = text.match(/\b(19\d\d|20\d\d)\b/g);
  return matches ? matches.map((m) => parseInt(m, 10)) : [];
}

/**
 * Extracts numbers (digits or standard written numbers up to 100) from text.
 */
export function extractNumbers(text: string): string[] {
  const digits = text.match(/\b\d+\b/g) || [];
  return digits;
}

/**
 * Extracts candidate proper names (capitalized words inside sentences, excluding sentence starters after periods).
 */
export function extractProperNames(text: string): string[] {
  // Split into sentences first
  const sentences = text.split(/(?<=[.!?])\s+/);
  const proper: string[] = [];

  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/).map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''));
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      // First word of a sentence is capitalized by convention, not necessarily a proper noun
      if (i === 0) continue;

      if (/^[A-Z][a-z]+$/.test(token) || /^[A-Z]{2,}$/.test(token)) {
        const lower = token.toLowerCase();
        const commonWords = [
          'this', 'that', 'here', 'here\'s', 'it', 'it\'s', 'the', 'new', 'climbing', 'number',
          'stay', 'we', 'and', 'with', 'from', 'coming', 'up', 'next', 'right', 'now', 'tuned',
          'today', 'track', 'song', 'hit', 'music', 'radio', 'credits', 'credit', 'behind', 'work',
          'release', 'boards', 'pen', 'include', 'featuring', 'straight', 'week', 'spot', 'national'
        ];
        if (!commonWords.includes(lower)) {
          proper.push(token);
        }
      }
    }
  }
  return proper;
}

/**
 * Validates break text against grounding, banned phrases, date constraints, and frequency rules.
 */
export function validateBreakOutput(
  text: string,
  context: ValidationContext
): ValidationResult {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { valid: false, rejectedReason: 'Empty script text', sanitizedText: '' };
  }

  // Helper to escape regex special characters
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Strip verified song titles for checks where title phrases shouldn't false-flag
  // Strip all quoted song titles (handling both standard ASCII "" and curly/typographical quotes “”, ‘’)
  // and strip target/previous artist names so parentheticals within titles/credits don't trigger stage direction check
  const quotedRegex = /["“”«»'‘’]([^"“”«»'‘’]+)["“”«»'‘’]/g;
  const quotedMatches = Array.from(trimmed.matchAll(quotedRegex)).map((m) => escapeRegExp(m[1]));
  
  const nextTitleEsc = context.songNext?.title ? escapeRegExp(context.songNext.title) : '___none___';
  const prevTitleEsc = context.songPlayed?.title ? escapeRegExp(context.songPlayed.title) : '___none___';
  const nextArtistEsc = context.songNext?.artist ? escapeRegExp(context.songNext.artist) : '___none___';
  const prevArtistEsc = context.songPlayed?.artist ? escapeRegExp(context.songPlayed.artist) : '___none___';

  let textWithoutTitles = trimmed
    .replace(new RegExp(nextTitleEsc, 'gi'), '')
    .replace(new RegExp(prevTitleEsc, 'gi'), '')
    .replace(new RegExp(nextArtistEsc, 'gi'), '')
    .replace(new RegExp(prevArtistEsc, 'gi'), '');

  // Strip whole quoted phrases (including the quotes) first
  textWithoutTitles = textWithoutTitles.replace(/["“”«»][^"“”«»]*["“”«»]/g, '');

  for (const qm of quotedMatches) {
    if (qm.trim()) {
      textWithoutTitles = textWithoutTitles.replace(new RegExp(qm, 'gi'), '');
    }
  }

  // 0a. Check speaker label (a name followed by a colon, e.g. "DJ:", "Mike:", "Announcer:", "Host:")
  // Ignore standard journalistic attribution openers like "From this morning's New York Times:" or "In the news:"
  const hasNewsLead = /^(from (?:this morning's )?(?:new york )?times|in the news|according to the times):/i.test(trimmed);
  if (!hasNewsLead && /^[A-Za-z0-9_\-\s]{1,30}:\s*/.test(trimmed)) {
    return {
      valid: false,
      rejectedReason: 'Contains speaker label (e.g. "Name:")',
      sanitizedText: '',
    };
  }

  // 0b. Check stage directions (parentheses or square brackets indicating delivery or sound effects, e.g. [laughter], (laughs), (upbeat))
  // Strip verified song titles first so songs like "Love Me With All Your Heart (Cuando Calienta El Sol)" don't get rejected
  if (/[\(\[][A-Za-z\s\-_,]{2,40}[\)\]]/.test(textWithoutTitles)) {
    return {
      valid: false,
      rejectedReason: 'Contains stage directions in parentheses or brackets',
      sanitizedText: '',
    };
  }

  // 0c. Check balanced quote marks
  const doubleQuotesCount = (trimmed.match(/"/g) || []).length;
  if (doubleQuotesCount % 2 !== 0) {
    return {
      valid: false,
      rejectedReason: 'Unbalanced quotation marks in script',
      sanitizedText: '',
    };
  }

  // 0d. Check question marks
  if (trimmed.includes('?')) {
    return {
      valid: false,
      rejectedReason: 'Contains question mark (?)',
      sanitizedText: '',
    };
  }

  // 0e. Check trailing ellipsis ("...")
  if (/\.{3,}$|…$/.test(trimmed)) {
    return {
      valid: false,
      rejectedReason: 'Contains trailing ellipsis ("...")',
      sanitizedText: '',
    };
  }

  // 0f. Check sentence count (max 2 sentences)
  const rawSegments = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sentenceSegments: string[] = [];
  for (const seg of rawSegments) {
    if (
      sentenceSegments.length > 0 &&
      /\b[A-Za-z]\.$|\b(?:mr|mrs|ms|dr|st|jr|sr|u\.s|u\.n)\.$/i.test(sentenceSegments[sentenceSegments.length - 1])
    ) {
      sentenceSegments[sentenceSegments.length - 1] += ' ' + seg;
    } else {
      sentenceSegments.push(seg);
    }
  }
  if (sentenceSegments.length > 2) {
    return {
      valid: false,
      rejectedReason: `Contains more than 2 sentences (${sentenceSegments.length} sentences found)`,
      sanitizedText: '',
    };
  }

  // 0g. Check first-person words (I, I'll, I've, I'm, my, we, etc.)
  // Strip verified song titles first so songs like "I Love Rock 'N Roll", "Don't You Want Me", or "Always On My Mind" don't get rejected
  for (const fp of FIRST_PERSON_WORDS) {
    if (fp.test(textWithoutTitles)) {
      return {
        valid: false,
        rejectedReason: `Contains first-person pronoun: ${fp}`,
        sanitizedText: '',
      };
    }
  }

  // 0h. Check hedge words ("I believe", "perhaps", etc.)
  for (const hedge of HEDGE_PHRASES) {
    if (hedge.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains hedge phrasing: ${hedge}`,
        sanitizedText: '',
      };
    }
  }

  // 0i. Check three consecutive ALL-CAPS words (acronyms like U.S. and U.N. are fine)
  const acronyms = new Set([
    'U.S.', 'U.N.', 'U.K.', 'USA', 'USSR', 'FBI', 'CIA', 'NASA',
    'DJ', 'FM', 'AM', 'NYT', 'NYC', 'AP', 'UPI', 'GOP', 'G.O.P.', 'NATO', 'OPEC'
  ]);
  const tokens = trimmed.split(/\s+/).map((w) => w.replace(/^[\"\'\(\[\{]+|[\"\'\)\]\}\.,;:!?]+$/g, ''));
  let consecutiveCaps = 0;
  for (const tok of tokens) {
    if (!tok) continue;
    if (acronyms.has(tok) || /^([A-Z]\.){2,}$/.test(tok)) {
      consecutiveCaps = 0;
      continue;
    }
    if (tok.length >= 2 && /^[A-Z]+$/.test(tok)) {
      consecutiveCaps++;
      if (consecutiveCaps >= 3) {
        return {
          valid: false,
          rejectedReason: 'Contains three consecutive all-caps words',
          sanitizedText: '',
        };
      }
    } else {
      consecutiveCaps = 0;
    }
  }

  // 0j. Reject non-words or OCR typos in LLM output (tokens not in dictionary or recognized names, e.g. "aniu")
  const BANNED_NON_WORDS = new Set(['groins', 'swtich', 'britian', 'britians', 'aniu']);
  const wordsInScript = trimmed
    .replace(/[-—–]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase().replace(/'s$/, ''))
    .filter((w) => w.length > 2);

  for (const tok of wordsInScript) {
    if (BANNED_NON_WORDS.has(tok)) {
      return {
        valid: false,
        rejectedReason: `Contains non-word or typo "${tok}"`,
        sanitizedText: '',
      };
    }
    // Reject non-words like consonant clusters (ignoring English words with vowel y like rhythm)
    if (/^[bcdfghjklmnpqrstvwxyz]{5,}$/.test(tok) && !/rhythm/i.test(tok)) {
      return {
        valid: false,
        rejectedReason: `Contains non-word "${tok}"`,
        sanitizedText: '',
      };
    }
  }

  // 1. Check exclamation marks (except when part of verified song title or quoted title like "Do Me!")
  const cleanOfTitles = textWithoutTitles;
  if (cleanOfTitles.includes('!')) {
    return {
      valid: false,
      rejectedReason: 'Contains exclamation mark (!)',
      sanitizedText: '',
    };
  }

  // 2. Check banned subjective/favorite phrases and "coming up" / "up next"
  for (const pattern of BANNED_PHRASES) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains banned subjective phrase: ${pattern}`,
        sanitizedText: '',
      };
    }
  }

  // 3. Check hype and filler words
  for (const hype of HYPE_WORDS) {
    if (hype.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains banned hype/filler word: ${hype}`,
        sanitizedText: '',
      };
    }
  }

  // 3b. Check interjections (e.g. "Wow", "Whoa", "Hey", "Oh", "Yikes")
  for (const interjection of INTERJECTIONS) {
    if (interjection.test(textWithoutTitles)) {
      return {
        valid: false,
        rejectedReason: `Contains interjection: ${interjection}`,
        sanitizedText: '',
      };
    }
  }

  // 3c. Check speculation words (e.g. "looks like", "seems", "probably", "getting ready", "sounds like")
  for (const speculation of SPECULATION_WORDS) {
    if (speculation.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains speculation phrasing: ${speculation}`,
        sanitizedText: '',
      };
    }
  }

  // 3c2. Check unconverted relative time words from newspaper reporting
  // "this week" is legitimate for radio DJs referring to the weekly chart
  const REL_WORDS = [
    /\b(?:last night|yesterday|this morning|today|tomorrow)\b/i,
  ];
  for (const rel of REL_WORDS) {
    if (rel.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains unconverted relative time word: ${rel}`,
        sanitizedText: '',
      };
    }
  }

  // 3c3. Check evaluative language, journalistic opinion, and subjective adjectives
  const EVAL_WORDS = [
    /\b(?:unexpected grace|scandals?|publicity stunts?|bizarre|controversial|notorious)\b/i,
  ];
  for (const ev of EVAL_WORDS) {
    if (ev.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: `Contains evaluative or opinion language: ${ev}`,
        sanitizedText: '',
      };
    }
  }

  // 3d. Check for news observation rules and source attribution
  const isNewsBreak =
    context.breakType === 'news' ||
    (context.factPacket?.source?.toLowerCase().includes('times') ?? false) ||
    (context.factPacket?.factText?.toLowerCase().includes('times:') ?? false);

  // Reject any script that mentions "New York Times" unless the break type is news
  if (/new york times/i.test(trimmed) && !isNewsBreak) {
    return {
      valid: false,
      rejectedReason: 'Mentions "New York Times" on a non-news break',
      sanitizedText: '',
    };
  }

  // Reject any script that names a source not in the packet
  const sourceMentions = [
    { pattern: /\bnew york times\b/i, name: 'New York Times' },
    { pattern: /\bbillboard\b/i, name: 'Billboard' },
    { pattern: /\bmusicbrainz\b/i, name: 'MusicBrainz' },
    { pattern: /\brolling stone\b/i, name: 'Rolling Stone' },
    { pattern: /\bassociated press\b/i, name: 'Associated Press' },
    { pattern: /\breuters\b/i, name: 'Reuters' },
  ];
  const packetSourceCorpus = `${context.factPacket?.source || ''} ${context.factPacket?.factText || ''}`.toLowerCase();
  for (const src of sourceMentions) {
    if (src.pattern.test(trimmed) && !packetSourceCorpus.includes(src.name.toLowerCase())) {
      return {
        valid: false,
        rejectedReason: `Names source "${src.name}" not present in fact packet`,
        sanitizedText: '',
      };
    }
  }

  if (isNewsBreak) {
    if (/\byesterday\b/i.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: 'News observation contains "yesterday"',
        sanitizedText: '',
      };
    }
    if (/\btoday\b/i.test(trimmed)) {
      return {
        valid: false,
        rejectedReason: 'News observation contains "today"',
        sanitizedText: '',
      };
    }
  }

  // 4. Reject if song title appears more than once
  const checkTitleRepeats = (title?: string) => {
    if (!title || title.length < 3) return null;
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const matches = trimmed.match(regex);
    if (matches && matches.length > 1) {
      return `Song title "${title}" appears ${matches.length} times (must only appear once)`;
    }
    return null;
  };
  const titleRepeatError = checkTitleRepeats(context.songNext?.title) || checkTitleRepeats(context.songPlayed?.title);
  if (titleRepeatError) {
    return {
      valid: false,
      rejectedReason: titleRepeatError,
      sanitizedText: '',
    };
  }

  // 5. Rhetorical openers frequency check: "Did you know" and "You remember this one"
  // max ~1 in 5 (20%)
  const hasRhetorical = RHETORICAL_OPENERS.some((r) => r.test(trimmed));
  if (hasRhetorical) {
    const total = context.recentBreaksTotal ?? 0;
    const rhetoricalCount = context.recentRhetoricalOpenersCount ?? 0;
    if (total >= 4 && (rhetoricalCount + 1) / (total + 1) > 0.22) {
      return {
        valid: false,
        rejectedReason: 'Rhetorical opener frequency exceeded (more than 1 in 5 breaks)',
        sanitizedText: '',
      };
    }
  }

  // 6. Year constraint: Reject any year after selectedDate
  const targetYear = parseInt(context.selectedDate.slice(0, 4), 10);
  const yearsInText = extractYears(trimmed);
  for (const y of yearsInText) {
    if (y > targetYear) {
      return {
        valid: false,
        rejectedReason: `Contains future year ${y} after selected date ${context.selectedDate}`,
        sanitizedText: '',
      };
    }
  }

  // 7. Grounding verification
  // For news breaks: content-word grounding check against the full headline and lead (not trimmed lead)
  // Every noun, verb, and adjective in the script must appear in them, ignoring titles like President and Senator
  // and a small function-word list. Rejects new adjectives such as "regular" or "consecutive".
  const isNews = context.breakType === 'observation' && (
    (context.factPacket?.source || '').toLowerCase().includes('times') ||
    (context.factPacket?.factText || '').toLowerCase().includes('times') ||
    Boolean(context.fullHeadline)
  );

  if (isNews && (context.fullHeadline || context.factPacket?.factText)) {
    const fullSourceText = `${context.fullHeadline || ''} ${context.fullLead || ''} ${context.factPacket?.factText || ''}`.toLowerCase();
    const sourceTokens = new Set(
      fullSourceText
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
    );

    const FUNCTION_WORDS = new Set([
      'the', 'a', 'an', 'this', 'that', 'these', 'those', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
      'might', 'must', 'and', 'or', 'but', 'nor', 'for', 'yet', 'so', 'in', 'on', 'at', 'to', 'from', 'by',
      'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'up', 'down', 'in', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
      'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'not', 'only', 'own', 'same', 'than', 'too', 'very', 's', 't', 'just', 'don', 'now',
      // News frame words
      'news', 'times', 'reports', 'morning', 'papers', 'according',
      // Political and journalistic titles
      'president', 'senator', 'representative', 'governor', 'premier', 'secretary', 'minister', 'general', 'admiral', 'ambassador'
    ]);

    // Strip news frame openers
    const cleanScript = trimmed.replace(/^(?:the times reports|in the news(?: this morning)?|according to the times|from the morning papers|from this morning's (?:new york )?times):\s*/i, '');
    const scriptWords = cleanScript.replace(/[^a-zA-Z]/g, ' ').split(/\s+/).map((w) => w.toLowerCase()).filter(Boolean);

    // Build lemma set for source tokens to support irregular verb tense / inflection variants
    const sourceLemmas = new Set<string>();
    for (const st of sourceTokens) {
      if (COMMON_IRREGULAR_VERB_LEMMAS[st]) {
        sourceLemmas.add(COMMON_IRREGULAR_VERB_LEMMAS[st]);
      }
    }

    for (const w of scriptWords) {
      if (FUNCTION_WORDS.has(w)) continue;
      // Stem check: exact match or regular noun plural/singular in sourceTokens
      let match = sourceTokens.has(w);
      // Singular / plural variants for nouns (e.g. falkland <-> falklands, warship <-> warships, island <-> islands)
      if (!match && w.endsWith('s')) match = sourceTokens.has(w.slice(0, -1));
      if (!match && w.endsWith('es')) match = sourceTokens.has(w.slice(0, -2));
      if (!match && !w.endsWith('s')) match = sourceTokens.has(w + 's');
      if (!match && !w.endsWith('es')) match = sourceTokens.has(w + 'es');

      // Requirement 1: News scripts must reuse the headline's own verbs.
      // Reject scripts containing a verb form (including -ing forms) not in the headline or lead.
      // Exact verb forms or irregular past tense lemmas present in sourceTokens only.
      if (!match && COMMON_IRREGULAR_VERB_LEMMAS[w]) {
        const wLemma = COMMON_IRREGULAR_VERB_LEMMAS[w];
        if (sourceLemmas.has(wLemma) || sourceTokens.has(wLemma)) {
          match = true;
        }
      }

      if (!match) {
        return {
          valid: false,
          rejectedReason: `Ungrounded content word or verb form "${w}" not found in headline or lead`,
          sanitizedText: '',
        };
      }
    }
  }

  // General Grounding verification: Every number, year, and proper name must appear in the fact packet or song metadata
  const corpus = [
    context.fullHeadline || '',
    context.fullLead || '',
    context.factPacket?.factText || '',
    context.factPacket?.source || '',
    context.factPacket?.date || '',
    context.songPlayed?.title || '',
    context.songPlayed?.artist || '',
    context.songPlayed?.primary_artist || '',
    context.songNext?.title || '',
    context.songNext?.artist || '',
    context.songNext?.primary_artist || '',
    context.selectedDate,
    // Add common number word mappings (1-100) if numbers appear in words in factText
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'first', 'second', 'third', 'fourth', 'fifth', 'top ten', 'hot 100', 'billboard', 'retrof',
    'america', 'american', 'country', 'nation', 'summit', 'peak',
    'new york times', 'new york', 'york', 'times', 'news', 'president', 'senator', 'governor', 'premier', 'secretary'
  ].join(' ').toLowerCase();

  // Verify numbers
  const numbersInText = extractNumbers(trimmed);
  for (const num of numbersInText) {
    // If it's a year, check if it's in corpus
    if (!corpus.includes(num.toLowerCase())) {
      // Check if number was written in words in packet
      const numVal = parseInt(num, 10);
      const wordMap: Record<number, string> = {
        1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten'
      };
      if (!wordMap[numVal] || !corpus.includes(wordMap[numVal])) {
        return {
          valid: false,
          rejectedReason: `Unverified number "${num}" not present in fact packet or song metadata`,
          sanitizedText: '',
        };
      }
    }
  }

  // Verify proper names (for non-news breaks, or proper names not matching corpus)
  if (!isNews) {
    const properNames = extractProperNames(trimmed);
    for (const name of properNames) {
      const nameLower = name.toLowerCase();
      if (!corpus.includes(nameLower)) {
        return {
          valid: false,
          rejectedReason: `Unverified proper name "${name}" not found in fact packet or metadata`,
          sanitizedText: '',
        };
      }
    }
  }

  return {
    valid: true,
    sanitizedText: trimmed,
  };
}

/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { FactCategory } from './types.js';
import { normalizeCategory } from './categoryNormalizer.js';

export interface NationalFocusEvaluation {
  keep: boolean;
  reason: string;
  isFrontPage: boolean;
  isNonStory?: boolean;
  desk?: string;
  section?: string;
  matchedNycLocation?: string;
  matchedNycTeam?: string;
}

const NON_STORY_HEADLINE_PHRASES = [
  'reports earnings',
  'company reports',
  'correction',
  'no title',
  'transactions',
  'bridge:',
  'chess:',
  'quiz',
  'answers to quiz',
  'calendar of events',
];

/**
 * Checks if an item is a non-story item that should be dropped from the DJ pool
 * (routine business earnings reports, corrections, no-title entries, bridge/chess columns,
 * quizzes, calendar listings, obituary notices, or items with summary shorter than ~60 chars).
 */
export function isNonStoryItem(
  headline: string,
  summary: string,
  doc: any
): { isNonStory: boolean; reason: string } {
  const h = (headline || '').trim();
  const hLower = h.toLowerCase();

  // 1. Specific non-story headline phrases
  for (const phrase of NON_STORY_HEADLINE_PHRASES) {
    if (hLower.includes(phrase)) {
      if (phrase === 'reports earnings' || phrase === 'company reports') {
        return { isNonStory: true, reason: 'Non-story item: Routine corporate earnings report' };
      }
      if (phrase === 'correction') {
        return { isNonStory: true, reason: 'Non-story item: Correction note' };
      }
      if (phrase === 'no title') {
        return { isNonStory: true, reason: "Non-story item: Untitled entry ('No Title')" };
      }
      if (phrase === 'transactions') {
        return { isNonStory: true, reason: 'Non-story item: Routine transactions listing' };
      }
      if (phrase === 'bridge:') {
        return { isNonStory: true, reason: 'Non-story item: Bridge column' };
      }
      if (phrase === 'chess:') {
        return { isNonStory: true, reason: 'Non-story item: Chess column' };
      }
      if (phrase === 'quiz' || phrase === 'answers to quiz') {
        return { isNonStory: true, reason: 'Non-story item: Quiz or quiz answers' };
      }
      if (phrase === 'calendar of events') {
        return { isNonStory: true, reason: 'Non-story item: Calendar of events listing' };
      }
      return { isNonStory: true, reason: `Non-story item: Headline contains "${phrase}"` };
    }
  }

  // 2. Obituary notices
  const typeOfMaterial = (doc.type_of_material || '').toLowerCase();
  const desk = (doc.news_desk || '').toLowerCase();
  const section = (doc.section_name || '').toLowerCase();
  if (
    typeOfMaterial === 'obituary' ||
    desk.includes('obit') ||
    section.includes('obit') ||
    /\b(obituary|memorial service|funeral notice|deaths elsewhere)\b/i.test(hLower)
  ) {
    return { isNonStory: true, reason: 'Non-story item: Obituary / memorial notice' };
  }

  // 3. Short summary (< 60 chars)
  const trimmedSummary = (summary || '').trim();
  if (trimmedSummary.length < 60) {
    return {
      isNonStory: true,
      reason: `Non-story item: Summary shorter than 60 characters (${trimmedSummary.length} chars)`,
    };
  }

  return { isNonStory: false, reason: '' };
}

/**
 * Evaluates whether an NYT archive article doc satisfies the National Focus criteria:
 *
 * Rules:
 * 1. Drop non-story items (earnings reports, corrections, bridge/chess, quizzes, obituaries, summary <60 chars).
 * 2. Loosened sports rule: Keep ALL sports stories unless the story is about a single NYC team
 *    (Yankees, Mets, Giants, Jets, Knicks, Rangers, Islanders, Nets, Devils) without a national angle.
 * 3. Exclude NYC Metro desk/section or NYC location tags, UNLESS on front page (A1) or National/Foreign desk.
 * 4. Keep front page (Section A, Page 1) and national-interest desks (National, Foreign, Washington, Business,
 *    Financial, Science, Arts, Culture, Style, Weekend).
 */
export function evaluateNYTNationalFocus(doc: any): NationalFocusEvaluation {
  const headline = (doc.headline?.main || doc.headline?.print_headline || '').trim();
  const summary = (doc.abstract || doc.snippet || doc.lead_paragraph || '').trim();

  const printSec = (doc.print_section || '').trim().toUpperCase();
  const printPage = String(doc.print_page || '').trim();
  const isFrontPage = printSec === 'A' && (printPage === '1' || printPage === '01');

  const rawDesk = (doc.news_desk || '').trim();
  const desk = rawDesk.toLowerCase();
  const rawSection = (doc.section_name || '').trim();
  const section = rawSection.toLowerCase();

  // Rule 1: Drop non-story items from the DJ pool (keep in review table with reason)
  const nonStoryCheck = isNonStoryItem(headline, summary, doc);
  if (nonStoryCheck.isNonStory) {
    return {
      keep: false,
      reason: nonStoryCheck.reason,
      isFrontPage,
      isNonStory: true,
      desk: rawDesk,
      section: rawSection,
    };
  }

  const isNationalOrForeignDesk =
    desk.includes('national') ||
    desk.includes('foreign') ||
    desk.includes('washington');

  // Keep desk criteria: National, Foreign, Washington, Business, Financial, Science, Arts, Culture, Style, Weekend
  const keepDeskRegex = /\b(national|foreign|washington|business|financial|science|arts|cultural|culture|style|weekend)\b/i;
  const hasKeepDesk = keepDeskRegex.test(desk);

  // Sports detection
  const keywords: string[] = Array.isArray(doc.keywords)
    ? doc.keywords.map((k: any) => (k.value || '').toLowerCase())
    : [];
  const isSports =
    desk.includes('sport') ||
    section.includes('sport') ||
    keywords.some((k: string) =>
      /\b(baseball|football|basketball|hockey|soccer|tennis|golf|boxing|olympic|athletics|sports)\b/i.test(k)
    );

  const combinedText = `${headline} ${summary} ${keywords.join(' ')}`.toLowerCase();
  const nationalSportsRegex = /\b(world series|playoff|playoffs|super bowl|olympic|olympics|all-star|all star|championship|stanley cup|wimbledon|us open|pga|masters|world cup|indy 500|kentucky derby|nba finals|final four|pennant)\b/i;
  const hasNationalAngle = isFrontPage || nationalSportsRegex.test(combinedText);

  // NYC sports teams
  const nycTeams = [
    'yankees',
    'mets',
    'giants',
    'jets',
    'knicks',
    'rangers',
    'islanders',
    'nets',
    'devils',
  ];

  let isNycTeamSports = false;
  let matchedNycTeam = '';
  if (isSports) {
    for (const team of nycTeams) {
      if (new RegExp(`\\b${team}\\b`, 'i').test(combinedText)) {
        isNycTeamSports = true;
        matchedNycTeam = team;
        break;
      }
    }
  }

  // Rule 2: Loosened sports rule
  // Keep ALL sports stories unless the story is about a single NYC team without a national angle
  if (isSports) {
    if (isNycTeamSports && !hasNationalAngle) {
      return {
        keep: false,
        reason: `NYC local team sports coverage (${matchedNycTeam}) without national angle`,
        isFrontPage,
        desk: rawDesk,
        section: rawSection,
        matchedNycTeam,
      };
    }

    return {
      keep: true,
      reason: isFrontPage
        ? 'Front page sports coverage (Section A, Page 1)'
        : isNycTeamSports
        ? `NYC sports team (${matchedNycTeam}) with national event/championship angle`
        : 'Sports story (national interest)',
      isFrontPage,
      desk: rawDesk,
      section: rawSection,
      matchedNycTeam: isNycTeamSports ? matchedNycTeam : undefined,
    };
  }

  // Metro desk or New York section
  const isMetroDeskOrSection =
    desk.includes('metropolitan') ||
    desk.includes('metro') ||
    section === 'new york' ||
    section.includes('metro');

  // NYC-area location tags in keywords
  const nycLocations = [
    'new york city',
    'manhattan',
    'brooklyn',
    'queens',
    'bronx',
    'staten island',
    'long island',
    'westchester',
  ];

  let hasNycLocation = false;
  let matchedNycLocation = '';
  if (Array.isArray(doc.keywords)) {
    for (const k of doc.keywords) {
      if (k.name === 'glocations' && k.value) {
        const val = k.value.toLowerCase();
        for (const loc of nycLocations) {
          if (val.includes(loc)) {
            hasNycLocation = true;
            matchedNycLocation = k.value;
            break;
          }
        }
      }
      if (hasNycLocation) break;
    }
  }

  // Rule 3: Metro desk / section or NYC location tag check:
  // "unless it also meets a 'keep' condition above because it ran on the front page or the National or Foreign desk"
  if (isMetroDeskOrSection || hasNycLocation) {
    if (isFrontPage) {
      return {
        keep: true,
        reason: 'Front page coverage (Section A, Page 1) overrides NYC local tag/desk',
        isFrontPage: true,
        desk: rawDesk,
        section: rawSection,
        matchedNycLocation,
      };
    }

    if (isNationalOrForeignDesk) {
      return {
        keep: true,
        reason: `National/Foreign desk (${rawDesk}) overrides local NYC tag`,
        isFrontPage: false,
        desk: rawDesk,
        section: rawSection,
        matchedNycLocation,
      };
    }

    const locReason = isMetroDeskOrSection
      ? `NYC Metro desk/section (${rawDesk || rawSection})`
      : `Tagged with NYC-area location (${matchedNycLocation})`;

    return {
      keep: false,
      reason: locReason,
      isFrontPage: false,
      desk: rawDesk,
      section: rawSection,
      matchedNycLocation,
    };
  }

  // Rule 4: Keep criteria for general stories:
  if (isFrontPage) {
    return {
      keep: true,
      reason: 'Front page (Section A, Page 1)',
      isFrontPage: true,
      desk: rawDesk,
      section: rawSection,
    };
  }

  if (hasKeepDesk) {
    return {
      keep: true,
      reason: `National-interest desk (${rawDesk})`,
      isFrontPage: false,
      desk: rawDesk,
      section: rawSection,
    };
  }

  // Default non-national items (society desks, local classifieds, regional entries, etc.)
  return {
    keep: false,
    reason: `Non-national desk (${rawDesk || 'Unspecified'}) without front page or national focus criteria`,
    isFrontPage: false,
    desk: rawDesk,
    section: rawSection,
  };
}

/**
 * Categorizes an NYT article using structured metadata (news_desk, section_name, keywords)
 * BEFORE keyword guessing, so sports stories are NEVER labeled music.
 * Also returns whether the assigned category differs from the previous keyword-guessing category.
 */
export function categorizeNYTArticle(doc: any): {
  category: FactCategory;
  changedFromOldGuess: boolean;
  oldCategory: FactCategory;
} {
  const headline = (doc.headline?.main || doc.headline?.print_headline || '').trim();
  const summary = (doc.abstract || doc.snippet || doc.lead_paragraph || '').trim();
  const rawCategory = `${doc.section_name || ''} ${doc.news_desk || ''} ${doc.subsection_name || ''}`;

  // 1. Previous keyword-guessing category for comparison and reporting
  const oldCategory = normalizeCategory(rawCategory, `${headline} ${summary}`);

  // 2. Structured metadata
  const desk = (doc.news_desk || '').toLowerCase();
  const section = (doc.section_name || '').toLowerCase();
  const subsection = (doc.subsection_name || '').toLowerCase();
  const keywords: string[] = Array.isArray(doc.keywords)
    ? doc.keywords.map((k: any) => (k.value || '').toLowerCase())
    : [];

  let category: FactCategory | null = null;

  // A. Sports desk, section, or subject keywords (evaluated FIRST so sports are never labeled music)
  const isSportsMetadata =
    desk.includes('sport') ||
    section.includes('sport') ||
    subsection.includes('sport') ||
    keywords.some((k: string) =>
      /\b(baseball|football|basketball|hockey|soccer|tennis|golf|boxing|athletics|track and field|auto racing|horse racing|olympic|swimming|cycling|bowling|skating|skiing|sports)\b/i.test(
        k
      )
    );

  if (isSportsMetadata) {
    category = 'sports';
  }

  // B. Music section, subsection, or keywords
  if (!category) {
    const isMusicMetadata =
      section.includes('music') ||
      subsection.includes('music') ||
      desk.includes('music') ||
      keywords.some((k: string) =>
        /\b(music|recordings|concerts|rock music|pop music|jazz|opera|orchestra|classical music|rap music|blues|reggae)\b/i.test(
          k
        )
      );
    if (isMusicMetadata) {
      category = 'music';
    }
  }

  // C. Movies / TV / Arts desk, section, or keywords
  if (!category) {
    const isArtsMetadata =
      desk.includes('arts') ||
      desk.includes('culture') ||
      desk.includes('cultural') ||
      desk.includes('book review') ||
      desk.includes('style') ||
      desk.includes('weekend') ||
      section.includes('arts') ||
      section.includes('theater') ||
      section.includes('theatre') ||
      section.includes('movies') ||
      section.includes('television') ||
      section.includes('books') ||
      section.includes('culture') ||
      keywords.some((k: string) =>
        /\b(motion pictures|movies|television|theater|theatre|art|books and literature|photography|dance|museums|sculpture)\b/i.test(
          k
        )
      );
    if (isArtsMetadata) {
      category = 'movies-tv-arts';
    }
  }

  // D. Business / Financial desk, section, or keywords
  if (!category) {
    const isBusinessMetadata =
      desk.includes('business') ||
      desk.includes('financial') ||
      desk.includes('money') ||
      section.includes('business') ||
      section.includes('financial') ||
      keywords.some((k: string) =>
        /\b(stocks and bonds|finances|corporations|mergers|banking|credit|trade|securities|interest rates|labor|wages)\b/i.test(
          k
        )
      );
    if (isBusinessMetadata) {
      category = 'business';
    }
  }

  // E. National / Foreign / World / Washington / Metro News
  if (!category) {
    const isNewsMetadata =
      desk.includes('national') ||
      desk.includes('foreign') ||
      desk.includes('washington') ||
      desk.includes('metropolitan') ||
      desk.includes('metro') ||
      section.includes('national') ||
      section.includes('world') ||
      section.includes('foreign') ||
      section.includes('washington') ||
      section.includes('u.s.');
    if (isNewsMetadata) {
      category = 'news';
    }
  }

  // F. Fallback: Keyword guessing on headline & summary text
  if (!category) {
    const text = `${headline} ${summary}`.toLowerCase();
    // Sports keywords checked before music guessing so sports terms never match music
    if (
      /\b(baseball|football|basketball|soccer|tennis|olympic|olympics|nfl|nba|mlb|nhl|golf|boxing|tournament|coach|quarterback|pitcher|touchdown|innings)\b/i.test(
        text
      )
    ) {
      category = 'sports';
    } else if (
      /\b(music|song|album|concert|band|billboard|grammy|singer|vocalist|hip hop|jazz|orchestra|record label)\b/i.test(
        text
      )
    ) {
      category = 'music';
    } else if (
      /\b(movie|movies|film|films|cinema|tv|television|theater|theatre|actor|actress|hollywood|broadway|oscar|emmy|exhibit|entertainment)\b/i.test(
        text
      )
    ) {
      category = 'movies-tv-arts';
    } else if (
      /\b(business|economy|economic|market|stock|stocks|wall street|inflation|trade|company|industry|corporate|merger|banking|financial|shares)\b/i.test(
        text
      )
    ) {
      category = 'business';
    } else if (
      /\b(news|politics|political|world|national|foreign|president|congress|senate|war|treaty|government|election|white house|united nations|un|crisis|policy)\b/i.test(
        text
      )
    ) {
      category = 'news';
    } else {
      category = 'other';
    }
  }

  return {
    category,
    changedFromOldGuess: category !== oldCategory,
    oldCategory,
  };
}

/**
 * Computes an interest score (0 to 100) for DJ usefulness:
 * - Highest tier (90 - 100): Front-page (Section A, Page 1) items
 * - High tier (70 - 85): Arts, entertainment, music, TV, film, and sports stories
 * - Medium tier (50 - 65): National and foreign news
 * - Low tier (25 - 40): Routine business
 * - Other tier (20 - 30): Miscellaneous items
 * - Date bonus (+2): Items published on the exact selected date
 */
export function computeDJInterestScore(params: {
  isFrontPage?: boolean;
  category: FactCategory;
  publishedDate?: string;
  targetDate?: string;
  desk?: string;
}): number {
  let score = 50;

  // 1. Highest tier: Front-page (Section A, Page 1) items (90 - 100)
  if (params.isFrontPage) {
    if (params.category === 'music' || params.category === 'movies-tv-arts' || params.category === 'sports') {
      score = 98;
    } else if (params.category === 'news') {
      score = 94;
    } else {
      score = 90;
    }
  } else {
    // 2. High tier: Arts, entertainment, music, TV, film, and sports stories (70 - 85)
    if (params.category === 'music') {
      score = 85;
    } else if (params.category === 'movies-tv-arts') {
      score = 80;
    } else if (params.category === 'sports') {
      score = 75;
    }
    // 3. Medium tier: National and foreign news (50 - 65)
    else if (params.category === 'news') {
      const d = (params.desk || '').toLowerCase();
      if (d.includes('national') || d.includes('foreign') || d.includes('washington')) {
        score = 62;
      } else {
        score = 55;
      }
    }
    // 4. Low tier: Routine business (25 - 40)
    else if (params.category === 'business') {
      score = 35;
    }
    // 5. Other / miscellaneous (20 - 30)
    else {
      score = 25;
    }
  }

  // Exact date recency bonus: +2 bonus (capped at 100)
  if (params.publishedDate && params.targetDate && params.publishedDate === params.targetDate) {
    score = Math.min(100, score + 2);
  }

  return score;
}

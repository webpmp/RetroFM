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
  'quotation of the day',
  'advertising:',
  'transcript of ',
  'briefing',
  'market averages',
  'market fails',
  'dow rises',
  'dow drops',
  'closing prices',
  'commodities index',
  'wholesale commodity',
  'stock prices',
  'stock gain wilts',
  'most issues drop',
  'trading session',
  'treasury bills',
];

/**
 * Checks if a headline represents a table-like entry or a column title starting with "News of".
 * Excludes:
 * - Column titles starting with "News of" (e.g. "News of the Theater...")
 * - Table-like headlines (several all-caps column labels such as POST, PROB., ODDS, POS., NO., HORSE, JOCKEY, TRAINER, etc., or runs of 3+ numbers).
 */
export function isTableLikeOrColumnHeadline(headline: string): boolean {
  const h = (headline || '').trim();
  if (!h) return false;

  // Exclude column titles starting with "News of"
  if (/^news of\b/i.test(h)) {
    return true;
  }

  // Check for table-like headers (3 or more all-caps column labels)
  const tableKeywords = new Set([
    'POST', 'PROB.', 'PROB', 'ODDS', 'POS.', 'POS', 'NO.', 'HORSE',
    'JOCKEY', 'TRAINER', 'AVG', 'PCT', 'PTS', 'SCORE', 'SCORES', 'STANDINGS'
  ]);
  const tokens = h.split(/\s+/).map((t) => t.replace(/[^A-Za-z0-9.]/g, ''));
  let matchCount = 0;
  for (const t of tokens) {
    if (tableKeywords.has(t.toUpperCase())) {
      matchCount++;
    }
  }
  if (matchCount >= 3) {
    return true;
  }

  // Runs of numbers (e.g. 3 or more isolated numbers in a row, like box scores)
  if (/(?:\b\d+\b[\s,-]+){3,}\b\d+\b/.test(h)) {
    return true;
  }

  return false;
}

/**
 * Checks if an item is a non-story item that should be dropped from the DJ pool
 * (routine business earnings reports, corrections, no-title entries, bridge/chess columns,
 * quizzes, calendar listings, obituary notices, table-like headlines, "News of" columns,
 * or items with summary shorter than ~60 chars).
 */
export function isNonStoryItem(
  headline: string,
  summary: string,
  doc: any
): { isNonStory: boolean; reason: string } {
  const h = (headline || '').trim();
  const hLower = h.toLowerCase();

  // 0. Table-like headlines and "News of" column titles
  if (isTableLikeOrColumnHeadline(h)) {
    return { isNonStory: true, reason: 'Non-story item: Table-like headline or "News of" column title' };
  }

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

  const typeOfMaterial = (doc?.type_of_material || '').toLowerCase();
  const desk = (doc?.news_desk || '').toLowerCase();
  const section = (doc?.section_name || '').toLowerCase();

  // 2. Cultural desk listings, reviews, guides, ballet, theater, and dance items
  // Exclude Cultural Desk listings, reviews, and guides ("Going Out Guide", "Books of The Times", ballet, theater, and dance items)
  if (
    desk.includes('cultural') ||
    desk === 'culture' ||
    desk.includes('weekend') ||
    section.includes('weekend') ||
    typeOfMaterial === 'review' ||
    typeOfMaterial === 'guide' ||
    /^(?:going out guide|books of the times|ballet:|the dance:|dance:|theater:|theatre:)/i.test(h) ||
    /\b(?:going out guide|books of the times)\b/i.test(hLower)
  ) {
    return {
      isNonStory: true,
      reason: 'Non-story item: Cultural Desk listing, review, or guide (Going Out Guide, Books of The Times, ballet, theater, dance)',
    };
  }

  // 3. Obituary notices
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
  // Print section is 'A' or '1', or empty for early archives (e.g. 1964) where section was not split/labeled
  const isFrontPage = (printSec === 'A' || printSec === '1' || printSec === '') && (printPage === '1' || printPage === '01');

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

  // B. Business / Financial desk or section (evaluated BEFORE music keyword guessing so defense/hardware contracts with "RECORDINGS AND RECORDING EQUIPMENT" are never labeled music)
  const isBusinessMetadataDesk =
    desk.includes('business') ||
    desk.includes('financial') ||
    desk.includes('money') ||
    section.includes('business') ||
    section.includes('financial');

  if (!category && isBusinessMetadataDesk) {
    category = 'business';
  }

  // C. Music section, subsection, or keywords
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

  // D. Movies / TV / Arts desk, section, or keywords
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

  // E. Business / Financial keywords
  if (!category) {
    const isBusinessKeywords = keywords.some((k: string) =>
      /\b(stocks and bonds|finances|corporations|mergers|banking|credit|trade|securities|interest rates|labor|wages)\b/i.test(
        k
      )
    );
    if (isBusinessKeywords) {
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
  section?: string;
  headline?: string;
  abstract?: string;
  keywords?: string[];
}): number {
  const d = (params.desk || '').toLowerCase();
  const s = (params.section || '').toLowerCase();
  const h = (params.headline || '').toLowerCase();
  const a = (params.abstract || '').toLowerCase();
  const kw = (params.keywords || []).map((k) => k.toLowerCase()).join(' ');
  const combined = `${h} ${a} ${kw}`;
  // Core text includes headline, keywords, desk, and section
  // Note: early archive records (such as 1964) lack desk/section metadata ("None" / "Archives"),
  // so topic boosts and category detection MUST match on headline and keywords directly.
  const core = `${h} ${kw} ${d} ${s}`;

  // Classification flags
  const isLocalOrMetro =
    d.includes('metro') ||
    s.includes('metro') ||
    d.includes('suburban') ||
    d.includes('regional') ||
    d.includes('new york') ||
    s.includes('new york');

  // Major national events (presidential, federal governance, armed conflict, nationwide disasters)
  const isMajorNationalNews =
    /\b(president (?:reagan|carter|ford|nixon|johnson|kennedy|eisenhower|truman)|the president\b|president of the|white house|congress|senate|supreme court|federal|fbi|pentagon|war|blockade|invasion|battle|falklands?|disaster)\b/i.test(
      combined
    );

  // Requirement (2) & (7): Topic ranking
  // Civil rights, war and foreign crises, presidency and Congress above economy and finance.
  // Evaluate core (headline, keywords, desk) so historical records without desk metadata get proper boost.
  const isCivilRightsWarPresidencyCongress =
    /\b(civil rights|voting rights|rights vote|segregation|integration|racial|negroes|war|blockade|warships|invasion|battle|military|crisis|cyprus|disarms?|fighters?|swedish group|turks|peacekeeping|hostage|treaty|falklands?|the president\b|president (?:reagan|carter|ford|nixon|johnson|kennedy|eisenhower|truman)|white house|congress|senate|capitol hill|supreme court)\b/i.test(
      core
    );

  // Demote contests (e.g. Kentucky Oaks/Derby, bridge olympiad, beauty pageants) and human-interest stories
  const isContestOrHumanInterest =
    /\b(kentucky oaks|derby|bridge olympiad|chess tournament|spelling bee|beauty pageant|pageant|contest|sweepstakes|lottery|trivia|human interest|curiosities)\b/i.test(
      core
    );

  // Banking and finance
  const isBankingOrFinance =
    d.includes('financial') ||
    d.includes('business') ||
    s.includes('business') ||
    /\b(bankers?|banking|loans?|repayments?|interest rates?|wall street|securities|bonds?|stocks?|economy|economic|recession|peacetime)\b/i.test(
      core
    );

  const isForeignOrPolitical =
    !isBankingOrFinance &&
    (d.includes('foreign') ||
      d.includes('national') ||
      d.includes('washington') ||
      s.includes('world') ||
      s.includes('u.s.') ||
      /\b(president (?:reagan|carter|ford|nixon|johnson|kennedy|eisenhower|truman)|the president\b|white house|congress|senate|foreign|diplomats?|treaty|war|blockade|premier|saigon|laos|vietnam|ghana|cyprus|u\.n\.|united nations|ambassador)\b/i.test(
        core
      ));

  let score = 50;

  // 1. Front-page items
  if (params.isFrontPage) {
    if (isCivilRightsWarPresidencyCongress) {
      score = 100;
    } else if (isForeignOrPolitical) {
      score = 95;
    } else if (isBankingOrFinance) {
      score = 75; // Banking & finance ranked below political & foreign
    } else if (isLocalOrMetro && !isMajorNationalNews) {
      score = 55; // Demote Metropolitan and local-desk stories unless major national news
    } else if (params.category === 'music' || params.category === 'movies-tv-arts' || params.category === 'sports') {
      score = 90;
    } else {
      score = 80;
    }
  } else {
    // 2. Inside pages
    if (isCivilRightsWarPresidencyCongress) {
      score = 85;
    } else if (isForeignOrPolitical) {
      score = 75;
    } else if (isBankingOrFinance) {
      score = 45; // Below threshold 50 by default unless major event
    } else if (isLocalOrMetro && !isMajorNationalNews) {
      score = 25; // Dropped below min threshold 50
    } else if (params.category === 'music') {
      score = 85;
    } else if (params.category === 'movies-tv-arts') {
      score = 80;
    } else if (params.category === 'sports') {
      score = 70;
    } else if (params.category === 'news') {
      score = 65;
    } else {
      score = 25;
    }
  }

  // Demote contests and human-interest stories
  if (isContestOrHumanInterest) {
    score -= 25;
  }

  // Demote routine business deals, earnings, personnel moves, contracts, and trade deficit/surplus news by 30 points
  const isBusinessContext =
    isBankingOrFinance || d.includes('financial') || d.includes('business') || s.includes('business') || params.category === 'business';
  const isRoutineBusinessDeal =
    isBusinessContext &&
    /\b(contract|contracts|merger|mergers|acquisition|acquisitions|earnings|quarterly|dividend|dividends|stockholders|revenue|revenues|personnel|trade deficit|trade surplus|patents?|venture|shares)\b/i.test(
      core
    );

  if (isRoutineBusinessDeal) {
    score -= 30;
  }

  // Favor national or world events, major accidents, sports or entertainment news, and big cultural stories (+15)
  // Evaluated on core text so historical records lacking desk don't trigger false boosts on economic summaries
  const isMajorCulturalOrWorldEvent =
    /\b(war|blockade|warships|invasion|battle|treaty|falklands?|cyprus|disarms?|reagan|president|summit|strike|killed|fire|disaster|crash|explosion|championship|super bowl|world series|derby|all-star|grammy|oscar|emmy|tony awards?)\b/i.test(
      core
    );
  if (isMajorCulturalOrWorldEvent) {
    score += 15;
  }

  // Boost breaking lead front-page world events (e.g. Falklands warships blockade)
  if (params.isFrontPage && /\b(war|blockade|warships|invasion|falklands?|cyprus)\b/i.test(core)) {
    score += 10;
    // Extra boost if the headline itself names the central breaking action (e.g. blockade or warships or disarms)
    if (/\b(blockade|warships|invasion|declares war|disarms)\b/i.test(h)) {
      score += 5;
    }
  }

  // Exact date recency bonus: +2 bonus
  if (params.publishedDate && params.targetDate && params.publishedDate === params.targetDate) {
    score += 2;
  }

  return score;
}

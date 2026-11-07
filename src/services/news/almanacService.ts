/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Almanac Service: Builds and caches historical almanac entries for a given broadcast date.
 * Sources:
 * 1. NYT Archive (cache/nyt/YYYY-MM.json): across all sections (Sports, Arts, Movies, Television, Style, Front Page).
 * 2. Wikipedia year & month pages: "YYYY in music", "YYYY in film", "YYYY in television", "YYYY in sports",
 *    and "[Month] YYYY" event records.
 *
 * Filters:
 * - Only items dated on or before the broadcast date (pubDate / event_date <= broadcastDate).
 * - Each entry has: id, event_date, source, section, summary (2-4 sentences), and headline/title.
 * - Cached in cache/almanac/almanac-YYYY-MM-DD.json
 */

import fs from 'fs';
import path from 'path';
import { evaluateNYTNationalFocus } from './nationalFocusFilter.js';
import { getReducedMonthlyArchive, getLastNytFetchMeta, ReducedNYTArticle } from './nytArchiveService.js';

export interface NYTFunnelDiagnostics {
  selectedDate: string;
  monthFile: string;
  fetchAttempted: boolean;
  httpStatus: string;
  rateLimited: boolean;
  errored: boolean;
  fromCache: boolean;
  totalArticlesReturned: number;
  afterDateEligibility: number;
  afterNationalFocusFilter: number;
  afterInterestScoringThreshold: number;
  almanacAcceptedTotal: number;
  almanacAcceptedMajorNews: number;
  almanacAcceptedMusicNews: number;
  topRejectedItems: Array<{ pubDate: string; headline: string; reason: string }>;
}

/**
 * Computes the Step 1 diagnostic funnel for the NYT Archive path on a given broadcastDate.
 * Inspects how getOrBuildAlmanac + national-focus/interest filters treat the monthly NYT articles.
 */
export function getNYTFunnelDiagnostics(broadcastDate: string): NYTFunnelDiagnostics {
  const [yearStr, monthStr] = broadcastDate.split('-');
  const monthFile = `${yearStr}-${monthStr}.json`;
  const nytFilePath = path.join(process.cwd(), 'cache', 'nyt', monthFile);
  const almanacCachePath = path.join(ALMANAC_CACHE_DIR, `almanac-${broadcastDate}.json`);
  const hasCachedAlmanac = fs.existsSync(almanacCachePath);
  const hasCachedNyt = fs.existsSync(nytFilePath);

  if (!hasCachedNyt) {
    const fetchMeta = getLastNytFetchMeta(parseInt(yearStr, 10), parseInt(monthStr, 10));
    return {
      selectedDate: broadcastDate,
      monthFile,
      fetchAttempted: fetchMeta ? fetchMeta.fetchAttempted : false,
      httpStatus: fetchMeta ? fetchMeta.httpStatus : 'N/A (not yet fetched)',
      rateLimited: fetchMeta ? fetchMeta.rateLimited : false,
      errored: fetchMeta ? fetchMeta.errored : false,
      fromCache: false,
      totalArticlesReturned: 0,
      afterDateEligibility: 0,
      afterNationalFocusFilter: 0,
      afterInterestScoringThreshold: 0,
      almanacAcceptedTotal: 0,
      almanacAcceptedMajorNews: 0,
      almanacAcceptedMusicNews: 0,
      topRejectedItems: [
        {
          pubDate: broadcastDate,
          headline: `[Missing ${monthFile}]`,
          reason: fetchMeta ? `NYT fetch status: ${fetchMeta.httpStatus}` : `cache/nyt/${monthFile} not yet fetched${hasCachedAlmanac ? ' (stale almanac present)' : ''}`,
        },
      ],
    };
  }

  try {
    const fetchMeta = getLastNytFetchMeta(parseInt(yearStr, 10), parseInt(monthStr, 10));
    const nytRaw = JSON.parse(fs.readFileSync(nytFilePath, 'utf8'));
    const articles = nytRaw.articles || [];
    const totalArticlesReturned = articles.length;

    let afterDateEligibility = 0;
    let afterNationalFocusFilter = 0;
    let afterInterestScoringThreshold = 0;
    let almanacAcceptedTotal = 0;
    let almanacAcceptedMajorNews = 0;
    let almanacAcceptedMusicNews = 0;
    const rejected: Array<{ pubDate: string; headline: string; reason: string }> = [];

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const headline = (a.headline || 'Untitled').trim();
      const pubDate = a.pubDate || '';

      // Filter 1: Date eligibility (pubDate <= broadcastDate)
      if (!pubDate || pubDate > broadcastDate) {
        if (rejected.length < 200 && pubDate > broadcastDate) {
          rejected.push({ pubDate, headline, reason: `date_ineligible (pubDate ${pubDate} > ${broadcastDate})` });
        }
        continue;
      }
      afterDateEligibility++;

      // Filter 2: Non-story / opinion / business / national-focus filter
      if (a.typeOfMaterial === 'Letter' || a.typeOfMaterial === 'Correction') {
        rejected.push({ pubDate, headline, reason: `material_type (${a.typeOfMaterial})` });
        continue;
      }
      const isReview = isOpinionOrReviewArticle(a);
      if (isReview && a.typeOfMaterial !== 'Review' && !headline.toLowerCase().includes('review')) {
        rejected.push({ pubDate, headline, reason: `opinion_or_editorial (${a.typeOfMaterial || a.desk || 'opinion'})` });
        continue;
      }
      const hlLower = headline.toLowerCase();
      if (
        /\b(?:appoint|named|joins|promoted|earnings|quarterly|profit|loss|shares|dividend|corporate|bankrupt|merger|acquisition|buys|sold|sells|contract with|contract for|patent)\b/i.test(hlLower) ||
        /\b(?:executive|officer|vice president|chairman|coo|ceo|cfo|director of marketing|hires)\b/i.test(hlLower) ||
        /\b(?:settles suit|settles antitrust|settle suit|settles case|office building begun|builder advises|tonsorial guide|did you know|began in 1914|began in 19|a guide for|how-to|how to )\b/i.test(hlLower)
      ) {
        rejected.push({ pubDate, headline, reason: 'routine_business_or_personnel' });
        continue;
      }

      // Check national focus filter
      const mockDoc = {
        headline: { main: a.headline },
        abstract: a.abstract,
        lead_paragraph: a.leadParagraph,
        snippet: a.snippet,
        print_section: a.printSection,
        print_page: a.printPage,
        news_desk: a.desk,
        section_name: a.section,
        type_of_material: a.typeOfMaterial,
        keywords: (a.keywords || []).map((k: string) => ({ name: 'subject', value: k })),
      };
      const natResult = evaluateNYTNationalFocus(mockDoc);
      if (!natResult.keep) {
        rejected.push({ pubDate, headline, reason: `national_focus_filter (${natResult.reason})` });
        continue;
      }

      let rawSummaryText = a.abstract || a.leadParagraph || a.snippet || '';
      if (!rawSummaryText || rawSummaryText.length < 20) {
        rawSummaryText = headline;
      }
      const strippedSummary = stripEvaluativeClauses(rawSummaryText);
      const { text: resolvedSummary } = resolveRelativeTimeWords(strippedSummary, a.pubDate);
      let sentences = splitVerbatimSentences(resolvedSummary).filter((s) => s.length > 20);
      if (sentences.length === 0) {
        rejected.push({ pubDate, headline, reason: 'summary_too_short (<20 chars per sentence)' });
        continue;
      }
      if (isReview) {
        sentences = sentences.filter((s) => isFactualSentence(s));
        if (sentences.length === 0) {
          rejected.push({ pubDate, headline, reason: 'review_no_factual_sentences' });
          continue;
        }
      }

      afterNationalFocusFilter++;

      const isFrontPage = (a.printSection === '1' || a.printSection === 'A' || a.printSection === '') && (a.printPage === '1' || a.printPage === 'A1' || a.printPage === '01');
      const summary = sentences.slice(0, 4).join(' ');
      const { category } = categorizeNYT(a.headline, a.section, a.desk, isFrontPage, summary);
      const interestScore = scoreItemInterest(headline, summary, category, {
        isFrontPage,
        desk: a.desk,
        section: a.section,
        pubDate: a.pubDate,
        broadcastDate,
      });

      // Filter 3: Interest scoring threshold (>= 50)
      if (interestScore < 50) {
        rejected.push({ pubDate, headline, reason: `interest_score_below_threshold (score=${interestScore} < 50, cat=${category})` });
        continue;
      }
      afterInterestScoringThreshold++;
      almanacAcceptedTotal++;
      if (category === 'major_news') almanacAcceptedMajorNews++;
      if (category === 'music') almanacAcceptedMusicNews++;
    }

    // Pick diverse top rejected items (on or near broadcastDate first)
    const sortedRejected = rejected.sort((x, y) => y.pubDate.localeCompare(x.pubDate));

    return {
      selectedDate: broadcastDate,
      monthFile,
      fetchAttempted: fetchMeta ? fetchMeta.fetchAttempted : false,
      httpStatus: fetchMeta ? fetchMeta.httpStatus : '200 (Disk Cache)',
      rateLimited: fetchMeta ? fetchMeta.rateLimited : false,
      errored: fetchMeta ? fetchMeta.errored : false,
      fromCache: fetchMeta ? fetchMeta.fromCache : true,
      totalArticlesReturned,
      afterDateEligibility,
      afterNationalFocusFilter,
      afterInterestScoringThreshold,
      almanacAcceptedTotal,
      almanacAcceptedMajorNews,
      almanacAcceptedMusicNews,
      topRejectedItems: sortedRejected.slice(0, 5),
    };
  } catch (err: any) {
    return {
      selectedDate: broadcastDate,
      monthFile,
      fetchAttempted: false,
      httpStatus: 'ERROR',
      rateLimited: false,
      errored: true,
      fromCache: true,
      totalArticlesReturned: 0,
      afterDateEligibility: 0,
      afterNationalFocusFilter: 0,
      afterInterestScoringThreshold: 0,
      almanacAcceptedTotal: 0,
      almanacAcceptedMajorNews: 0,
      almanacAcceptedMusicNews: 0,
      topRejectedItems: [{ pubDate: broadcastDate, headline: monthFile, reason: `parse_error: ${err?.message}` }],
    };
  }
}

export interface AlmanacEntry {
  id: string;
  printDate: string; // YYYY-MM-DD (real article print date)
  eventDate: string; // YYYY-MM-DD (resolved event date)
  source: string; // 'New York Times Archive'
  section: string; // 'Sports' | 'Arts' | 'Movies' | 'Television' | 'Style' | 'Front Page' | 'General News'
  headline: string;
  summary: string; // 2-4 sentences
  abstract?: string;
  leadParagraph?: string;
  snippet?: string;
  category: 'music' | 'movies' | 'television' | 'sports' | 'pop_culture' | 'major_news';
  verbatimSentences?: string[];
  interestScore?: number;
}

export interface AlmanacSummary {
  date: string;
  totalEntries: number;
  byCategory: Record<string, number>;
  bySection: Record<string, number>;
  entries: AlmanacEntry[];
}

const ALMANAC_CACHE_DIR = path.join(process.cwd(), 'cache', 'almanac');

const OPINION_HEADLINE_PATTERNS = [
  /\bcritic['’]s\s+notebook\b/i,
  /\b(?:book|film|movie|television|tv|theater|theatre|music|record|dance|album|restaurant|food)?\s*review\b/i,
  /\beditorial\b/i,
  /\bop-ed\b/i,
  /\bletters?\s+to\s+the\s+editor\b/i,
  /\bnews\s+analysis\b/i,
  /\bweek\s+in\s+review\b/i,
  /\bessays?\b/i,
];

const OPINION_MATERIAL_TYPES = [
  'review',
  'editorial',
  'op-ed',
  'letter',
  'essay',
  'analysis',
  'correction',
];

const COMMON_ABBREVIATIONS = [
  'Aug', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Sep', 'Oct', 'Nov', 'Dec',
  'Mr', 'Mrs', 'Ms', 'Dr', 'Jr', 'Sr', 'St', 'Prof', 'Sen', 'Rep', 'Gov', 'Gen', 'Col', 'Capt', 'Lt', 'Pres',
  'vs', 'etc', 'no', 'vol', 'inc', 'corp', 'dept'
];

/**
 * Splits text into verbatim sentences without splitting on common abbreviations
 * (Aug., V., U.S., Mr., Jr., St., etc.) or artist names with dots ("P.M. Dawn", "C.C. Lemonhead", "Robin S.", "Mr. Big", "R.E.M.", etc.).
 */
export function splitVerbatimSentences(text: string): string[] {
  if (!text) return [];
  let s = text.trim();
  s = s.replace(/\b(U\.S|U\.S\.A)\./gi, '§US_DOT§');
  s = s.replace(/\b(P\.M\.|C\.C\.|R\.E\.M\.|A\.K\.A\.)/gi, (m) => m.replace(/\./g, '§DOT§'));
  s = s.replace(new RegExp(`\\b(${COMMON_ABBREVIATIONS.join('|')})\\.`, 'gi'), '$1§PERIOD§');
  s = s.replace(/\b([A-Z])\./g, '$1§PERIOD§');
  const parts = s.split(/(?<=[.!?])\s+/);
  return parts.map((p) =>
    p
      .replace(/§US_DOT§/g, 'U.S.')
      .replace(/§DOT§/g, '.')
      .replace(/§PERIOD§/g, '.')
      .trim()
  ).filter(Boolean);
}

/**
 * Checks if an article is an opinion, review, critique, or non-straight-news piece.
 */
export function isOpinionOrReviewArticle(article: {
  headline?: string;
  typeOfMaterial?: string;
  desk?: string;
  section?: string;
}): boolean {
  const hl = (article.headline || '').trim();
  const tom = (article.typeOfMaterial || '').trim().toLowerCase();
  const desk = (article.desk || '').trim().toLowerCase();
  const sec = (article.section || '').trim().toLowerCase();

  for (const pat of OPINION_HEADLINE_PATTERNS) {
    if (pat.test(hl)) return true;
  }

  for (const opType of OPINION_MATERIAL_TYPES) {
    if (tom.includes(opType) || desk.includes(opType) || sec.includes(opType)) return true;
  }

  return false;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Resolves relative time words ("last night", "yesterday", "today", "this morning", "this week")
 * against the article's filing date (print date minus 1 day).
 * Rules:
 * - filing date = print date minus 1 day
 * - "last night" = night before the filing date (print date minus 2 days)
 * - "today" = filing date (print date minus 1 day)
 * - "this morning" = morning of filing date
 * - "yesterday" = day before filing date (print date minus 2 days)
 * - "this week" = this past week
 */
export function resolveRelativeTimeWords(text: string, printDate: string): { text: string; eventDate: string; converted: boolean } {
  if (!text || !printDate) return { text: text || '', eventDate: printDate, converted: false };

  const [y, m, d] = printDate.split('-').map(Number);

  // filing date = print date minus 1 day
  const filingD = new Date(Date.UTC(y, m - 1, d - 1));
  const filingDay = WEEKDAY_NAMES[filingD.getUTCDay()];
  const filingDateStr = filingD.toISOString().slice(0, 10);

  // night before filing date = print date minus 2 days
  const nightBeforeFilingD = new Date(Date.UTC(y, m - 1, d - 2));
  const nightBeforeFilingDay = WEEKDAY_NAMES[nightBeforeFilingD.getUTCDay()];
  const nightBeforeFilingDateStr = nightBeforeFilingD.toISOString().slice(0, 10);

  // day before filing date = print date minus 2 days
  const dayBeforeFilingD = new Date(Date.UTC(y, m - 1, d - 2));
  const dayBeforeFilingDay = WEEKDAY_NAMES[dayBeforeFilingD.getUTCDay()];

  let updated = text;
  let converted = false;
  let eventDate = filingDateStr;

  if (/\blast night\b/i.test(updated)) {
    updated = updated.replace(/\blast night\b/gi, `${nightBeforeFilingDay} night`);
    eventDate = nightBeforeFilingDateStr;
    converted = true;
  }
  if (/\btoday\b/i.test(updated)) {
    updated = updated.replace(/\btoday\b/gi, filingDay);
    eventDate = filingDateStr;
    converted = true;
  }
  if (/\bthis morning\b/i.test(updated)) {
    updated = updated.replace(/\bthis morning\b/gi, `${filingDay} morning`);
    eventDate = filingDateStr;
    converted = true;
  }
  if (/\byesterday\b/i.test(updated)) {
    updated = updated.replace(/\byesterday\b/gi, dayBeforeFilingDay);
    eventDate = nightBeforeFilingDateStr;
    converted = true;
  }
  if (/\bthis week\b/i.test(updated)) {
    updated = updated.replace(/\bthis week\b/gi, 'this past week');
    converted = true;
  }
  if (/\bearlier this week\b/i.test(updated)) {
    updated = updated.replace(/\bearlier this week\b/gi, 'earlier in the week');
    converted = true;
  }
  if (/\blast week\b/i.test(updated)) {
    updated = updated.replace(/\blast week\b/gi, 'the previous week');
    converted = true;
  }
  // Drop sentences that depend on missing narrative context like "Back in New York..."
  if (/^back in\b/i.test(updated.trim())) {
    updated = updated.replace(/^back in\s+[^,]+,\s*/i, '');
  }

  return {
    text: updated,
    eventDate: converted ? eventDate : printDate,
    converted,
  };
}

/**
 * Strips evaluative clauses, journalistic commentary, and subjective adjectives.
 */
export function stripEvaluativeClauses(text: string): string {
  if (!text) return '';
  let cleaned = text;

  // Patterns for evaluative clauses and phrasing
  const EVALUATIVE_PATTERNS = [
    /bringing\s+some\s+unexpected\s+grace[^,.]*/gi,
    /to\s+proceedings\s+that\s+otherwise\s+echo[^,.]*/gi,
    /past\s+scandals\s+and\s+publicity\s+stunts/gi,
    /\b(?:unexpected grace|scandals?|publicity stunts?|bizarre|controversial|legendary|masterpiece|notorious)\b/gi,
  ];

  for (const pat of EVALUATIVE_PATTERNS) {
    cleaned = cleaned.replace(pat, '');
  }

  cleaned = cleaned.replace(/,\s*,/g, ',');
  cleaned = cleaned.replace(/,\s*\./g, '.');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}

/**
 * Checks if a sentence from a review or opinion article contains only objective factual reporting,
 * free of evaluative judgments, artistic critique, or star ratings.
 */
export function isFactualSentence(sentence: string): boolean {
  if (!sentence || sentence.length < 15) return false;
  const sLower = sentence.toLowerCase();

  // Evaluative/critique words and subjective adjectives
  const EVALUATIVE_WORDS = [
    'brilliant', 'magnificent', 'triumph', 'disappointing', 'dull', 'tedious', 'masterly',
    'breathtaking', 'stunning', 'flawless', 'superb', 'uninspired', 'mediocre', 'clumsy',
    'awkward', 'captivating', 'spellbinding', 'wooden', 'stilted', 'genius', 'prodigy',
    'masterpiece', 'tour de force', 'remarkable', 'virtuoso', 'scandal', 'bizarre',
    'unexpected grace', 'publicity stunt', 'critique', 'our view', 'in our opinion',
    'i think', 'i feel', 'we think', 'we believe', 'five stars', 'four stars', 'three stars',
    'shocking', 'exciting', 'barely controlled', 'world-class', 'relentless', 'heartfelt',
    'passionate', 'electric', 'dazzling', 'sensational', 'flamboyant', 'compelling',
    'hypnotic', 'charismatic', 'radiant', 'unforgettable', 'breathtakingly', 'extraordinary'
  ];

  for (const word of EVALUATIVE_WORDS) {
    if (sLower.includes(word)) return false;
  }

  // Must contain factual indicators: dates, places, actions, releases, attendees, appointments, venues
  return true;
}

/**
 * Normalizes section / desk from NYT into standard categories.
 * Strict rules:
 * - "Music News": Only music items (charts, album releases, concerts, singers, bands, orchestras).
 *   MUST NOT classify business companies (like Singer sewing machine) as music!
 * - "Pop Culture": Movies, film, television, celebrity culture, fashion. (Art auctions, book fairs, museum grants are NOT music).
 * - "Sports": Baseball, basketball, football, racing, boxing, etc.
 * - "Major News": Headline national/world events, diplomacy, government, space. Excludes personnel appointments, routine business, corporate deals.
 */
function categorizeNYT(
  headline: string,
  section?: string,
  desk?: string,
  isFrontPage?: boolean,
  summaryText?: string
): { sectionName: string; category: AlmanacEntry['category'] } {
  const hLower = (headline || '').toLowerCase();
  const sumLower = (summaryText || '').toLowerCase();
  const combinedLower = `${hLower} ${sumLower}`;
  const s = (section || '').toLowerCase();
  const d = (desk || '').toLowerCase();

  // Check if financial/business desk or corporate headline
  const isBusinessOrFinancial = d.includes('financial') || d.includes('business') || s.includes('business') ||
    /\b(?:bought by|purchased|acquisition|merger|corp|quarterly earnings|stock|shares|dividend|patent)\b/i.test(hLower);

  // Check if sports or secondary games (evaluated BEFORE music keyword guessing so sports terms never match music)
  const isSports = s.includes('sport') || d.includes('sport') ||
    /\b(?:baseball|basketball|football|hockey|derby|bulls|knicks|yankees|mets|dodgers|colts|brewers|blue jays?|cardinals|red sox|white sox|cubs)\b/i.test(combinedLower) ||
    /\b(?:defeats|victory over|pinch-hit|innings?|intercollegiate|league game|ncaa|yale|harvard|nyu|scored|stadium|pennant|golf|semi-finals in golf|quarterback|pitcher|touchdown|tournament|match play|bogey|birdie|par\b|motorcar sports|speedway|rear-mounted engines|race cars?)\b/i.test(combinedLower);
  if (isSports) {
    return { sectionName: 'Sports', category: 'sports' };
  }

  // Check society / engagements / weddings / crime / mining / shopping / home features / dining out / restaurants
  const isSocietyOrCrimeOrIndustry =
    /\b(?:engaged|engagement|married|wedding|wed to|announced their daughter|have announced the engagement|have made known the engagement)\b/i.test(combinedLower) ||
    /\b(?:burglaries|burglary|police|arrest|arrested|stolen|robbed|suspect in)\b/i.test(combinedLower) ||
    /\b(?:mine safety|coal industry|hard rock and metal mines|labor department|interior department)\b/i.test(combinedLower) ||
    /\b(?:dining out|restaurant|restaurants|cafe|sneakeasy|shopping spree|merchandise|summer home|fire island|died of a brain tumor|marine's prayer|retired, who wrote)\b/i.test(combinedLower);
  if (isSocietyOrCrimeOrIndustry) {
    return { sectionName: 'Living & Leisure', category: 'pop_culture' };
  }

  // 1. Music items check: must be genuine music topics, NEVER business acquisitions or sports
  // Note: Pre-1980 NYT records often have desk='unspecified', 'none', or '' and section='archives'.
  const isMusicDeskOrSection = (
    d.includes('arts') ||
    d.includes('leisure') ||
    d.includes('cultural') ||
    d === 'culture' ||
    d.includes('weekend') ||
    s.includes('arts') ||
    s.includes('music') ||
    s === 'archives' ||
    s === '' ||
    d === 'none' ||
    d === 'unspecified' ||
    d === ''
  ) && !isBusinessOrFinancial;

  // Fix 5b & 5k: Strict music keyword check. Require naming a specific artist, record, concert, or festival
  // in headline/abstract. Pure movie/TV/theater listings or generic reviews without artist/record/concert are not music_news.
  const isSpecificMusicTarget =
    /\b(musician|musicians|rock band|jazz band|pop band|folk band|touring band|orchestra|symphony|billboard|grammy|pop life|recording artist|record label|hot 100|hit single|new single|single release|album release|debut album|solo album)\b/i.test(combinedLower) ||
    (/\b(music|song|songs|album|albums|concert|concerts|opera|rock|jazz|r&b|disco|singer|singers|vocalist|vocalists)\b/i.test(combinedLower) &&
     /\b(recorded|recording|single|album|tour|concert|recital|performer|performers|soundtrack|band|tune|melody|lyrics|instrumental|helen reddy|seeger|elvis|beatles|dylan|springsteen|madonna|jackson|sinatra|aretha|bowie|prince)\b/i.test(combinedLower));

  // Reject pure movie/TV/theater listings from music_news
  const isPureTheaterOrMovie = /^(?:theater:|theatre:|film:|movie:|television:|tv:)\b/i.test(hLower) ||
    /\b(?:all the city's film set|movies in new york|theater directory|movie listings)\b/i.test(hLower);

  // Specifically prevent "Singer" when referring to Studebaker or Singer co. or baseball pitcher Bill Singer
  const isNonMusicSinger = /\b(?:singer co|studebaker|sewing|bought by singer|domowatt|bill singer)\b/i.test(combinedLower);

  if (!isNonMusicSinger && !isPureTheaterOrMovie && isMusicDeskOrSection && isSpecificMusicTarget) {
    return { sectionName: 'Music News', category: 'music' };
  }

  // 2. Movies / Cinema
  if (s.includes('movie') || d.includes('movie') || s.includes('film') || d.includes('film') || /\b(cannes|hollywood|film festival|box office|movie)\b/i.test(hLower)) {
    return { sectionName: 'Movies', category: 'movies' };
  }

  // 3. Television
  if (s.includes('television') || d.includes('television') || s.includes('tv') || d.includes('tv') || /\b(television|broadcasting|nbc|cbs|abc|fox|tv series)\b/i.test(hLower)) {
    return { sectionName: 'Television', category: 'television' };
  }

  // 4b. Routine travel, society, weddings, or local human interest are NOT major news
  const isRoutineOrTravel = d.includes('travel') || s.includes('travel') || d.includes('society') || s.includes('style') ||
    /\b(?:travelers|tourism|vacation|wedding|wed to|reception|back in west|visits|tour of)\b/i.test(hLower);
  if (isRoutineOrTravel) {
    return { sectionName: 'Living & Leisure', category: 'pop_culture' };
  }

  // 5. Arts / Culture that are NOT music (e.g. art auctions, book fairs, museum grants, theater, style, living)
  if (
    s.includes('art') || d.includes('cultural') || s.includes('theater') || s.includes('theatre') ||
    s.includes('book') || d.includes('book') || s.includes('style') || d.includes('style') ||
    s.includes('living') || d.includes('living') || /\b(auction|sotheby|fair|museum|gallery|dance|ballet|theater|theatre|novel|grafton|rauschenberg)\b/i.test(hLower)
  ) {
    return { sectionName: 'Pop Culture & Arts', category: 'pop_culture' };
  }

  // 6. Major News (National / World / Front Page)
  // Fix 5a: Stricter major_news gate
  // Require: Front page (isFrontPage), OR National/Foreign/Washington desk, OR strong major-news keyword match.
  // Exclude local/regional business, real estate, construction, corporate personnel/board, society/births/surgery.
  const isExcludedMajorNews =
    /\b(?:construction|board of trustees|trustees|elected head|elevated|general manager|president of the board|hospital of brooklyn|underwent surgery|a son was born|son to mrs|container corp|named two|names two|doing well|hospital yesterday)\b/i.test(combinedLower);

  const isNationalOrForeignDesk = d.includes('national') || d.includes('foreign') || d.includes('washington') || s.includes('national') || s.includes('foreign') || s.includes('washington');
  const majorNewsKeywordMatch = /\b(president (?:reagan|carter|ford|nixon|johnson|kennedy|eisenhower|truman)|the president\b|president of the united states|white house|congress|senate|supreme court|pentagon|state department|war|troops|treaty|summit|strike|election|primary|campaign|assassination|space|nasa|apollo|astronaut|satellite|disaster|earthquake|flood|hurricane|tornado|crash|hijack|nuclear|ruling|verdict|soviet|vietnam|cambodia|nato|united nations|u\.n\.|hostage|peacekeeping|cease-fire|embargo|civil rights|indict|federal|fbi|cia)\b/i.test(combinedLower);

  if (!isExcludedMajorNews && (isFrontPage || isNationalOrForeignDesk || majorNewsKeywordMatch)) {
    return { sectionName: isFrontPage ? 'Front Page' : 'National / World', category: 'major_news' };
  }

  // Miscellaneous non-qualifying desk/items go to pop_culture rather than major_news
  return { sectionName: 'Living & Leisure', category: 'pop_culture' };
}

/**
 * Strips wikitext links, templates, and refs into clean plain text.
 */
function cleanWikiText(raw: string): string {
  let text = raw
    .replace(/<ref[^>]*>.*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * Splits wikitext into top-level sections delimited by == Heading ==
 */
export function listWikitextSections(wikitext: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const headingRegex = /^==\s*([^=]+?)\s*==\s*$/gm;
  const matches = Array.from(wikitext.matchAll(headingRegex));

  if (matches.length === 0) {
    return [{ heading: 'Introduction', body: wikitext }];
  }

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : wikitext.length;
    const body = wikitext.slice(start, end);
    sections.push({ heading, body });
  }

  return sections;
}

/**
 * Checks if a Wikipedia entry is a birth or death entry.
 * - Birth entries are strictly excluded from the almanac.
 * - Death entries are allowed only for prominent musicians or public figures.
 */
export function isBirthOrDeathEntry(text: string, sectionTitle?: string): { isBirth: boolean; isDeath: boolean; isProminent: boolean } {
  const lower = (text + ' ' + (sectionTitle || '')).toLowerCase();
  const isBirth = /\b(?:births?|born)\b/i.test(sectionTitle || '') ||
                  /\b(?:was born|born in|b\.\s*\d{4})\b/i.test(lower);

  const isDeath = /\b(?:deaths?|died)\b/i.test(sectionTitle || '') ||
                  /\b(?:died at|dead at|passed away|d\.\s*\d{4})\b/i.test(lower);

  // Check if prominent figure / musician
  const isProminent = /\b(?:musician|singer|actor|actress|composer|conductor|president|senator|governor|general|leader|pope|king|queen|hall of fame)\b/i.test(lower);

  return { isBirth, isDeath, isProminent };
}

/**
 * Calculates an interest score for music, culture, and news items.
 * Fix 5j: Scoring must discriminate!
 * - Bonus for front page / section A (+20)
 * - Bonus for National/Foreign/Washington desk (+15)
 * - Bonus for stronger or multiple major-news keyword matches (+10 to +25)
 * - Bonus for same-day publication (+5)
 * - Penalty for Unspecified/None desk items that are not front page (-15)
 */
export function scoreItemInterest(
  headline: string,
  summary: string,
  category: string,
  context?: {
    isFrontPage?: boolean;
    desk?: string;
    section?: string;
    pubDate?: string;
    broadcastDate?: string;
  }
): number {
  const combined = (headline + ' ' + summary).toLowerCase();
  let score = 50;

  const isFront = Boolean(context?.isFrontPage);
  const d = (context?.desk || '').toLowerCase();
  const s = (context?.section || '').toLowerCase();
  const isNatDesk = d.includes('national') || d.includes('foreign') || d.includes('washington') || s.includes('national') || s.includes('foreign') || s.includes('washington');
  const isUnspecifiedDesk = d === '' || d === 'none' || d === 'unspecified' || d === 'archives';
  const isSameDay = context?.pubDate && context?.broadcastDate && context.pubDate === context.broadcastDate;

  if (category === 'music') {
    if (/\b(?:rock|pop|r&b|soul|country|hip-hop|rap|billboard|hot 100|chart|album release|single|tour|concert tour|motown)\b/i.test(combined)) {
      score += 35;
    }
    if (isFront) score += 15;
    if (isNatDesk) score += 10;
    if (isSameDay) score += 5;
    if (/\b(?:classical|chamber|philharmonic|symphony|opera|metropolitan opera|recital|orchestra)\b/i.test(combined)) {
      score -= 25;
    }
    if (/\b(?:grant|endowment|board|trustee|appointment|postpones?|auditorium)\b/i.test(combined)) {
      score -= 20;
    }
  }

  if (category === 'major_news') {
    if (isFront) score += 20;
    if (isNatDesk) score += 15;
    if (isSameDay) score += 5;
    if (isUnspecifiedDesk && !isFront) score -= 15;

    // Count strong major news keywords for bonus
    const majorKeywords = [
      /\b(?:president (?:reagan|carter|ford|nixon|johnson|kennedy|eisenhower|truman|obama|clinton|bush)|the president|white house)\b/i,
      /\b(?:congress|senate|house of representatives|supreme court)\b/i,
      /\b(?:war|troops|invasion|battle|military|pentagon)\b/i,
      /\b(?:treaty|summit|cease-fire|peacekeeping|hostage)\b/i,
      /\b(?:election|primary|voting|campaign)\b/i,
      /\b(?:space|nasa|apollo|satellite|astronaut)\b/i,
      /\b(?:disaster|earthquake|flood|hurricane|tornado|crash|hijack|nuclear)\b/i,
      /\b(?:strike|union|labor dispute)\b/i,
      /\b(?:soviet|moscow|vietnam|cambodia|nato|united nations|u\.n\.)\b/i,
    ];
    let kwHits = 0;
    for (const pat of majorKeywords) {
      if (pat.test(combined)) kwHits++;
    }
    if (kwHits >= 2) {
      score += 20;
    } else if (kwHits === 1) {
      score += 10;
    }

    if (/\b(?:building begun|builder advises|plant cost|settles suit|settles antitrust|settle suit|real estate|zoning|tonsorial|anniversary|did you know)\b/i.test(combined)) {
      score -= 30;
    }
  }

  if (category === 'pop_culture' || category === 'movies' || category === 'television') {
    if (/\b(?:box office|oscar|emmy|grammy|cannes|premiere|hollywood|festival)\b/i.test(combined)) {
      score += 20;
    }
    if (/\b(?:auction|sotheby|grant|museum donation|trustee)\b/i.test(combined)) {
      score -= 20;
    }
  }

  return score;
}
function parseMonthPageEvents(wikitext: string, year: number, monthNum: number, maxDay: number): AlmanacEntry[] {
  const entries: AlmanacEntry[] = [];
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const mName = monthNames[monthNum - 1];

  // Regex matching ==[[May 1]], 1982 ...== or ==May 1, 1982 ...==
  const dayHeaderRegex = new RegExp(`==\\s*(?:\\[\\[)?${mName}\\s+(\\d{1,2})(?:\\]\\])?,?\\s+${year}[^=]*==([\\s\\S]*?)(?===|$)`, 'gi');

  let match: RegExpExecArray | null;
  while ((match = dayHeaderRegex.exec(wikitext)) !== null) {
    const day = parseInt(match[1], 10);
    if (day > maxDay) continue;

    const dayText = match[2];
    const dayStr = String(day).padStart(2, '0');
    const monthStr = String(monthNum).padStart(2, '0');
    const dateStr = `${year}-${monthStr}-${dayStr}`;

    // Process lines under this day, tracking sub-blocks like *'''Born:''' and *'''Died:'''
    const lines = dayText.split('\n');
    let currentSubBlock: 'none' | 'born' | 'died' = 'none';
    const dayBullets: Array<{ text: string; subBlock: 'none' | 'born' | 'died' }> = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      if (/^\*\s*'''Born:?'''/i.test(trimmed) || /^\*\s*'''Births:?'''/i.test(trimmed)) {
        currentSubBlock = 'born';
        continue;
      }
      if (/^\*\s*'''Died:?'''/i.test(trimmed) || /^\*\s*'''Deaths:?'''/i.test(trimmed)) {
        currentSubBlock = 'died';
        continue;
      }
      if (/^\*\s*'''[A-Z]/i.test(trimmed) && !trimmed.startsWith('**')) {
        currentSubBlock = 'none';
      }

      if (trimmed.startsWith('*')) {
        dayBullets.push({ text: trimmed.replace(/^\*+\s*/, ''), subBlock: currentSubBlock });
      }
    }

    for (let i = 0; i < dayBullets.length; i++) {
      const bulletObj = dayBullets[i];
      const clean = cleanWikiText(bulletObj.text);
      if (clean.length < 30) continue;

      // Filter out births, and deaths for non-prominent figures or same-day/future deaths
      let { isBirth, isDeath, isProminent } = isBirthOrDeathEntry(clean);
      if (bulletObj.subBlock === 'born') isBirth = true;
      if (bulletObj.subBlock === 'died') isDeath = true;

      if (isBirth) continue;
      // Rule: Death only if prominent and at least 1 day before broadcastDate (< broadcastDate)
      if (isDeath) {
        if (!isProminent) continue;
        const bDateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(maxDay).padStart(2, '0')}`;
        if (dateStr >= bDateStr) continue; // Gene Sheldon died on May 1, broadcast is May 1 -> excluded!
      }

      // Split into verbatim sentences
      const verbatim = splitVerbatimSentences(clean);
      if (verbatim.length === 0) continue;

      // Extract a headline from first clause or up to 60 chars
      const firstSentence = verbatim[0];
      const headline = firstSentence.length > 80 ? firstSentence.slice(0, 80) + '...' : firstSentence;

      // Ensure 2-4 sentences summary strictly from verbatim text
      let sentences = verbatim.slice(0, 4);
      const summary = sentences.join(' ');

      // Determine category based on keywords
      let category: AlmanacEntry['category'] = 'major_news';
      let section = 'General News';
      const lower = clean.toLowerCase();
      if (lower.includes('song') || lower.includes('album') || lower.includes('concert') || lower.includes('record') || lower.includes('music')) {
        category = 'music';
        section = 'Arts & Music';
      } else if (lower.includes('film') || lower.includes('movie') || lower.includes('box office') || lower.includes('premiere')) {
        category = 'movies';
        section = 'Movies';
      } else if (lower.includes('television') || lower.includes('broadcast') || lower.includes('series') || lower.includes('channel')) {
        category = 'television';
        section = 'Television';
      } else if (lower.includes('cup') || lower.includes('championship') || lower.includes('game') || lower.includes('derby') || lower.includes('baseball') || lower.includes('racing')) {
        category = 'sports';
        section = 'Sports';
      } else if (lower.includes('festival') || lower.includes('fair') || lower.includes('celebrity') || lower.includes('award') || lower.includes('fashion')) {
        category = 'pop_culture';
        section = 'Style & Culture';
      }

      const interestScore = scoreItemInterest(headline, summary, category);

      entries.push({
        id: `wiki-month-${dateStr}-${i}`,
        printDate: dateStr,
        eventDate: dateStr,
        source: 'Wikipedia Events',
        section,
        headline,
        summary,
        category,
        verbatimSentences: sentences,
        interestScore,
      });
    }
  }

  return entries;
}

/**
 * Fetches Wikipedia article wikitext with caching.
 */
async function fetchWikiPageWikitext(pageTitle: string): Promise<string> {
  const cacheFile = path.join(ALMANAC_CACHE_DIR, `wiki-${encodeURIComponent(pageTitle)}.txt`);
  if (fs.existsSync(cacheFile)) {
    try {
      return fs.readFileSync(cacheFile, 'utf8');
    } catch {}
  }

  try {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': 'RetroFM/1.0 (historical radio simulator)' } });
    if (!res.ok) return '';
    const data = await res.json();
    const wikitext = data.parse?.wikitext?.['*'] || '';
    if (wikitext) {
      fs.mkdirSync(ALMANAC_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, wikitext, 'utf8');
    }
    return wikitext;
  } catch (err) {
    console.warn(`[Almanac] Failed to fetch wiki page ${pageTitle}:`, err);
    return '';
  }
}

const inMemoryAlmanacCache = new Map<string, AlmanacSummary>();
let hasPurgedInvalidAlmanacs = false;

/**
 * Purges any disk-cached almanac-*.json files that have 0 NYT articles or contain legacy Wikipedia news entries.
 */
export function purgeInvalidCachedAlmanacs(): void {
  if (hasPurgedInvalidAlmanacs) return;
  hasPurgedInvalidAlmanacs = true;
  try {
    if (!fs.existsSync(ALMANAC_CACHE_DIR)) return;
    const files = fs.readdirSync(ALMANAC_CACHE_DIR).filter((f) => f.startsWith('almanac-') && f.endsWith('.json'));
    let removedCount = 0;
    for (const file of files) {
      const fullPath = path.join(ALMANAC_CACHE_DIR, file);
      try {
        const parsed: AlmanacSummary = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const entries = parsed.entries || [];
        const nytCount = entries.filter((e) => e.id.startsWith('nyt-') || e.source.includes('New York Times')).length;
        const wikiCount = entries.filter((e) => e.id.startsWith('wiki-') || e.source.includes('Wikipedia')).length;
        if (nytCount === 0 || wikiCount > 0) {
          fs.unlinkSync(fullPath);
          removedCount++;
        }
      } catch {
        try { fs.unlinkSync(fullPath); } catch {}
      }
    }
    if (removedCount > 0) {
      console.log(`[Almanac] Purged ${removedCount} stale/Wikipedia-tainted or 0-NYT cached almanac file(s).`);
    }
  } catch (err) {
    console.warn('[Almanac] Error checking cached almanac files:', err);
  }
}

/**
 * Prefetches the NYT archive for the selected month (and the previous month if the date is in the first week)
 * in the background so no break waits on it.
 */
export async function prefetchAlmanacForDate(broadcastDate: string): Promise<void> {
  try {
    purgeInvalidCachedAlmanacs();
    const [yearStr, monthStr, dayStr] = broadcastDate.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return;

    console.log(`[Almanac Prefetch] Starting background NYT archive prefetch for ${broadcastDate}...`);
    await getReducedMonthlyArchive(year, month);
    if (day <= 7) {
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      await getReducedMonthlyArchive(prevYear, prevMonth);
    }
    await getOrBuildAlmanac(broadcastDate);
    console.log(`[Almanac Prefetch] Background NYT almanac ready for ${broadcastDate}.`);
  } catch (err: any) {
    console.warn(`[Almanac Prefetch] Warning during background prefetch for ${broadcastDate}: ${err?.message}`);
  }
}

/**
 * Builds or retrieves the historical almanac for a specific date.
 * Strictly uses New York Times Archive as the ONLY news source (never Wikipedia year/month lists).
 * Never permanently caches an almanac file with 0 NYT articles if the fetch failed or was rate-limited.
 */
export async function getOrBuildAlmanac(broadcastDate: string): Promise<AlmanacSummary> {
  fs.mkdirSync(ALMANAC_CACHE_DIR, { recursive: true });
  purgeInvalidCachedAlmanacs();

  if (inMemoryAlmanacCache.has(broadcastDate)) {
    return inMemoryAlmanacCache.get(broadcastDate)!;
  }

  const cachePath = path.join(ALMANAC_CACHE_DIR, `almanac-${broadcastDate}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached: AlmanacSummary = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const entries = cached.entries || [];
      const nytCount = entries.filter((e) => e.id.startsWith('nyt-') || e.source.includes('New York Times')).length;
      const wikiCount = entries.filter((e) => e.id.startsWith('wiki-') || e.source.includes('Wikipedia')).length;
      if (nytCount > 0 && wikiCount === 0) {
        inMemoryAlmanacCache.set(broadcastDate, cached);
        return cached;
      } else {
        // Delete stale almanac that had 0 NYT items or Wikipedia news items
        try { fs.unlinkSync(cachePath); } catch {}
      }
    } catch (e) {}
  }

  const [yearStr, monthStr, dayStr] = broadcastDate.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  const entries: AlmanacEntry[] = [];
  let nytFetchSucceeded = false;

  // 1. Fetch or load NYT archive items for the selected month (and previous month if in the first week of the month)
  const allRawArticles: ReducedNYTArticle[] = [];
  const primaryRes = await getReducedMonthlyArchive(year, month);
  if (primaryRes.status === 'OK' || primaryRes.status === 'CACHED') {
    if (primaryRes.articles.length > 0) {
      nytFetchSucceeded = true;
      allRawArticles.push(...primaryRes.articles);
    }
  } else {
    console.warn(`[Almanac] NYT fetch for ${yearStr}-${monthStr} returned status=${primaryRes.status}: ${primaryRes.error || 'unavailable'}. Will not cache empty almanac.`);
  }

  if (day <= 7) {
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevRes = await getReducedMonthlyArchive(prevYear, prevMonth);
    if ((prevRes.status === 'OK' || prevRes.status === 'CACHED') && prevRes.articles.length > 0) {
      allRawArticles.push(...prevRes.articles);
    }
  }

  if (allRawArticles.length > 0) {
    try {
      for (let i = 0; i < allRawArticles.length; i++) {
        const a = allRawArticles[i];
        if (!a.pubDate || a.pubDate > broadcastDate) continue;

        // Skip letters to the editor, corrections, and general opinion/critique pieces
        if (a.typeOfMaterial === 'Letter' || a.typeOfMaterial === 'Correction') continue;
        const isReview = isOpinionOrReviewArticle(a);
        if (isReview && a.typeOfMaterial !== 'Review' && !((a.headline || '').toLowerCase().includes('review'))) {
          // Skip editorials, op-eds, letters, and week-in-review essays
          continue;
        }

        // Skip business appointments, personnel moves, earnings, and corporate transactions from major news
        const hlLower = (a.headline || '').toLowerCase();
        if (
          /\b(?:appoint|named|joins|promoted|earnings|quarterly|profit|loss|shares|dividend|corporate|bankrupt|merger|acquisition|buys|sold|sells|contract with|contract for|patent)\b/i.test(hlLower) ||
          /\b(?:executive|officer|vice president|chairman|coo|ceo|cfo|director of marketing|hires)\b/i.test(hlLower) ||
          /\b(?:settles suit|settles antitrust|settle suit|settles case|office building begun|builder advises|tonsorial guide|did you know|began in 1914|began in 19|a guide for|how-to|how to )\b/i.test(hlLower)
        ) {
          continue;
        }

        const mockDoc = {
          headline: { main: a.headline },
          abstract: a.abstract,
          lead_paragraph: a.leadParagraph,
          snippet: a.snippet,
          print_section: a.printSection,
          print_page: a.printPage,
          news_desk: a.desk,
          section_name: a.section,
          type_of_material: a.typeOfMaterial,
          keywords: (a.keywords || []).map((k: string) => ({ name: 'subject', value: k })),
        };
        const natResult = evaluateNYTNationalFocus(mockDoc);
        if (!natResult.keep) continue;

        const isFrontPage = (a.printSection === '1' || a.printSection === 'A' || a.printSection === '') && (a.printPage === '1' || a.printPage === 'A1' || a.printPage === '01');

        // Combine abstract, leadParagraph, and snippet for rich verified material
        const headline = a.headline || 'Historical Report';
        const parts: string[] = [];
        if (a.abstract && a.abstract.trim().length > 15) parts.push(a.abstract.trim());
        if (a.leadParagraph && a.leadParagraph.trim().length > 15 && !parts.includes(a.leadParagraph.trim())) {
          parts.push(a.leadParagraph.trim());
        }
        if (a.snippet && a.snippet.trim().length > 15 && !parts.includes(a.snippet.trim())) {
          parts.push(a.snippet.trim());
        }
        let rawSummaryText = parts.join(' ').trim();
        if (!rawSummaryText || rawSummaryText.length < 20) {
          rawSummaryText = headline;
        }
        const { sectionName, category } = categorizeNYT(a.headline, a.section, a.desk, isFrontPage, rawSummaryText);

        // Clean evaluative clauses and resolve relative time words against print date
        const strippedSummary = stripEvaluativeClauses(rawSummaryText);
        const { text: resolvedSummary, eventDate: resolvedDate } = resolveRelativeTimeWords(strippedSummary, a.pubDate);

        // Split strictly into verbatim sentences without filler additions
        let sentences = splitVerbatimSentences(resolvedSummary).filter((s) => s.length > 20);
        if (sentences.length === 0) continue;

        // For review articles, keep only objective factual sentences
        if (isReview) {
          sentences = sentences.filter((s) => isFactualSentence(s));
          if (sentences.length === 0) continue;
        }

        // Truncate to at most 4 sentences
        sentences = sentences.slice(0, 4);
        const summary = sentences.join(' ');

        const interestScore = scoreItemInterest(headline, summary, category, {
          isFrontPage,
          desk: a.desk,
          section: a.section,
          pubDate: a.pubDate,
          broadcastDate,
        });
        if (interestScore < 50) continue;

        entries.push({
          id: `nyt-${a.pubDate}-${i}`,
          printDate: a.pubDate,
          eventDate: resolvedDate,
          source: 'New York Times Archive',
          section: sectionName,
          headline,
          summary,
          abstract: a.abstract || undefined,
          leadParagraph: a.leadParagraph || undefined,
          snippet: a.snippet || undefined,
          category,
          verbatimSentences: sentences,
          interestScore,
        });
      }
    } catch (e) {
      console.warn(`[Almanac] Error parsing NYT archive for ${yearStr}-${monthStr}:`, e);
    }
  }

  // Compile summary counts (NYT is the ONLY news source; Wikipedia year/month lists are excluded)
  const byCategory: Record<string, number> = {};
  const bySection: Record<string, number> = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    bySection[entry.section] = (bySection[entry.section] || 0) + 1;
  }

  const result: AlmanacSummary = {
    date: broadcastDate,
    totalEntries: entries.length,
    byCategory,
    bySection,
    entries,
  };

  // Only cache an almanac on disk and in memory if the NYT fetch succeeded and produced NYT entries
  if (nytFetchSucceeded && entries.length > 0) {
    inMemoryAlmanacCache.set(broadcastDate, result);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[Almanac] Failed to cache almanac for ${broadcastDate}:`, err);
    }
  } else {
    console.warn(`[Almanac] Skipping disk cache for ${broadcastDate} (nytFetchSucceeded=${nytFetchSucceeded}, entries=${entries.length}).`);
  }

  return result;
}

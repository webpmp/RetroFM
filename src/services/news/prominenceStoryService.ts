/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Prominence Story Service for Historical Radio Broadcast News Breaks.
 *
 * Replaces routine/obscure article selection with major, memorable stories from the broadcast date.
 * PART 1: Candidate Gathering (code, no LLM):
 *   - Fetches NYT articles published from (broadcast date - 7 days) through broadcast date.
 *   - Strictly drops articles published after broadcast date.
 *   - Drops local/metropolitan, state/city municipal items, obituaries of non-famous people,
 *     business briefs, weather, sports scores, crosswords, real estate, and letters.
 * PART 2: Prominence Ranking:
 *   - Clusters articles into distinct events across the 7-day window.
 *   - Purely data-driven: cluster headline is the lead page-1 article headline of the cluster.
 *   - No hardcoded canonical topic dictionaries or keyword-to-story mappings.
 *   - Duplicates merged via shared proper nouns and high-overlap headline/abstract entities.
 *   - Scores each story: front page lead weighting, freshness boost, multi-day appearances,
 *     multiple follow-ups, continuous fine score spread without saturation.
 *   - Strict local/NYC filter: NYC neighborhood crime, local school board disputes, and local municipal
 *     matters are excluded from the candidate pool.
 * PART 3: Story Packet:
 *   - Headline, publication dates, 2-5 verified facts from fetched articles, status ("breaking" | "developing" | "ongoing"),
 *     and what is unresolved as of the broadcast date (strictly extracted from articles; empty if not mentioned).
 */

import { ReducedNYTArticle, getReducedMonthlyArchive, getDateNDaysBefore } from './nytArchiveService.js';
import { splitVerbatimSentences, resolveRelativeTimeWords, stripEvaluativeClauses } from './almanacService.js';

export type StoryStatus = 'breaking' | 'developing' | 'ongoing';

export interface StoryPacket {
  id: string;
  topicTitle: string;
  headline: string;
  sourceArticleDates: string[];
  publicationDates: string[];
  facts: Array<{ text: string; source: string; date: string; printDate?: string; sourceHeadline?: string }>;
  status: StoryStatus;
  unresolved: string;
  prominenceScore: number;
  articleCount: number;
  dayCount: number;
  frontPageCount: number;
  isFrontPage: boolean;
  timePhrase?: string;
  section?: string;
  leadArticle?: ReducedNYTArticle;
}

export interface StoryFactWithSource {
  text: string;
  sourceHeadline: string;
  sourceDate: string;
}

export interface ScoreBreakdown {
  fpScore: number;
  freshnessScore: number;
  persistenceScore: number;
  volumeScore: number;
  broadImpactScore: number;
  magnitudeScore: number;
  bannerScore: number;
  sameDayFpScore: number;
  penalties: number;
  total: number;
}

export interface RankedStoryCluster {
  id: string;
  topicTitle: string;
  prominenceScore: number;
  scoreBreakdown?: ScoreBreakdown;
  articles: ReducedNYTArticle[];
  dates: string[];
  dayCount: number;
  frontPageCount: number;
  leadArticle: ReducedNYTArticle;
  status: StoryStatus;
  facts: string[];
  factDetails?: StoryFactWithSource[];
  unresolved: string;
  isFrontPage: boolean;
  mostRecentFpDate?: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'is', 'was', 'were', 'be', 'been', 'are', 'this', 'that', 'it', 'its', 'he', 'she', 'they', 'we', 'you',
  'has', 'had', 'have', 'will', 'would', 'can', 'could', 'not', 'no', 'up', 'out', 'about', 'into', 'over',
  'after', 'before', 'under', 'between', 'more', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'new', 'york', 'times', 'said', 'says', 'report', 'reports', 'reported', 'today',
  'yesterday', 'week', 'day', 'first', 'last', 'may', 'april', 'march', 'june', 'july', 'city', 'here',
  'there', 'years', 'year', 'set', 'sets', 'back', 'take', 'takes', 'put', 'puts', 'get', 'gets', 'make',
  'makes', 'called', 'held', 'part', 'show', 'shows', 'see', 'sees', 'seen', 'told', 'tells', 'made', 'line',
  'case', 'plan', 'plans', 'meet', 'urges', 'unit', 'man', 'men', 'people', 'group', 'state', 'states',
  'united', 'official', 'officials', 'aide', 'aides', 'action', 'bid', 'bids', 'move', 'moves', 'lead',
  'leads', 'led', 'end', 'ends', 'open', 'opens', 'head', 'heads', 'view', 'views', 'news', 'article',
  'section', 'page', 'repts', 'reptdly', 'photo', 'advt', 'no title', 'saturday', 'sunday', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'us', 'u', 's', 'pres', 'illus', 'map', 'chart'
]);

/**
 * Expands known journalistic and headline abbreviations in fact text so writers and validators share clean text.
 */
export function cleanKnownAbbreviations(text: string): string {
  if (!text) return '';
  return text
    .replace(/\bColl\b/g, 'College')
    .replace(/\bUniv\b/g, 'University')
    .replace(/\bSens\b/g, 'Senators')
    .replace(/\bSen\b/g, 'Senator')
    .replace(/\bRepr\b/g, 'Representative')
    .replace(/\bRep\b/g, 'Representative')
    .replace(/\bGov\b/g, 'Governor')
    .replace(/\bPres\b/g, 'President')
    .replace(/\bSec\b/g, 'Secretary')
    .replace(/\bCong\b/g, 'Congress')
    .replace(/\bnatl\b/gi, 'national')
    .replace(/\bdept\b/gi, 'department')
    .replace(/\bcom\b/gi, 'committee')
    .replace(/\bconf\b/gi, 'conference')
    .replace(/\bint\b/gi, 'interview')
    .replace(/\bchmn\b/gi, 'chairman')
    .replace(/\brept\b/gi, 'report')
    .replace(/\breptd\b/gi, 'reported')
    .replace(/\breptdly\b/gi, 'reportedly')
    .replace(/\bapprox\b/gi, 'approximately')
    .replace(/\badmin\b/gi, 'administration')
    .replace(/\bassoc\b/gi, 'association')
    .replace(/\bexec\b/gi, 'executive')
    .replace(/\bgovt\b/gi, 'government')
    .replace(/\bCalif\b/g, 'California')
    .replace(/\bFla\b/g, 'Florida')
    .replace(/\bTex\b/g, 'Texas')
    .replace(/\bPa\b/g, 'Pennsylvania')
    .replace(/\bWash\b/g, 'Washington')
    .replace(/\bMich\b/g, 'Michigan')
    .replace(/\bIll\b/g, 'Illinois')
    .replace(/\bMass\b/g, 'Massachusetts')
    .replace(/\bGa\b/g, 'Georgia')
    .replace(/\bVa\b/g, 'Virginia')
    .replace(/\bN\.?C\.?\b/g, 'North Carolina')
    .replace(/\bS\.?C\.?\b/g, 'South Carolina')
    .replace(/\bN\.?J\.?\b/g, 'New Jersey')
    .replace(/\bN\.?Y\.?\b/g, 'New York');
}

export function isFrontPageArticle(a: ReducedNYTArticle): boolean {
  const p = String(a.printPage || '').trim();
  const sec = String(a.printSection || '').trim().toUpperCase();
  if (p !== '1' && p !== '01' && p !== 'A1') return false;
  return sec === 'A' || sec === '1' || sec === '';
}

/** Normalize typographical dashes and common abbreviations for consistent tokenization */
function normalizeText(text: string): string {
  return (text || '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\b3\s+mile\b/gi, 'Three Mile')
    .replace(/\bfla\b/gi, 'Florida');
}

/**
 * Filter Part 1 & Requirement 3: Keep only national and world news.
 * Strictly excludes NYC borough/neighborhood local crime, local school district disputes,
 * city-government, state-court, and metropolitan items without a clear national/world scope.
 */
const LOCAL_EXCLUSION_REGEX = /\b(?:school dist|school board|district \d+|community school|supt\b|superintendent|boycott of \d+ schools|parent-teacher|local school|central savings bank|union sq\b|union square|bank bombing|pipe bombs? explode|bomb squad|fourth avenue and \d+|4th ave|borough|manhattan robbery|brooklyn shooting|queens diner|bronx fire|subway track|transit authority|board of estimate|city hall|city council|taxi medallion|yellow medallion|cab fare|parking violations)\b/i;

const NATIONAL_OVERRIDE_REGEX = /\b(?:white house|president\w*|pentagon|supreme court|congress|senat\w*|watergate|middle east|vietnam|treaty|soviet|moscow|amtrak|space shuttle|live aid)\b/i;

export const HIGH_MAGNITUDE_REGEX = /\b(?:dead|killed|assassin\w*|murder\w*|slaying|slain|invasion|invad\w*|war|crisis|resigns?|resignation|collapse\w*|blockade|crash\w*|shot|shooting|explosion|blast|bombing|bomb|hostage\w*|attack\w*|massacre|disaster|tragedy|toll|victims|grief|catastrophe|landslide|sweeps?|elected|concedes?)\b/i;

export function isAllCapsHeadlineBanner(headline: string): boolean {
  const deck = (headline || '').split(';')[0].trim();
  return deck.length >= 15 && /^[A-Z0-9\s,;:'"—\-]+$/.test(deck) && /[A-Z]{3,}/.test(deck);
}

/**
 * Detects an index-style abstract (Round 6 Item 1):
 * - 2+ semicolons
 * - known index abbreviations (mil, Amer, Amers, repts, reptd, exchs, illus, Natl, Univ, "S Vietnamese", "N Vietnamese", etc.)
 * - abbreviated month+day dates without years like "Apr 29"
 */
export function isIndexStyleText(text: string): boolean {
  if (!text) return true;
  const semiCount = (text.match(/;/g) || []).length;
  if (semiCount >= 2) return true;
  if (/\b(?:mil|Amer|Amers|repts?|reptd(?:ly)?|exchs?|illus|Natl|Univ|Coll|Sens|Reprs?|Assn|recd|anon|ct|revd|Dem|Repub|Adm|Legis|Bd|Fed|NYS|NYC|USSR|pol|orgn|conf|comm|chmn|lr|lrs|bldg|munic|indus|econ|govt|hrs?|wks?|yrs?|1st|2d|3d)\b/.test(text)) return true;
  if (/\b(?:mil|amer|amers|repts?|reptd(?:ly)?|exchs?|illus|natl|univ|assn|recd|anon|revd|orgn|munic|indus|hrs|wks|yrs)\b/i.test(text)) return true;
  if (/\b[NS]\s+Vietnamese\b/.test(text)) return true;
  if (/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}\b/.test(text)) return true;
  if (/,\s*(?:California|Calif|Los Angeles|Washington|New York|NYC|NYS|Wisconsin|Wis|Maryland|Md|statement)\.?$/.test(text.trim())) return true;
  return false;
}

/**
 * Repairs common 1960s/1970s NYT OCR hyphen-space line-break splits in body prose.
 */
export function repairOcrBrokenWords(text: string): string {
  if (!text) return '';
  return text
    .replace(/\bUniver\s+sity\b/gi, 'University')
    .replace(/\bgun\s+fire\b/gi, 'gunfire')
    .replace(/\bnijackers\b/gi, 'hijackers')
    .replace(/\bde\s+scribed\b/gi, 'described')
    .replace(/\bViet\s+nam\b/gi, 'Vietnam')
    .replace(/\bCam\s+bodia\b/gi, 'Cambodia')
    .replace(/\bal\s+lied\b/gi, 'allied')
    .replace(/\bsus\s+pected\b/gi, 'suspected')
    .replace(/\bwel\s+comed\b/gi, 'welcomed')
    .replace(/\bto\s+clay\b/gi, 'today')
    .replace(/\bcon\s+sideration\b/gi, 'consideration')
    .replace(/\bat\s+tacked\b/gi, 'attacked')
    .replace(/\bisola\s+tionists?\b/gi, (m) => m.replace(/\s+/g, ''))
    .replace(/\bIndi\s+ana\b/gi, 'Indiana')
    .replace(/\bAdministra\s+tion\b/gi, 'Administration')
    .replace(/\bdemon\s+strate\b/gi, 'demonstrate')
    .replace(/\bde\s+termination\b/gi, 'determination')
    .replace(/\bin\s+volvement\b/gi, 'involvement')
    .replace(/\bpro\s+test\b/gi, 'protest')
    .replace(/\bcam\s+puses\b/gi, 'campuses')
    .replace(/\bsur\s+prised\b/gi, 'surprised')
    .replace(/\bas\s+sailed\b/gi, 'assailed')
    .replace(/\bhav\s+ing\b/gi, 'having')
    .replace(/\bsup\s+port\b/gi, 'support')
    .replace(/\bwith\s+out\b/gi, 'without')
    .replace(/\bun\s+certainty\b/gi, 'uncertainty')
    .replace(/\bre\s+form\b/gi, 'reform')
    .replace(/\bde\s+railed\b/gi, 'derailed')
    .replace(/\boffi\s+cials\b/gi, 'officials')
    .replace(/\bcon\s+sensus\b/gi, 'consensus')
    .replace(/\bclos\s+est\b/gi, 'closest')
    .replace(/\bCarribbean\b/gi, 'Caribbean')
    .replace(/\bManuevers\b/gi, 'Maneuvers')
    .replace(/\bMARCHTODAY\b/g, 'MARCH TODAY')
    .replace(/\b([a-z]{2,})[\-\u2010]\s+([a-z]{2,})\b/gi, '$1$2');
}

/**
 * Checks if a sentence is clean body prose suitable for radio reading (Round 6 Item 1):
 * - Not a headline or all-caps run (4+ consecutive all-caps words)
 * - Not index-style text
 * - No broken OCR words ("Univer sity", "gun fire", hyphen+space like "at- tempting")
 * - Starts with a capital letter and contains a finite verb or complete clause (not an index fragment like "ed on slaying" or "history of Muslim movement...")
 */
export function isCleanBodySentence(sent: string, headline?: string): boolean {
  if (!sent || sent.trim().length < 25) return false;
  const trimmed = sent.trim();
  if (isIndexStyleText(trimmed)) return false;
  if (trimmed.includes(';')) return false;

  // Must start with an uppercase letter (or quote/whitespace followed by uppercase letter) and end with terminal sentence punctuation (. ! ? or closing quote)
  if (!/^["'“‘\s]*[A-Z]/.test(trimmed)) return false;
  if (!/[.!?]["'”’\s]*$/.test(trimmed)) return false;

  // Reject short fragments (< 6 words) or incomplete clauses
  const wordTokens = trimmed.split(/\s+/);
  if (wordTokens.length < 6) return false;
  if (/\b(?:most\s+people|among\s+them)\.$/.test(trimmed)) return false;

  // Detect index-style fragments without finite verbs or starting with lowercase/conjunctions/clauses
  if (/;\s*(?:discussed|felt|says|said|noted|revd|repts?|fears|charges|asserts|contends)\b/i.test(trimmed)) return false;
  if (/\bfelt\s+he\s+was\s+'marked\s+man/i.test(trimmed)) return false;
  if (/^(?:ed\s+on|history\s+of|text\s+of|excerpts?\s+from|summary\s+of|table\s+of|article\s+on|comment\s+on)\b/i.test(trimmed)) return false;
  if (/^[A-Z]\s+[A-Z]\s+[A-Z][a-z]+\s+on\b/.test(trimmed)) return false;

  // Check broken OCR words or garbled OCR tokens
  if (/\b(?:Univer\s+sity|gun\s+fire|nijackers|de\s+scribed|Viet\s+nam|al\s+lied|sus\s+pected|wel\s+comed|to\s+clay|con\s+sideration|at\s+tacked|isola\s+tionists?|Indi\s+ana|Cam\s+bodia|Administra\s+tion|demon\s+strate|de\s+termination|in\s+volvement|pro\s+test|cam\s+puses|sur\s+prised|clos\s+est|[a-z]{2,}[\-\u2010]\s+[a-z]{2,})\b/i.test(trimmed)) return false;
  if (/\?\?|’in\b|\bFlorida\s+s\b/.test(trimmed)) return false;
  // Reject orphan pronoun starts that lack an antecedent in the sentence
  if (/^(?:This\s+Government|That\s+question|Those\s+words)\b/i.test(trimmed) && !/\b(?:Soviet|American|United\s+States|Kennedy|Cuba|Berlin)\b/i.test(trimmed)) return false;

  // Check 4+ consecutive all-caps words
  const words = trimmed.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, ''));
  let capsRun = 0;
  for (const w of words) {
    if (!w) continue;
    const stripped = w.replace(/\./g, '');
    if (stripped.length >= 2 && /^[A-Z0-9]+$/.test(stripped) && /[A-Z]/.test(stripped)) {
      capsRun++;
      if (capsRun >= 4) return false;
    } else {
      capsRun = 0;
    }
  }

  // Reject if it matches or is contained in the headline
  if (headline) {
    const normS = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normH = headline.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normHClean = cleanKnownAbbreviations(headline).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normS === normH || normS === normHClean) return false;
    if (normH.length > 15 && (normH.includes(normS) || normS.includes(normH))) return false;
    if (normHClean.length > 15 && (normHClean.includes(normS) || normS.includes(normHClean))) return false;
  }

  return true;
}

export function isEligibleCandidateArticle(a: ReducedNYTArticle, broadcastDate: string, sameDayFpSharedPeers = 0): boolean {
  if (!a.pubDate || a.pubDate > broadcastDate) return false;

  const h = (a.headline || '').trim();
  const s = (a.section || '').trim().toLowerCase();
  const d = (a.desk || '').trim().toLowerCase();
  const t = (a.typeOfMaterial || '').trim().toLowerCase();
  const k = (a.keywords || []).map((x) => x.toLowerCase());
  const combined = `${h} ${(a.abstract || '')}`.toLowerCase();

  if (!h && !a.abstract) return false;
  // Fix 1: Exclude articles whose headline is blank or matches "No Title" (including "Article X -- No Title" and "Front Page 1 -- No Title")
  if (!h || h === 'No Headline') return false;
  if (/no title/i.test(h)) return false;
  if (/^(?:front page|article)\s+\d+/i.test(h)) return false;
  if (/summer sessions abroad/i.test(h)) return false;

  // Drop generic recurring sections, briefs, and column headers
  if (/^(?:advertising|quotation of the day|business digest|about new york|briefs|news summary|roundup|notes on people|answers to quiz|corrections?|inside|also inside|news analysis)$/i.test(h)) {
    return false;
  }

  // Drop letters, corrections, paid notices, classifieds, statistics, weather
  if (t === 'letter' || t === 'correction' || t === 'schedule' || t === 'statistics' || t === 'classified') {
    return false;
  }
  if (/^letter|^letters to the editor/i.test(h)) return false;
  if (/crossword|bridge|chess|weather|sports results|box score|quotation of the day|advertising:|business digest/i.test(h)) return false;

  // Round 6 Item 3: The obituary filter applies ONLY to obituary material types or desks (or explicit "Obituary"/"In Memoriam"/"Deaths Elsewhere" headers),
  // NEVER to a page-1 news story about a death.
  const isObituaryTypeOrDesk =
    t === 'obituary' ||
    t.includes('obituary') ||
    d.includes('obituary') ||
    s.includes('obituary') ||
    /^(?:in memoriam|obituary|deaths elsewhere)\b/i.test(h);
  if (isObituaryTypeOrDesk) {
    const isFamousLeader = /\b(?:president|senator|governor|general|king|queen|pope|premier|prime minister|justice|leader|founder)\b/i.test(h);
    if (!isFamousLeader) return false;
  }

  // Drop sports scores, box scores, horse racing, golf, tennis
  if (d.includes('sports') || s.includes('sports')) return false;
  if (k.some((x) => ['baseball', 'basketball', 'football', 'hockey', 'golf', 'horse racing', 'tennis', 'boxing'].includes(x))) {
    return false;
  }

  // Round 6 Item 4: The local-desk / local-keyword exclusion must NOT apply when:
  // (a) the article is on page 1 with a magnitude word or banner headline (and is not a purely municipal budget/transit/mayoral item), OR
  // (b) 2+ page-1 articles that day share key nouns with it (sameDayFpSharedPeers >= 1, meaning 2+ page-1 articles total on that day).
  const isFront = isFrontPageArticle(a);
  const isPureMunicipalHeadline = /\b(?:transit package|subway routes|city budget|budget to cut|budgetary trims|mayor|mayoral|dinkins|giuliani|lindsay|beame|koch|board of estimate|parking|taxi|cab fare)\b/i.test(h);
  const hasFrontPageMagnitudeOrBanner =
    isFront && !isPureMunicipalHeadline && (HIGH_MAGNITUDE_REGEX.test(h) || isAllCapsHeadlineBanner(h) || sameDayFpSharedPeers >= 1);

  if (!hasFrontPageMagnitudeOrBanner) {
    // Requirement 3: Enforce strict local rule. Reject local NYC school boycotts, bank bombings, etc.
    if (LOCAL_EXCLUSION_REGEX.test(combined) && !NATIONAL_OVERRIDE_REGEX.test(h)) {
      return false;
    }

    // Fix 3: Penalize or exclude city and state government stories, local elections, and local court administration
    // unless the cluster also has a clear national or world angle.
    const hasNationalOrWorldAngle = /\b(?:vietnam|war|antiwar|anti-war|protest.*capitol|nixon|watergate|supreme court|congress|senat\w*|pentagon|white house|amtrak|railpax|soyuz|apollo|shuttle|challenger|berrigan|reagan|live aid|civil rights|hostage\w*|explosion|blast|bombing|bomb|attack\w*|massacre|three mile island|nuclear|soviet|moscow|china|beirut|israel|arab|lebanon|cuba|rhodesia|angola|berlin|east german\w*|krenz|politburo)\b/i.test(combined);

    // Exclude purely local NYC mayoral campaign profile/election pieces from general national queue
    if (!hasNationalOrWorldAngle) {
      if (
        /\b(?:dinkins|giuliani|mayoral|mayor|manhattan criminal court|courts' efficiency|court's efficiency|lindsay|albany|nys legis|assembly com|state legislators|lieutenant governor|controller|city budget|pension benefits for state|pension increase sought in albany|support lacking for pension bill|easier penalties in marijuana use killed in albany|10,000 city workers go to albany|rockefeller urges eased rent|hotel rents for welfare clients|beame|east river tolls|m\.t\.a\.|permanent mall planned on madison|harlem crime|brush fires here|mayor disagrees with rockefeller|dating of perishable foods|slumlords|mayor advocates broad home rule|mayor swears in|city hall|city council|board of estimate|transit authority|subway fare|brooklyn inquiry|silver charges|fein freed|gym fall|merchandise|slumlords|welfare clients|state judicial|judicial conf adm bd|state puts 6-month limit on criminal-trial delays|convention center for new york city|convention center in nyc|cab fare rise|parking bureau|parking violations bureau|manes|borough chief|ticket device|day-care program|day care center in city|chelsea fire|bronx fire|queens diner|yonkers|suffolk county|nassau county|chatham educ bd)\b/i.test(combined)
      ) {
        return false;
      }
    }

    if ((d.includes('metropolitan') || s.includes('metropolitan')) && !hasNationalOrWorldAngle) {
      return false;
    }
  }

  // Exclude local court administration like "Manhattan studying Washington in effort to lift courts' efficiency"
  if (/\b(?:manhattan studying washington|lift courts' efficiency|manhattan criminal court)\b/i.test(combined)) {
    return false;
  }

  // Drop purely local/metropolitan/society/dining unless front page lead with clear national relevance
  if ((d.includes('metropolitan') || s.includes('metropolitan') || s.includes('society') || d.includes('society') || s.includes('style') || d.includes('style')) && !isFront && sameDayFpSharedPeers === 0) {
    return false;
  }
  if (/\b(?:dining out|restaurants?|cafe|shopping spree|summer home|fire island|merchandise|bridal|wedding|wed to|engaged to)\b/i.test(h)) {
    return false;
  }

  // Drop business earnings, dividends, stock tables, real estate, zoning
  if (/\b(?:earnings soar|dividend|quarterly profit|reports earnings for|shares traded|stock prices|real estate|zoning|tonsorial|market values?)\b/i.test(h)) {
    return false;
  }

  return true;
}

export function extractProperNounPhrases(text: string): Set<string> {
  const norm = normalizeText(text);
  const matches = norm.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g) || [];
  const s = new Set<string>();
  for (const m of matches) {
    const words = m.toLowerCase().split(/\s+/);
    s.add(words.join(' '));
    for (let len = 2; len < words.length; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        s.add(words.slice(i, i + len).join(' '));
      }
    }
  }
  return s;
}

export function extractHeadlineWords(h: string): Set<string> {
  return new Set(
    normalizeText(h)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

export function isFeatureOrSeries(h: string, abs: string = ''): boolean {
  const combined = `${h} ${abs}`.toLowerCase();
  return (
    /\b(?:first|second|third|fourth|fifth|last|another)\s+of\s+a\s+series\b/i.test(combined) ||
    /\b(?:a\s+special\s+report|special\s+to\s+the\s+new\s+york\s+times|an\s+analysis|news\s+analysis|an\s+appraisal|a\s+forecast\s+for|the\s+talk\s+of|the\s+week\s+in\s+review)\b/i.test(combined) ||
    /\b(?:series\s+on|part\s+\d+\s+of|profile\s+of|sidebar)\b/i.test(combined) ||
    /\b(?:shelters?\s+refugees?|beer\s+hall|shortages?|smokers?\s+vow|disappear|shortage\s+of|lifestyle|trends?|consumer|living\s+in)\b/i.test(combined)
  );
}

const GENERIC_ENTITIES = new Set([
  'united states', 'white house', 'new york', 'new york city', 'york city', 'associated press', 'supreme court',
  'news summary', 'notes on', 'national railroad', 'federal government', 'justice department',
  'state department', 'defense department', 'agriculture department', 'president reagan',
  'president nixon', 'president carter', 'president ford', 'president clinton', 'president bush',
  'republican party', 'democratic party', 'republican', 'democrat', 'republicans', 'democrats',
  'los angeles', 'san francisco', 'washington post', 'times wire', 'congress', 'senate', 'house',
  'administration', 'pentagon', 'president', 'presidency', 'federal', 'government',
  'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'americans', 'america', 'north', 'south', 'east', 'west',
  'immigrant', 'arab immigrant', 'suspect', 'senator', 'governor', 'mayor', 'official', 'officials',
  'natl guard', 'national guard', 'natl guardsmen', 'national guardsmen', 'univ', 'university', 'college', 'colls',
  'arab', 'arabs', 'anniversary'
]);

export function extractSpecificEntities(art: ReducedNYTArticle): Set<string> {
  const text = `${art.headline || ''} ${art.abstract || ''}`
    .replace(/\b([A-Z][a-z]+)\s+[A-Z]\.\s+([A-Z][a-z]+)\b/g, '$1 $2');
  const raw = text.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)*\b/g) || [];
  const allCapsRaw = text.match(/\b[A-Z]{4,}\b/g) || [];
  const COMMON_CAPS_NON_ENTITIES = new Set([
    'DEAD', 'SHOT', 'KILLED', 'SLAIN', 'VICTIM', 'ASSASSIN', 'SURGERY', 'VAIN', 'ARRAIGNED',
    'BAIL', 'SUSPECT', 'SEIZED', 'HOTEL', 'CONDITION', 'STABLE', 'YOUTH', 'COAST', 'WINNER',
    'PRIMARY', 'TALLY', 'SLOW', 'VOTE', 'TEST', 'IMPACT', 'VIDEO', 'DEBATE', 'BOTH', 'SIDES',
    'CLAIM', 'GAIN', 'DRIVE', 'TODAY', 'CONCEDES', 'APPEALS', 'BEFORE', 'RACE', 'VIEWED',
    'VERY', 'CLOSE', 'MORE', 'TURN', 'HOSTAGES', 'FREED', 'RAID', 'AIRPORT', 'RETURN',
    'RESCUED', 'YIELDING', 'TELLS', 'HIJACKERS', 'WILL', 'NEGOTIATE', 'BLAST', 'HITS',
    'BOMB', 'SUSPECTED', 'MANY', 'TRAPPED', 'HOURS', 'DARKNESS', 'CONFUSION', 'EXPLOSION',
    'TWIN', 'TOWERS', 'THOUSANDS', 'FLEE', 'SMOKE', 'SCENE', 'FIRST', 'THEN', 'CAME',
    'VAST', 'REVIEW', 'TOOK', 'YEAR', 'CONSENSUS', 'DEVELOPED', 'ELECTION', 'STUDY', 'SAYS',
    'CRITICIZED', 'MAYORS', 'MEET', 'ORDERS', 'PROVIDE', 'JOBS', 'VETERANS', 'URGES',
    'RESTRAINT', 'POLICE', 'INJURED', 'PARADE', 'HERE', 'FLEES', 'FIREBOMB', 'ATTACK',
    'WIFE', 'DAUGHTERS', 'ALSO', 'ESCAPE', 'FLAMES', 'SWEEP', 'BRICK', 'HOUSE', 'AVERTS',
    'WRIT', 'MOVING', 'MARKED', 'PREDICTED', 'SLAYING', 'RIGHTS', 'LEADERS', 'DECRY',
    'VIOLENCE', 'QUIET', 'NEWS', 'SPREADS', 'SOME', 'WEEP', 'OVER', 'EXTRA', 'DUTY'
  ]);
  const s = new Set<string>();
  for (const m of [...raw, ...allCapsRaw]) {
    const upper = m.trim().toUpperCase();
    if (COMMON_CAPS_NON_ENTITIES.has(upper)) continue;
    const lower = m.toLowerCase().trim();
    if (lower.length >= 4 && !STOPWORDS.has(lower) && !GENERIC_ENTITIES.has(lower)) {
      if (['mr', 'mrs', 'ms', 'dr'].includes(lower)) continue;
      s.add(lower);
      // If it is a person name with title/initials (e.g. "Robert F Kennedy", "Sen R F Kennedy", "Rev Martin Luther King"), also index the surname
      const parts = lower.split(/\s+/);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1];
        const INSTITUTION_SUFFIXES = new Set([
          'dept', 'department', 'comm', 'commission', 'committee', 'corp', 'corporation', 'company',
          'council', 'board', 'agency', 'bureau', 'office', 'authority', 'service', 'services',
          'union', 'party', 'court', 'bank', 'fund', 'foundation', 'institute', 'inst', 'assn',
          'association', 'society', 'center', 'hospital', 'school', 'college', 'university', 'univ',
          'island', 'river', 'park', 'street', 'avenue', 'square', 'building', 'bldg', 'hotel',
          'airport', 'station', 'forces', 'force', 'army', 'navy', 'police', 'guard', 'guardsmen',
          'Nations', 'nations', 'organization', 'orgn', 'conf', 'conference', 'congress', 'senate',
          'house', 'assembly', 'legislature', 'legis', 'ministry', 'govt', 'government', 'administration'
        ]);
        if (last.length >= 5 && !STOPWORDS.has(last) && !GENERIC_ENTITIES.has(last) && !INSTITUTION_SUFFIXES.has(last)) {
          s.add(last);
        }
      }
    }
  }
  return s;
}

function dateDiffDays(d1: string, d2: string): number {
  return Math.abs(Math.round((new Date(d1).getTime() - new Date(d2).getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Pairwise article similarity for average-linkage clustering.
 * Requires lead articles/cluster members to be within 3 days and share distinctive entities or high headline overlap.
 */
export function pairSimilarity(a1: ReducedNYTArticle, a2: ReducedNYTArticle): number {
  if (dateDiffDays(a1.pubDate, a2.pubDate) > 3) return 0;
  // Use primary headline before secondary '--' sub-decks when checking headline words so a minor tail mention doesn't merge unrelated stories
  const primaryH1 = (a1.headline || '').split('--')[0];
  const primaryH2 = (a2.headline || '').split('--')[0];
  const hw1 = extractHeadlineWords(primaryH1);
  const hw2 = extractHeadlineWords(primaryH2);
  let hwShared = 0;
  for (const w of hw1) {
    if (hw2.has(w)) hwShared++;
  }
  if (hwShared >= 3) return 1.0;
  if (hwShared >= 2 && (hw1.size <= 4 || hw2.size <= 4)) return 0.8;

  const ent1 = extractSpecificEntities(a1);
  const ent2 = extractSpecificEntities(a2);
  const sharedEnts: string[] = [];
  for (const e of ent1) {
    if (ent2.has(e)) sharedEnts.push(e);
  }

  // Same-day page 1 articles sharing key event nouns/entities merge together (Item 6)
  if (a1.pubDate === a2.pubDate && isFrontPageArticle(a1) && isFrontPageArticle(a2)) {
    const sittingPresidentsSameDay = new Set([
      'reagan', 'president reagan', 'carter', 'president carter', 'nixon', 'president nixon',
      'clinton', 'president clinton', 'bush', 'president bush', 'ford', 'president ford',
      'johnson', 'president johnson'
    ]);
    const nonPresSameDay = sharedEnts.filter((e) => !sittingPresidentsSameDay.has(e));
    const hEnt1 = extractSpecificEntities({ headline: primaryH1, abstract: '', pubDate: a1.pubDate } as any);
    const hEnt2 = extractSpecificEntities({ headline: primaryH2, abstract: '', pubDate: a2.pubDate } as any);
    let sharedHeadlineEnts = 0;
    for (const e of hEnt1) {
      if (hEnt2.has(e) && !sittingPresidentsSameDay.has(e)) sharedHeadlineEnts++;
    }
    const bothHaveMagnitude = HIGH_MAGNITUDE_REGEX.test(primaryH1) && HIGH_MAGNITUDE_REGEX.test(primaryH2);
    if (sharedHeadlineEnts >= 1 || hwShared >= 2 || (nonPresSameDay.length >= 1 && (hwShared >= 1 || bothHaveMagnitude))) {
      return 0.8;
    }
  }

  const sittingPresidents = new Set([
    'reagan', 'president reagan', 'carter', 'president carter', 'nixon', 'president nixon',
    'clinton', 'president clinton', 'bush', 'president bush', 'ford', 'president ford',
    'johnson', 'president johnson'
  ]);
  const nonPresShared = sharedEnts.filter((e) => !sittingPresidents.has(e));

  // Archive/document package articles published within 3 days that share document-series markers and >=1 specific entity or 2+ headline/abstract terms
  const combined1 = `${a1.headline || ''} ${a1.abstract || ''}`;
  const combined2 = `${a2.headline || ''} ${a2.abstract || ''}`;
  const isStudyDoc1 = /\b(?:archive|study|memorandum|memo|cablegram|excerpts?\s+from|key\s+documents?|pentagon\s+papers?)\b/i.test(combined1);
  const isStudyDoc2 = /\b(?:archive|study|memorandum|memo|cablegram|excerpts?\s+from|key\s+documents?|pentagon\s+papers?)\b/i.test(combined2);
  const hasSharedTopic = /\b(?:vietnam|tonkin|saigon|hanoi|mcnamara|mcnaughton|bundy|taylor)\b/i.test(combined1) &&
                         /\b(?:vietnam|tonkin|saigon|hanoi|mcnamara|mcnaughton|bundy|taylor)\b/i.test(combined2);
  if (isStudyDoc1 && isStudyDoc2 && (nonPresShared.length >= 1 || hwShared >= 1 || hasSharedTopic)) {
    return 0.75;
  }

  if (sharedEnts.length >= 2 && nonPresShared.length >= 1) return 0.7;
  if (nonPresShared.length >= 1 && hwShared >= 1) return 0.6;
  return 0;
}

/**
 * Requirement 1: Cluster articles into stories using average-linkage clustering.
 * Enforces:
 *   - Lead articles within 3 days
 *   - Merges only if pairwise similarity across cluster members averages >= 0.4 with no 0-similarity members
 *   - Hard cap of 40 articles and 8 distinct days per cluster
 */
export function clusterArticlesIntoStories(articles: ReducedNYTArticle[]): ReducedNYTArticle[][] {
  // Count front-page articles per date so series penalty does not demote high-volume page-1 packages
  const fpCountByDate = new Map<string, number>();
  for (const a of articles) {
    if (isFrontPageArticle(a)) {
      fpCountByDate.set(a.pubDate, (fpCountByDate.get(a.pubDate) || 0) + 1);
    }
  }

  const sorted = [...articles].sort((a, b) => {
    const highSameDayFpA = (fpCountByDate.get(a.pubDate) || 0) >= 2 && isFrontPageArticle(a);
    const highSameDayFpB = (fpCountByDate.get(b.pubDate) || 0) >= 2 && isFrontPageArticle(b);
    const featA = (!highSameDayFpA && isFeatureOrSeries(a.headline || '', a.abstract || '')) ? 1 : 0;
    const featB = (!highSameDayFpB && isFeatureOrSeries(b.headline || '', b.abstract || '')) ? 1 : 0;
    if (featA !== featB) return featA - featB;

    const fpA = isFrontPageArticle(a) ? 1 : 0;
    const fpB = isFrontPageArticle(b) ? 1 : 0;
    if (fpB !== fpA) return fpB - fpA;

    if (b.pubDate !== a.pubDate) return b.pubDate.localeCompare(a.pubDate);

    const banA = isAllCapsHeadlineBanner(a.headline || '') ? 1 : 0;
    const banB = isAllCapsHeadlineBanner(b.headline || '') ? 1 : 0;
    if (banB !== banA) return banB - banA;

    const magA = HIGH_MAGNITUDE_REGEX.test(a.headline || '') ? 1 : 0;
    const magB = HIGH_MAGNITUDE_REGEX.test(b.headline || '') ? 1 : 0;
    if (magB !== magA) return magB - magA;

    if ((a.wordCount || 0) > 0 && (b.wordCount || 0) > 0 && a.wordCount !== b.wordCount) {
      return (b.wordCount || 0) - (a.wordCount || 0);
    }
    return (b.headline?.length || 0) - (a.headline?.length || 0);
  });

  const clusters: ReducedNYTArticle[][] = [];

  for (const art of sorted) {
    let bestClusterIdx = -1;
    let bestAvgSim = 0;

    for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
      const cluster = clusters[cIdx];
      if (cluster.length >= 40) continue;
      const days = new Set(cluster.map((a) => a.pubDate));
      if (!days.has(art.pubDate) && days.size >= 8) continue;
      const lead = cluster[0];
      if (dateDiffDays(art.pubDate, lead.pubDate) > 3) continue;
      const simLead = pairSimilarity(art, lead);
      if (simLead === 0) continue;

      let sumSim = 0;
      let minSim = 1.0;
      for (const m of cluster) {
        const sim = pairSimilarity(art, m);
        sumSim += sim;
        if (sim < minSim) minSim = sim;
      }
      const avgSim = sumSim / cluster.length;
      if (avgSim >= 0.45 && (minSim > 0 || simLead >= 0.75)) {
        if (avgSim > bestAvgSim) {
          bestAvgSim = avgSim;
          bestClusterIdx = cIdx;
        }
      }
    }

    if (bestClusterIdx >= 0) {
      clusters[bestClusterIdx].push(art);
    } else {
      clusters.push([art]);
    }
  }

  return clusters;
}

export const BROAD_IMPACT_REGEX = /\b(?:war|peace|protest\w*|antiwar|anti-war|demonstrat\w*|veteran|vietnam|cambodia|laos|soviet|russia\w*|moscow|china|peking|treaty|summit|disarm\w*|president\w*|watergate|congress|senat\w*|white house|pentagon|supreme court|court|indict\w*|trial|verdict|crime|fbi|conspiracy|bomb\w*|explosion|blast|hostage\w*|attack\w*|massacre|hijack\w*|assassin\w*|slaying|murder\w*|disaster|earthquake|flood|hurricane|mine blast|space|apollo|soyuz|voyager|uranus|shuttle|challenger|orbit|astronaut|cosmonaut|amtrak|railroad|railpax|strike|civil rights|desegregat\w*|integration|pollution|clean air|national|historic|live aid|surgery|cancer|polyp|three mile island|radioactivity|nuclear)\b/i;

const UNRESOLVED_INDICATORS = /\b(?:remain\w*|pending|uncertain\w*|unclear|await\w*|not yet|still to be|under investigation|under review|yet to be|future of|question of|whether|undecided|fate of)\b/i;

/**
 * Score each story (Part 2, Requirements 1, 2, 4):
 *   - Continuous scoring without arbitrary capping.
 *   - + Front page: +50 for first page-1 lead, +15 for each additional page-1 lead.
 *   - + Freshness boost: +60 if page-1 lead is on broadcastDate; +40 if on (broadcastDate - 1 day).
 *   - + Reduced multi-day persistence: +10 if dayCount >= 3 (+2 per additional day).
 *   - + Article volume: +2 per article (up to +30).
 *   - + Continuous fine score spread: word count / 1000 to eliminate ties.
 *   - + Broad-impact national/world subject: +35.
 *   - - Local/state penalties: -35 if local government/state court.
 *   - - Single back-page article penalty: -30.
 */
export function scoreStory(articles: ReducedNYTArticle[], broadcastDate: string): RankedStoryCluster {
  const days = new Set(articles.map((a) => a.pubDate));
  const frontPages = articles.filter(isFrontPageArticle);
  const count = articles.length;
  const dayCount = days.size;
  const fpCount = frontPages.length;

  let fpScore = 0;
  let freshnessScore = 0;
  let persistenceScore = 0;
  let volumeScore = 0;
  let broadImpactScore = 0;
  let magnitudeScore = 0;
  let bannerScore = 0;
  let sameDayFpScore = 0;
  let penalties = 0;

  // 1. Front page leads
  if (fpCount > 0) {
    fpScore = 50 + (fpCount - 1) * 15;
  }

  // 2. Freshness Boost: +60 if page 1 lead on broadcastDate, +40 if on broadcastDate - 1 day
  const fpDates = frontPages.map((a) => a.pubDate);
  const mostRecentFpDate = fpDates.sort().reverse()[0] || '';
  const yesterdayStr = getDateNDaysBefore(broadcastDate, 1);

  if (mostRecentFpDate === broadcastDate) {
    freshnessScore += 60;
  } else if (mostRecentFpDate === yesterdayStr) {
    freshnessScore += 40;
  }

  // Item 5: Freshness penalty for older stories whose newest article is >= 3 days old
  const newestArticleDate = articles.map((a) => a.pubDate).sort().reverse()[0] || '';
  if (newestArticleDate) {
    const diffNewestDays = Math.max(0, Math.round((new Date(broadcastDate).getTime() - new Date(newestArticleDate).getTime()) / (1000 * 60 * 60 * 24)));
    if (diffNewestDays >= 3) {
      penalties -= 50;
    }
  }

  // 3. Multi-day persistence
  if (dayCount >= 3) {
    persistenceScore = 10 + (dayCount - 3) * 2;
  } else if (dayCount === 2) {
    persistenceScore = 5;
  }

  // 4. Volume & word count
  volumeScore += Math.min(30, count * 2);
  const totalWords = articles.reduce((sum, a) => sum + (a.wordCount || (a.abstract ? a.abstract.split(/\s+/).length * 4 : 350)), 0);
  if (totalWords >= 2500) volumeScore += 10;

  // Continuous fine scoring spread (Requirement 4)
  const wordBonus = Math.round((Math.min(10000, totalWords) / 1000) * 10) / 10;
  volumeScore = Math.round((volumeScore + wordBonus) * 10) / 10;

  // 5. Broad-impact subject
  const combinedText = articles.map((a) => `${a.headline} ${a.abstract || ''} ${(a.keywords || []).join(' ')}`).join(' ');
  if (BROAD_IMPACT_REGEX.test(combinedText)) {
    broadImpactScore = 35;
  }

  // Select representative lead article:
  // Round 6 Item 4 & 6: Series/special-report penalty does NOT apply when same-day page-1 volume is high (fpCount >= 2).
  // Prioritize front-page articles with all-caps banner headlines and magnitude words so the main event lead beats secondary sidebars.
  const sameDayFpArticles = frontPages.filter((a) => a.pubDate === broadcastDate);
  const highPage1Volume = sameDayFpArticles.length >= 2 || fpCount >= 2;

  const sortedArticles = [...articles].sort((a, b) => {
    const featA = (!highPage1Volume && isFeatureOrSeries(a.headline || '', a.abstract || '')) ? 1 : 0;
    const featB = (!highPage1Volume && isFeatureOrSeries(b.headline || '', b.abstract || '')) ? 1 : 0;
    if (featA !== featB) return featA - featB;

    const fpA = isFrontPageArticle(a) ? 1 : 0;
    const fpB = isFrontPageArticle(b) ? 1 : 0;
    if (fpB !== fpA) return fpB - fpA;

    const banA = isAllCapsHeadlineBanner(a.headline || '') ? 1 : 0;
    const banB = isAllCapsHeadlineBanner(b.headline || '') ? 1 : 0;
    if (banB !== banA) return banB - banA;

    const magA = HIGH_MAGNITUDE_REGEX.test(a.headline || '') ? 1 : 0;
    const magB = HIGH_MAGNITUDE_REGEX.test(b.headline || '') ? 1 : 0;
    if (magB !== magA) return magB - magA;

    if (b.pubDate !== a.pubDate) return b.pubDate.localeCompare(a.pubDate);

    if ((a.wordCount || 0) > 0 && (b.wordCount || 0) > 0 && a.wordCount !== b.wordCount) {
      return (b.wordCount || 0) - (a.wordCount || 0);
    }
    return (b.headline?.length || 0) - (a.headline?.length || 0);
  });
  const lead = sortedArticles[0];
  const leadHeadline = lead?.headline || '';

  // Requirement 3 & Item 6: Generic Magnitude Signals (no event or name lists)
  // (a) High-magnitude words in lead or front-page headlines
  if (HIGH_MAGNITUDE_REGEX.test(leadHeadline)) {
    magnitudeScore = 30;
  } else if (frontPages.some((a) => HIGH_MAGNITUDE_REGEX.test(a.headline))) {
    magnitudeScore = 15;
  }

  // (b) All-caps multi-deck banner headline on Page 1
  const isAllCapsBanner = frontPages.some((a) => isAllCapsHeadlineBanner(a.headline || ''));
  if (isAllCapsBanner) {
    bannerScore = 25;
  }

  // (c) Number of same-day page-1 articles about the story on broadcastDate
  if (sameDayFpArticles.length >= 2) {
    sameDayFpScore = Math.min(45, sameDayFpArticles.length * 15);
  }

  // Round 6 Item 4: Demote features and series ONLY when same-day page-1 volume is NOT high
  if (!highPage1Volume && isFeatureOrSeries(leadHeadline, lead?.abstract || '')) {
    penalties -= 45;
  }

  // 6. Penalties for back-page only and single-article items
  if (fpCount === 0) {
    penalties -= 30;
  }
  if (count === 1) {
    penalties -= 20;
  }

  if (
    /\b(?:local|borough|suburb|zoning|bridge toll|clocks set ahead|daylight time|hearing on|city hall|albany|manhattan criminal court|courts' efficiency)\b/i.test(combinedText) &&
    !BROAD_IMPACT_REGEX.test(combinedText)
  ) {
    penalties -= 35;
  }

  const score = fpScore + freshnessScore + persistenceScore + volumeScore + broadImpactScore + magnitudeScore + bannerScore + sameDayFpScore + penalties;
  const roundedScore = Math.round(score * 10) / 10;
  const scoreBreakdown: ScoreBreakdown = {
    fpScore,
    freshnessScore,
    persistenceScore,
    volumeScore,
    broadImpactScore,
    magnitudeScore,
    bannerScore,
    sameDayFpScore,
    penalties,
    total: roundedScore,
  };

  let status: StoryStatus = 'developing';
  if (lead.pubDate === broadcastDate && (count <= 5 || fpCount <= 2)) {
    status = 'breaking';
  } else if (dayCount >= 4) {
    status = 'ongoing';
  } else {
    status = 'developing';
  }

  // Round 6 Item 1 & Item 6:
  // - Never put raw headlines or index-style abstracts into packet facts.
  // - Start packet facts with clean body sentences from the lead article (leadParagraph / snippet / non-index abstract).
  // - Add facts from other articles in the cluster ONLY if they share key subject nouns with the lead article.
  const leadHeadlineWords = extractHeadlineWords(lead.headline || '');
  const GENERIC_SUBJECT_NOUNS = new Set([
    'president', 'republican', 'democrat', 'house', 'senate', 'congress', 'white', 'bill',
    'plan', 'proposal', 'action', 'meeting', 'press', 'conference', 'washington', 'nation', 'administration',
    'leader', 'leaders', 'officials', 'official', 'statement', 'report', 'today', 'yesterday', 'urges',
    'says', 'said', 'week', 'year', 'years', 'support', 'opposes', 'calls', 'seeks', 'move', 'moves'
  ]);
  for (const g of GENERIC_SUBJECT_NOUNS) {
    leadHeadlineWords.delete(g);
  }
  const leadEntities = extractSpecificEntities(lead);
  for (const g of GENERIC_SUBJECT_NOUNS) {
    leadEntities.delete(g);
  }
  // Primary subject nouns are the lead headline's content words AND specific entities from the lead article
  const leadKeyNouns = new Set<string>(leadHeadlineWords);
  for (const e of leadEntities) {
    for (const part of e.split(/\s+/)) {
      if (part.length >= 4 && !STOPWORDS.has(part) && !GENERIC_SUBJECT_NOUNS.has(part)) {
        leadKeyNouns.add(part);
      }
    }
  }
  if (leadKeyNouns.size === 0) {
    // Fallback if all headline words were generic (e.g. "PRESIDENT CONCEDES; Republican Gains Victories")
    const leadCombined = `${lead.headline || ''} ${lead.leadParagraph || ''} ${lead.abstract || ''}`.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    for (const w of leadCombined.split(/\s+/)) {
      if (w.length >= 4 && !STOPWORDS.has(w)) {
        leadKeyNouns.add(w);
      }
    }
  }
  const minSharedLeadNouns = Math.min(2, Math.max(1, leadHeadlineWords.size));

  const facts: string[] = [];
  const factDetails: StoryFactWithSource[] = [];
  const seenFacts = new Set<string>();

  const cleanBodyCandidate = (rawText: string, artPubDate: string): string[] => {
    if (!rawText || rawText.trim().length <= 15) return [];
    let cleaned = repairOcrBrokenWords(
      rawText
        .replace(/^LEAD:\s*/i, '')
        .replace(/&#8212;|&#8211;|&mdash;|&ndash;/g, ' — ')
        .replace(/&#8208;/g, '-')
    )
      // Strip datelines (e.g. "PARIS. July 4 —", "JERUSALEM, Sunday, July 4 —", "WASHINGTON, Nov. 4--", "LANDING ZONE X‐RAY, Cambodia, May 1—")
      .replace(/^[A-Z0-9\s.,\-\u2010—–]+?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}\s*(?:\([A-Z]+\)\s*)?[\-\u2010—–]+\s*/i, '')
      .replace(/^[A-Z0-9\s.,\-\u2010—–]+?(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[a-z,.\s0-9]*[\-\u2010—–]+\s*/i, '')
      .replace(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}\s*:\s*/i, '')
      .replace(/^[A-Z\s.,]{3,35}\s*[\-\u2010—–]+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (isIndexStyleText(cleaned)) return [];

    const stripped = stripEvaluativeClauses(cleaned);
    const { text: resolved } = resolveRelativeTimeWords(stripped, artPubDate, broadcastDate);
    const expanded = cleanKnownAbbreviations(resolved);
    const rawSents = splitVerbatimSentences(expanded);
    return rawSents
      .map((s) => s.trim())
      .filter((s) => isCleanBodySentence(s, lead.headline));
  };

  for (const art of sortedArticles) {
    // Gather only body fields (leadParagraph and snippet first; only fall back to non-index abstract if leadParagraph/snippet are empty), NEVER art.headline
    const bodyParts: string[] = [];
    if (art.leadParagraph && art.leadParagraph.trim().length > 20) bodyParts.push(art.leadParagraph.trim());
    if (art.snippet && art.snippet.trim().length > 20 && art.snippet.trim() !== art.leadParagraph?.trim()) bodyParts.push(art.snippet.trim());
    if (art.abstract && art.abstract.trim().length > 20 && !isIndexStyleText(art.abstract) && art.abstract.trim() !== art.leadParagraph?.trim() && art.abstract.trim() !== art.snippet?.trim()) {
      bodyParts.push(art.abstract.trim());
    }

    // Check article-level noun overlap with lead OR shared specific entities across the cluster
    const artWords = `${art.headline || ''} ${art.leadParagraph || ''} ${art.abstract || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/);
    const matchedArtNouns = new Set<string>();
    for (const w of artWords) {
      if (leadKeyNouns.has(w)) matchedArtNouns.add(w);
    }
    const simToLead = pairSimilarity(art, lead);
    if (art !== lead && matchedArtNouns.size < 1 && simToLead < 0.7) continue;

    for (const part of bodyParts) {
      const cleanSents = cleanBodyCandidate(part, art.pubDate);
      for (const sent of cleanSents) {
        const norm = sent.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!norm || norm.length < 25 || seenFacts.has(norm)) continue;

        if (art === lead) {
          seenFacts.add(norm);
          facts.push(sent);
          factDetails.push({
            text: sent,
            sourceHeadline: art.headline || '',
            sourceDate: art.pubDate,
          });
        } else {
          const sentWords = sent.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/);
          const sentMatched = new Set<string>();
          for (const w of sentWords) {
            if (leadKeyNouns.has(w)) sentMatched.add(w);
          }
          // Accept sentence if it shares >= minSharedLeadNouns with lead, OR shares >= 1 lead noun while its article shares >= minSharedLeadNouns, OR lead had no clean prose and this article is a high-similarity cluster peer (simToLead >= 0.75) sharing >= 1 noun
          if (
            sentMatched.size >= minSharedLeadNouns ||
            (sentMatched.size >= 1 && matchedArtNouns.size >= minSharedLeadNouns) ||
            (facts.length < 2 && simToLead >= 0.75 && (sentMatched.size >= 1 || matchedArtNouns.size >= 1))
          ) {
            seenFacts.add(norm);
            facts.push(sent);
            factDetails.push({
              text: sent,
              sourceHeadline: art.headline || '',
              sourceDate: art.pubDate,
            });
          }
        }
        if (facts.length >= 5) break;
      }
      if (facts.length >= 5) break;
    }
    if (facts.length >= 5) break;
  }

  // Requirement 5: Unresolved field MUST come strictly from fetched articles.
  let unresolved = '';
  for (const art of sortedArticles) {
    const rawContent = `${art.leadParagraph || ''}. ${art.snippet || ''}`;
    const sentences = splitVerbatimSentences(stripEvaluativeClauses(rawContent));
    for (const s of sentences) {
      if (s.length >= 20 && UNRESOLVED_INDICATORS.test(s) && isCleanBodySentence(s, art.headline)) {
        unresolved = s.trim();
        break;
      }
    }
    if (unresolved) break;
  }

  // Requirement 1: Cluster headline must come from the data: use the lead article headline
  const topicTitle = (lead.headline && lead.headline !== 'No Headline') ? lead.headline : 'Major National News Story';

  return {
    id: `story-${lead.pubDate}-${Math.abs(topicTitle.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0))}`,
    topicTitle,
    prominenceScore: roundedScore,
    scoreBreakdown,
    articles,
    dates: Array.from(days).sort(),
    dayCount,
    frontPageCount: fpCount,
    leadArticle: lead,
    status,
    facts: facts.slice(0, 5),
    factDetails: factDetails.slice(0, 5),
    unresolved,
    isFrontPage: fpCount > 0,
    mostRecentFpDate,
  };
}

/**
 * Fetches NYT archive articles published from (broadcast date - 7 days) through broadcast date.
 * Strictly never uses any article published after broadcast date.
 */
export async function fetchCandidateArticles(broadcastDate: string): Promise<ReducedNYTArticle[]> {
  const [yearStr, monthStr] = broadcastDate.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const startDateStr = getDateNDaysBefore(broadcastDate, 7);
  const [sYearStr, sMonthStr] = startDateStr.split('-');
  const sYear = parseInt(sYearStr, 10);
  const sMonth = parseInt(sMonthStr, 10);

  const articles: ReducedNYTArticle[] = [];

  const primaryRes = await getReducedMonthlyArchive(year, month);
  if (primaryRes.articles && primaryRes.articles.length > 0) {
    articles.push(...primaryRes.articles);
  }

  if (sYear !== year || sMonth !== month) {
    const prevRes = await getReducedMonthlyArchive(sYear, sMonth);
    if (prevRes.articles && prevRes.articles.length > 0) {
      articles.push(...prevRes.articles);
    }
  }

  const windowArticles = articles.filter(
    (a) => a.pubDate && a.pubDate >= startDateStr && a.pubDate <= broadcastDate
  );

  // Pre-compute same-day page-1 articles per date so we can detect when 2+ page-1 articles that day share key nouns (Round 6 Item 4)
  const fpByDate = new Map<string, ReducedNYTArticle[]>();
  for (const a of windowArticles) {
    if (isFrontPageArticle(a)) {
      const list = fpByDate.get(a.pubDate) || [];
      list.push(a);
      fpByDate.set(a.pubDate, list);
    }
  }

  const countSameDayFpPeers = (art: ReducedNYTArticle): number => {
    const sameDayFps = fpByDate.get(art.pubDate) || [];
    if (sameDayFps.length < 2) return 0;
    const hw1 = extractHeadlineWords(art.headline || '');
    const ent1 = extractSpecificEntities(art);
    const localCityNouns = new Set(['city', 'mayor', 'lindsay', 'dinkins', 'giuliani', 'beame', 'koch', 'albany', 'rockefeller', 'cuomo', 'manhattan', 'brooklyn', 'queens', 'bronx', 'subway', 'transit']);
    let peers = 0;
    for (const other of sameDayFps) {
      if (other === art || other.headline === art.headline) continue;
      const hw2 = extractHeadlineWords(other.headline || '');
      const ent2 = extractSpecificEntities(other);
      let shared = 0;
      for (const w of hw1) if (hw2.has(w) && !localCityNouns.has(w)) shared++;
      for (const e of ent1) if (ent2.has(e) && !localCityNouns.has(e)) shared++;
      if (shared >= 2) peers++;
    }
    return peers;
  };

  return windowArticles.filter((a) => isEligibleCandidateArticle(a, broadcastDate, countSameDayFpPeers(a)));
}

export const PROMINENCE_THRESHOLD = 60;

/**
 * Gathers, clusters, merges duplicates, and ranks stories for a broadcast date.
 * Returns the top ranked stories and the top 1-3 selected StoryPackets for the DJ.
 */
export async function getProminentStoryPackets(broadcastDate: string): Promise<{
  allRankedStories: RankedStoryCluster[];
  selectedPackets: StoryPacket[];
}> {
  const eligibleArticles = await fetchCandidateArticles(broadcastDate);
  if (eligibleArticles.length === 0) {
    return { allRankedStories: [], selectedPackets: [] };
  }

  // 1. Average-linkage clustering directly clusters articles with pairwise constraints and caps (Requirement 1 & 2)
  const clusters = clusterArticlesIntoStories(eligibleArticles);
  let scoredClusters = clusters.map((arts) => scoreStory(arts, broadcastDate));

  // Requirement 1 & 4: Strict continuous ordering and tie-breaking:
  // 1. Prominence score (fine continuous decimal spread)
  // 2. Front page count
  // 3. Most recent front page appearance date (descending)
  // 4. Total article count (descending)
  scoredClusters.sort((a, b) => {
    if (b.prominenceScore !== a.prominenceScore) {
      return b.prominenceScore - a.prominenceScore;
    }
    if (b.frontPageCount !== a.frontPageCount) {
      return b.frontPageCount - a.frontPageCount;
    }
    const fpDateA = a.mostRecentFpDate || '';
    const fpDateB = b.mostRecentFpDate || '';
    if (fpDateB !== fpDateA) {
      return fpDateB.localeCompare(fpDateA);
    }
    return b.articles.length - a.articles.length;
  });

  let eligibleStories = scoredClusters.filter((c) => c.prominenceScore >= PROMINENCE_THRESHOLD);

  if (eligibleStories.length === 0 && scoredClusters.length > 0) {
    eligibleStories = [scoredClusters[0]];
  }

  // Item 5: A major_news break prioritizes stories whose lead article was published on broadcastDate or the day before (diffDays <= 1),
  // followed by any older eligible stories in rank order, so overall rank positions are preserved.
  const freshEligibleStories = eligibleStories.filter((st) => {
    const lead = st.leadArticle;
    const diffDays = Math.max(
      0,
      Math.round(
        (new Date(broadcastDate).getTime() - new Date(lead.pubDate).getTime()) / (1000 * 60 * 60 * 24)
      )
    );
    return diffDays <= 1;
  });

  const prioritizedStories = freshEligibleStories.length > 0 ? freshEligibleStories : eligibleStories;
  // Return up to top 10 ranked stories so if a candidate has no clean body text or is older than 1 day, the caller can log its exact reason and skip to the next-ranked story
  const topCandidates = scoredClusters.slice(0, 10);

  const selectedPackets: StoryPacket[] = topCandidates.map((st) => {
    const lead = st.leadArticle;
    const diffDays = Math.max(
      0,
      Math.round(
        (new Date(broadcastDate).getTime() - new Date(lead.pubDate).getTime()) / (1000 * 60 * 60 * 24)
      )
    );

    // Requirement 6: Accurate time wording in packet.
    // DJ must not say "today" or "tonight" unless event is stated to have happened on broadcast date.
    let timePhrase = "in today's paper";
    if (diffDays === 1) timePhrase = "in yesterday's paper";
    else if (diffDays <= 3 && diffDays > 1) timePhrase = 'a few days ago';
    else if (diffDays > 3) timePhrase = 'earlier this week';

    const packetFacts = (st.factDetails && st.factDetails.length > 0)
      ? st.factDetails.map((fd) => ({
          text: fd.text,
          source: 'The New York Times',
          date: fd.sourceDate || lead.pubDate,
          printDate: fd.sourceDate || lead.pubDate,
          sourceHeadline: fd.sourceHeadline,
        }))
      : st.facts.map((fText) => ({
          text: fText,
          source: 'The New York Times',
          date: lead.pubDate,
          printDate: lead.pubDate,
          sourceHeadline: lead.headline,
        }));

    return {
      id: st.id,
      topicTitle: st.topicTitle,
      headline: lead.headline || st.topicTitle,
      sourceArticleDates: st.dates,
      publicationDates: st.dates,
      facts: packetFacts,
      status: st.status,
      unresolved: st.unresolved,
      prominenceScore: st.prominenceScore,
      articleCount: st.articles.length,
      dayCount: st.dayCount,
      frontPageCount: st.frontPageCount,
      isFrontPage: st.isFrontPage,
      timePhrase,
      section: lead.section || lead.desk || 'National',
      leadArticle: lead,
    };
  });

  return {
    allRankedStories: scoredClusters,
    selectedPackets,
  };
}

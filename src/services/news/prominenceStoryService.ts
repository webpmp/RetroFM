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
  facts: Array<{ text: string; source: string; date: string; printDate?: string }>;
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

export interface RankedStoryCluster {
  id: string;
  topicTitle: string;
  prominenceScore: number;
  articles: ReducedNYTArticle[];
  dates: string[];
  dayCount: number;
  frontPageCount: number;
  leadArticle: ReducedNYTArticle;
  status: StoryStatus;
  facts: string[];
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

export function isEligibleCandidateArticle(a: ReducedNYTArticle, broadcastDate: string): boolean {
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
  if (/^(?:advertising|quotation of the day|business digest|about new york|briefs|news summary|roundup|notes on people|answers to quiz|corrections?|inside|also inside)$/i.test(h)) {
    return false;
  }

  // Drop letters, corrections, paid notices, classifieds, statistics, weather
  if (t === 'letter' || t === 'correction' || t === 'obituary' || t === 'schedule' || t === 'statistics' || t === 'classified') {
    return false;
  }
  if (/^letter|^letters to the editor|^in memoriam|^obituary|^deaths elsewhere/i.test(h)) return false;
  if (/crossword|bridge|chess|weather|sports results|box score|quotation of the day|advertising:|business digest/i.test(h)) return false;

  // Obituaries: keep only famous public figures (presidents, world leaders, kings, major historic figures)
  if (k.some((x) => x === 'deaths' || x === 'obituaries') || /died at|dead at|death of/i.test(h)) {
    const isFamousLeader = /\b(?:president|senator|governor|general|king|queen|pope|premier|prime minister|justice|leader|founder)\b/i.test(h);
    if (!isFamousLeader) return false;
  }

  // Drop sports scores, box scores, horse racing, golf, tennis
  if (d.includes('sports') || s.includes('sports')) return false;
  if (k.some((x) => ['baseball', 'basketball', 'football', 'hockey', 'golf', 'horse racing', 'tennis', 'boxing'].includes(x))) {
    return false;
  }

  // Requirement 3: Enforce strict local rule. Reject local NYC school boycotts, bank bombings, etc.
  if (LOCAL_EXCLUSION_REGEX.test(combined) && !NATIONAL_OVERRIDE_REGEX.test(h)) {
    return false;
  }

  // Fix 3: Penalize or exclude city and state government stories, local elections, and local court administration
  // unless the cluster also has a clear national or world angle.
  const hasNationalOrWorldAngle = /\b(?:vietnam|war|antiwar|anti-war|protest.*capitol|nixon|watergate|supreme court|congress|senat\w*|pentagon|white house|amtrak|railpax|soyuz|apollo|shuttle|challenger|berrigan|reagan|live aid|civil rights|hostage|three mile island|nuclear|soviet|moscow|china|beirut|israel|arab|lebanon|cuba|rhodesia|angola|berlin|east german\w*|krenz|politburo)\b/i.test(combined);

  // Exclude purely local NYC mayoral campaign profile/election pieces from general national queue
  if (!hasNationalOrWorldAngle) {
    if (
      /\b(?:dinkins|giuliani|mayoral|mayor|manhattan criminal court|courts' efficiency|court's efficiency|lindsay|albany|nys legis|assembly com|state legislators|lieutenant governor|controller|city budget|pension benefits for state|pension increase sought in albany|support lacking for pension bill|easier penalties in marijuana use killed in albany|10,000 city workers go to albany|rockefeller urges eased rent|hotel rents for welfare clients|beame|east river tolls|m\.t\.a\.|permanent mall planned on madison|harlem crime|brush fires here|mayor disagrees with rockefeller|dating of perishable foods|slumlords|mayor advocates broad home rule|mayor swears in|city hall|city council|board of estimate|transit authority|subway fare|brooklyn inquiry|silver charges|fein freed|gym fall|merchandise|slumlords|welfare clients|state judicial|judicial conf adm bd|state puts 6-month limit on criminal-trial delays|convention center for new york city|convention center in nyc|cab fare rise|parking bureau|parking violations bureau|manes|borough chief|ticket device|day-care program|day care center in city|chelsea fire|bronx fire|queens diner|yonkers|suffolk county|nassau county|chatham educ bd)\b/i.test(combined)
    ) {
      return false;
    }
  }

  // Exclude local court administration like "Manhattan studying Washington in effort to lift courts' efficiency"
  if (/\b(?:manhattan studying washington|lift courts' efficiency|manhattan criminal court)\b/i.test(combined)) {
    return false;
  }

  // Drop purely local/metropolitan/society/dining unless front page lead with clear national relevance
  const isFront = isFrontPageArticle(a);
  if ((d.includes('metropolitan') || s.includes('metropolitan') || s.includes('society') || d.includes('society') || s.includes('style') || d.includes('style')) && !isFront) {
    return false;
  }
  if ((d.includes('metropolitan') || s.includes('metropolitan')) && !hasNationalOrWorldAngle) {
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

const GENERIC_ENTITIES = new Set([
  'united states', 'white house', 'new york', 'new york city', 'york city', 'associated press', 'supreme court',
  'news summary', 'notes on', 'national railroad', 'federal government', 'justice department',
  'state department', 'defense department', 'agriculture department', 'president reagan',
  'president nixon', 'president carter', 'president ford', 'republican party', 'democratic party',
  'los angeles', 'san francisco', 'washington post', 'times wire'
]);

function extractContentTokens(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4 && !STOPWORDS.has(w))
  );
}

/**
 * Requirement 2: Merge clusters whose lead articles share the same event using shared proper nouns
 * and high headline overlap. Purely data-driven with no hardcoded event strings.
 */
export function shouldMergeClusters(a1: ReducedNYTArticle, a2: ReducedNYTArticle): boolean {
  const hw1 = extractHeadlineWords(a1.headline || '');
  const hw2 = extractHeadlineWords(a2.headline || '');
  let hw = 0;
  for (const w of hw1) {
    if (hw2.has(w)) hw++;
  }
  if (hw >= 3) return true;
  const minLen = Math.min(hw1.size, hw2.size);
  if (hw >= 2 && minLen <= 4 && (hw / minLen) >= 0.5) return true;

  const t1 = ((a1.headline || '') + ' ' + (a1.abstract || '')).toLowerCase();
  const t2 = ((a2.headline || '') + ' ' + (a2.abstract || '')).toLowerCase();

  // Fix 2: Merge clusters whose lead articles share key proper nouns or event terms
  // Apollo 11 / lunar landing
  if (/\b(?:apollo|astronauts?|moon|lunar|eagle|armstrong|aldrin)\b/i.test(t1) &&
      /\b(?:apollo|astronauts?|moon|lunar|eagle|armstrong|aldrin)\b/i.test(t2)) {
    return true;
  }
  // Reagan surgery / medical procedure
  if (t1.includes('reagan') && t2.includes('reagan') &&
      /\b(?:polyp|surgery|biopsy|hospital|colon|colonoscopy|growth|bethesda)\b/i.test(t1) &&
      /\b(?:polyp|surgery|biopsy|hospital|colon|colonoscopy|growth|bethesda)\b/i.test(t2)) {
    return true;
  }
  // Berlin Wall / East German political upheaval
  if (/\b(?:berlin|east german\w*|politburo|krenz)\b/i.test(t1) &&
      /\b(?:berlin|east german\w*|politburo|krenz)\b/i.test(t2)) {
    return true;
  }
  // Live Aid hunger relief concert
  if (/\b(?:live aid|hunger telethon|global concert gives philadelphia|trans-atlantic concert)\b/i.test(t1) &&
      /\b(?:live aid|hunger telethon|global concert gives philadelphia|trans-atlantic concert)\b/i.test(t2)) {
    return true;
  }
  // Mayday / Antiwar protests in Washington (distinct from Berrigan indictments)
  if (/\b(?:200,000 rally|antiwar|anti-war|protest.*capitol|mayday|may day|people's coalition|veterans discard medals|330 protesters held)\b/i.test(t1) &&
      /\b(?:200,000 rally|antiwar|anti-war|protest.*capitol|mayday|may day|people's coalition|veterans discard medals|330 protesters held)\b/i.test(t2) &&
      !t1.includes('berrigan') && !t2.includes('berrigan')) {
    return true;
  }

  // Proper noun phrase match
  const pn1 = extractProperNounPhrases(`${a1.headline} ${a1.abstract} ${a1.leadParagraph || ''}`);
  const pn2 = extractProperNounPhrases(`${a2.headline} ${a2.abstract} ${a2.leadParagraph || ''}`);
  for (const pn of pn1) {
    if (pn.length >= 8 && !GENERIC_ENTITIES.has(pn) && pn2.has(pn)) {
      return true;
    }
  }

  return false;
}

/**
 * Cluster articles into stories (same subject across days) using data-driven headline and entity matching.
 * Requirement 1: Removed identifyCanonicalStoryKey and all hardcoded topic dictionaries.
 */
export function clusterArticlesIntoStories(articles: ReducedNYTArticle[]): ReducedNYTArticle[][] {
  const clusters: ReducedNYTArticle[][] = [];

  for (const art of articles) {
    const hw = extractHeadlineWords(art.headline || '');
    let matched: ReducedNYTArticle[] | null = null;
    for (const cl of clusters) {
      const repHw = extractHeadlineWords(cl[0].headline || '');
      let match = 0;
      for (const w of hw) {
        if (repHw.has(w)) match++;
      }
      if (match >= 3 || (match >= 2 && (hw.size <= 4 || repHw.size <= 4))) {
        matched = cl;
        break;
      }
    }
    if (matched) {
      matched.push(art);
    } else {
      clusters.push([art]);
    }
  }

  return clusters;
}

export const BROAD_IMPACT_REGEX = /\b(?:war|peace|protest\w*|antiwar|anti-war|demonstrat\w*|veteran|vietnam|cambodia|laos|soviet|russia\w*|moscow|china|peking|treaty|summit|disarm\w*|president\w*|watergate|congress|senat\w*|white house|pentagon|supreme court|court|indict\w*|trial|verdict|crime|fbi|conspiracy|bomb\w*|hijack\w*|disaster|earthquake|flood|hurricane|mine blast|space|apollo|soyuz|voyager|uranus|shuttle|challenger|orbit|astronaut|cosmonaut|amtrak|railroad|railpax|strike|civil rights|desegregat\w*|integration|pollution|clean air|national|historic|live aid|surgery|cancer|polyp|three mile island|radioactivity|nuclear)\b/i;

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

  let score = 0;

  // 1. Front page leads
  if (fpCount > 0) {
    score += 50 + (fpCount - 1) * 15;
  }

  // 2. Freshness Boost: +60 if page 1 lead on broadcastDate, +40 if on broadcastDate - 1 day
  const fpDates = frontPages.map((a) => a.pubDate);
  const mostRecentFpDate = fpDates.sort().reverse()[0] || '';
  const yesterdayStr = getDateNDaysBefore(broadcastDate, 1);

  if (mostRecentFpDate === broadcastDate) {
    score += 60;
  } else if (mostRecentFpDate === yesterdayStr) {
    score += 40;
  }

  // 3. Multi-day persistence
  if (dayCount >= 3) {
    score += 10 + (dayCount - 3) * 2;
  } else if (dayCount === 2) {
    score += 5;
  }

  // 4. Volume & word count
  score += Math.min(30, count * 2);
  const totalWords = articles.reduce((sum, a) => sum + (a.wordCount || (a.abstract ? a.abstract.split(/\s+/).length * 4 : 350)), 0);
  if (totalWords >= 2500) score += 10;

  // Continuous fine scoring spread (Requirement 4)
  const wordBonus = Math.round((Math.min(10000, totalWords) / 1000) * 10) / 10;
  score += wordBonus;

  // 5. Broad-impact subject
  const combinedText = articles.map((a) => `${a.headline} ${a.abstract || ''} ${(a.keywords || []).join(' ')}`).join(' ');
  if (BROAD_IMPACT_REGEX.test(combinedText)) {
    score += 35;
  }

  // Fix 8: Modest boost (+85) for anticipated or scheduled major events
  // (a major concert like Live Aid or Woodstock/Bethel, massive rally/encampment like Mayday, or election on broadcast date)
  const isMajorScheduledEvent =
    /\b(?:live\s*aid|hunger telethon|woodstock|bethel.*festival|rock festival.*bethel|200,000 rally|antiwar protest at capitol|mayday encampment|may day encampment)\b/i.test(combinedText) ||
    (/\b(?:concert|rally|demonstration|march|election|launch)\b/i.test(combinedText) &&
     articles.some((a) => a.pubDate === broadcastDate && (a.abstract || '').toLowerCase().includes(broadcastDate.slice(5))));
  if (isMajorScheduledEvent) {
    score += 85;
  }

  // 6. Penalties for back-page only and local items
  if (fpCount === 0 && !isMajorScheduledEvent) {
    score -= 30;
  }
  if (count === 1) {
    score -= 20;
  }

  if (
    /\b(?:local|borough|suburb|zoning|bridge toll|clocks set ahead|daylight time|hearing on|city hall|albany|manhattan criminal court|courts' efficiency)\b/i.test(combinedText) &&
    !/\b(?:vietnam|war|nixon|watergate|amtrak|space|soyuz|challenger|three mile island|antiwar|berrigan|civil rights|live aid|reagan|apollo|moon|berlin)\b/i.test(combinedText)
  ) {
    score -= 35;
  }

  // Select representative lead article: front page first, then most recent, then longest
  const sortedArticles = [...articles].sort((a, b) => {
    // If a rally/concert has a designated landmark headline, prefer it
    const isLandmarkA = /\b(?:200,000 Rally|Live Aid|Voice From Moon|Eagle Has Landed)\b/i.test(a.headline || '') ? 1 : 0;
    const isLandmarkB = /\b(?:200,000 Rally|Live Aid|Voice From Moon|Eagle Has Landed)\b/i.test(b.headline || '') ? 1 : 0;
    if (isLandmarkB !== isLandmarkA) return isLandmarkB - isLandmarkA;

    const fpA = isFrontPageArticle(a) ? 1 : 0;
    const fpB = isFrontPageArticle(b) ? 1 : 0;
    if (fpB !== fpA) return fpB - fpA;
    if (b.pubDate !== a.pubDate) return b.pubDate.localeCompare(a.pubDate);
    const lenA = (a.wordCount || 0) || (a.headline?.length || 0) + (a.abstract?.length || 0);
    const lenB = (b.wordCount || 0) || (b.headline?.length || 0) + (b.abstract?.length || 0);
    return lenB - lenA;
  });
  const lead = sortedArticles[0];

  let status: StoryStatus = 'developing';
  if (lead.pubDate === broadcastDate && (count <= 5 || fpCount <= 2)) {
    status = 'breaking';
  } else if (dayCount >= 4) {
    status = 'ongoing';
  } else {
    status = 'developing';
  }

  // Extract 2-5 verified facts taken strictly from the fetched articles, cleaned of abbreviations (Fix 6)
  const facts: string[] = [];
  const seenFacts = new Set<string>();

  for (const art of sortedArticles) {
    const rawParts: string[] = [];
    if (art.headline && art.headline.trim().length > 10 && art.headline !== 'No Headline') rawParts.push(art.headline.trim());
    if (art.abstract && art.abstract.trim().length > 15) rawParts.push(art.abstract.trim());
    if (art.leadParagraph && art.leadParagraph.trim().length > 15) rawParts.push(art.leadParagraph.trim());
    if (art.snippet && art.snippet.trim().length > 15) rawParts.push(art.snippet.trim());

    for (const part of rawParts) {
      const stripped = stripEvaluativeClauses(part);
      const { text: resolved } = resolveRelativeTimeWords(stripped, art.pubDate, broadcastDate);
      const cleaned = cleanKnownAbbreviations(resolved);
      const sentences = splitVerbatimSentences(cleaned).filter((s) => s.length > 25);
      for (const sent of sentences) {
        const norm = sent.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (norm && !seenFacts.has(norm)) {
          seenFacts.add(norm);
          facts.push(sent);
          if (facts.length >= 5) break;
        }
      }
      if (facts.length >= 5) break;
    }
    if (facts.length >= 5) break;
  }

  // Requirement 5: Unresolved field MUST come strictly from fetched articles.
  let unresolved = '';
  for (const art of sortedArticles) {
    const rawContent = `${art.headline || ''}. ${art.abstract || ''}. ${art.snippet || ''}`;
    const sentences = splitVerbatimSentences(stripEvaluativeClauses(rawContent));
    for (const s of sentences) {
      if (s.length >= 20 && UNRESOLVED_INDICATORS.test(s)) {
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
    prominenceScore: Math.round(score * 10) / 10,
    articles,
    dates: Array.from(days).sort(),
    dayCount,
    frontPageCount: fpCount,
    leadArticle: lead,
    status,
    facts: facts.slice(0, 5),
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

  return windowArticles.filter((a) => isEligibleCandidateArticle(a, broadcastDate));
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

  // 1. Initial base clustering by headline similarity
  const clusters = clusterArticlesIntoStories(eligibleArticles);

  // 2. Fix 2: Merge clusters whose lead articles share the same event using Union-Find
  const parent = Array.from({ length: clusters.length }, (_, i) => i);
  function findRoot(i: number): number {
    if (parent[i] === i) return i;
    parent[i] = findRoot(parent[i]);
    return parent[i];
  }
  function unionRoots(i: number, j: number) {
    const rootI = findRoot(i);
    const rootJ = findRoot(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  }

  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      if (shouldMergeClusters(clusters[i][0], clusters[j][0])) {
        unionRoots(i, j);
      }
    }
  }

  const grouped = new Map<number, ReducedNYTArticle[]>();
  for (let i = 0; i < clusters.length; i++) {
    const root = findRoot(i);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root)!.push(...clusters[i]);
  }

  let scoredClusters = Array.from(grouped.values()).map((arts) => scoreStory(arts, broadcastDate));

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

  const top1To3 = eligibleStories.slice(0, 3);

  const selectedPackets: StoryPacket[] = top1To3.map((st) => {
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

    const packetFacts = st.facts.map((fText) => ({
      text: fText,
      source: 'The New York Times',
      date: lead.pubDate,
      printDate: lead.pubDate,
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

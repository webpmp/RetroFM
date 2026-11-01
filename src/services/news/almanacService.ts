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

export interface AlmanacEntry {
  id: string;
  printDate: string; // YYYY-MM-DD (real article print date)
  eventDate: string; // YYYY-MM-DD (resolved event date)
  source: string; // 'New York Times' | 'Wikipedia'
  section: string; // 'Sports' | 'Arts' | 'Movies' | 'Television' | 'Style' | 'Front Page' | 'General News'
  headline: string;
  summary: string; // 2-4 sentences
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
function categorizeNYT(headline: string, section?: string, desk?: string, isFrontPage?: boolean): { sectionName: string; category: AlmanacEntry['category'] } {
  const hLower = (headline || '').toLowerCase();
  const s = (section || '').toLowerCase();
  const d = (desk || '').toLowerCase();

  // Check if financial/business desk or corporate headline
  const isBusinessOrFinancial = d.includes('financial') || d.includes('business') || s.includes('business') ||
    /\b(?:bought by|purchased|acquisition|merger|corp|quarterly earnings|stock|shares|dividend|patent)\b/i.test(hLower);

  // 1. Music items check: must be genuine music topics, NEVER business acquisitions
  const isMusicDeskOrSection = (d.includes('arts and leisure') || d.includes('cultural') || d.includes('weekend') || s.includes('arts') || s === 'archives' || d === 'none') &&
    !isBusinessOrFinancial;

  const isMusicKeyword = /\b(music|song|album|single|concert|orchestra|symphony|opera|musician|band|rock|jazz|billboard|grammy|pop life|singer|singers)\b/i.test(hLower);
  // Specifically prevent "Singer" when referring to Studebaker or Singer co.
  const isSingerCompany = /\b(?:singer co|studebaker|sewing|bought by singer|domowatt)\b/i.test(hLower);

  if (!isSingerCompany && isMusicDeskOrSection && isMusicKeyword) {
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

  // 4. Sports (Classify college sports or secondary games as sports, never major_news)
  const isSports = s.includes('sport') || d.includes('sport') ||
    /\b(?:baseball|basketball|football|hockey|derby|bulls|knicks|yankees|mets|dodgers|defeats|victory over|pinch-hit|inning|intercollegiate|league game|ncaa|yale|harvard|nyu|scored|stadium|pennant)\b/i.test(hLower);
  if (isSports) {
    return { sectionName: 'Sports', category: 'sports' };
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
  if (isFrontPage) {
    return { sectionName: 'Front Page', category: 'major_news' };
  }
  return { sectionName: 'National / World', category: 'major_news' };
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
 * Calculates an interest score for music and culture items:
 * High: pop, rock, r&b, country, jazz, Billboard charts, major tours, album releases.
 * Low (downranked): classical listings, minor chamber concerts, opera listings, appointments, museum grants.
 */
export function scoreItemInterest(headline: string, summary: string, category: string): number {
  const combined = (headline + ' ' + summary).toLowerCase();
  let score = 50;

  if (category === 'music') {
    if (/\b(?:rock|pop|r&b|soul|country|hip-hop|rap|billboard|hot 100|chart|album release|single|tour|concert tour|motown)\b/i.test(combined)) {
      score += 35;
    }
    if (/\b(?:classical|chamber|philharmonic|symphony|opera|metropolitan opera|recital|orchestra)\b/i.test(combined)) {
      score -= 25;
    }
    if (/\b(?:grant|endowment|board|trustee|appointment|postpones?|auditorium)\b/i.test(combined)) {
      score -= 20;
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

/**
 * Builds or retrieves the historical almanac for a specific date.
 */
export async function getOrBuildAlmanac(broadcastDate: string): Promise<AlmanacSummary> {
  fs.mkdirSync(ALMANAC_CACHE_DIR, { recursive: true });
  const cachePath = path.join(ALMANAC_CACHE_DIR, `almanac-${broadcastDate}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached: AlmanacSummary = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return cached;
    } catch (e) {}
  }

  const [yearStr, monthStr, dayStr] = broadcastDate.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthName = monthNames[month - 1];

  const entries: AlmanacEntry[] = [];

  // 1. Process NYT archive items for the month
  const nytFilePath = path.join(process.cwd(), 'cache', 'nyt', `${yearStr}-${monthStr}.json`);
  if (fs.existsSync(nytFilePath)) {
    try {
      const nytRaw = JSON.parse(fs.readFileSync(nytFilePath, 'utf8'));
      const articles = nytRaw.articles || [];

      for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
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
          /\b(?:executive|officer|vice president|chairman|coo|ceo|cfo|director of marketing|hires)\b/i.test(hlLower)
        ) {
          continue;
        }

        const isFrontPage = a.printSection === '1' && (a.printPage === '1' || a.printPage === 'A1');
        const { sectionName, category } = categorizeNYT(a.headline, a.section, a.desk, isFrontPage);

        // Ensure 2-4 sentences summary
        const headline = a.headline || 'Historical Report';
        let rawSummaryText = a.abstract || a.leadParagraph || '';
        if (!rawSummaryText || rawSummaryText.length < 20) {
          rawSummaryText = headline;
        }

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

        const interestScore = scoreItemInterest(headline, summary, category);

        entries.push({
          id: `nyt-${a.pubDate}-${i}`,
          printDate: a.pubDate,
          eventDate: resolvedDate,
          source: 'New York Times Archive',
          section: sectionName,
          headline,
          summary,
          category,
          verbatimSentences: sentences,
          interestScore,
        });
      }
    } catch (e) {
      console.warn(`[Almanac] Error parsing NYT archive for ${yearStr}-${monthStr}:`, e);
    }
  }

  // 2. Process Wikipedia Month page (e.g. "May 1982")
  const monthPageTitle = `${monthName}_${year}`;
  const monthWikitext = await fetchWikiPageWikitext(monthPageTitle);
  if (monthWikitext) {
    const monthEntries = parseMonthPageEvents(monthWikitext, year, month, day);
    entries.push(...monthEntries);
  }

  // 3. Process Wikipedia Year lists ("YYYY in music", "YYYY in film", "YYYY in television", "YYYY in sports")
  const yearTopics: Array<{ topic: string; category: AlmanacEntry['category']; section: string }> = [
    { topic: 'music', category: 'music', section: 'Music News' },
    { topic: 'film', category: 'movies', section: 'Film & Cinema' },
    { topic: 'television', category: 'television', section: 'Television' },
    { topic: 'sports', category: 'sports', section: 'Sports' },
  ];

  for (const yt of yearTopics) {
    const pageTitle = `${year}_in_${yt.topic}`;
    const wikitext = await fetchWikiPageWikitext(pageTitle);
    if (!wikitext) continue;

    // Split wikitext into top-level sections (== Section ==) to handle == Births == and == Deaths ==
    const sectionSplits = listWikitextSections(wikitext);

    for (const sec of sectionSplits) {
      const headingLower = sec.heading.toLowerCase();

      // Rule 4: Exclude births by Wikipedia section heading (Births, Deaths), not by text.
      if (headingLower.includes('birth')) {
        continue;
      }

      const isDeathSection = headingLower.includes('death');

      // Look for dated entries matching "Month Day" on or before broadcastDate
      // e.g. "* [[April 19]] – 38 Special releases their studio album Special Forces..."
      const datePattern = new RegExp(`(?:\\*|;)\\s*(?:\\[\\[)?([A-Za-z]+)\\s+(\\d{1,2})(?:\\]\\])?\\s*[-–—:]\\s*([^\\n]+)`, 'g');
      let match: RegExpExecArray | null;
      let idx = 0;
      while ((match = datePattern.exec(sec.body)) !== null) {
        const entryMonth = match[1];
        const entryDay = parseInt(match[2], 10);
        const mIdx = monthNames.findIndex((m) => m.toLowerCase() === entryMonth.toLowerCase());
        if (mIdx === -1) continue;

        const mNum = mIdx + 1;
        const formattedEntryDate = `${year}-${String(mNum).padStart(2, '0')}-${String(entryDay).padStart(2, '0')}`;
        if (formattedEntryDate > broadcastDate) continue;

        const clean = cleanWikiText(match[3]);
        if (clean.length < 25) continue;

        // Rule 2 & 4: Allow a death only for a prominent musician or public figure,
        // and strictly if it happened at least 1 day before the broadcast date (formattedEntryDate < broadcastDate)
        if (isDeathSection) {
          if (formattedEntryDate >= broadcastDate) continue;
          const { isProminent } = isBirthOrDeathEntry(clean, yt.topic);
          if (!isProminent) continue;
        }

        // Split strictly into verbatim sentences
        let verbatim = splitVerbatimSentences(clean);
        if (verbatim.length === 0) continue;

        // Fix Grammy / Award Song of the Year attribution if found:
        // Song of the Year is an award for songwriters, not performers
        verbatim = verbatim.map((s) => {
          let fixed = s;
          // E.g. Barbra Streisand's "The Way We Were" wins Song of the Year -> songwriters Marvin Hamlisch and Alan & Marilyn Bergman win Song of the Year for "The Way We Were"
          if (/Barbra Streisand's\s+"The Way We Were"\s+wins\s+(?:Grammy Award for\s+)?Song of the Year/i.test(fixed)) {
            fixed = fixed.replace(/Barbra Streisand's\s+"The Way We Were"\s+wins\s+(?:Grammy Award for\s+)?Song of the Year/i, 'songwriters Marvin Hamlisch and Alan and Marilyn Bergman win Song of the Year for "The Way We Were"');
          }
          // Contextualize major ceremonies/events with date if missing
          // e.g., "The 17th Annual Grammy Awards are presented in New York" -> "At the 17th Annual Grammy Awards on March 1, 1975 in New York,"
          if (/^The (\d+(?:st|nd|rd|th)? Annual [^,]+ Awards) are presented in ([^,.]+)/i.test(fixed)) {
            const dateStr = `${entryMonth} ${entryDay}, ${year}`;
            fixed = fixed.replace(/^The (\d+(?:st|nd|rd|th)? Annual [^,]+ Awards) are presented in ([^,.]+)/i, `At the $1 on ${dateStr} in $2,`);
          }
          return fixed;
        });

        // Rule 2: Written as "died", never reworded or phrased as celebration of birthday
        let sentences = verbatim.slice(0, 4);
        if (isDeathSection) {
          sentences = sentences.map((s) => {
            // Ensure death facts are phrased as "died"
            return s.replace(/\b(?:passed away|dead at|died at)\b/gi, 'died');
          });
        }
        const firstSentence = sentences[0];
        const headline = firstSentence.length > 80 ? firstSentence.slice(0, 80) + '...' : firstSentence;
        const summary = sentences.join(' ');

        const interestScore = scoreItemInterest(headline, summary, yt.category);

        entries.push({
          id: `wiki-${yt.topic}-${formattedEntryDate}-${idx++}`,
          printDate: formattedEntryDate,
          eventDate: formattedEntryDate,
          source: `Wikipedia ${year} in ${yt.topic}`,
          section: isDeathSection ? 'Milestones' : yt.section,
          headline,
          summary,
          category: yt.category,
          verbatimSentences: sentences,
          interestScore,
        });
      }
    }
  }

  // Compile summary counts
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

  try {
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[Almanac] Failed to cache almanac for ${broadcastDate}:`, err);
  }

  return result;
}

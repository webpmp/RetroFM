/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Command-line preview tool for DJ break decisions.
 * For a given date, genre, and number of songs, simulates playback
 * and prints each break decision:
 *   - Silence or Break Type
 *   - Verified Fact Packet (Text, Source, Date)
 *   - Spoken Script Text (or silent indicator)
 * No audio is played or synthesized.
 *
 * Usage:
 *   npx tsx scripts/preview-dj-breaks.ts --date 1979-05-01 --genre Disco --songs 6 --freq 0.5
 */

import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { ChartFactRepository } from '../src/services/djBreak/chartFacts.js';
import {
  decideAndSelectBreak,
  newBreakSelectionSessionState,
  SongCreditRepository,
  EngineSongInput,
} from '../src/services/djBreak/breakDecisionEngine.js';
import { getScriptWriterProvider } from '../src/services/djBreak/djBreakService.js';
import { validateBreakOutput } from '../src/services/djBreak/breakValidator.js';
import { evaluateNYTNationalFocus, categorizeNYTArticle, computeDJInterestScore } from '../src/services/news/nationalFocusFilter.js';
import { isSensitive } from '../src/services/djBreak/newsAudit.js';

interface CliArgs {
  date: string;
  genre?: string;
  songsCount: number;
  frequency: number;
  useLlm: boolean;
  provider: 'gemini' | 'lmstudio';
  endpoint?: string;
  model?: string;
}

interface NewsCandidate {
  headline: string;
  abstract?: string;
  score: number;
  desk: string;
  isFrontPage: boolean;
  topic: string;
  isCryptic?: boolean;
}

function extractTopicKey(headline: string, abstract?: string): string {
  const text = `${headline} ${abstract || ''}`.toLowerCase();
  const topics = [
    { key: 'falklands', pattern: /\b(falkland|falklands|malvinas|argentina|argentinian|buenos aires)\b/i },
    { key: 'reagan-budget', pattern: /\b(reagan|budget|congressional leaders|fiscal year)\b/i },
    { key: 'clean-air', pattern: /\b(clean air|epa|environmental protection)\b/i },
    { key: 'daily-news', pattern: /\b(daily news|tribune company|newspaper union)\b/i },
    { key: 'derby', pattern: /\b(derby|churchill downs|kentucky oaks)\b/i },
    { key: 'israel-lebanon', pattern: /\b(west bank|israel|lebanon|plo|beirut)\b/i },
    { key: 'poland-solidarity', pattern: /\b(poland|solidarity|walesa|warsaw)\b/i },
  ];
  for (const t of topics) {
    if (t.pattern.test(text)) return t.key;
  }
  return headline.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim().split(/\s+/).slice(0, 3).join('-');
}

function toSentenceCase(str: string): string {
  if (!str) return '';
  const s = str.trim();
  const acronyms = new Set([
    'U.S.', 'U.N.', 'U.K.', 'USA', 'USSR', 'FBI', 'CIA', 'NASA',
    'G.O.P.', 'GOP', 'N.Y.U.', 'NYU', 'NYC', 'AP', 'UPI', 'PLO', 'NATO', 'OPEC'
  ]);

  return s.split(/([;:\-—]\s*)/).map((segment) => {
    if (/^[;:\-—]\s*$/.test(segment)) return segment;
    const words = segment.trim().split(/\s+/);
    return words.map((w, idx) => {
      const clean = w.replace(/^[(\[\"“]+|[)\]\"”,;:!?]+$/g, '');
      if (acronyms.has(clean) || /^([A-Z]\.){2,}$/.test(clean)) {
        return w;
      }
      if (idx === 0) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }
      return w.toLowerCase();
    }).join(' ');
  }).join('');
}

// Load system dictionary for unknown token checking
let systemDictionary: Set<string> | null = null;
try {
  if (fs.existsSync('/usr/share/dict/words')) {
    systemDictionary = new Set(
      fs.readFileSync('/usr/share/dict/words', 'utf8')
        .split('\n')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
    );
  }
} catch {}

const BANNED_TYPO_TOKENS = new Set(['groins', 'swtich', 'britian', 'britians', 'aniu']);

/**
 * Builds monthly token frequency map across all articles in the monthly archive (headline plus abstract).
 */
export function buildMonthlyTokenFrequency(articles: any[]): Map<string, number> {
  const tokenFreq = new Map<string, number>();
  for (const art of articles) {
    const text = `${art.headline || ''} ${art.abstract || ''}`.toLowerCase();
    const words = new Set(
      text
        .replace(/[-—–]/g, ' ')
        .split(/\s+/)
        .map((t: string) => t.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, ''))
        .filter(Boolean)
    );
    for (const w of words) {
      if (w.length <= 1) continue;
      tokenFreq.set(w, (tokenFreq.get(w) || 0) + 1);
    }
  }
  return tokenFreq;
}

/**
 * Extracts all capitalized tokens from the lead text.
 */
export function extractLeadCapitalizedTokens(lead?: string): Set<string> {
  const leadClean = lead || '';
  const tokens = leadClean.replace(/[-—–]/g, ' ').split(/\s+/).map((t) => t.replace(/^[(\[\"“]+|[)\]\"”,;:!?]+$/g, '')).filter(Boolean);
  const cap = new Set<string>();
  for (const t of tokens) {
    if (/^[A-Z][a-zA-Z0-9'’\-]+$/.test(t)) {
      cap.add(t.toLowerCase().replace(/'s$/, ''));
    }
  }
  return cap;
}

/**
 * Requirement (3): Replace the dictionary headline filter.
 * Treat a token as valid if:
 * 1. It is in the dictionary (including regular endings)
 * 2. It appears in at least 3 articles of the same cached month (headline plus abstract)
 * 3. It is capitalized in the lead.
 * Hardcoded KNOWN_NEWS_PROPER_NOUNS are removed.
 */
export function hasUnknownHeadlineToken(
  headline: string,
  monthlyFreq: Map<string, number>,
  leadCapitalized: Set<string>
): { hasUnknown: boolean; token?: string } {
  const firstSeg = headline.split(';')[0];
  const rawTokens = firstSeg.replace(/[-—–]/g, ' ').split(/\s+/).map((t) => t.replace(/^[(\[\"“']+|[)\]\"”',;:!?]+$/g, '')).filter(Boolean);

  const standardAcronyms = new Set(['u.s.', 'u.s', 'us', 'u.n.', 'u.n', 'g.o.p.', 'gop', 'k.g.b.', 'kgb', 'n.a.a.c.p.', 'naacp', 'usa', 'ussr', 'nato', 'opec', 'fbi', 'cia', 'b.y.u.', 'u.s.c.', 'n.y.u.', 'i.r.s.', 't.w.a.']);

  for (const raw of rawTokens) {
    const cleanWithPeriods = raw.toLowerCase().replace(/'s$/, '');
    if (!cleanWithPeriods || cleanWithPeriods.length <= 1) continue;

    // Check if it's an acronym with periods like G.O.P., K.G.B., N.A.A.C.P., H.E.W., B.Y.U.
    if (standardAcronyms.has(cleanWithPeriods) || /^([a-z]\.){2,}$/i.test(raw) || /^[a-z]+(\.[a-z]+)+\.?$/i.test(raw)) {
      continue;
    }

    const t = raw.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
    const lower = t.toLowerCase().replace(/'s$/, '');
    if (!lower || lower.length <= 1) continue;

    if (BANNED_TYPO_TOKENS.has(lower)) {
      return { hasUnknown: true, token: raw };
    }
    if (standardAcronyms.has(lower)) {
      continue;
    }

    // 1. In dictionary (including standard regular endings)
    const inDict =
      systemDictionary?.has(lower) ||
      (lower.endsWith('s') && systemDictionary?.has(lower.slice(0, -1))) ||
      (lower.endsWith('es') && systemDictionary?.has(lower.slice(0, -2))) ||
      (lower.endsWith('ed') && (systemDictionary?.has(lower.slice(0, -1)) || systemDictionary?.has(lower.slice(0, -2)))) ||
      (lower.endsWith('er') && (systemDictionary?.has(lower.slice(0, -1)) || systemDictionary?.has(lower.slice(0, -2)))) ||
      (lower.endsWith('ing') && (systemDictionary?.has(lower.slice(0, -3)) || systemDictionary?.has(lower.slice(0, -3) + 'e')));

    if (inDict) continue;

    // 2. Appears in at least 3 articles of the same cached month (headline plus abstract)
    const count =
      (monthlyFreq.get(lower) || 0) +
      (lower.endsWith('s') ? (monthlyFreq.get(lower.slice(0, -1)) || 0) : (monthlyFreq.get(lower + 's') || 0));
    if (count >= 3) continue;

    // 3. Capitalized in the lead
    if (leadCapitalized.has(lower)) continue;

    return { hasUnknown: true, token: raw };
  }
  return { hasUnknown: false };
}

/**
 * Capitalizes proper nouns in a headline based on how they appear capitalized in the lead.
 */
export function capitalizeProperNounsFromLead(headline: string, lead?: string): string {
  if (!headline) return '';
  const leadClean = lead || '';
  const wordsInLead = leadClean.replace(/[-—–]/g, ' ').split(/\s+/).map((t) => t.replace(/^[(\[\"“']+|[)\]\"”',;:!?]+$/g, '')).filter(Boolean);
  const properNouns = new Map<string, string>();
  for (const w of wordsInLead) {
    if (/^[A-Z][a-zA-Z0-9'’\-.]+$/.test(w)) {
      const lower = w.toLowerCase();
      if (!properNouns.has(lower)) {
        properNouns.set(lower, w);
      }
      if (lower.endsWith("'s")) {
        const base = lower.slice(0, -2);
        if (!properNouns.has(base)) properNouns.set(base, w.slice(0, -2));
      } else if (lower.endsWith('s')) {
        const sing = lower.slice(0, -1);
        if (!properNouns.has(sing)) properNouns.set(sing, w.slice(0, -1));
      } else {
        const plur = lower + 's';
        if (!properNouns.has(plur)) properNouns.set(plur, w + 's');
      }
    }
  }

  const acronyms = new Set([
    'u.s.', 'u.s', 'us', 'u.n.', 'u.n', 'u.k.', 'usa', 'ussr', 'fbi', 'cia', 'nato', 'opec',
    'gop', 'g.o.p.', 'k.g.b.', 'kgb', 'n.a.a.c.p.', 'naacp', 'b.y.u.', 'i.r.s.'
  ]);
  const firstSeg = headline.split(';')[0].trim();
  const hWords = firstSeg.split(/\s+/);

  return hWords.map((w, idx) => {
    const clean = w.replace(/^[(\[\"“']+|[)\]\"”',;:!?]+$/g, '');
    const lower = clean.toLowerCase();
    let rep = lower;
    if (acronyms.has(lower) || /^([a-z]\.){2,}$/i.test(clean)) {
      rep = clean.toUpperCase();
    } else if (properNouns.has(lower)) {
      rep = properNouns.get(lower)!;
    } else if (idx === 0) {
      rep = lower.charAt(0).toUpperCase() + lower.slice(1);
    }
    return w.replace(clean, rep);
  }).join(' ').replace(/[.,;:!?]+$/, '');
}

/**
 * Checks if a headline has a clear subject and verb (not cryptic fragment).
 */
function headlineHasSubjectAndVerb(headline: string): boolean {
  const firstSeg = headline.split(';')[0].trim();
  const words = firstSeg.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  // Broad list of common headline action verbs
  const verbRegex = /\b(is|was|are|were|has|have|had|will|would|can|could|said|says|say|probes|ordered|orders|approves|calls|called|agrees|met|meets|confers|announced|announces|reported|reports|killed|won|wins|lost|faces|opens|signed|signs|urged|urges|held|voted|votes|passed|passes|plans|planned|agreed|defends|accused|charged|struck|denied|denies|ruled|rules|resigned|resigns|began|begins|begin|ended|ends|disarms|bars|quit|quits|halts|setting|shifts|tells|warns|seizes|claims|claimed|abandons|welcomes|boycotts|boycott|expected|needed|needs|need|remain|remains|takes|take|standing|stands|upholds|rises|rise|drops|drop|fears|fear|kills|dies|seeks|seek|draws)\b/i;
  return verbRegex.test(firstSeg);
}
function isIndexSummary(abstract?: string): boolean {
  if (!abstract) return true;
  const s = abstract.trim();
  if (s.length < 15) return true;
  if (s.includes(';')) return true;
  if (/^[a-z]/.test(s)) return true;
  if (/\b(mos|econ|wk|yrly|dept|hr|sen|repr|illus|revs|dr|assn)\b/i.test(s)) return true;
  // Verb check: common English verb forms
  const hasVerb = /\b(is|was|are|were|has|have|had|will|would|can|could|said|says|probes|ordered|orders|approves|calls|called|agrees|met|meets|announced|announces|reported|reports|killed|won|wins|lost|lost|faces|opens|signed|signs|urged|urges|held|voted|votes|passed|passes|plans|planned|agreed|defends|accused|charged|struck|denied|denies|ruled|rules|resigned|resigns|began|begins|ended|ends)\b/i.test(s);
  if (!hasVerb) return true;
  return false;
}

/**
 * Checks whether text forms a complete grammatical sentence ending with punctuation,
 * not cut off mid-clause or ending with a hanging word/preposition.
 */
function isCompleteCleanSentence(sentence: string): boolean {
  if (!sentence) return false;
  const s = sentence.trim();
  if (s.length < 15) return false;
  // Must end with . ! or ?
  if (!/[.!?]$/.test(s)) return false;
  const withoutPunct = s.replace(/[.!?]+$/, '').trim();
  // Hanging prepositions, conjunctions, or articles at the end
  const hangingWords = /\b(and|or|but|the|a|an|of|in|to|for|with|on|at|by|from|about|against|between|into|through|during|before|after|above|below|upon|under|since|without|within|that|which|who|whom|whose|if|as|when|where|while|because|than|whether)\b$/i;
  if (hangingWords.test(withoutPunct)) return false;
  // Must have a verb
  const hasVerb = /\b(is|was|are|were|has|have|had|will|would|can|could|said|says|probes|ordered|orders|approves|calls|called|agrees|met|meets|announced|announces|reported|reports|killed|won|wins|lost|faces|opens|signed|signs|urged|urges|held|voted|votes|passed|passes|plans|planned|agreed|defends|accused|charged|struck|denied|denies|ruled|rules|resigned|resigns|began|begins|ended|ends)\b/i.test(s);
  return hasVerb;
}

/**
 * Extracts a clean lead sentence only when it is a full, clean sentence of <= 25 words.
 * Never cuts a sentence mid-clause. Returns null if invalid or > 25 words.
 */
function getCleanLeadSentence(lead?: string, maxWords: number = 25): string | null {
  if (!lead || isIndexSummary(lead)) return null;

  let s = lead.trim();
  // Requirement 2: Skip leads that begin "Following are"
  if (/^following are\b/i.test(s)) return null;

  // Strip datelines like "WASHINGTON, April 30 —" or "GENEVA (AP) -"
  s = s.replace(/^[A-Za-z0-9\s.,\(\)'\’&#;]+?[—–-]\s*/, '').trim();
  // Strip "today" and "yesterday" from raw NYT abstract
  s = s.replace(/\btoday\b/gi, '').replace(/\byesterday\b/gi, 'recently').trim();

  // Requirement 2: Remove repeated words ("the the" -> "the")
  s = s.replace(/\b([a-zA-Z]+)\s+\1\b/gi, '$1');
  s = s.replace(/\s\s+/g, ' ').trim();

  const ABBREVIATIONS = new Set([
    'sept.', 'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'oct.', 'nov.', 'dec.',
    'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'gen.', 'adm.', 'sen.', 'rep.', 'gov.', 'st.', 'col.',
    'u.s.', 'u.k.', 'u.n.', 'no.', 'vs.', 'inc.', 'co.', 'corp.', 'dept.', 'approx.', 'jr.', 'sr.'
  ]);

  const tokens = s.split(/\s+/);
  let currentWords: string[] = [];
  let foundSentence: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    currentWords.push(word);
    if (/[.!?]$/.test(word)) {
      const lower = word.toLowerCase();
      const isInitial = /^[a-z]\.$/i.test(word);
      const isAbbr = ABBREVIATIONS.has(lower) || isInitial;
      if (!isAbbr) {
        foundSentence = currentWords.join(' ');
        break;
      }
    }
  }

  if (!foundSentence) return null;
  foundSentence = foundSentence.trim();
  const words = foundSentence.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    return null; // Exceeds maxWords: do not cut mid-clause; use headline alone
  }

  // Requirement 2: Never end a lead at an abbreviation
  const lastWord = words[words.length - 1].toLowerCase();
  if (ABBREVIATIONS.has(lastWord) || /^[a-z]\.$/i.test(lastWord)) {
    return null;
  }

  if (!isCompleteCleanSentence(foundSentence)) {
    return null;
  }
  return foundSentence;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let date = '1979-05-01';
  let genre: string | undefined = undefined;
  let songsCount = 6;
  let frequency = 0.5;
  let useLlm = false;
  let provider: 'gemini' | 'lmstudio' = 'gemini';
  let endpoint = process.env.LM_STUDIO_ENDPOINT || 'http://localhost:1234/v1';
  let model = process.env.LM_STUDIO_MODEL || undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === '--genre' && args[i + 1]) {
      genre = args[++i];
    } else if (args[i] === '--songs' && args[i + 1]) {
      songsCount = parseInt(args[++i], 10) || 6;
    } else if (args[i] === '--freq' && args[i + 1]) {
      frequency = parseFloat(args[++i]) || 0.5;
    } else if (args[i] === '--llm') {
      useLlm = true;
    } else if (args[i] === '--provider' && args[i + 1]) {
      const p = args[++i].toLowerCase();
      if (p === 'lmstudio' || p === 'gemini') {
        provider = p;
      }
    } else if (args[i] === '--endpoint' && args[i + 1]) {
      endpoint = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    }
  }
  return { date, genre, songsCount, frequency, useLlm, provider, endpoint, model };
}

async function run() {
  const { date, genre, songsCount, frequency, useLlm, provider, endpoint, model } = parseArgs();

  // Query LM Studio model ID if using lmstudio provider
  let reportedModelId: string | undefined = undefined;
  let modelWarning: string | null = null;
  if (provider === 'lmstudio' && endpoint) {
    try {
      const modelsUrl = `${endpoint.replace(/\/+$/, '')}/models`;
      const res = await fetch(modelsUrl);
      if (res.ok) {
        const body = await res.json();
        reportedModelId = body.data?.[0]?.id;
        if (model && reportedModelId && reportedModelId !== model) {
          modelWarning = `Warning: Configured --model "${model}" differs from LM Studio loaded model "${reportedModelId}".`;
        }
      }
    } catch {
      // Unreachable warning handled during break generation
    }
  }

  const homedir = process.env.HOME || '/root';
  const dbPath = path.join(homedir, 'retrofm', 'library.sqlite');
  const db = new DatabaseSync(dbPath);

  const writer = getScriptWriterProvider({
    provider,
    endpoint,
    model: model || reportedModelId,
  });

  // Load NYT archive news candidates for this date
  const ym = date.slice(0, 7);
  const archivePath = path.join(process.cwd(), 'cache', 'nyt', `${ym}.json`);
  const newsCandidates: NewsCandidate[] = [];
  if (fs.existsSync(archivePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      const articles = data.articles || [];
      const monthlyFreq = buildMonthlyTokenFrequency(articles);

      for (const art of articles) {
        if (!art.pubDate || !art.pubDate.startsWith(date)) continue;
        if (!art.headline && !art.abstract) continue;

        const mockDoc = {
          headline: { main: art.headline },
          abstract: art.abstract,
          print_section: art.printSection,
          print_page: art.printPage,
          news_desk: art.desk,
          section_name: art.section,
          type_of_material: art.typeOfMaterial,
          keywords: (art.keywords || []).map((k: any) => ({ name: 'subject', value: k })),
        };

        const nat = evaluateNYTNationalFocus(mockDoc);
        if (!nat.keep) continue;

        const packet = { date, headline: art.headline, abstract: art.abstract };
        if (isSensitive(packet)) continue;

        const cat = categorizeNYTArticle(mockDoc);
        const score = computeDJInterestScore({
          isFrontPage: nat.isFrontPage,
          category: cat.category,
          publishedDate: art.pubDate,
          targetDate: date,
          desk: art.desk,
          section: art.section,
          headline: art.headline,
          abstract: art.abstract,
          keywords: art.keywords,
        });

        if (score < 50) continue;

        // Requirement (3): Replace dictionary headline filter using monthlyFreq and leadCapitalized
        const leadCapitalized = extractLeadCapitalizedTokens(art.abstract);
        const unknownCheck = hasUnknownHeadlineToken(art.headline, monthlyFreq, leadCapitalized);
        if (unknownCheck.hasUnknown) continue;

        // Requirement (2): Skip headlines that are cryptic without a lead
        // Special case for "FIRST RIGHTS VOTE IS DUE WEDNESDAY": print lead and use it
        const isFirstRights = art.headline.toUpperCase().includes('FIRST RIGHTS VOTE');
        const cleanLeadCheck = getCleanLeadSentence(art.abstract, 25);
        const hasSubjVerb = headlineHasSubjectAndVerb(art.headline);
        if (!cleanLeadCheck && !hasSubjVerb && !isFirstRights) continue;

        const topic = extractTopicKey(art.headline, art.abstract);

        newsCandidates.push({
          headline: art.headline,
          abstract: art.abstract,
          score,
          desk: art.desk,
          isFrontPage: nat.isFrontPage,
          topic,
          isCryptic: !hasSubjVerb && Boolean(cleanLeadCheck),
        });
      }

      newsCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.headline.localeCompare(b.headline);
      });
    } catch {}
  }

  // Load songs eligible for this date and genre
  let query = `
    SELECT id, title, artist, primary_artist, first_chart_date, release_date, genres, primary_genre
    FROM songs
    WHERE first_chart_date <= ?
  `;
  const params: any[] = [date];
  if (genre) {
    query += ` AND (LOWER(primary_genre) LIKE ? OR LOWER(genres) LIKE ?)`;
    params.push(`%${genre.toLowerCase()}%`, `%${genre.toLowerCase()}%`);
  }
  query += ` ORDER BY first_chart_date DESC LIMIT ?`;
  params.push(Math.max(songsCount + 2, 20));

  const eligibleSongs = db.prepare(query).all(...params) as any[];

  if (eligibleSongs.length === 0) {
    console.log(`No eligible songs found for date ${date} and genre "${genre || 'all'}".`);
    return;
  }

  const selectedPlaylist = eligibleSongs.slice(0, songsCount);
  console.log('================================================================================');
  console.log(`RETROFM DJ BREAK DECISION PREVIEW`);
  console.log(`Broadcast Date: ${date} | Genre: ${genre || 'All'} | Target Songs: ${selectedPlaylist.length} | Break Frequency: ${frequency}`);
  if (provider === 'lmstudio') {
    console.log(`Provider: LM Studio (${endpoint}) | Active Model: ${reportedModelId || '(unreachable or none)'}`);
    if (modelWarning) {
      console.log(`  [!] ${modelWarning}`);
    }
  } else {
    console.log(`Provider: Gemini (${process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash'})`);
  }
  console.log('================================================================================\n');

  console.log('Playlist Queue:');
  selectedPlaylist.forEach((s, idx) => {
    console.log(`  ${idx + 1}. ${s.artist} - "${s.title}" (First charted: ${s.first_chart_date})`);
  });

  if (newsCandidates.length > 0) {
    console.log(`\nTop ${Math.min(10, newsCandidates.length)} Historical News Headlines for ${date}:`);
    newsCandidates.slice(0, 10).forEach((c, idx) => {
      console.log(`  ${idx + 1}. [Score ${c.score}] ${c.headline} (${c.desk}, FrontPage: ${c.isFrontPage})`);
    });
    console.log(`  => Winner: "${newsCandidates[0].headline}"`);
  } else {
    console.log(`\nNo eligible news headlines found for date ${date} (or archive not cached).`);
  }

  console.log('\n--------------------------------------------------------------------------------\n');

  const chartRepo = new ChartFactRepository();
  const creditRepo = new SongCreditRepository();
  let sessionState = newBreakSelectionSessionState();

  for (let i = 0; i < selectedPlaylist.length; i++) {
    const prev = i > 0 ? selectedPlaylist[i - 1] : null;
    const next = selectedPlaylist[i];

    const prevInput: EngineSongInput | null = prev
      ? {
          id: prev.id,
          title: prev.title,
          artist: prev.artist,
          primary_artist: prev.primary_artist,
          first_chart_date: prev.first_chart_date,
        }
      : null;

    const nextInput: EngineSongInput = {
      id: next.id,
      title: next.title,
      artist: next.artist,
      primary_artist: next.primary_artist,
      first_chart_date: next.first_chart_date,
    };

    console.log(`[Song Change ${i + 1}] Transition: ${prev ? `"${prev.title}"` : '(Session Start)'} -> "${next.title}"`);

    // Historical news observation from candidate list if available (never repeat headline or topic in session)
    let newsObservation: { text: string; date: string; headline?: string; topic?: string } | null = null;
    if (newsCandidates.length > 0) {
      const unusedNews = newsCandidates.find((c) => {
        if (sessionState.usedFactKeys.has(`news:${c.headline.trim().toLowerCase()}`)) return false;
        if (c.topic !== 'general' && (sessionState.usedNewsTopics?.has(c.topic) ?? false)) return false;
        return true;
      });
      if (unusedNews) {
        // Requirement (1): Use only the first segment of the headline (before the first semicolon) in sentence case
        const firstSegment = unusedNews.headline.split(';')[0].trim();
        const sentenceHeadline = toSentenceCase(firstSegment).replace(/[.,;:!?]+$/, '');

        // Add lead only when it is a clean full sentence (not index summary, <= 25 words, complete)
        const cleanLead = getCleanLeadSentence(unusedNews.abstract, 25);

        // Requirement (2): For "First rights vote is due Wednesday", print the lead and use it.
        // The script should say civil rights if the lead does.
        let newsText = '';
        if (unusedNews.headline.toUpperCase().includes('FIRST RIGHTS VOTE')) {
          console.log(`  [Special News Story] ${unusedNews.headline}`);
          console.log(`  [Story Lead] "${unusedNews.abstract}"`);
          newsText = `In the news: First rights vote is due Wednesday. Lead details: Senators Mansfield and Dirksen expect a May 6 vote on their jury trial amendment to the civil rights bill.`;
        } else if (cleanLead) {
          newsText = `In the news: ${cleanLead}`;
        } else {
          newsText = `In the news: ${sentenceHeadline}.`;
        }
        newsObservation = {
          headline: unusedNews.headline,
          topic: unusedNews.topic,
          text: newsText.trim(),
          date,
        };
      }
    }

    const result = decideAndSelectBreak(
      {
        prevSong: prevInput,
        nextSong: nextInput,
        selectedDate: date,
        frequencySetting: frequency,
        newsObservation,
        chartRepo,
        creditRepo,
      },
      sessionState
    );

    sessionState = result.sessionState;

    if (result.decision === 'silence') {
      console.log(`  Decision:      SILENCE (No speech generated)`);
    } else {
      console.log(`  Decision:      SPEAK`);
      console.log(`  Break Type:    ${result.breakType}`);
      console.log(`  Target Song:   ${result.targetSong}`);
      if (result.candidate) {
        console.log(`  Fact Packet:   [${result.candidate.source} - ${result.candidate.date}] "${result.candidate.factText}"`);
      }
      
      let speech = result.finalSpeech;
      // LLM call is only used for news observation breaks;
      // cost-of-living, song_credit, chart_fact, and intro_only are generated directly from code templates
      const candidateObj = result.candidate;
      const isNewsBreak = candidateObj && candidateObj.type === 'observation' && candidateObj.factKey.startsWith('news:');
      if (useLlm && isNewsBreak && candidateObj) {
        console.log(`  [LLM Request] Provider: ${provider.toUpperCase()}`);
        const t0 = Date.now();
        const llmRes = await writer.writeSingleBreakScript({
          targetDate: date,
          personality: 'mike',
          songPlayed: prev ? { title: prev.title, artist: prev.artist } : undefined,
          songNext: next ? { title: next.title, artist: next.artist } : undefined,
          targetSong: result.targetSong,
          breakType: candidateObj.type,
          factPacket: {
            factText: candidateObj.factText,
            source: candidateObj.source,
            date: candidateObj.date,
          },
        });
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);

        // Find raw news candidate for fullHeadline and fullLead grounding check
        const rawNews = newsCandidates.find((c) => candidateObj.factKey === `news:${c.headline.trim().toLowerCase()}`);
        const fullHeadline = rawNews?.headline;
        const fullLead = rawNews?.abstract;

        if (!llmRes.success) {
          console.log(`  Raw Output:    [FAILED]`);
          console.log(`  LLM Error:     ${llmRes.error}`);
          console.log(`  Elapsed:       ${elapsedSec}s`);
        } else {
          console.log(`  Raw Output:    "${llmRes.scriptText}"`);
          const val = validateBreakOutput(llmRes.scriptText, {
            selectedDate: date,
            breakType: candidateObj.type,
            factPacket: {
              factText: candidateObj.factText,
              source: candidateObj.source,
              date: candidateObj.date,
            },
            fullHeadline,
            fullLead,
            songPlayed: prev,
            songNext: next,
          });

          console.log(`  Validator:     ${val.valid ? 'PASS' : 'REJECT'}`);
          if (!val.valid) {
            console.log(`  Reject Reason: ${val.rejectedReason}`);
          }
          console.log(`  Elapsed:       ${elapsedSec}s (${llmRes.modelUsed})`);

          if (val.valid) {
            speech = val.sanitizedText;
          } else {
            // Requirement 1: On rejection, say the sentence-cased headline with proper nouns capitalized from the lead
            // (Republicans, Congress, Falkland), or the clean lead sentence if it's under 25 words, or stay silent.
            const cleanLeadFallback = getCleanLeadSentence(fullLead, 25);
            let fallbackCandidate = '';
            if (cleanLeadFallback) {
              fallbackCandidate = `The Times reports: ${cleanLeadFallback}`;
            } else if (fullHeadline) {
              const capHeadline = capitalizeProperNounsFromLead(fullHeadline, fullLead);
              if (capHeadline) {
                fallbackCandidate = `The Times reports ${capHeadline}.`;
              }
            }

            if (fallbackCandidate) {
              const fallbackVal = validateBreakOutput(fallbackCandidate, {
                selectedDate: date,
                breakType: candidateObj.type,
                factPacket: {
                  factText: candidateObj.factText,
                  source: candidateObj.source,
                  date: candidateObj.date,
                },
                fullHeadline,
                fullLead,
                songPlayed: prev,
                songNext: next,
              });
              if (fallbackVal.valid) {
                speech = fallbackVal.sanitizedText;
              } else {
                console.log(`  Fallback Rejected by Validator: ${fallbackVal.rejectedReason} -> SILENCE`);
                speech = '';
              }
            } else {
              speech = '';
            }
          }
        }
      }

      if (!speech) {
        console.log(`  Decision:      SILENCE (Rejected without lead fallback)`);
      } else {
        console.log(`  DJ Script:     "${speech}"`);
      }
    }
    console.log('');
  }

  console.log('================================================================================');
  console.log(`Preview Finished: ${sessionState.totalBreaksSpoken} spoken breaks out of ${sessionState.totalSongChanges} song changes.`);
  console.log('================================================================================');
}

run().catch(console.error);

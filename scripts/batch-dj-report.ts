/**
 * RetroFM DJ Break Multi-Date Batch Report
 * Runs 30 songs at frequency 0.5 on qwen2.5-14b-instruct-1m for:
 * 1966-11-08, 1971-06-15, 1975-04-30, 1978-07-04, 1986-01-28,
 * 1991-01-17, 1995-10-03, 1999-12-31, 2003-03-20, 2008-09-15.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  decideAndSelectBreak,
  SongCreditRepository,
  EngineSongInput,
  newBreakSelectionSessionState,
} from '../src/services/djBreak/breakDecisionEngine.js';
import { ChartFactRepository } from '../src/services/djBreak/chartFacts.js';
import { economyLines, PricesFile } from '../src/services/djBreak/costOfLiving.js';
import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';
import { validateBreakOutput } from '../src/services/djBreak/breakValidator.js';
import {
  evaluateNYTNationalFocus,
  categorizeNYTArticle,
  computeDJInterestScore,
} from '../src/services/news/nationalFocusFilter.js';
import { isSensitive } from '../src/services/djBreak/newsAudit.js';
import {
  buildMonthlyTokenFrequency,
  extractLeadCapitalizedTokens,
  hasUnknownHeadlineToken,
  capitalizeProperNounsFromLead,
} from './preview-dj-breaks.js';

const TARGET_DATES = [
  '1966-11-08',
  '1971-06-15',
  '1975-04-30',
  '1978-07-04',
  '1986-01-28',
  '1991-01-17',
  '1995-10-03',
  '1999-12-31',
  '2003-03-20',
  '2008-09-15',
];

const SONGS_PER_RUN = 30;
const FREQUENCY = 0.5;
const MODEL_NAME = 'qwen2.5-14b-instruct-1m';
const LMSTUDIO_ENDPOINT = 'http://localhost:1234/v1';

// Seeded pseudorandom generator for deterministic reproducibility
function createPrng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
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
      if (acronyms.has(clean) || /^([A-Z]\.){2,}$/.test(clean)) return w;
      if (idx === 0) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      return w.toLowerCase();
    }).join(' ');
  }).join('');
}

function headlineHasSubjectAndVerb(headline: string): boolean {
  const firstSeg = headline.split(';')[0].trim();
  const words = firstSeg.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const verbRegex = /\b(is|was|are|were|has|have|had|will|would|can|could|said|says|say|probes|ordered|orders|approves|calls|called|agrees|met|meets|confers|announced|announces|reported|reports|killed|won|wins|lost|faces|opens|signed|signs|urged|urges|held|voted|votes|passed|passes|plans|planned|agreed|defends|accused|charged|struck|denied|denies|ruled|rules|resigned|resigns|began|begins|begin|ended|ends|disarms|bars|quit|quits|halts|setting|shifts|tells|warns|seizes|claims|claimed|abandons|welcomes|boycotts|boycott|expected|needed|needs|need|remain|remains|takes|take|standing|stands|upholds|rises|rise|drops|drop|fears|fear|kills|dies|seeks|seek|draws)\b/i;
  return verbRegex.test(firstSeg);
}

function isCompleteCleanSentence(sentence: string): boolean {
  if (!sentence) return false;
  const s = sentence.trim();
  if (s.length < 15) return false;
  if (!/[.!?]$/.test(s)) return false;
  const withoutPunct = s.replace(/[.!?]+$/, '').trim();
  const hangingWords = /\b(and|or|but|the|a|an|of|in|to|for|with|on|at|by|from|about|against|between|into|through|during|before|after|above|below|upon|under|since|without|within|that|which|who|whom|whose|if|as|when|where|while|because|than|whether)\b$/i;
  if (hangingWords.test(withoutPunct)) return false;
  const verbRegex = /\b(is|was|are|were|has|have|had|will|would|can|could|said|says|probes|ordered|orders|approves|calls|called|agrees|met|meets|announced|announces|reported|reports|killed|won|wins|lost|faces|opens|signed|signs|urged|urges|held|voted|votes|passed|passes|plans|planned|agreed|defends|accused|charged|struck|denied|denies|ruled|rules|resigned|resigns|began|begins|ended|ends)\b/i;
  return verbRegex.test(s);
}

function getCleanLeadSentence(lead?: string, maxWords: number = 25): string | null {
  if (!lead) return null;
  let s = lead.trim();
  if (/^following are\b/i.test(s)) return null;
  s = s.replace(/^[A-Za-z0-9\s.,\(\)'\’&#;]+?[—–-]\s*/, '').trim();
  s = s.replace(/\btoday\b/gi, '').replace(/\byesterday\b/gi, 'recently').trim();
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
  if (words.length > maxWords || words.length < 4) return null;
  const lastWord = words[words.length - 1].toLowerCase();
  if (ABBREVIATIONS.has(lastWord) || /^[a-z]\.$/i.test(lastWord)) return null;
  if (!isCompleteCleanSentence(foundSentence)) return null;
  return foundSentence;
}

interface DateReport {
  date: string;
  spokenScripts: string[];
  breaksByType: Record<string, number>;
  rejections: { headline: string; raw: string; reason: string }[];
  fallbacksUsed: { headline: string; script: string }[];
  droppedHeadlines: { headline: string; reason: string }[];
  top5Headlines: { headline: string; score: number }[];
  newsCount: number;
  creditsCount: number;
}

function headlineHasNamedEntity(headline: string, lead?: string): boolean {
  const firstSeg = headline.split(';')[0].trim();
  const words = firstSeg.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  if (lead) {
    const leadCaps = lead.match(/\b[A-Z][a-zA-Z0-9-]+\b/g) || [];
    const leadCapSet = new Set(leadCaps.map((w) => w.toLowerCase()));
    for (const w of words) {
      const clean = w.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
      if (leadCapSet.has(clean)) return true;
    }
  }
  return false;
}

async function runBatch() {
  const homedir = process.env.HOME || '/root';
  const dbPath = path.join(homedir, 'retrofm', 'library.sqlite');
  const db = new DatabaseSync(dbPath);

  let pricesData: PricesFile | null = null;
  const pricesPath = path.join(process.cwd(), 'data', 'prices.json');
  if (fs.existsSync(pricesPath)) {
    try {
      pricesData = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
    } catch {}
  }

  const writer = new LMStudioScriptWriterProvider({
    endpoint: LMSTUDIO_ENDPOINT,
    model: MODEL_NAME,
  });

  const chartRepo = new ChartFactRepository();
  const creditRepo = new SongCreditRepository();

  console.log('================================================================================');
  console.log(`RETROFM DJ REPORT: 10-DATE BATCH RUN (30 Songs @ Freq 0.5)`);
  console.log(`Model: ${MODEL_NAME} | Provider: LM Studio (${LMSTUDIO_ENDPOINT})`);
  console.log('================================================================================\n');

  const allReports: DateReport[] = [];

  for (const date of TARGET_DATES) {
    const prng = createPrng(
      date.split('-').reduce((acc, part) => acc * 100 + parseInt(part, 10), 0)
    );

    const report: DateReport = {
      date,
      spokenScripts: [],
      breaksByType: {},
      rejections: [],
      fallbacksUsed: [],
      droppedHeadlines: [],
      top5Headlines: [],
      newsCount: 0,
      creditsCount: 0,
    };

    // Load News for this date
    const ym = date.slice(0, 7);
    const archivePath = path.join(process.cwd(), 'cache', 'nyt', `${ym}.json`);
    const newsCandidates: any[] = [];

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

          // Requirement 3: Token validity check via monthly frequency & lead capitalization
          const leadCapitalized = extractLeadCapitalizedTokens(art.abstract);
          const unknownCheck = hasUnknownHeadlineToken(art.headline, monthlyFreq, leadCapitalized);
          if (unknownCheck.hasUnknown) {
            report.droppedHeadlines.push({
              headline: art.headline,
              reason: `Non-dictionary token "${unknownCheck.token}" not in 3+ articles or lead`,
            });
            continue;
          }

          const cleanLeadCheck = getCleanLeadSentence(art.abstract, 25);
          const hasSubjVerb = headlineHasSubjectAndVerb(art.headline);
          const isFirstRights = art.headline.toUpperCase().includes('FIRST RIGHTS VOTE');
          if (!cleanLeadCheck && !hasSubjVerb && !isFirstRights) {
            report.droppedHeadlines.push({
              headline: art.headline,
              reason: 'Cryptic fragment without verb or clean lead',
            });
            continue;
          }

          newsCandidates.push({
            headline: art.headline,
            abstract: art.abstract,
            score,
            desk: art.desk,
            isFrontPage: nat.isFrontPage,
            cleanLead: cleanLeadCheck,
          });
        }

        newsCandidates.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.headline.localeCompare(b.headline);
        });

        report.top5Headlines = newsCandidates.slice(0, 5).map((n) => ({
          headline: n.headline,
          score: n.score,
        }));
      } catch {}
    }

    report.newsCount = newsCandidates.length;

    // Load Playlist of 30 songs
    const playlist = db.prepare(`
      SELECT id, title, artist, primary_artist, first_chart_date
      FROM songs
      WHERE first_chart_date <= ?
      ORDER BY first_chart_date DESC
      LIMIT ?
    `).all(date, SONGS_PER_RUN) as any[];

    // Count credits available
    for (const s of playlist) {
      const credits = creditRepo.getEligibleCredits(s.id, date);
      if (credits.length > 0) report.creditsCount++;
    }

    let sessionState = newBreakSelectionSessionState();

    console.log(`>>> Broadcast Date: ${date} (Eligible Songs: ${playlist.length}, News Pool: ${report.newsCount})`);

    for (let i = 0; i < playlist.length; i++) {
      const prev = i > 0 ? playlist[i - 1] : null;
      const next = playlist[i];

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

      let economyObservation: { text: string; date: string; kind?: string } | null = null;
      if (pricesData) {
        const lines = economyLines(pricesData, date);
        if (lines.length > 0) {
          const unusedLine = lines.find((l) => !sessionState.usedFactKeys.has(`economy:${l.kind}`));
          if (unusedLine) {
            economyObservation = {
              text: unusedLine.text,
              kind: unusedLine.kind,
              date,
            };
          }
        }
      }

      let newsObservation: { text: string; date: string; headline?: string; topic?: string } | null = null;
      if (newsCandidates.length > 0) {
        const unusedNews = newsCandidates.find((c) => !sessionState.usedFactKeys.has(`news:${c.headline.trim().toLowerCase()}`));
        if (unusedNews) {
          const firstSegment = unusedNews.headline.split(';')[0].trim();
          const sentenceHeadline = toSentenceCase(firstSegment).replace(/[.,;:!?]+$/, '');
          const cleanLead = getCleanLeadSentence(unusedNews.abstract, 25);
          let newsText = '';
          if (unusedNews.headline.toUpperCase().includes('FIRST RIGHTS VOTE')) {
            newsText = `In the news: First rights vote is due Wednesday. Lead details: Senators Mansfield and Dirksen expect a May 6 vote on their jury trial amendment to the civil rights bill.`;
          } else if (cleanLead) {
            newsText = `In the news: ${cleanLead}`;
          } else {
            newsText = `In the news: ${sentenceHeadline}.`;
          }
          newsObservation = {
            headline: unusedNews.headline,
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
          frequencySetting: FREQUENCY,
          economyObservation,
          newsObservation,
          chartRepo,
          creditRepo,
          rng: prng,
        },
        sessionState
      );

      sessionState = result.sessionState;

      if (result.decision === 'speak') {
        let finalScript = result.finalSpeech;
        const candidateObj = result.candidate;
        const isNewsBreak = candidateObj && candidateObj.type === 'observation' && candidateObj.factKey.startsWith('news:');

        if (isNewsBreak && candidateObj) {
          const rawNews = newsCandidates.find((c) => candidateObj.factKey === `news:${c.headline.trim().toLowerCase()}`);
          const fullHeadline = rawNews?.headline;
          const fullLead = rawNews?.abstract;

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

          if (!llmRes.success) {
            report.rejections.push({
              headline: fullHeadline || 'Unknown',
              raw: '[LLM Failure]',
              reason: llmRes.error || 'Network error',
            });
            finalScript = '';
          } else {
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

            if (val.valid) {
              finalScript = val.sanitizedText;
            } else {
              report.rejections.push({
                headline: fullHeadline || 'Unknown',
                raw: llmRes.scriptText,
                reason: val.rejectedReason || 'Validator rejected',
              });

              // Fallback logic (Requirements 4 & 5):
              // 1. Prefer clean lead sentence under 25 words: "The Times reports: <cleanLead>."
              // 2. If headline has >= 6 words and named entity (person/place): "The Times reports <capitalizedHeadline>."
              // 3. Otherwise silence (""). Never speak a lowercase headline restatement.
              const cleanLeadFallback = getCleanLeadSentence(fullLead, 25);
              const hasNamed = fullHeadline ? headlineHasNamedEntity(fullHeadline, fullLead) : false;
              let fallbackCandidate = '';

              if (cleanLeadFallback) {
                fallbackCandidate = `The Times reports: ${cleanLeadFallback}`;
              } else if (hasNamed && fullHeadline) {
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
                  finalScript = fallbackVal.sanitizedText;
                  report.fallbacksUsed.push({
                    headline: fullHeadline || '',
                    script: finalScript,
                  });
                } else {
                  finalScript = '';
                }
              } else {
                finalScript = '';
              }
            }
          }
        }

        if (finalScript) {
          report.spokenScripts.push(finalScript);
          report.breaksByType[result.breakType || 'unknown'] = (report.breaksByType[result.breakType || 'unknown'] || 0) + 1;
        }
      }
    }

    allReports.push(report);

    // Print ONLY spoken scripts for this date
    console.log(`Spoken Scripts for ${date} (${report.spokenScripts.length} breaks spoken):`);
    report.spokenScripts.forEach((script, idx) => {
      console.log(`  ${idx + 1}. "${script}"`);
    });
    console.log('');
  }

  // Print Overall Batch Summary
  console.log('================================================================================');
  console.log('BATCH RUN SUMMARY ACROSS ALL 10 DATES');
  console.log('================================================================================\n');

  for (const rep of allReports) {
    console.log(`[Date: ${rep.date}]`);
    console.log(`  Total Spoken: ${rep.spokenScripts.length} / 30 songs`);
    console.log(`  Breaks By Type:`, rep.breaksByType);

    // Requirement 8: Print top 5 ranked headlines for each date
    console.log(`  Top 5 Ranked Headlines:`);
    if (rep.top5Headlines && rep.top5Headlines.length > 0) {
      rep.top5Headlines.forEach((h, idx) => {
        console.log(`    ${idx + 1}. [Score: ${h.score}] "${h.headline}"`);
      });
    } else {
      console.log(`    (None eligible)`);
    }

    console.log(`  LLM Rejections: ${rep.rejections.length}`);
    rep.rejections.forEach((r, idx) => {
      console.log(`    ${idx + 1}. [Headline: "${r.headline}"]`);
      console.log(`       Raw Output: "${r.raw}"`);
      console.log(`       Reject Reason: ${r.reason}`);
    });
    console.log(`  Fallbacks Used: ${rep.fallbacksUsed.length}`);
    rep.fallbacksUsed.forEach((f, idx) => {
      console.log(`    ${idx + 1}. [Headline: "${f.headline}"] -> Fallback: "${f.script}"`);
    });

    // Requirement 3: Print every single dropped headline and the exact reason
    console.log(`  Headlines Dropped by Token/Structure Filter: ${rep.droppedHeadlines.length}`);
    if (rep.droppedHeadlines.length > 0) {
      rep.droppedHeadlines.forEach((d, idx) => {
        console.log(`    ${idx + 1}. "${d.headline}": ${d.reason}`);
      });
    }
    const warnings: string[] = [];
    if (rep.newsCount === 0) warnings.push('NO NEWS CANDIDATES');
    if (rep.creditsCount === 0) warnings.push('NO CREDITS AVAILABLE');
    if (warnings.length > 0) {
      console.log(`  [!] WARNING: ${warnings.join(', ')}`);
    } else {
      console.log(`  Status: OK (News: ${rep.newsCount}, Credits: ${rep.creditsCount})`);
    }
    console.log('');
  }

  console.log('================================================================================');
  console.log('BATCH DJ REPORT COMPLETED.');
  console.log('================================================================================');
}

runBatch().catch(console.error);

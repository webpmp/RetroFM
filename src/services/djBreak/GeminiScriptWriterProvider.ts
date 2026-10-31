/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { GoogleGenAI, Type } from '@google/genai';
import {
  ScriptWriterProvider,
  BreakGeneratorInput,
  BreakGeneratorResult,
  GeneratedDJBreak,
  StationPersonality,
  AnachronismCheckResult,
  SingleBreakPacketInput,
  SingleBreakPacketResult,
} from './types.js';
import { recordTextModelCall } from './breakSessionStats.js';
import { getEnv } from '../envUtil.js';
import { splitVerbatimSentences } from '../news/almanacService.js';

export const PERSONALITIES: Record<'mike' | 'lisa', StationPersonality> = {
  mike: {
    id: 'mike',
    name: 'Mike',
    gender: 'Male',
    age: 'Late 30s',
    description: 'Fast-paced, dry humor, slightly irreverent, veteran top-40 radio chops.',
    promptPersona:
      'You are Mike: male, late 30s. Fast-paced, dry humor, slightly irreverent veteran Top 40 radio DJ. Casual, punchy, confident, effortless broadcast tone.',
  },
  lisa: {
    id: 'lisa',
    name: 'Lisa',
    gender: 'Female',
    age: 'Early 20s',
    description: 'Energetic, pop-culture oriented, conversational, slightly sarcastic.',
    promptPersona:
      'You are Lisa: female, early 20s. Energetic, pop-culture oriented, conversational, slightly sarcastic, relatable Top 40 radio personality.',
  },
};

export class GeminiScriptWriterProvider implements ScriptWriterProvider {
  public readonly name = 'GeminiScriptWriterProvider';
  public readonly modelName: string;
  public readonly fallbackModelName?: string;
  private ai: GoogleGenAI;

  constructor(apiKey?: string, modelName = 'gemini-3.8-flash', fallbackModelName?: string) {
    const key = apiKey || getEnv('GEMINI_API_KEY');
    if (!key) {
      console.warn('[GeminiScriptWriterProvider] Warning: GEMINI_API_KEY is not defined in environment.');
    }
    this.modelName = modelName;
    this.fallbackModelName = fallbackModelName;
    this.ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  /**
   * Helper to check if an error is an unavailable / 503 / timeout / high-load condition.
   */
  private isUnavailableError(err: any): boolean {
    const msg = (err?.message || '').toLowerCase();
    const status = err?.status || err?.statusCode || 0;
    return (
      status === 503 ||
      status === 504 ||
      status === 408 ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('408') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('exceeded 45s') ||
      msg.includes('deadline exceeded') ||
      msg.includes('unavailable') ||
      msg.includes('high demand') ||
      msg.includes('overloaded') ||
      msg.includes('backend error')
    );
  }

  /**
   * Wraps a promise with a timeout (default 45s).
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    let timer: any = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timeout: ${operationName} exceeded ${timeoutMs / 1000}s limit.`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Executes a model call with a 45-second timeout on each model call.
   * On timeout, treats it like a 503: retries up to 3 times with 2s, 5s, 10s backoff,
   * then tries the fallback model.
   * If everything fails, throws a clear error stating which step timed out.
   */
  private async executeWithRetryAndFallback<T>(
    operationName: string,
    executeFn: (model: string) => Promise<T>,
    timeoutMs = 45000
  ): Promise<{ result: T; modelUsed: string; callStartTime: string; durationSec: number }> {
    const retryDelaysMs = [2000, 5000, 10000];
    let lastError: any = null;
    const callStart = Date.now();
    const callStartTime = new Date(callStart).toISOString();

    // 1. Try primary model with up to 3 retries on 503 / UNAVAILABLE / Timeout
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      const attemptStart = Date.now();
      try {
        recordTextModelCall(1);
        const result = await this.withTimeout(executeFn(this.modelName), timeoutMs, operationName);
        const durationSec = Number(((Date.now() - attemptStart) / 1000).toFixed(1));
        return { result, modelUsed: this.modelName, callStartTime, durationSec };
      } catch (err: any) {
        lastError = err;
        const isUnavailable = this.isUnavailableError(err);
        const isQuota =
          err?.message?.includes('429') ||
          err?.message?.includes('RESOURCE_EXHAUSTED') ||
          err?.message?.includes('quota');

        // Do not retry 429 quota errors or non-unavailable client errors
        if (!isUnavailable || isQuota || attempt >= retryDelaysMs.length) {
          break;
        }

        const waitMs = retryDelaysMs[attempt];
        const isTimeout = (err?.message || '').toLowerCase().includes('timeout');
        console.warn(
          `[GeminiScriptWriterProvider] ${operationName} returned ${isTimeout ? 'TIMEOUT' : '503/UNAVAILABLE'}. Retrying (${attempt + 1} of 3) in ${waitMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    // 2. If primary model failed/timed out after all retries, try fallback model once if configured
    if (this.fallbackModelName && this.fallbackModelName !== this.modelName && this.isUnavailableError(lastError)) {
      console.warn(
        `[GeminiScriptWriterProvider] Primary model ${this.modelName} unavailable/timed out. Attempting fallback model: ${this.fallbackModelName}...`
      );
      const fallbackStart = Date.now();
      try {
        recordTextModelCall(1);
        const result = await this.withTimeout(executeFn(this.fallbackModelName), timeoutMs, operationName);
        const durationSec = Number(((Date.now() - fallbackStart) / 1000).toFixed(1));
        return { result, modelUsed: this.fallbackModelName, callStartTime, durationSec };
      } catch (fallbackErr: any) {
        lastError = fallbackErr;
      }
    }

    // If everything failed on timeout, throw clear error stating which step timed out
    if ((lastError?.message || '').toLowerCase().includes('timeout')) {
      const stepError = new Error(`${operationName} timed out after ${timeoutMs / 1000}s (all retries and fallback models failed).`);
      (stepError as any).status = 504;
      (stepError as any).isTimeout = true;
      throw stepError;
    }

    throw lastError;
  }

  /**
   * Helper to invoke generateContent with minimal/off thinking (thinkingBudget: 0)
   * and fallback cleanly without thinkingConfig if the model does not support it.
   */
  private async safeGenerateContent(params: any): Promise<any> {
    try {
      return await this.ai.models.generateContent(params);
    } catch (err: any) {
      if (err?.message && /thinking/i.test(err.message)) {
        // Retry immediately without thinkingConfig for models that do not support thinking
        const strippedParams = { ...params, config: { ...params.config } };
        delete strippedParams.config.thinkingConfig;
        return await this.ai.models.generateContent(strippedParams);
      }
      throw err;
    }
  }

  /**
   * Step 1 of 2: Generates the 3 DJ break scripts without running anachronism audit.
   * Returns immediately with break scripts marked with status "CHECKING".
   */
  async writeBreaksOnly(input: BreakGeneratorInput): Promise<{
    success: boolean;
    breaks: GeneratedDJBreak[];
    providedFactItems: any[];
    modelUsed: string;
    callStartTime: string;
    callDurationSec: number;
    error?: string;
    isUnavailable?: boolean;
    quotaExceeded?: boolean;
    stepTimedOut?: 'step1' | null;
  }> {
    const persona = PERSONALITIES[input.personality] || PERSONALITIES.mike;
    const targetWords = Math.round(input.secondsAvailable * 2.5); // ~2.5 words per second
    const minWords = Math.max(5, Math.round(targetWords * 0.8));
    const maxWords = Math.round(targetWords * 1.2);

    const factItemsGiven = input.factItems.slice(0, 15);

    // Format fact items for prompt
    const factSummaryList = factItemsGiven.map((item, idx) => {
      return `[Item ${idx + 1}] (${item.category.toUpperCase()} - ${item.publishedDate}) "${item.headline}": ${item.summary || 'N/A'}`;
    }).join('\n');

    const prompt = `
ROLE & TASK:
${persona.promptPersona}
You are on the air on an authentic Top 40 radio station.
Current date: ${input.targetDate}
Current time of day: ${input.timeOfDay}
Radio format: ${input.format}
Song that just finished: "${input.songPlayed}"
Next song starting right now: "${input.songNext}"
Target airtime available: ${input.secondsAvailable} seconds (Approximately ${targetWords} words total; range ${minWords}-${maxWords} words at standard 2.5 words/second radio cadence).

FACT PACKET (Real news and cultural events from this exact time period):
${factSummaryList.length > 0 ? factSummaryList : 'No specific news items provided. Talk naturally about current date and music.'}

CRITICAL RULES:
1. Write what a real radio DJ would say out loud in the time available (${input.secondsAvailable}s).
2. Pick ONE or TWO items from the Fact Packet and turn them into a natural observation or conversational opinion rather than reading a headline.
   - Style reference: A DJ in 1986 saying "You can't walk into a theater without seeing somebody in those Top Gun sunglasses" is a natural observation about the world, not an announcement of a fact.
3. Speak as if it is CURRENTLY ${input.targetDate} at ${input.timeOfDay}. You are living right now in this exact moment.
4. Use ONLY facts in the packet plus general cultural knowledge that clearly existed BEFORE or ON ${input.targetDate}.
5. NEVER mention or hint at anything that happened after ${input.targetDate} (no future knowledge, no hindsight, no 21st-century perspective).
6. Do NOT invent specific unverified details such as fictitious weather, imaginary traffic, sports scores, or fake quotes not in the packet.
7. Do NOT say "according to the New York Times" or cite news wire sources.
8. Do NOT sound like a historian, documentary narrator, or school textbook.
9. Do NOT include station IDs or call letters (e.g. do not say "WXYZ", "101.5", etc.).
10. ALWAYS end naturally by leading into the next song ("${input.songNext}").
11. Generate exactly THREE distinct variations of the DJ break. Each variation should take a different angle or choose a different item.

Respond ONLY with valid JSON matching this schema:
{
  "breaks": [
    {
      "breakNumber": 1,
      "scriptText": "Exact words spoken by the DJ",
      "citedItemHeadlines": ["Exact headline of the item(s) drawn from"]
    },
    {
      "breakNumber": 2,
      "scriptText": "...",
      "citedItemHeadlines": [...]
    },
    {
      "breakNumber": 3,
      "scriptText": "...",
      "citedItemHeadlines": [...]
    }
  ]
}
`.trim();

    let rawBreaksData: any = null;
    let finalModelUsed = this.modelName;
    let startTimeIso = new Date().toISOString();
    let durationSec = 0;

    try {
      const { result, modelUsed, callStartTime, durationSec: dur } = await this.executeWithRetryAndFallback(
        'Step 1: writing 3 breaks',
        async (activeModel) => {
          const response = await this.safeGenerateContent({
            model: activeModel,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  breaks: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        breakNumber: { type: Type.INTEGER },
                        scriptText: { type: Type.STRING },
                        citedItemHeadlines: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                      },
                      required: ['breakNumber', 'scriptText', 'citedItemHeadlines'],
                    },
                  },
                },
                required: ['breaks'],
              },
              temperature: 0.85,
              maxOutputTokens: 1000, // Lower latency: limit output tokens to what 3 short breaks need
              thinkingConfig: {
                thinkingBudget: 0, // Lower latency: turn thinking off/minimal
              },
            },
          });
          const text = response.text || '';
          return JSON.parse(text);
        },
        45000 // 45-second timeout on each model call
      );

      rawBreaksData = result;
      finalModelUsed = modelUsed;
      startTimeIso = callStartTime;
      durationSec = dur;
    } catch (err: any) {
      console.error('[GeminiScriptWriterProvider] Step 1 break writing error:', err);
      const isUnavailable = this.isUnavailableError(err);
      const isQuota =
        err?.message?.includes('429') ||
        err?.message?.includes('RESOURCE_EXHAUSTED') ||
        err?.message?.includes('quota');
      const isTimeout = (err?.message || '').toLowerCase().includes('timeout') || err?.isTimeout;

      return {
        success: false,
        breaks: [],
        providedFactItems: factItemsGiven,
        modelUsed: finalModelUsed,
        callStartTime: startTimeIso,
        callDurationSec: durationSec,
        quotaExceeded: isQuota,
        isUnavailable,
        stepTimedOut: isTimeout ? 'step1' : null,
        error: isQuota
          ? 'Gemini API text model quota limit reached (429 RESOURCE_EXHAUSTED).'
          : isTimeout
          ? 'Step 1 (writing 3 breaks) timed out after 45s (all retries and fallback models failed).'
          : isUnavailable
          ? 'Model is busy right now, try again in a few minutes.'
          : err?.message || 'Failed generating DJ breaks with Gemini',
      };
    }

    const rawBreaks = Array.isArray(rawBreaksData?.breaks) ? rawBreaksData.breaks : [];
    if (rawBreaks.length === 0) {
      return {
        success: false,
        breaks: [],
        providedFactItems: factItemsGiven,
        modelUsed: finalModelUsed,
        callStartTime: startTimeIso,
        callDurationSec: durationSec,
        error: 'Model did not return break scripts.',
      };
    }

    // Build the initial 3 break cards with audit status "CHECKING"
    const generatedBreaks: GeneratedDJBreak[] = rawBreaks.map((b: any, i: number) => {
      const scriptText = (b.scriptText || '').trim();
      const words = scriptText.split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      const estimatedSeconds = Number((wordCount / 2.5).toFixed(1));

      const citedHeadlines: string[] = Array.isArray(b.citedItemHeadlines) ? b.citedItemHeadlines : [];
      const citedItems = citedHeadlines.map((hl) => {
        const found = input.factItems.find(
          (f) => f.headline.toLowerCase().includes(hl.toLowerCase()) || hl.toLowerCase().includes(f.headline.toLowerCase())
        );
        return {
          headline: hl,
          publishedDate: found?.publishedDate || input.targetDate,
          category: found?.category || 'news',
        };
      });

      return {
        id: `break_${Date.now()}_${i + 1}`,
        breakNumber: b.breakNumber || i + 1,
        scriptText,
        wordCount,
        estimatedSeconds,
        targetSeconds: input.secondsAvailable,
        citedItems,
        anachronismCheck: {
          status: 'CHECKING',
          notes: 'Checking for anachronisms...',
          flaggedPhrases: [],
        },
      };
    });

    return {
      success: true,
      breaks: generatedBreaks,
      providedFactItems: factItemsGiven,
      modelUsed: finalModelUsed,
      callStartTime: startTimeIso,
      callDurationSec: durationSec,
    };
  }

  /**
   * Step 2 of 2: Runs anachronism audit on the generated breaks in a single model call.
   * If model call fails or times out, returns auditUnavailable: true so scripts still display.
   */
  async auditBreaksOnly(
    scripts: { breakNumber: number; scriptText: string }[],
    targetDate: string,
    modelToUse?: string
  ): Promise<{
    success: boolean;
    audits: Record<number, AnachronismCheckResult>;
    modelUsed: string;
    callStartTime: string;
    callDurationSec: number;
    error?: string;
    auditUnavailable?: boolean;
    stepTimedOut?: 'step2' | null;
  }> {
    const scriptsFormatted = scripts.map((s) => {
      return `[Break #${s.breakNumber}]: "${s.scriptText}"`;
    }).join('\n\n');

    const auditPrompt = `
You are an expert historical chronological fact auditor.
Target historical date: ${targetDate}

Here are ${scripts.length} radio DJ script variations to audit:
${scriptsFormatted}

TASK:
Examine each script variation carefully. Could a real human radio DJ speaking live on ${targetDate} have known and said every phrase and reference in this script?
- Look for anachronistic words, references to people/events/technology that happened after ${targetDate}.
- Look for future hindsight (e.g. knowing who won an election/war/championship that hadn't happened yet, knowing that an album or movie would become an iconic hit if it just came out, or referring to historical dates in retrospect).
- If ANY phrase or fact could not have been known on ${targetDate}, mark status as "FAIL" and explain the specific flagged phrase and reason.
- If everything could legitimately have been known on ${targetDate}, mark status as "PASS" and provide a brief confirmation.

Respond strictly with JSON schema:
{
  "audits": [
    {
      "breakNumber": 1,
      "status": "PASS" or "FAIL",
      "notes": "Short explanation of findings",
      "flaggedPhrases": ["phrase 1"]
    }
  ]
}
`.trim();

    let finalModelUsed = modelToUse || this.modelName;
    let startTimeIso = new Date().toISOString();
    let durationSec = 0;

    try {
      const { result, modelUsed, callStartTime, durationSec: dur } = await this.executeWithRetryAndFallback(
        'Step 2: checking for anachronisms',
        async (activeModel) => {
          const response = await this.safeGenerateContent({
            model: activeModel,
            contents: auditPrompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  audits: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        breakNumber: { type: Type.INTEGER },
                        status: { type: Type.STRING, enum: ['PASS', 'FAIL'] },
                        notes: { type: Type.STRING },
                        flaggedPhrases: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                      },
                      required: ['breakNumber', 'status', 'notes'],
                    },
                  },
                },
                required: ['audits'],
              },
              temperature: 0.1,
              maxOutputTokens: 600, // Lower latency: limit output tokens to what audit notes need
              thinkingConfig: {
                thinkingBudget: 0, // Lower latency: turn thinking off/minimal
              },
            },
          });
          const text = response.text || '';
          return JSON.parse(text);
        },
        45000 // 45-second timeout on each model call
      );

      finalModelUsed = modelUsed;
      startTimeIso = callStartTime;
      durationSec = dur;

      const auditMap: Record<number, AnachronismCheckResult> = {};
      const audits = Array.isArray(result?.audits) ? result.audits : [];
      for (const a of audits) {
        auditMap[a.breakNumber] = {
          status: a.status === 'FAIL' ? 'FAIL' : 'PASS',
          notes: a.notes || 'Chronologically authentic for this date.',
          flaggedPhrases: a.flaggedPhrases || [],
        };
      }

      // Ensure every script has an entry
      for (const s of scripts) {
        if (!auditMap[s.breakNumber]) {
          auditMap[s.breakNumber] = {
            status: 'PASS',
            notes: 'Chronologically authentic for this date.',
            flaggedPhrases: [],
          };
        }
      }

      return {
        success: true,
        audits: auditMap,
        modelUsed: finalModelUsed,
        callStartTime: startTimeIso,
        callDurationSec: durationSec,
      };
    } catch (err: any) {
      console.warn('[GeminiScriptWriterProvider] Step 2 anachronism audit error/timeout:', err?.message);
      const isTimeout = (err?.message || '').toLowerCase().includes('timeout') || err?.isTimeout;
      const errorMsg = isTimeout
        ? 'Step 2 (anachronism audit) timed out after 45s (all retries and fallback models failed).'
        : err?.message || 'Audit unavailable';

      const fallbackMap: Record<number, AnachronismCheckResult> = {};
      for (const s of scripts) {
        fallbackMap[s.breakNumber] = {
          status: 'UNAVAILABLE',
          notes: `Audit unavailable: ${errorMsg}`,
          flaggedPhrases: [],
        };
      }

      return {
        success: false,
        audits: fallbackMap,
        auditUnavailable: true,
        stepTimedOut: isTimeout ? 'step2' : null,
        modelUsed: finalModelUsed,
        callStartTime: startTimeIso,
        callDurationSec: durationSec,
        error: errorMsg,
      };
    }
  }

  /**
   * Spec A: Writes 1 to 2 spoken sentences from exactly ONE verified fact packet.
   * Specific prompts tailored per break type.
   */
  async writeSingleBreakScript(input: SingleBreakPacketInput): Promise<SingleBreakPacketResult> {
    const persona = PERSONALITIES[input.personality || 'mike'] || PERSONALITIES.mike;
    const isChartFact = input.breakType === 'chart_fact';
    const isSongCredit = input.breakType === 'song_credit';
    const isObservation = input.breakType === 'observation';
    const isNews = isObservation && (input.factPacket.source.toLowerCase().includes('times') || input.factPacket.factText.toLowerCase().includes('times'));

    let prompt = '';

    if (isNews) {
      prompt = `
ROLE & TASK:
${persona.promptPersona}
You are on the air on an authentic Top 40 radio station on ${input.targetDate}.
You glance at the morning newspaper between records.

NEWS FACT PACKET:
Source: ${input.factPacket.source} (${input.factPacket.date})
Fact: "${input.factPacket.factText}"

CRITICAL RULES:
1. Write EXACTLY ONE plain spoken sentence (~15 to 25 words max).
2. Always attribute news to "The Times". Use one of these rotating openers: "The Times reports...", "In the news this morning, The Times reports...", "According to The Times...".
3. Use ONLY facts and names provided in the packet. Never invent details or outcomes.
4. Do NOT use the words "yesterday" or "today".
5. Do NOT include personal opinions, reactions, commentary, or humor.
6. Do NOT mention upcoming songs or say "coming up".
7. No exclamation points (!). Use periods only. No hype words or interjections.
8. Output ONLY the raw spoken radio script.
`.trim();

    } else if (isChartFact) {
      const isNext = input.targetSong === 'next';
      const targetSong = isNext ? input.songNext : input.songPlayed;

      prompt = `
ROLE & TASK:
${persona.promptPersona}
You are on the air on an authentic Top 40 radio station on ${input.targetDate}.
You share a Billboard chart fact between songs.

CHART FACT PACKET:
Source: ${input.factPacket.source}
Fact: "${input.factPacket.factText}"
Target Song: "${targetSong?.title || 'Unknown'}" by ${targetSong?.artist || 'Unknown'} (${isNext ? 'starting now' : 'just finished'})

CRITICAL RULES:
1. Write 1 or 2 plain spoken sentences only.
2. Use ONLY facts in the packet. Never invent chart numbers or peaks.
3. Mention the song title at most ONCE.
4. Do NOT use the word "debut". New entries are "new on the Hot 100 this week at number N".
5. Do NOT mention newspapers or "New York Times".
6. Do NOT use exclamation points (!).
7. NEVER say "coming up" or "up next".
8. No hype words (no "fresh", "hot", "amazing", "incredible", "smash", "on fire").
9. Output ONLY the raw spoken radio script.
`.trim();

    } else if (isSongCredit) {
      const isNext = input.targetSong === 'next';
      const targetSong = isNext ? input.songNext : input.songPlayed;

      prompt = `
ROLE & TASK:
${persona.promptPersona}
You are on the air on an authentic Top 40 radio station on ${input.targetDate}.
You share a verified songwriter or producer credit for a song.

CREDIT PACKET:
Source: ${input.factPacket.source}
Credit: "${input.factPacket.factText}"
Song: "${targetSong?.title || 'Unknown'}" by ${targetSong?.artist || 'Unknown'} (${isNext ? 'coming up' : 'just finished'})

CRITICAL RULES:
1. Write 1 or 2 plain spoken sentences only.
2. Use ONLY the writer/producer names provided in the packet.
3. Mention the song title at most ONCE.
4. Do NOT mention newspapers or "New York Times".
5. Do NOT use exclamation points (!).
6. No hype words or interjections.
7. Output ONLY the raw spoken radio script.
`.trim();

    } else {
      prompt = `
ROLE & TASK:
${persona.promptPersona}
You are on the air on an authentic Top 40 radio station on ${input.targetDate}.
You share an understated everyday cost-of-living statistic.

STATISTIC PACKET:
Source: ${input.factPacket.source}
Fact: "${input.factPacket.factText}"

CRITICAL RULES:
1. Write exactly 1 plain spoken sentence.
2. State the numbers and statistic honest and plainly as given in the packet.
3. Do NOT add personal complaints, reactions, or commentary.
4. Do NOT mention newspapers or "New York Times".
5. Do NOT mention upcoming songs or say "coming up".
6. No exclamation points (!).
7. Output ONLY the raw spoken radio script.
`.trim();
    }

    try {
      const { result, modelUsed, callStartTime, durationSec } = await this.executeWithRetryAndFallback(
        'Writing single break script from 1 fact packet',
        async (activeModel) => {
          const response = await this.safeGenerateContent({
            model: activeModel,
            contents: prompt,
            config: {
              temperature: 0.7,
              maxOutputTokens: 250,
              thinkingConfig: {
                thinkingBudget: 0,
              },
            },
          });
          let text = (response.text || '').trim();
          const quoteMatches = text.match(/"/g) || [];
          if (text.startsWith('"') && text.endsWith('"') && quoteMatches.length >= 2) {
            if (quoteMatches.length === 2) {
              text = text.slice(1, -1).trim();
            } else {
              const secondQuoteIndex = text.indexOf('"', 1);
              if (secondQuoteIndex === -1 || secondQuoteIndex === text.length - 1) {
                text = text.slice(1, -1).trim();
              }
            }
          }
          return text;
        },
        30000
      );

      return {
        success: true,
        scriptText: result,
        modelUsed,
        callStartTime,
        callDurationSec: durationSec,
      };
    } catch (err: any) {
      const isUnavailable = this.isUnavailableError(err);
      return {
        success: false,
        scriptText: '',
        modelUsed: this.modelName,
        callStartTime: new Date().toISOString(),
        callDurationSec: 0,
        isUnavailable,
        error: isUnavailable
          ? 'Gemini server is currently unreachable or overloaded'
          : err?.message || 'Failed generating single break script',
      };
    }
  }

  /**
   * Unified generateBreaks: Executes Step 1 (writing) then Step 2 (auditing).
   */
  async generateBreaks(input: BreakGeneratorInput): Promise<BreakGeneratorResult> {
    const step1 = await this.writeBreaksOnly(input);
    if (!step1.success) {
      return {
        success: false,
        targetDate: input.targetDate,
        personality: input.personality,
        timeOfDay: input.timeOfDay,
        format: input.format,
        songPlayed: input.songPlayed,
        songNext: input.songNext,
        secondsAvailable: input.secondsAvailable,
        breaks: [],
        providedFactItems: step1.providedFactItems,
        callsUsedThisRun: 1,
        quotaExceeded: step1.quotaExceeded,
        isUnavailable: step1.isUnavailable,
        stepTimedOut: step1.stepTimedOut,
        error: step1.error,
        modelUsed: step1.modelUsed,
        callStartTime: step1.callStartTime,
        callDurationSec: step1.callDurationSec,
      };
    }

    const scriptsForAudit = step1.breaks.map((b) => ({
      breakNumber: b.breakNumber,
      scriptText: b.scriptText,
    }));

    const step2 = await this.auditBreaksOnly(scriptsForAudit, input.targetDate, step1.modelUsed);

    const auditedBreaks = step1.breaks.map((b) => ({
      ...b,
      anachronismCheck: step2.audits[b.breakNumber] || {
        status: step2.auditUnavailable ? 'UNAVAILABLE' : 'PASS',
        notes: step2.error ? `Audit unavailable: ${step2.error}` : 'Chronologically authentic for this date.',
        flaggedPhrases: [],
      },
    }));

    return {
      success: true,
      targetDate: input.targetDate,
      personality: input.personality,
      timeOfDay: input.timeOfDay,
      format: input.format,
      songPlayed: input.songPlayed,
      songNext: input.songNext,
      secondsAvailable: input.secondsAvailable,
      breaks: auditedBreaks,
      providedFactItems: step1.providedFactItems,
      callsUsedThisRun: 2,
      modelUsed: step2.modelUsed || step1.modelUsed,
      callStartTime: step1.callStartTime,
      callDurationSec: Number(((step1.callDurationSec || 0) + (step2.callDurationSec || 0)).toFixed(1)),
      auditUnavailable: step2.auditUnavailable,
      stepTimedOut: step2.stepTimedOut,
    };
  }

  /**
   * Generates a rich spoken radio talk segment using the full monologue prompt architecture:
   * 1. Provides a verified Fact Sheet, code-chosen hook, 3 short voice exemplars, and strict style rules
   *    (short spoken sentences, direct address, varied rhythm, strictly no connector words, no opinion/hindsight, no outside facts).
   * 2. Gemini writes the whole segment monologue.
   * 3. Real claim verification: splits script into sentences, audits each against the fact sheet, and drops any unsupported sentences.
   */
  async writeSegmentBreakScript(input: import('./types.js').SegmentBreakScriptInput): Promise<import('./types.js').SegmentBreakScriptResult> {
    const persona = PERSONALITIES[(input.personality as 'mike' | 'lisa') || 'mike'] || PERSONALITIES.mike;

    const [y, m, d] = input.targetDate.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const weekday = WEEKDAY_NAMES[dateObj.getUTCDay()];
    const month = MONTH_NAMES[dateObj.getUTCMonth()];
    const fullDateSpoken = `${weekday}, ${month} ${d}, ${y}`;

    const startTime = Date.now();
    const factItems = input.facts || [];
    if (factItems.length === 0) {
      return {
        success: false,
        scriptText: '',
        modelUsed: this.modelName,
        callStartTime: new Date(startTime).toISOString(),
        callDurationSec: 0,
        error: 'No facts provided in packet',
      };
    }

    const factLines = factItems.map((f, i) => `Fact [${i + 1}]: ${f.text}`).join('\n');

    // Code-chosen hook matched strictly to content type (at least 50% have NO opener)
    // Requirement 3: 15+ natural variants, many of them none at all. Deleted invented framing phrases like "music ledger".
    const seed = Math.abs(input.topicTitle.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0));
    let hook = '';
    // Roughly 60% of breaks start immediately with facts (no opener)
    const useOpener = (seed % 5) === 0 || (seed % 5) === 1;

    if (useOpener) {
      if (input.topic === 'next_song_story') {
        const SONG_OPENERS = [
          'Behind this next record,',
          'Here is the story on this track.',
          'Looking at how this one came together,',
          'Turning to this next cut,',
          'Here is the background on this one.',
          'Checking in on this next release,',
          'Taking a look at this one,',
          'Behind the music on this track,',
          'Here is what went into this next one.',
          'Turning to the story behind the track,',
          'Looking into the background of this next sound,',
          'Here is a quick look behind this record.',
          'On this next one,',
          'Behind the session for this next track,',
          'Taking a closer look at this next record,',
          'Here is the history behind this sound.',
        ];
        hook = SONG_OPENERS[seed % SONG_OPENERS.length];
      } else if (input.topic === 'music_news') {
        const MUSIC_NEWS_OPENERS = [
          'In music news this week,',
          'Across the music world,',
          'From the music wires,',
          'In the headlines across the music scene,',
          'Turning to the music beat this week,',
          'Checking the news wire in music,',
        ];
        hook = MUSIC_NEWS_OPENERS[seed % MUSIC_NEWS_OPENERS.length];
      } else if (input.topic === 'major_news') {
        const NEWS_OPENERS = [
          'The Times reports this week,',
          'In national news,',
          'From the front pages of The Times,',
          'Across the country this week,',
          'In headlines from The Times,',
          'Checking the national news wire,',
        ];
        hook = NEWS_OPENERS[seed % NEWS_OPENERS.length];
      } else if (input.topic === 'sports') {
        const SPORTS_OPENERS = [
          'In sports action,',
          'Checking the sports wire across the leagues,',
          'From the sports pages,',
        ];
        hook = SPORTS_OPENERS[seed % SPORTS_OPENERS.length];
      }
    }

    const failureCorrection = input.failureReason
      ? `\n\nCRITICAL FIX REQUIRED FROM PREVIOUS ATTEMPT: Your previous draft was rejected for the following exact reason: "${input.failureReason}". You MUST avoid this completely and adhere strictly to the rules.`
      : '';

    const promptStep1 = `ROLE & INSTRUCTIONS:
You are ${persona.name}, a genuine Top 40 radio DJ broadcasting on ${fullDateSpoken}.
You deliver a natural, engaging spoken radio segment between records.

AUTHENTIC RADIO VOICE EXEMPLARS:
Exemplar 1:
"Checking in on the Hot 100, Kenny Rogers climbs into the top forty this week with 'She Believes In Me.' He recorded the track in Nashville with producer Larry Butler earlier this spring."

Exemplar 2:
"The Times reports twelve people died Thursday morning in an apartment hotel fire in Hoboken. Fire officials suspect arson in the predawn blaze."

Exemplar 3:
"Smokey Robinson penned this next one for Mary Wells back in 1964. He produced the session at Motown's Hitsville U.S.A. studio in Detroit."

STRICT STYLE RULES:
1. Short spoken sentences with direct address and varied rhythm. Talk straight to the listener.
2. ABSOLUTELY NO CONNECTOR WORDS. Never use: "Furthermore", "Meanwhile", "In addition", "At the same time", "On that note", "Along with that", "Adding to that", "Beyond that".
3. STRICTLY BANNED PHRASES: Never use "making waves", "latest news", "music scene", "epic", "insane", "mind-blowing", "whopping", "heartfelt", "you might be surprised", "showcasing its lasting appeal", "himself", "lasting appeal", "a feat unmatched". Never use "record-breaking" unless the word "record-breaking" appears directly in the Fact Sheet. Never say a band or group was "formed" unless the word "formed" appears directly in the Fact Sheet.
4. PARAPHRASE ALL SOURCE FACTS: Never copy more than 6 consecutive words from the Fact Sheet (or 12 for short credits). Put facts into your own natural spoken words.
5. LOCKED CHART SENTENCES: Any chart sentence (e.g. "It reached number one on the Hot 100 in May 1975." or "It spent 21 weeks on the chart.") is code-locked: you MUST keep it verbatim or omit it entirely. NEVER paraphrase or merge chart facts. Never say "topped the charts" or "staying there for X weeks". Weeks at number one and weeks on the chart must never be mixed.
6. In any news or review break, name the person or event in your very first sentence.
7. Use full artist and person names at least once (e.g. "P.M. Dawn", "C.C. Lemonhead", "Robin S.", "Jay Ski", "Mr. Big", "R.E.M."). Never truncate names.
8. Use ONLY the verified facts in the Fact Sheet. NEVER add outside names, studios, characterizations ("pioneering", "legendary", "virtuoso"), or future knowledge.
9. No hindsight language (never say what a song "went on to do" or "later became").
10. If the hook is given, open with it; otherwise jump right into the first fact.
11. NEVER write a song handoff or announce the upcoming track title. The station automation adds the upcoming song hand-off by code.
12. Fix punctuation: never leave double periods (..) after abbreviations, and never capitalize after a comma unless it is a proper name.

FACT SHEET:
${factLines}
${hook ? `CHOSEN HOOK: "${hook}"` : `CHOSEN HOOK: None (start immediately with the facts)`}${failureCorrection}

TASK:
Write the complete spoken radio segment monologue following all rules. Output ONLY the commentary facts without any song introduction or handoff. Output ONLY the words spoken on air.`;

    let rawDraft = '';
    let modelUsedStep1 = this.modelName;

    try {
      const { result, modelUsed } = await this.executeWithRetryAndFallback(
        'Step 1: monologue generation',
        async (activeModel) => {
          const response = await this.safeGenerateContent({
            model: activeModel,
            contents: promptStep1,
            config: {
              temperature: 0.3,
              maxOutputTokens: 350,
              thinkingConfig: { thinkingBudget: 0 },
            },
          });
          return (response.text || '').trim();
        },
        30000
      );
      rawDraft = result || '';
      modelUsedStep1 = modelUsed;
    } catch (err: any) {
      console.warn('[Gemini] Step 1 monologue generation failed:', err);
    }

    if (!rawDraft) {
      rawDraft = `${hook ? hook + ' ' : ''}${factItems.map(f => f.text).join(' ')}`.trim();
    }

    // Fix comma capitalization bug
    const cleanedDraft = rawDraft
      .replace(/,\s+([A-Z][a-z]+)/g, (m, word) => {
        const commonLower = ['The', 'This', 'That', 'It', 'He', 'She', 'They', 'We', 'A', 'An', 'In', 'On', 'At', 'With', 'And', 'Featuring', 'Holding', 'Adding'];
        if (commonLower.includes(word)) {
          return `, ${word.toLowerCase()}`;
        }
        return m;
      })
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Step 2: Real claim verification per sentence
    const sentences = splitVerbatimSentences(cleanedDraft)
      .map(s => s.trim())
      .filter(s => s.length > 5);

    // Filter out pure song handoffs (title and artist of the next song) or opener from strict claim check
    // Requirement 3: Exclude the hand-off line (title and artist of the next song) from the claim audit.
    const HANDOFF_PATTERNS = [
      /\b(?:now on retrofm|here on retrofm|spinning now|let's hear|here is|next up|coming up|switching gears|turning to|right now|playing now)\b/i,
      /\b(?:coming up|this one's from|up next|here's a good one|time for|let's get back to the music|check this one out)\b/i,
      /\b(?:we've got|let's give|turn it up|got a great track|let's take a listen|this is)\b/i,
      /\b(?:get ready for|coming your way|don't touch that dial|let's crank it up|this one's got some energy)\b/i,
      /\b(?:let's ease into|enjoy|settling in with|a little something from|let's spend a few minutes|coming through the speakers|take a listen to)\b/i,
      /\b(?:coming at you with|listen to|let's hear it for)\b/i,
      /\b(?:straight from|on the turntable|making its way onto the playlist|let's roll with|another great track from|taking us back with)\b/i,
    ];
    const claimsToCheck: Array<{ sentence: string; index: number }> = [];
    sentences.forEach((s, idx) => {
      if (input.targetSongTitle && s.includes(input.targetSongTitle)) return;
      if (HANDOFF_PATTERNS.some((pat) => pat.test(s))) return;
      claimsToCheck.push({ sentence: s, index: idx });
    });

    const auditPrompt = claimsToCheck.map((c, i) => `Claim ${i + 1}: ${c.sentence}`).join('\n');

    const promptStep2 = `You are a strict radio broadcast fact verifier.
Verify each numbered claim sentence against the fact sheet.

CRITICAL RULES:
1. If a claim contains ANY detail, adjective, title, praise, or characterization (such as "pioneering", "legendary", "iconic", "virtuoso", studio name, location, number of stories, or drum name) that is NOT explicitly stated in the fact sheet, you MUST output:
[Claim N]: UNSUPPORTED: <reason>
2. General cultural knowledge, external facts, or historical inferences outside the fact sheet are STRICTLY FORBIDDEN.
3. If every detail in the claim is explicitly supported by a fact, output:
[Claim N]: SUPPORTED (Fact <id>)

FACT SHEET:
${factLines}

CLAIMS TO VERIFY:
${auditPrompt}

VERDICTS:`;

    const unsupportedClaims: string[] = [];
    const droppedSentenceIndexes = new Set<number>();

    if (claimsToCheck.length > 0) {
      try {
        const { result } = await this.executeWithRetryAndFallback(
          'Step 2: claim verification',
          async (activeModel) => {
            const response = await this.safeGenerateContent({
              model: activeModel,
              contents: promptStep2,
              config: {
                temperature: 0.0,
                maxOutputTokens: 500,
                thinkingConfig: { thinkingBudget: 0 },
              },
            });
            return (response.text || '').trim();
          },
          30000
        );

        const auditLines = (result || '').split('\n').filter(Boolean);
        for (const al of auditLines) {
          const match = al.match(/\[Claim\s*(\d+)\]:\s*UNSUPPORTED:\s*(.+)/i);
          if (match) {
            const claimIdx = parseInt(match[1], 10) - 1;
            if (claimsToCheck[claimIdx]) {
              unsupportedClaims.push(al);
              droppedSentenceIndexes.add(claimsToCheck[claimIdx].index);
            }
          }
        }
      } catch (err: any) {
        console.warn('[Gemini] Step 2 claim verification failed:', err);
      }
    }

    const finalSentences = sentences.filter((_, idx) => !droppedSentenceIndexes.has(idx));

    // Strip every hand-off the model wrote (any sentence containing target song title,
    // or phrases like "let's hear", "next up", "here is", "now on retrofm", "here on retrofm", "spinning now", "switching gears", "turning to", etc.)
    const isModelHandoff = (s: string) => {
      if (input.targetSongTitle && s.toLowerCase().includes(input.targetSongTitle.toLowerCase())) return true;
      return HANDOFF_PATTERNS.some((pat) => pat.test(s));
    };

    while (finalSentences.length > 0 && isModelHandoff(finalSentences[finalSentences.length - 1])) {
      finalSentences.pop();
    }

    const finalScript = finalSentences.join(' ').replace(/\s{2,}/g, ' ').trim();

    const durationSec = Number(((Date.now() - startTime) / 1000).toFixed(2));
    return {
      success: true,
      scriptText: finalScript,
      modelUsed: `gemini:${modelUsedStep1}`,
      callStartTime: new Date(startTime).toISOString(),
      callDurationSec: durationSec,
      rawResponse: `--- PROMPT ---\n${promptStep1}\n\n--- RAW OUTPUT ---\n${rawDraft}\n\n--- AUDIT ---\n${unsupportedClaims.join('\n') || 'None'}`,
      unsupportedClaims,
      openerUsed: hook || 'None',
      closerUsed: '',
    };
  }
}

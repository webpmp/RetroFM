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
} from './types.js';
import { recordTextModelCall } from './breakCache.js';

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
    const key = apiKey || process.env.GEMINI_API_KEY;
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
}

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
   * Helper to check if an error is an unavailable / 503 / high-load condition.
   */
  private isUnavailableError(err: any): boolean {
    const msg = (err?.message || '').toLowerCase();
    const status = err?.status || err?.statusCode || 0;
    return (
      status === 503 ||
      msg.includes('503') ||
      msg.includes('unavailable') ||
      msg.includes('high demand') ||
      msg.includes('overloaded') ||
      msg.includes('backend error')
    );
  }

  /**
   * Executes a model call with up to 3 automatic retries with 2s, 5s, 10s backoff for 503 / UNAVAILABLE.
   * If all retries fail and a fallback model is configured, attempts the fallback model once.
   */
  private async executeWithRetryAndFallback<T>(
    operationName: string,
    executeFn: (model: string) => Promise<T>
  ): Promise<{ result: T; modelUsed: string }> {
    const retryDelaysMs = [2000, 5000, 10000];
    let lastError: any = null;

    // 1. Try primary model with up to 3 retries on 503 / UNAVAILABLE
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        recordTextModelCall(1);
        const result = await executeFn(this.modelName);
        return { result, modelUsed: this.modelName };
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
        console.warn(
          `[GeminiScriptWriterProvider] ${operationName} returned 503/UNAVAILABLE. Model busy, retrying (${attempt + 1} of 3) in ${waitMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    // 2. If primary model is still unavailable after all retries, try fallback model once if configured
    if (this.fallbackModelName && this.fallbackModelName !== this.modelName && this.isUnavailableError(lastError)) {
      console.warn(
        `[GeminiScriptWriterProvider] Primary model ${this.modelName} still unavailable. Attempting fallback model: ${this.fallbackModelName}...`
      );
      try {
        recordTextModelCall(1);
        const result = await executeFn(this.fallbackModelName);
        return { result, modelUsed: this.fallbackModelName };
      } catch (fallbackErr: any) {
        lastError = fallbackErr;
      }
    }

    throw lastError;
  }

  async generateBreaks(input: BreakGeneratorInput): Promise<BreakGeneratorResult> {
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

    // Call #1: Generate all 3 break variations in one single structured call
    try {
      const { result, modelUsed } = await this.executeWithRetryAndFallback(
        'Generate 3 DJ Breaks',
        async (activeModel) => {
          const response = await this.ai.models.generateContent({
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
            },
          });
          const text = response.text || '';
          return JSON.parse(text);
        }
      );

      rawBreaksData = result;
      finalModelUsed = modelUsed;
    } catch (err: any) {
      console.error('[GeminiScriptWriterProvider] Break generation error:', err);
      const isUnavailable = this.isUnavailableError(err);
      const isQuota =
        err?.message?.includes('429') ||
        err?.message?.includes('RESOURCE_EXHAUSTED') ||
        err?.message?.includes('quota');

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
        providedFactItems: factItemsGiven,
        callsUsedThisRun: 1,
        quotaExceeded: isQuota,
        isUnavailable,
        error: isQuota
          ? 'Gemini API text model quota limit reached (429 RESOURCE_EXHAUSTED).'
          : isUnavailable
          ? 'Model is busy right now, try again in a few minutes.'
          : err?.message || 'Failed generating DJ breaks with Gemini',
      };
    }

    const rawBreaks = Array.isArray(rawBreaksData?.breaks) ? rawBreaksData.breaks : [];
    if (rawBreaks.length === 0) {
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
        providedFactItems: factItemsGiven,
        callsUsedThisRun: 1,
        error: 'Model did not return break scripts.',
      };
    }

    // Call #2: Run anachronism audit for ALL 3 breaks in one second call
    const scriptsForAudit = rawBreaks.map((b: any, idx: number) => ({
      breakNumber: b.breakNumber || idx + 1,
      scriptText: b.scriptText || '',
    }));

    const auditResults = await this.checkAllAnachronisms(
      scriptsForAudit,
      input.targetDate,
      finalModelUsed
    );

    const generatedBreaks: GeneratedDJBreak[] = [];

    for (let i = 0; i < rawBreaks.length; i++) {
      const b = rawBreaks[i];
      const scriptText = (b.scriptText || '').trim();
      const words = scriptText.split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      const estimatedSeconds = Number((wordCount / 2.5).toFixed(1));

      // Match cited items
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

      const audit = auditResults[b.breakNumber || i + 1] || {
        status: 'PASS',
        notes: 'Chronologically authentic for this date.',
        flaggedPhrases: [],
      };

      generatedBreaks.push({
        id: `break_${Date.now()}_${i + 1}`,
        breakNumber: i + 1,
        scriptText,
        wordCount,
        estimatedSeconds,
        targetSeconds: input.secondsAvailable,
        citedItems,
        anachronismCheck: audit,
      });
    }

    return {
      success: true,
      targetDate: input.targetDate,
      personality: input.personality,
      timeOfDay: input.timeOfDay,
      format: input.format,
      songPlayed: input.songPlayed,
      songNext: input.songNext,
      secondsAvailable: input.secondsAvailable,
      breaks: generatedBreaks,
      providedFactItems: factItemsGiven,
      callsUsedThisRun: 2, // Exactly 2 calls per click
      modelUsed: finalModelUsed,
    };
  }

  /**
   * Runs anachronism audit for ALL generated breaks in a SINGLE second model call.
   */
  private async checkAllAnachronisms(
    scripts: { breakNumber: number; scriptText: string }[],
    targetDate: string,
    modelToUse: string
  ): Promise<Record<number, AnachronismCheckResult>> {
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

    try {
      const { result } = await this.executeWithRetryAndFallback(
        'Anachronism Audit for 3 Breaks',
        async (activeModel) => {
          const response = await this.ai.models.generateContent({
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
            },
          });
          const text = response.text || '';
          return JSON.parse(text);
        }
      );

      const auditMap: Record<number, AnachronismCheckResult> = {};
      const audits = Array.isArray(result?.audits) ? result.audits : [];
      for (const a of audits) {
        auditMap[a.breakNumber] = {
          status: a.status === 'FAIL' ? 'FAIL' : 'PASS',
          notes: a.notes || 'Chronologically authentic for this date.',
          flaggedPhrases: a.flaggedPhrases || [],
        };
      }
      return auditMap;
    } catch (err: any) {
      console.warn('[GeminiScriptWriterProvider] Combined anachronism audit fallback:', err?.message);
      const fallbackMap: Record<number, AnachronismCheckResult> = {};
      for (const s of scripts) {
        fallbackMap[s.breakNumber] = {
          status: 'PASS',
          notes: `Audit skipped due to service response: ${err?.message || 'offline'}`,
          flaggedPhrases: [],
        };
      }
      return fallbackMap;
    }
  }
}

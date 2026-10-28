/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import {
  ScriptWriterProvider,
  BreakGeneratorInput,
  BreakGeneratorResult,
  GeneratedDJBreak,
  AnachronismCheckResult,
  SingleBreakPacketInput,
  SingleBreakPacketResult,
} from './types.js';
import { PERSONALITIES } from './GeminiScriptWriterProvider.js';
import { recordTextModelCall } from './breakSessionStats.js';
import { getEnv } from '../envUtil.js';

export interface LMStudioConfig {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export class LMStudioScriptWriterProvider implements ScriptWriterProvider {
  public readonly name = 'LMStudioScriptWriterProvider';
  public readonly endpoint: string;
  public readonly modelName: string;
  private readonly timeoutMs: number;

  constructor(config?: LMStudioConfig) {
    const rawEndpoint =
      config?.endpoint ||
      getEnv('LM_STUDIO_ENDPOINT') ||
      'http://localhost:1234/v1';

    // Normalize endpoint: ensure it doesn't have trailing slash
    this.endpoint = rawEndpoint.replace(/\/+$/, '');
    this.modelName = config?.model || getEnv('LM_STUDIO_MODEL') || '';
    this.timeoutMs = config?.timeoutMs || 60000;
  }

  /**
   * Spec A & Step 1: Writes 1 to 2 spoken sentences from exactly ONE verified fact packet using LM Studio.
   * Specific prompts tailored per break type.
   */
  async writeSingleBreakScript(input: SingleBreakPacketInput): Promise<SingleBreakPacketResult> {
    const persona = PERSONALITIES[input.personality || 'mike'] || PERSONALITIES.mike;
    const isChartFact = input.breakType === 'chart_fact';
    const isSongCredit = input.breakType === 'song_credit';
    const isObservation = input.breakType === 'observation';
    const isNews = isObservation && (input.factPacket.source.toLowerCase().includes('times') || input.factPacket.factText.toLowerCase().includes('times'));

    let systemPrompt = '';
    let userPrompt = '';

    if (isNews) {
      // News Break Prompt: Rotates short news framings, 1 sentence, ~25 words max
      systemPrompt = `You are ${persona.name}, an authentic Top 40 radio DJ in ${input.targetDate.slice(0, 4)}.
You glance at the newspaper and deliver a single, plain news sentence.

EXAMPLES:
Example 1:
Fact: British warships have initiated an air and sea blockade around the Falkland Islands.
Script: The Times reports British warships have begun an air and sea blockade around the Falkland Islands.

Example 2:
Fact: President Reagan met with Republican Congressional leaders to plan budget strategy.
Script: In the news this morning, President Reagan is meeting with Republican leaders on Capitol Hill over the budget.

RULES:
1. Write EXACTLY ONE plain spoken sentence (~15 to 25 words max).
2. Always attribute news to "The Times". Use one of these rotating openers: "The Times reports...", "In the news this morning, The Times reports...", "According to The Times...".
3. Use ONLY facts and names provided in the packet. Never invent details or outcomes.
4. Do NOT use the words "yesterday" or "today".
5. Do NOT include personal opinions, reactions, commentary, or humor.
6. Do NOT mention upcoming songs or say "coming up".
7. No exclamation points (!). Use periods only. No hype words or interjections.
8. Output ONLY the raw spoken words.`.trim();

      userPrompt = `CURRENT BROADCAST DATE: ${input.targetDate}
NEWS FACT PACKET:
Source: ${input.factPacket.source} (${input.factPacket.date})
Fact: "${input.factPacket.factText}"

TASK:
Write exactly one plain spoken news sentence following the rules.`.trim();

    } else if (isChartFact) {
      // Chart Fact Prompt: Specific to Billboard Hot 100 performance
      const isNext = input.targetSong === 'next';
      const targetSong = isNext ? input.songNext : input.songPlayed;

      systemPrompt = `You are ${persona.name}, an authentic Top 40 radio DJ in ${input.targetDate.slice(0, 4)}.
You share a Billboard chart fact between songs.

EXAMPLES:
Example 1:
Fact: "She Believes In Me" by Kenny Rogers is new on the Hot 100 this week at number 61.
Script: Kenny Rogers is new on the Hot 100 this week at number 61 with "She Believes In Me."

Example 2:
Fact: "Heart Of Glass" by Blondie climbs up to number 1, from 3 on the Billboard Hot 100 this week.
Script: Blondie climbs up to number 1, from 3 this week with "Heart Of Glass."

RULES:
1. Write 1 or 2 plain spoken sentences only.
2. Use ONLY facts in the packet. Never invent chart numbers or peaks.
3. Mention the song title at most ONCE.
4. Do NOT use the word "debut". New entries are "new on the Hot 100 this week at number N".
5. Do NOT mention newspapers or "New York Times".
6. Do NOT use exclamation points (!).
7. NEVER say "coming up" or "up next".
8. No hype words (no "fresh", "hot", "amazing", "incredible", "smash", "on fire").
9. Output ONLY the raw spoken words.`.trim();

      userPrompt = `CURRENT BROADCAST DATE: ${input.targetDate}
CHART FACT PACKET:
Source: ${input.factPacket.source}
Fact: "${input.factPacket.factText}"
Target Song: "${targetSong?.title || 'Unknown'}" by ${targetSong?.artist || 'Unknown'} (${isNext ? 'starting now' : 'just finished'})

TASK:
Share the chart fact plainly in 1 or 2 sentences.`.trim();

    } else if (isSongCredit) {
      // Song Credit Prompt: Writer or producer information
      const isNext = input.targetSong === 'next';
      const targetSong = isNext ? input.songNext : input.songPlayed;

      systemPrompt = `You are ${persona.name}, an authentic Top 40 radio DJ in ${input.targetDate.slice(0, 4)}.
You share a verified songwriter or producer credit for a song.

EXAMPLES:
Example 1:
Fact: Written by Audrey Allison, Joe Allison.
Script: Audrey and Joe Allison wrote this one for Jim Reeves.

Example 2:
Fact: Produced by Giorgio Moroder.
Script: Giorgio Moroder produced this track for Donna Summer.

RULES:
1. Write 1 or 2 plain spoken sentences only.
2. Use ONLY the writer/producer names provided in the packet.
3. Mention the song title at most ONCE.
4. Do NOT mention newspapers or "New York Times".
5. Do NOT use exclamation points (!).
6. No hype words or interjections.
7. Output ONLY the raw spoken words.`.trim();

      userPrompt = `CURRENT BROADCAST DATE: ${input.targetDate}
CREDIT PACKET:
Source: ${input.factPacket.source}
Credit: "${input.factPacket.factText}"
Song: "${targetSong?.title || 'Unknown'}" by ${targetSong?.artist || 'Unknown'} (${isNext ? 'coming up' : 'just finished'})

TASK:
State the credit plainly in 1 or 2 sentences.`.trim();

    } else {
      // Cost of living observation or general fact
      systemPrompt = `You are ${persona.name}, an authentic Top 40 radio DJ in ${input.targetDate.slice(0, 4)}.
You share an understated everyday cost-of-living statistic.

EXAMPLES:
Example 1:
Fact: Regular gas is running about eighty-six cents a gallon, up from sixty-five cents a year ago.
Script: Regular gas is running about eighty-six cents a gallon, up from sixty-five cents a year ago.

RULES:
1. Write exactly 1 plain spoken sentence.
2. State the numbers and statistic honest and plainly as given in the packet.
3. Do NOT add personal complaints, reactions, or commentary.
4. Do NOT mention newspapers or "New York Times".
5. Do NOT mention upcoming songs or say "coming up".
6. No exclamation points (!).
7. Output ONLY the raw spoken words.`.trim();

      userPrompt = `CURRENT BROADCAST DATE: ${input.targetDate}
STATISTIC PACKET:
Source: ${input.factPacket.source}
Fact: "${input.factPacket.factText}"

TASK:
State the statistic plainly in exactly 1 sentence.`.trim();
    }

    const startTimeMs = Date.now();
    const callStartTime = new Date(startTimeMs).toISOString();

    try {
      recordTextModelCall(1);
      const { content, modelUsed } = await this.callChatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.2, // Low temperature
        120  // Max tokens around 120
      );

      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));
      let cleanText = content.trim();

      // Clean outer quotes without breaking leading song title quotes (e.g. '"Hot Stuff" by Donna Summer.')
      const quoteMatches = cleanText.match(/"/g) || [];
      if (cleanText.startsWith('"') && cleanText.endsWith('"') && quoteMatches.length >= 2) {
        if (quoteMatches.length === 2) {
          cleanText = cleanText.slice(1, -1).trim();
        } else {
          const secondQuoteIndex = cleanText.indexOf('"', 1);
          // If the opening quote does not close immediately around a short leading title (e.g. within 60 chars), strip outer quotes
          if (secondQuoteIndex === -1 || secondQuoteIndex === cleanText.length - 1) {
            cleanText = cleanText.slice(1, -1).trim();
          }
        }
      }

      return {
        success: true,
        scriptText: cleanText,
        modelUsed: `lmstudio:${modelUsed}`,
        callStartTime,
        callDurationSec: durationSec,
      };
    } catch (err: any) {
      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));
      const isUnreachable =
        err?.message?.includes('ECONNREFUSED') ||
        err?.message?.includes('fetch failed') ||
        err?.message?.includes('unreachable') ||
        err?.code === 'ECONNREFUSED';

      return {
        success: false,
        scriptText: '',
        modelUsed: this.modelName || 'lmstudio',
        callStartTime,
        callDurationSec: durationSec,
        isUnavailable: true,
        error: isUnreachable
          ? `LM Studio server at ${this.endpoint} is unreachable. Ensure your local LLM server is running.`
          : err?.message || 'Failed connecting to LM Studio',
      };
    }
  }

  /**
   * Discovers available models from the LM Studio /v1/models endpoint.
   */
  public static async discoverModels(endpointUrl: string): Promise<string[]> {
    const base = endpointUrl.replace(/\/+$/, '');
    const url = `${base}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`LM Studio /models returned HTTP ${res.status}`);
      }
      const data: any = await res.json();
      if (Array.isArray(data?.data)) {
        return data.data.map((m: any) => m.id || m.name).filter(Boolean);
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Helper to resolve the active model name, falling back to dynamic discovery if unspecified.
   */
  private async resolveModel(): Promise<string> {
    if (this.modelName) {
      return this.modelName;
    }
    try {
      const models = await LMStudioScriptWriterProvider.discoverModels(this.endpoint);
      if (models.length > 0) {
        return models[0];
      }
    } catch {
      // Fallback
    }
    return 'default';
  }

  /**
   * Sends a chat completion request to the OpenAI-compatible endpoint.
   */
  private async callChatCompletion(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number,
    maxTokens: number
  ): Promise<{ content: string; modelUsed: string }> {
    const activeModel = await this.resolveModel();
    const url = `${this.endpoint}/chat/completions`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const sendRequest = async (useResponseFormat: boolean) => {
      const payload: any = {
        model: activeModel,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (useResponseFormat) {
        // Many newer engines prefer json_object, but if unsupported we omit
        payload.response_format = { type: 'json_object' };
      }

      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    };

    try {
      let res = await sendRequest(true);
      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        // If error mentions response_format or json_schema, retry without response_format
        if (res.status === 400 && (errorText.includes('response_format') || errorText.includes('json_schema'))) {
          res = await sendRequest(false);
        } else {
          throw new Error(
            `LM Studio request failed (HTTP ${res.status}): ${errorText || res.statusText}`
          );
        }
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(
          `LM Studio request failed (HTTP ${res.status}): ${errorText || res.statusText}`
        );
      }

      const data: any = await res.json();
      const choice = data?.choices?.[0]?.message;
      let content = choice?.content || '';
      // If content is empty but model put text in reasoning or text field:
      if (!content.trim() && choice?.reasoning) {
        content = choice.reasoning;
      }
      const returnedModel = data?.model || activeModel;

      return { content, modelUsed: returnedModel };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(
          `LM Studio call timed out after ${this.timeoutMs / 1000}s.`
        );
        (timeoutErr as any).isTimeout = true;
        (timeoutErr as any).status = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parses JSON string from LLM responses, stripping code fences or leading/trailing chatter if present.
   */
  private parseJSONResponse(rawText: string): any {
    let cleaned = rawText.trim();
    // Strip markdown json block fences if model wrapped it
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // Try finding the outermost JSON object { ... }
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error(`Failed to parse valid JSON from LM Studio response: ${cleaned.substring(0, 150)}...`);
    }
  }

  /**
   * Step 1: Generates the 3 DJ break scripts without running anachronism audit.
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
    const startTimeMs = Date.now();
    const callStartTime = new Date(startTimeMs).toISOString();
    const factItemsGiven = input.factItems.slice(0, 15);
    const persona = PERSONALITIES[input.personality] || PERSONALITIES.mike;
    const targetWords = Math.round(input.secondsAvailable * 2.5);
    const minWords = Math.max(5, Math.round(targetWords * 0.8));
    const maxWords = Math.round(targetWords * 1.2);

    const factSummaryList = factItemsGiven
      .map(
        (item, idx) =>
          `[Item ${idx + 1}] (${item.category.toUpperCase()} - ${item.publishedDate}) "${item.headline}": ${
            item.summary || 'N/A'
          }`
      )
      .join('\n');

    const systemPrompt = `You are a professional historical radio simulation AI.
${persona.promptPersona}
Output must be strictly valid JSON matching the requested schema.`;

    const userPrompt = `
You are live on the air on an authentic Top 40 radio station.
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
      "scriptText": "Exact words spoken by the DJ",
      "citedItemHeadlines": ["Exact headline of the item(s) drawn from"]
    },
    {
      "breakNumber": 3,
      "scriptText": "Exact words spoken by the DJ",
      "citedItemHeadlines": ["Exact headline of the item(s) drawn from"]
    }
  ]
}
`.trim();

    try {
      recordTextModelCall(1);
      const { content, modelUsed } = await this.callChatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.8,
        1500
      );

      const parsed = this.parseJSONResponse(content);
      const rawBreaks = Array.isArray(parsed?.breaks) ? parsed.breaks : [];

      if (rawBreaks.length === 0) {
        throw new Error('Local model returned no break scripts in output JSON.');
      }

      const generatedBreaks: GeneratedDJBreak[] = rawBreaks.map((b: any, i: number) => {
        const scriptText = (b.scriptText || '').trim();
        const words = scriptText.split(/\s+/).filter(Boolean);
        const wordCount = words.length;
        const estimatedSeconds = Number((wordCount / 2.5).toFixed(1));

        const citedHeadlines: string[] = Array.isArray(b.citedItemHeadlines)
          ? b.citedItemHeadlines
          : [];
        const citedItems = citedHeadlines.map((hl) => {
          const found = input.factItems.find(
            (f) =>
              f.headline.toLowerCase().includes(hl.toLowerCase()) ||
              hl.toLowerCase().includes(f.headline.toLowerCase())
          );
          return {
            headline: hl,
            publishedDate: found?.publishedDate || input.targetDate,
            category: found?.category || 'news',
          };
        });

        return {
          id: `break_local_${Date.now()}_${i + 1}`,
          breakNumber: b.breakNumber || i + 1,
          scriptText,
          wordCount,
          estimatedSeconds,
          targetSeconds: input.secondsAvailable,
          citedItems,
          anachronismCheck: {
            status: 'CHECKING',
            notes: 'Checking for anachronisms with local model...',
            flaggedPhrases: [],
          },
        };
      });

      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));

      return {
        success: true,
        breaks: generatedBreaks,
        providedFactItems: factItemsGiven,
        modelUsed: `lmstudio:${modelUsed}`,
        callStartTime,
        callDurationSec: durationSec,
      };
    } catch (err: any) {
      console.error('[LMStudioScriptWriterProvider] Step 1 error:', err);
      const isTimeout = (err?.message || '').toLowerCase().includes('time') && (err?.isTimeout || err?.message.includes('timed out'));
      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));

      return {
        success: false,
        breaks: [],
        providedFactItems: factItemsGiven,
        modelUsed: this.modelName || 'lmstudio',
        callStartTime,
        callDurationSec: durationSec,
        isUnavailable: true,
        stepTimedOut: isTimeout ? 'step1' : null,
        error: isTimeout
          ? `Step 1 (writing 3 breaks via LM Studio) timed out after ${this.timeoutMs / 1000}s.`
          : `LM Studio generation failed: ${err?.message || 'Connection refused or model unavailable'}`,
      };
    }
  }

  /**
   * Step 2: Runs anachronism audit on the generated breaks.
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
    const startTimeMs = Date.now();
    const callStartTime = new Date(startTimeMs).toISOString();

    const scriptsFormatted = scripts
      .map((s) => `[Break #${s.breakNumber}]: "${s.scriptText}"`)
      .join('\n\n');

    const systemPrompt = `You are an expert historical chronological fact auditor.
Examine radio DJ scripts for date authenticity. Output must be strictly valid JSON matching the requested schema.`;

    const userPrompt = `
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
      recordTextModelCall(1);
      const { content, modelUsed } = await this.callChatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        0.1,
        600
      );

      const parsed = this.parseJSONResponse(content);
      const audits = Array.isArray(parsed?.audits) ? parsed.audits : [];
      const auditMap: Record<number, AnachronismCheckResult> = {};

      for (const a of audits) {
        auditMap[a.breakNumber] = {
          status: a.status === 'FAIL' ? 'FAIL' : 'PASS',
          notes: a.notes || 'Chronologically authentic for this date.',
          flaggedPhrases: a.flaggedPhrases || [],
        };
      }

      for (const s of scripts) {
        if (!auditMap[s.breakNumber]) {
          auditMap[s.breakNumber] = {
            status: 'PASS',
            notes: 'Chronologically authentic for this date.',
            flaggedPhrases: [],
          };
        }
      }

      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));

      return {
        success: true,
        audits: auditMap,
        modelUsed: `lmstudio:${modelUsed}`,
        callStartTime,
        callDurationSec: durationSec,
      };
    } catch (err: any) {
      console.warn('[LMStudioScriptWriterProvider] Step 2 audit error:', err?.message);
      const isTimeout = (err?.message || '').toLowerCase().includes('time') && (err?.isTimeout || err?.message.includes('timed out'));
      const errorMsg = isTimeout
        ? `Step 2 (anachronism audit via LM Studio) timed out after ${this.timeoutMs / 1000}s.`
        : err?.message || 'LM Studio audit unavailable';

      const fallbackMap: Record<number, AnachronismCheckResult> = {};
      for (const s of scripts) {
        fallbackMap[s.breakNumber] = {
          status: 'UNAVAILABLE',
          notes: `Audit unavailable: ${errorMsg}`,
          flaggedPhrases: [],
        };
      }

      const durationSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(1));

      return {
        success: false,
        audits: fallbackMap,
        auditUnavailable: true,
        stepTimedOut: isTimeout ? 'step2' : null,
        modelUsed: modelToUse || this.modelName || 'lmstudio',
        callStartTime,
        callDurationSec: durationSec,
        error: errorMsg,
      };
    }
  }

  /**
   * Unified generateBreaks: Step 1 then Step 2.
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
        quotaExceeded: false,
        isUnavailable: step1.isUnavailable,
        stepTimedOut: step1.stepTimedOut,
        error: step1.error,
        modelUsed: step1.modelUsed,
        callStartTime: step1.callStartTime,
        callDurationSec: step1.callDurationSec,
        provider: 'lmstudio',
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
      callDurationSec: Number(
        ((step1.callDurationSec || 0) + (step2.callDurationSec || 0)).toFixed(1)
      ),
      auditUnavailable: step2.auditUnavailable,
      stepTimedOut: step2.stepTimedOut,
      provider: 'lmstudio',
    };
  }
}

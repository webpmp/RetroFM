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
import { splitVerbatimSentences } from '../news/almanacService.js';

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
  public async resolveModel(): Promise<string> {
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

  /**
   * Generates a rich spoken radio talk segment using the full monologue prompt architecture:
   * 1. Provides a verified Fact Sheet, code-chosen hook, 3 short voice exemplars, and strict style rules
   *    (short spoken sentences, direct address, varied rhythm, strictly no connector words, no opinion/hindsight, no outside facts).
   * 2. The model writes the whole segment monologue.
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
        modelUsed: this.modelName || 'lmstudio',
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

    const systemPromptStep1 = `You are ${persona.name}, a genuine Top 40 radio DJ broadcasting on ${fullDateSpoken}.
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
12. Fix punctuation: never leave double periods (..) after abbreviations, and never capitalize after a comma unless it is a proper name.`;

    const failureCorrection = input.failureReason
      ? `\n\nCRITICAL FIX REQUIRED FROM PREVIOUS ATTEMPT: Your previous draft was rejected for the following exact reason: "${input.failureReason}". You MUST avoid this completely and adhere strictly to the rules.`
      : '';

    const userPromptStep1 = `FACT SHEET:
${factLines}
${hook ? `CHOSEN HOOK: "${hook}"` : `CHOSEN HOOK: None (start immediately with the facts)`}${failureCorrection}

TASK:
Write the complete spoken radio segment monologue following all rules. Output ONLY the commentary facts without any song introduction or handoff. Output ONLY the words spoken on air.`;

    let activeModel = '';
    try {
      activeModel = await this.resolveModel();
    } catch {
      activeModel = this.modelName || 'qwen2.5-14b-instruct-1m';
    }

    let rawDraft = '';
    try {
      const res1 = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel,
          messages: [
            { role: 'system', content: systemPromptStep1 },
            { role: 'user', content: userPromptStep1 },
          ],
          temperature: 0.3,
          max_tokens: 350,
        }),
      });

      if (res1.ok) {
        const data1 = await res1.json();
        rawDraft = data1?.choices?.[0]?.message?.content?.trim() || '';
      }
    } catch (err: any) {
      console.warn('[LMStudio] Step 1 monologue generation failed:', err);
    }

    if (!rawDraft) {
      // Fallback: build natural script from facts
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
    // Split monologue into sentences using splitVerbatimSentences to protect artist dots
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

    const systemPromptStep2 = `You are a strict radio broadcast fact verifier.
Verify each numbered claim sentence against the fact sheet.

CRITICAL RULES:
1. If a claim contains ANY detail, adjective, title, praise, or characterization (such as "pioneering", "legendary", "iconic", "virtuoso", studio name, location, number of stories, or drum name) that is NOT explicitly stated in the fact sheet, you MUST output:
[Claim N]: UNSUPPORTED: <reason>
2. General cultural knowledge, external facts, or historical inferences outside the fact sheet are STRICTLY FORBIDDEN.
3. If every detail in the claim is explicitly supported by a fact, output:
[Claim N]: SUPPORTED (Fact <id>)`;

    const userPromptStep2 = `FACT SHEET:
${factLines}

CLAIMS TO VERIFY:
${auditPrompt}

VERDICTS:`;

    const unsupportedClaims: string[] = [];
    const droppedSentenceIndexes = new Set<number>();

    if (claimsToCheck.length > 0) {
      try {
        const res2 = await fetch(`${this.endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: activeModel,
            messages: [
              { role: 'system', content: systemPromptStep2 },
              { role: 'user', content: userPromptStep2 },
            ],
            temperature: 0.0,
            max_tokens: 500,
          }),
        });

        if (res2.ok) {
          const data2 = await res2.json();
          const auditText = data2?.choices?.[0]?.message?.content?.trim() || '';
          const auditLines = auditText.split('\n').filter(Boolean);
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
        }
      } catch (err: any) {
        console.warn('[LMStudio] Step 2 claim verification failed:', err);
      }
    }

    // Assemble final script without unsupported sentences
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
      modelUsed: `lmstudio:${activeModel}`,
      callStartTime: new Date(startTime).toISOString(),
      callDurationSec: durationSec,
      rawResponse: `--- PROMPT ---\n${systemPromptStep1}\n${userPromptStep1}\n\n--- RAW OUTPUT ---\n${rawDraft}\n\n--- AUDIT ---\n${unsupportedClaims.join('\n') || 'None'}`,
      unsupportedClaims,
      openerUsed: hook || 'None',
      closerUsed: '',
    };
  }
}

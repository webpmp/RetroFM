/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsPacket, auditNewsLine, isSensitive } from '../djBreak/newsAudit.js';
import { getScriptWriterProvider } from '../djBreak/djBreakService.js';
import { LMStudioScriptWriterProvider } from '../djBreak/LMStudioScriptWriterProvider.js';
import { validateBreakOutput } from '../djBreak/breakValidator.js';

export interface NewsLineResult {
  line: string;
  packet: NewsPacket;
  result: 'ok' | 'rejected';
  reasons: string[];
  attempts: number;
}

export interface NewsWriterOptions {
  provider?: 'gemini' | 'lmstudio';
  endpoint?: string;
  model?: string;
}

/**
 * Builds the news writer prompt for a single packet according to spec.
 * Plain 1-sentence headline statement with no opinion, reaction, or inference.
 */
export function buildNewsPrompt(packet: NewsPacket, retryReasons?: string[]): string {
  const kwStr = packet.keywords && packet.keywords.length > 0 ? packet.keywords.join(', ') : '';
  const baseInstruction = `You are a radio DJ on ${packet.date}, glancing at the day's newspaper between records.
Frame the news script as "From this morning's New York Times: ..." in exactly one plain spoken sentence.
Do NOT use the words "yesterday" or "today".
Do NOT include any reactions, opinion, inference, or commentary.
Make clear who or what the story is about.
Use ONLY names and places present in the headline or abstract; do not invent new names, numbers, or outcomes.
Do NOT include interjections (no "wow", "whoa", "hey", "oh", "well", "yikes").
Do NOT include speculation phrasing (no "looks like", "seems", "probably", "getting ready", "sounds like").
Do NOT include exclamation points (!). Use a period only.
Do NOT start with any greeting (do not say "good morning", "folks", "listeners", etc.), and do not mention the next song.
Output ONLY the single plain spoken sentence beginning with "From this morning's New York Times: ".`;

  let prompt = `${baseInstruction}\n\nHEADLINE: "${packet.headline}"\nABSTRACT / LEAD: "${packet.abstract || ''}"`;
  if (kwStr) {
    prompt += `\nKEYWORDS: "${kwStr}"`;
  }

  if (retryReasons && retryReasons.length > 0) {
    prompt += `\n\nIMPORTANT CORRECTION: Your previous attempt was rejected for these reasons: ${retryReasons.join('; ')}. Fix these issues. Frame as "From this morning's New York Times: ..." in exactly one plain sentence with no "yesterday", no "today", no reactions, and no invented details.`;
  }

  return prompt;
}

/**
 * Executes a single completion for text using Gemini or LM Studio.
 */
async function callWriterForNews(
  prompt: string,
  options?: NewsWriterOptions
): Promise<string> {
  const providerType = options?.provider || 'gemini';

  if (providerType === 'lmstudio') {
    const lmProvider = new LMStudioScriptWriterProvider({
      endpoint: options?.endpoint,
      model: options?.model,
      timeoutMs: 30000,
    });
    // LM Studio call
    const res = await (lmProvider as any).callChatCompletion(
      [
        { role: 'system', content: 'You are an authentic historical radio DJ glancing at the morning paper. Output only the 1 or 2 spoken sentences.' },
        { role: 'user', content: prompt },
      ],
      0.7,
      200
    );
    return res.content || '';
  }

  // Gemini Writer
  const geminiWriter = getScriptWriterProvider({ provider: 'gemini' }) as any;
  const timeoutMs = 25000;

  try {
    const result = await geminiWriter.executeWithRetryAndFallback(
      'News line generation',
      async (modelToUse: string) => {
        const response = await geminiWriter.safeGenerateContent({
          model: modelToUse,
          contents: prompt,
          config: {
            temperature: 0.7,
            maxOutputTokens: 200,
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        });
        return response?.text || '';
      },
      timeoutMs
    );

    return result.result || '';
  } catch (err: any) {
    const isQuota =
      err?.message?.includes('429') ||
      err?.message?.includes('RESOURCE_EXHAUSTED') ||
      err?.message?.includes('quota');
    if (isQuota && geminiWriter.fallbackModelName && geminiWriter.fallbackModelName !== geminiWriter.modelName) {
      const response = await geminiWriter.safeGenerateContent({
        model: geminiWriter.fallbackModelName,
        contents: prompt,
        config: {
          temperature: 0.7,
          maxOutputTokens: 200,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      });
      return response?.text || '';
    }
    throw err;
  }
}

/**
 * Writes and audits a news line for a given NewsPacket with 1 retry.
 * Returns the audited line or null if rejected.
 */
export async function writeAndAuditNewsLine(
  packet: NewsPacket,
  options?: NewsWriterOptions
): Promise<NewsLineResult | null> {
  if (isSensitive(packet)) {
    console.log(`[News] date=${packet.date} packet="${packet.headline}" result=rejected reasons=sensitive topic`);
    return null;
  }

  // Attempt 1
  const prompt1 = buildNewsPrompt(packet);
  let line1 = '';
  try {
    line1 = (await callWriterForNews(prompt1, options)).trim();
  } catch (err: any) {
    console.warn(`[News] date=${packet.date} packet="${packet.headline}" result=rejected reasons=writer error: ${err?.message}`);
    return null;
  }

  // Strip wrapping quotes if AI enclosed entire line in quotes
  if (line1.startsWith('"') && line1.endsWith('"')) {
    line1 = line1.slice(1, -1).trim();
  }

  const audit1 = auditNewsLine(line1, packet);
  const val1 = validateBreakOutput(line1, {
    selectedDate: packet.date,
    factPacket: {
      factText: `${packet.headline}. ${packet.abstract || ''}`,
      source: 'New York Times Historical Archive',
      date: packet.date,
    },
  });
  if (audit1.ok && val1.valid) {
    console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line1}" result=ok reasons=none`);
    return {
      line: line1,
      packet,
      result: 'ok',
      reasons: [],
      attempts: 1,
    };
  }

  const reasons1 = [...audit1.reasons];
  if (!val1.valid && val1.rejectedReason) {
    reasons1.push(val1.rejectedReason);
  }

  // Retry once with failure reasons added to the prompt
  console.log(`[News] date=${packet.date} packet="${packet.headline}" attempt 1 failed line="${line1}" reasons=${reasons1.join(', ')}. Retrying once...`);

  const prompt2 = buildNewsPrompt(packet, reasons1);
  let line2 = '';
  try {
    line2 = (await callWriterForNews(prompt2, options)).trim();
  } catch (err: any) {
    console.warn(`[News] date=${packet.date} packet="${packet.headline}" result=rejected reasons=writer retry error: ${err?.message}`);
    return null;
  }

  if (line2.startsWith('"') && line2.endsWith('"')) {
    line2 = line2.slice(1, -1).trim();
  }

  const audit2 = auditNewsLine(line2, packet);
  const val2 = validateBreakOutput(line2, {
    selectedDate: packet.date,
    factPacket: {
      factText: `${packet.headline}. ${packet.abstract || ''}`,
      source: 'New York Times Historical Archive',
      date: packet.date,
    },
  });
  if (audit2.ok && val2.valid) {
    console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line2}" result=ok reasons=none (passed on retry)`);
    return {
      line: line2,
      packet,
      result: 'ok',
      reasons: [],
      attempts: 2,
    };
  }

  const reasons2 = [...audit2.reasons];
  if (!val2.valid && val2.rejectedReason) {
    reasons2.push(val2.rejectedReason);
  }

  console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line2}" result=rejected reasons=${reasons2.join(', ')}`);
  return {
    line: line2,
    packet,
    result: 'rejected',
    reasons: reasons2,
    attempts: 2,
  };
}

/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { NewsPacket, auditNewsLine, isSensitive } from '../djBreak/newsAudit.js';
import { getScriptWriterProvider } from '../djBreak/djBreakService.js';
import { LMStudioScriptWriterProvider } from '../djBreak/LMStudioScriptWriterProvider.js';

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
 */
export function buildNewsPrompt(packet: NewsPacket, retryReasons?: string[]): string {
  const kwStr = packet.keywords && packet.keywords.length > 0 ? packet.keywords.join(', ') : '';
  const baseInstruction = `You are a radio DJ on ${packet.date}, glancing at the day's newspaper between records.
Write 1 or 2 short spoken sentences (15 to 35 words) giving a light, human reaction to this headline, in the present tense.
Do not read the headline word for word.
Make clear who or what the story is about, using the names and terms from the headline, abstract, or keywords.
Use only information in the headline, abstract, and keywords: do not invent names, places, numbers, causes, or outcomes, and say nothing about what happened afterwards.
Do not start with any greeting or lead-in (do not say "good morning", "folks", "listeners", "here's the news", etc.), do not mention the time of day, and do not name the next song.
Output only the spoken sentences.`;

  let prompt = `${baseInstruction}\n\nHEADLINE: "${packet.headline}"\nABSTRACT: "${packet.abstract || ''}"`;
  if (kwStr) {
    prompt += `\nKEYWORDS: "${kwStr}"`;
  }

  if (retryReasons && retryReasons.length > 0) {
    prompt += `\n\nIMPORTANT CORRECTION: Your previous attempt was rejected for these reasons: ${retryReasons.join('; ')}. Fix these issues and ensure no invented names, places, numbers, future hindsight, greetings, or hype phrases are included. Output only the 1 or 2 spoken sentences.`;
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
  if (audit1.ok) {
    console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line1}" result=ok reasons=none`);
    return {
      line: line1,
      packet,
      result: 'ok',
      reasons: [],
      attempts: 1,
    };
  }

  // Retry once with failure reasons added to the prompt
  console.log(`[News] date=${packet.date} packet="${packet.headline}" attempt 1 failed line="${line1}" reasons=${audit1.reasons.join(', ')}. Retrying once...`);

  const prompt2 = buildNewsPrompt(packet, audit1.reasons);
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
  if (audit2.ok) {
    console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line2}" result=ok reasons=none (passed on retry)`);
    return {
      line: line2,
      packet,
      result: 'ok',
      reasons: [],
      attempts: 2,
    };
  }

  console.log(`[News] date=${packet.date} packet="${packet.headline}" line="${line2}" result=rejected reasons=${audit2.reasons.join(', ')}`);
  return {
    line: line2,
    packet,
    result: 'rejected',
    reasons: audit2.reasons,
    attempts: 2,
  };
}

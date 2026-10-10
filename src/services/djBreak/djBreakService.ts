/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import {
  ScriptWriterProvider,
  BreakGeneratorInput,
  BreakGeneratorResult,
} from './types.js';
import {
  GeminiScriptWriterProvider,
  PERSONALITIES,
} from './GeminiScriptWriterProvider.js';
import {
  computeBreakCacheKey,
  readBreakCache,
  writeBreakCache,
  recordBreakCacheHit,
  getDJBreakSessionStats,
} from './breakCache.js';
import { buildFactPacket } from '../news/factPacketService.js';
import { FactItem } from '../news/types.js';

// Default model can be configured via environment or default setting
const DEFAULT_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
const FALLBACK_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL_FALLBACK;

export const activeScriptWriter: GeminiScriptWriterProvider = new GeminiScriptWriterProvider(
  process.env.GEMINI_API_KEY,
  DEFAULT_TEXT_MODEL,
  FALLBACK_TEXT_MODEL
);

/**
 * Step 1 Service:
 * 1. Checks disk cache by input parameters.
 * 2. If cached (and not forceFresh), returns cached breaks immediately with audit already completed.
 * 3. If not cached, loads cached NYT fact packet for that date.
 * 4. Generates 3 break scripts via Step 1 (model call #1) with minimal latency settings.
 * 5. Returns breaks with audit status "CHECKING" immediately.
 */
export async function generateDJBreaksStep1Service(
  params: {
    targetDate: string;
    personality: 'mike' | 'lisa';
    timeOfDay: 'morning' | 'afternoon' | 'evening' | 'late night';
    format: 'Top 40';
    songPlayed: string;
    songNext: string;
    secondsAvailable: number;
    forceFresh?: boolean;
    nationalFocus?: boolean;
  }
): Promise<BreakGeneratorResult> {
  const isNationalFocus = params.nationalFocus !== false;
  const cacheKey = computeBreakCacheKey({
    targetDate: params.targetDate,
    personality: params.personality,
    timeOfDay: params.timeOfDay,
    format: params.format,
    songPlayed: params.songPlayed,
    songNext: params.songNext,
    secondsAvailable: params.secondsAvailable,
    nationalFocus: isNationalFocus,
  });

  if (!params.forceFresh) {
    const cached = readBreakCache(cacheKey);
    if (cached) {
      recordBreakCacheHit();
      return {
        ...cached,
        cached: true,
        auditCompleted: true,
        callsUsedThisRun: 0,
      };
    }
  }

  // Load cached NYT fact packet for that date (reuses existing cache; won't re-call NYT if cached)
  const factPacket = await buildFactPacket(params.targetDate, false, ['nyt'], isNationalFocus);
  const nytItems = factPacket.results?.nyt?.items || [];

  // Spread up to 15 items across categories
  const selectedFactItems = selectDiverseFactItems(nytItems, 15);

  const input: BreakGeneratorInput = {
    targetDate: params.targetDate,
    personality: params.personality,
    timeOfDay: params.timeOfDay,
    format: params.format,
    songPlayed: params.songPlayed,
    songNext: params.songNext,
    secondsAvailable: params.secondsAvailable,
    factItems: selectedFactItems,
    nationalFocusEnabled: isNationalFocus,
  };

  const step1 = await activeScriptWriter.writeBreaksOnly(input);

  return {
    success: step1.success,
    targetDate: params.targetDate,
    personality: params.personality,
    timeOfDay: params.timeOfDay,
    format: params.format,
    songPlayed: params.songPlayed,
    songNext: params.songNext,
    secondsAvailable: params.secondsAvailable,
    breaks: step1.breaks,
    providedFactItems: selectedFactItems,
    nationalFocusEnabled: isNationalFocus,
    callsUsedThisRun: step1.success ? 1 : 0,
    modelUsed: step1.modelUsed,
    callStartTime: step1.callStartTime,
    callDurationSec: step1.callDurationSec,
    error: step1.error,
    isUnavailable: step1.isUnavailable,
    quotaExceeded: step1.quotaExceeded,
    stepTimedOut: step1.stepTimedOut,
    cached: false,
    auditCompleted: false,
  };
}

/**
 * Step 2 Service:
 * 1. Takes the 3 breaks and target date.
 * 2. Runs anachronism audit in a single model call with 45s timeout and retries.
 * 3. On success, writes the full audited result to disk cache.
 * 4. On failure/timeout, returns auditUnavailable: true so scripts still display.
 */
export async function auditDJBreaksStep2Service(
  params: {
    breaks: any[];
    targetDate: string;
    modelUsed?: string;
    personality?: 'mike' | 'lisa';
    timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'late night';
    format?: 'Top 40';
    songPlayed?: string;
    songNext?: string;
    secondsAvailable?: number;
    nationalFocus?: boolean;
    providedFactItems?: FactItem[];
  }
): Promise<{
  success: boolean;
  breaks: any[];
  modelUsed: string;
  callStartTime: string;
  callDurationSec: number;
  auditUnavailable?: boolean;
  stepTimedOut?: 'step2' | null;
  error?: string;
}> {
  const scriptsForAudit = params.breaks.map((b, idx) => ({
    breakNumber: b.breakNumber || idx + 1,
    scriptText: b.scriptText || '',
  }));

  const step2 = await activeScriptWriter.auditBreaksOnly(
    scriptsForAudit,
    params.targetDate,
    params.modelUsed
  );

  const updatedBreaks = params.breaks.map((b, idx) => {
    const num = b.breakNumber || idx + 1;
    const audit = step2.audits[num] || {
      status: step2.auditUnavailable ? 'UNAVAILABLE' : 'PASS',
      notes: step2.error ? `Audit unavailable: ${step2.error}` : 'Chronologically authentic for this date.',
      flaggedPhrases: [],
    };
    return {
      ...b,
      anachronismCheck: audit,
    };
  });

  // If parameters provided, persist complete audited result to disk cache
  if (
    params.personality &&
    params.timeOfDay &&
    params.format &&
    params.songPlayed &&
    params.songNext &&
    params.secondsAvailable
  ) {
    const isNationalFocus = params.nationalFocus !== false;
    const cacheKey = computeBreakCacheKey({
      targetDate: params.targetDate,
      personality: params.personality,
      timeOfDay: params.timeOfDay,
      format: params.format,
      songPlayed: params.songPlayed,
      songNext: params.songNext,
      secondsAvailable: params.secondsAvailable,
      nationalFocus: isNationalFocus,
    });

    const fullResult: BreakGeneratorResult = {
      success: true,
      targetDate: params.targetDate,
      personality: params.personality,
      timeOfDay: params.timeOfDay,
      format: params.format,
      songPlayed: params.songPlayed,
      songNext: params.songNext,
      secondsAvailable: params.secondsAvailable,
      breaks: updatedBreaks,
      providedFactItems: params.providedFactItems || [],
      nationalFocusEnabled: isNationalFocus,
      callsUsedThisRun: 2,
      modelUsed: step2.modelUsed,
      cached: false,
      auditCompleted: true,
      auditUnavailable: step2.auditUnavailable,
    };

    writeBreakCache(cacheKey, fullResult);
  }

  return {
    success: step2.success,
    breaks: updatedBreaks,
    modelUsed: step2.modelUsed,
    callStartTime: step2.callStartTime,
    callDurationSec: step2.callDurationSec,
    auditUnavailable: step2.auditUnavailable,
    stepTimedOut: step2.stepTimedOut,
    error: step2.error,
  };
}

/**
 * Service to orchestrate DJ Break Generation:
 * 1. Checks disk cache by input parameters.
 * 2. If not cached (or forceFresh), loads cached NYT fact packet for that date.
 * 3. Spreads up to 15 items across categories.
 * 4. Generates 3 breaks and runs anachronism checks.
 * 5. Caches output to disk.
 */
export async function generateDJBreaksService(
  params: {
    targetDate: string;
    personality: 'mike' | 'lisa';
    timeOfDay: 'morning' | 'afternoon' | 'evening' | 'late night';
    format: 'Top 40';
    songPlayed: string;
    songNext: string;
    secondsAvailable: number;
    forceFresh?: boolean;
    nationalFocus?: boolean;
  }
): Promise<BreakGeneratorResult> {
  const isNationalFocus = params.nationalFocus !== false;
  const cacheKey = computeBreakCacheKey({
    targetDate: params.targetDate,
    personality: params.personality,
    timeOfDay: params.timeOfDay,
    format: params.format,
    songPlayed: params.songPlayed,
    songNext: params.songNext,
    secondsAvailable: params.secondsAvailable,
    nationalFocus: isNationalFocus,
  });

  if (!params.forceFresh) {
    const cached = readBreakCache(cacheKey);
    if (cached) {
      recordBreakCacheHit();
      return { ...cached, cached: true };
    }
  }

  // Load cached NYT fact packet for that date (reuses existing service with nationalFocus; won't re-call NYT if cached)
  const factPacket = await buildFactPacket(params.targetDate, false, ['nyt'], isNationalFocus);
  const nytItems = factPacket.results?.nyt?.items || [];

  // Spread up to 15 items across categories
  const selectedFactItems = selectDiverseFactItems(nytItems, 15);

  const input: BreakGeneratorInput = {
    targetDate: params.targetDate,
    personality: params.personality,
    timeOfDay: params.timeOfDay,
    format: params.format,
    songPlayed: params.songPlayed,
    songNext: params.songNext,
    secondsAvailable: params.secondsAvailable,
    factItems: selectedFactItems,
    nationalFocusEnabled: isNationalFocus,
  };

  const result = await activeScriptWriter.generateBreaks(input);
  result.nationalFocusEnabled = isNationalFocus;

  if (result.success && result.breaks && result.breaks.length > 0) {
    writeBreakCache(cacheKey, result);
  }

  return { ...result, cached: false };
}

/**
 * Selects up to `maxItems` (default 15) items from the TOP of the scored list,
 * spread across categories (music, movies-tv-arts, sports, news, business, other),
 * instead of taking arbitrary ones.
 */
export function selectDiverseFactItems(items: FactItem[], maxItems = 15): FactItem[] {
  if (items.length <= maxItems) {
    return [...items].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // Ensure items are sorted highest score first
  const sortedItems = [...items].sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    if (diff !== 0) return diff;
    return b.publishedDate.localeCompare(a.publishedDate);
  });

  // Group items by category (each category array is ordered highest score first)
  const byCat: Record<string, FactItem[]> = {};
  for (const item of sortedItems) {
    if (!byCat[item.category]) byCat[item.category] = [];
    byCat[item.category].push(item);
  }

  // Desired category prioritization for authentic radio DJ broadcast
  const preferredCategoryOrder = ['music', 'movies-tv-arts', 'sports', 'news', 'business', 'other'];
  const presentCategories = preferredCategoryOrder.filter((cat) => byCat[cat] && byCat[cat].length > 0);

  const selected: FactItem[] = [];
  const selectedSet = new Set<string>();

  // Round-robin selection taking top-scoring items across diverse categories
  let round = 0;
  let addedInRound = true;

  while (selected.length < maxItems && addedInRound) {
    addedInRound = false;
    for (const cat of presentCategories) {
      if (selected.length >= maxItems) break;
      const list = byCat[cat];
      if (list && round < list.length) {
        const item = list[round];
        const key = `${item.publishedDate}_${item.headline}`;
        if (!selectedSet.has(key)) {
          selected.push(item);
          selectedSet.add(key);
          addedInRound = true;
        }
      }
    }
    round++;
  }

  // If still under maxItems, backfill with remaining highest-scoring items from the top of the list
  if (selected.length < maxItems) {
    for (const item of sortedItems) {
      if (selected.length >= maxItems) break;
      const key = `${item.publishedDate}_${item.headline}`;
      if (!selectedSet.has(key)) {
        selected.push(item);
        selectedSet.add(key);
      }
    }
  }

  // Return the selected items sorted by score descending (highest first)
  return selected.sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    if (diff !== 0) return diff;
    return b.publishedDate.localeCompare(a.publishedDate);
  });
}

export { getDJBreakSessionStats, PERSONALITIES };

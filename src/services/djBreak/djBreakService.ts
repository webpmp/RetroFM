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

export const activeScriptWriter: ScriptWriterProvider = new GeminiScriptWriterProvider(
  process.env.GEMINI_API_KEY,
  DEFAULT_TEXT_MODEL,
  FALLBACK_TEXT_MODEL
);

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
 * Selects up to `maxItems` items spread across categories (music, movies-tv-arts, sports, news, business, other)
 */
function selectDiverseFactItems(items: FactItem[], maxItems = 15): FactItem[] {
  if (items.length <= maxItems) return items;

  // Group by category
  const byCat: Record<string, FactItem[]> = {};
  for (const item of items) {
    if (!byCat[item.category]) byCat[item.category] = [];
    byCat[item.category].push(item);
  }

  const selected: FactItem[] = [];
  const categories = Object.keys(byCat);

  // Round robin pick from each category
  let added = true;
  let round = 0;
  while (selected.length < maxItems && added) {
    added = false;
    for (const cat of categories) {
      if (selected.length >= maxItems) break;
      const list = byCat[cat];
      if (list && round < list.length) {
        selected.push(list[round]);
        added = true;
      }
    }
    round++;
  }

  return selected;
}

export { getDJBreakSessionStats, PERSONALITIES };

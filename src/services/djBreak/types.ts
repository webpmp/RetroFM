/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { FactItem } from '../news/types.js';

export type StationPersonalityId = 'mike' | 'lisa';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'late night';
export type RadioFormat = 'Top 40';

export interface StationPersonality {
  id: StationPersonalityId;
  name: string;
  gender: string;
  age: string;
  description: string;
  promptPersona: string;
}

export interface StepProgressEvent {
  step: 1 | 2;
  totalSteps: 2;
  stepName: string;
  model: string;
  status: 'starting' | 'retrying' | 'completed' | 'failed' | 'fallback';
  attempt?: number;
  maxAttempts?: number;
  retryWaitMs?: number;
  breaks?: GeneratedDJBreak[];
  error?: string;
  durationMs?: number;
  callStartIso?: string;
}

export interface BreakGeneratorInput {
  targetDate: string; // YYYY-MM-DD
  personality: StationPersonalityId;
  timeOfDay: TimeOfDay;
  format: RadioFormat;
  songPlayed: string; // "Artist - Title"
  songNext: string; // "Artist - Title"
  secondsAvailable: number; // 5 to 20
  factItems: FactItem[]; // up to 15 items from NYT Archive
  nationalFocusEnabled?: boolean;
  onStepProgress?: (event: StepProgressEvent) => void;
}

export interface AnachronismCheckResult {
  status: 'PASS' | 'FAIL' | 'CHECKING' | 'UNAVAILABLE';
  notes: string;
  flaggedPhrases?: string[];
}

export interface GeneratedDJBreak {
  id: string;
  breakNumber: number;
  scriptText: string;
  wordCount: number;
  estimatedSeconds: number;
  targetSeconds: number;
  citedItems: {
    headline: string;
    publishedDate: string;
    category?: string;
  }[];
  anachronismCheck: AnachronismCheckResult;
}

export interface BreakGeneratorResult {
  success: boolean;
  targetDate: string;
  personality: StationPersonalityId;
  timeOfDay: TimeOfDay;
  format: RadioFormat;
  songPlayed: string;
  songNext: string;
  secondsAvailable: number;
  breaks: GeneratedDJBreak[];
  providedFactItems?: FactItem[]; // up to 15 items provided to the model
  nationalFocusEnabled?: boolean;
  callsUsedThisRun?: number; // Exactly 2 calls per successful generation
  error?: string;
  isUnavailable?: boolean; // Model busy/unavailable 503
  quotaExceeded?: boolean; // 429 quota error
  cached?: boolean;
  modelUsed?: string;
  auditCompleted?: boolean;
  auditUnavailable?: boolean;
  callStartTime?: string;
  callDurationSec?: number;
  stepTimedOut?: 'step1' | 'step2' | null;
  provider?: 'gemini' | 'lmstudio';
}

export type AIProviderType = 'gemini' | 'lmstudio';

export interface SingleBreakPacketInput {
  targetDate: string; // YYYY-MM-DD
  personality?: StationPersonalityId;
  timeOfDay?: TimeOfDay;
  format?: RadioFormat;
  songPlayed?: { title: string; artist: string; primary_artist?: string | null };
  songNext?: { title: string; artist: string; primary_artist?: string | null };
  targetSong?: 'prev' | 'next' | 'none';
  breakType: 'chart_fact' | 'song_credit' | 'observation' | 'intro_only';
  factPacket: {
    factText: string;
    source: string;
    date: string;
  };
  secondsAvailable?: number;
}

export interface SingleBreakPacketResult {
  success: boolean;
  scriptText: string;
  modelUsed: string;
  callStartTime: string;
  callDurationSec: number;
  error?: string;
  isUnavailable?: boolean;
  rawResponse?: string;
}

export interface FactRewriteResult {
  factIndex: number;
  originalFact: string;
  rewrittenSentence: string;
  source?: string;
  auditStatus?: 'SUPPORTED' | 'UNSUPPORTED';
  auditReason?: string;
}

export interface SegmentBreakScriptResult extends SingleBreakPacketResult {
  perSentenceRewrites?: FactRewriteResult[];
  unsupportedClaims?: string[];
  openerUsed?: string;
  connectorUsed?: string;
  closerUsed?: string;
}

export interface ScriptWriterProvider {
  readonly name: string;
  readonly modelName: string;
  generateBreaks(input: BreakGeneratorInput): Promise<BreakGeneratorResult>;
  writeBreaksOnly(input: BreakGeneratorInput): Promise<{
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
  }>;
  auditBreaksOnly(
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
  }>;
  writeSingleBreakScript(input: SingleBreakPacketInput): Promise<SingleBreakPacketResult>;
  writeSegmentBreakScript?(input: SegmentBreakScriptInput): Promise<SegmentBreakScriptResult>;
}

export interface SegmentBreakScriptInput {
  targetDate: string; // YYYY-MM-DD
  personality?: 'mike' | 'sarah' | 'charlie';
  topic: string;
  topicTitle: string;
  targetSongTitle?: string;
  targetSongArtist?: string;
  facts: Array<{ text: string; source?: string; date?: string }>;
  failureReason?: string;
  exactPrompt?: string;
}

export interface DJBreakSessionStats {
  textModelCalls: number;
  cacheHits: number;
}

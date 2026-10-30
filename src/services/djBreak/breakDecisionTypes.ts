/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Types for Spec A DJ Break Decision & Selection.
 * Shared between client and server without pulling in Node or SQLite dependencies.
 */

export type SpecABreakType = 'chart_fact' | 'song_credit' | 'observation' | 'intro_only';

export interface BreakCandidate {
  type: SpecABreakType;
  factKey: string; // Unique identifier to prevent repeats
  factText: string;
  source: string;
  date: string;
  targetSong: 'prev' | 'next' | 'none';
}

export interface EngineSongInput {
  title: string;
  artist: string;
  primary_artist?: string | null;
  id?: string;
  first_chart_date?: string | null;
  release_date?: string | null;
}

export interface BreakSelectionSessionState {
  usedFactKeys: Set<string>;
  usedNewsTopics?: Set<string>;
  songsWithSpokenBreak?: Set<string>;
  lastBreakType: SpecABreakType | null;
  totalSongChanges: number;
  totalBreaksSpoken: number;
  recentRhetoricalOpeners: number;
  breaksSinceLastNews: number;
  breaksSinceLastRetroFm?: number;
  lastHandoffGroup?: number | null;
  recentHandoffTemplates?: string[];
  lastIntroTemplateIndex?: number;
  lastChartTemplateIndex?: number;
  lastCreditTemplateIndex?: number;
}

export function newBreakSelectionSessionState(): BreakSelectionSessionState {
  return {
    usedFactKeys: new Set<string>(),
    usedNewsTopics: new Set<string>(),
    songsWithSpokenBreak: new Set<string>(),
    lastBreakType: null,
    totalSongChanges: 0,
    totalBreaksSpoken: 0,
    recentRhetoricalOpeners: 0,
    breaksSinceLastNews: 4, // eligible immediately on first break (cap is at most 1 in 4)
    breaksSinceLastRetroFm: 4, // allow RetroFM at most once in every 4 breaks
    lastHandoffGroup: null,
    recentHandoffTemplates: [],
    lastIntroTemplateIndex: -1,
  };
}

export interface BreakDecisionRequestPayload {
  selectedDate: string;
  prevSong: EngineSongInput | null;
  nextSong: EngineSongInput | null;
  frequencySetting?: number;
  usedFactKeys: string[];
  lastBreakType: SpecABreakType | null;
  newsObservation?: { text: string; date: string } | null;
  economyObservation?: { text: string; date: string } | null;
}

export interface BreakDecisionResponsePayload {
  decision: 'speak' | 'silence';
  breakType: SpecABreakType | null;
  candidate: BreakCandidate | null;
  finalSpeech: string;
  targetSong: 'prev' | 'next' | 'none';
}

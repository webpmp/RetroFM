/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState, useEffect } from 'react';
import {
  Mic2,
  Play,
  RotateCw,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Radio,
  Volume2,
  Calendar,
  Layers,
  ChevronDown,
  ChevronUp,
  FileText,
  User,
  Music,
  ExternalLink,
  ShieldCheck,
  ShieldAlert,
  Cpu,
  Filter,
} from 'lucide-react';
import {
  StationPersonalityId,
  TimeOfDay,
  RadioFormat,
  GeneratedDJBreak,
  BreakGeneratorResult,
  DJBreakSessionStats,
} from '../services/djBreak/types.js';
import { FactItem } from '../services/news/types.js';

export const HISTORICAL_PRESET_DATES = [
  { date: '1969-07-21', label: '1969-07-21 (Apollo 11 Moon Landing)' },
  { date: '1977-05-26', label: '1977-05-26 (Star Wars Premieres & UK Punk Wave)' },
  { date: '1985-07-13', label: '1985-07-13 (Live Aid Global Concert)' },
  { date: '1986-05-20', label: '1986-05-20 (Mid-80s Billboard & Top Gun)' },
  { date: '1996-07-04', label: '1996-07-04 (Independence Day / Mid-90s)' },
];

interface DJBreakGeneratorTestProps {
  onLogEvent?: (msg: string) => void;
  onSpeakScript?: (scriptText: string) => void;
  onSpeakOverMusic?: (scriptText: string) => void;
  isMixingAudio?: boolean;
}

export function DJBreakGeneratorTest({
  onLogEvent,
  onSpeakScript,
  onSpeakOverMusic,
  isMixingAudio = false,
}: DJBreakGeneratorTestProps) {
  // Input parameters
  const [selectedDate, setSelectedDate] = useState<string>('1985-07-13');
  const [personality, setPersonality] = useState<StationPersonalityId>('mike');
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDay>('afternoon');
  const [format, setFormat] = useState<RadioFormat>('Top 40');
  const [songPlayed, setSongPlayed] = useState<string>('Wham! - Wake Me Up Before You Go-Go');
  const [songNext, setSongNext] = useState<string>('Dire Straits - Money for Nothing');
  const [secondsAvailable, setSecondsAvailable] = useState<number>(12);
  const [forceFresh, setForceFresh] = useState<boolean>(false);
  const [nationalFocus, setNationalFocus] = useState<boolean>(true); // ON by default: exclude NYC-local coverage

  // Execution & state
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [retryStatusText, setRetryStatusText] = useState<string | null>(null);
  const [result, setResult] = useState<BreakGeneratorResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isModelBusy, setIsModelBusy] = useState<boolean>(false);
  const [quotaExceeded, setQuotaExceeded] = useState<boolean>(false);
  const [sessionStats, setSessionStats] = useState<DJBreakSessionStats>({
    textModelCalls: 0,
    cacheHits: 0,
  });

  // Track currently speaking break
  const [speakingBreakId, setSpeakingBreakId] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/dj-break/stats');
      if (res.ok) {
        const data = await res.json();
        if (data.stats) setSessionStats(data.stats);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const handleGenerate = async (overrideDate?: string) => {
    const target = overrideDate || selectedDate;
    if (!target) return;

    setIsGenerating(true);
    setRetryStatusText(null);
    setErrorMsg(null);
    setIsModelBusy(false);
    setQuotaExceeded(false);

    onLogEvent?.(
      `[DJ Break] Requesting 3 breaks for ${target} (${personality}, ${timeOfDay}, ${secondsAvailable}s, nationalFocus=${nationalFocus}, forceFresh=${forceFresh})...`
    );

    // Client-side retry orchestration for 503 / UNAVAILABLE
    const maxRetries = 3;
    const retryDelaysMs = [2000, 5000, 10000];
    let finalData: BreakGeneratorResult | null = null;
    let finalError: string | null = null;
    let isQuota = false;
    let isUnavailable = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const waitMs = retryDelaysMs[attempt - 1];
        setRetryStatusText(`Model busy, retrying (${attempt} of 3)...`);
        onLogEvent?.(`[DJ Break] Model busy, waiting ${waitMs / 1000}s before retry (${attempt} of 3)...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      try {
        const res = await fetch('/api/dj-break/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetDate: target,
            personality,
            timeOfDay,
            format,
            songPlayed,
            songNext,
            secondsAvailable,
            forceFresh,
            nationalFocus,
          }),
        });

        const data: BreakGeneratorResult = await res.json();

        if (data && (data as any).stats) {
          setSessionStats((data as any).stats);
        }

        if (res.ok && data.success) {
          finalData = data;
          break; // Succeeded!
        }

        // Check if 429 quota error -> do NOT auto-retry quota errors
        if (res.status === 429 || data.quotaExceeded) {
          isQuota = true;
          finalError = data.error || 'Gemini API text model quota limit reached (429 RESOURCE_EXHAUSTED).';
          break;
        }

        // Check if 503 or model unavailable -> eligible for retry
        const is503 = res.status === 503 || data.isUnavailable || (data.error || '').toLowerCase().includes('busy') || (data.error || '').toLowerCase().includes('unavailable');
        if (is503) {
          isUnavailable = true;
          finalError = data.error || 'Model is busy right now, try again in a few minutes.';
          if (attempt < maxRetries) {
            continue; // Proceed to next retry attempt
          }
        } else {
          // Other client/server error
          finalError = data.error || `HTTP ${res.status}: Failed to generate DJ breaks.`;
          break;
        }
      } catch (err: any) {
        finalError = err?.message || 'Network error requesting DJ breaks';
        if (attempt < maxRetries) {
          isUnavailable = true;
          continue;
        }
        break;
      }
    }

    setRetryStatusText(null);
    setIsGenerating(false);

    if (finalData && finalData.success) {
      setResult(finalData);
      onLogEvent?.(
        `[DJ Break] Successfully generated 3 breaks for ${target} (${finalData.callsUsedThisRun || 2} calls used, Model: ${finalData.modelUsed || 'Gemini'}, Cached: ${Boolean(finalData.cached)}).`
      );
    } else if (isQuota) {
      setQuotaExceeded(true);
      setErrorMsg(finalError);
      setResult(null);
      onLogEvent?.(`[DJ Break Quota Limit] ${finalError}`);
    } else if (isUnavailable) {
      setIsModelBusy(true);
      setErrorMsg(finalError || 'Model is busy right now, try again in a few minutes.');
      setResult(null);
      onLogEvent?.(`[DJ Break Unavailable] All retries exhausted: ${finalError}`);
    } else {
      setErrorMsg(finalError || 'Generation failed.');
      setResult(null);
      onLogEvent?.(`[DJ Break Error] ${finalError}`);
    }

    fetchStats();
  };

  const handleSpeakSolo = (b: GeneratedDJBreak) => {
    setSpeakingBreakId(b.id);
    if (onSpeakScript) {
      onSpeakScript(b.scriptText);
    } else if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(b.scriptText);
      u.rate = 1.05;
      u.onend = () => setSpeakingBreakId(null);
      u.onerror = () => setSpeakingBreakId(null);
      window.speechSynthesis.speak(u);
    }
  };

  const handleSpeakOverMusicMix = (b: GeneratedDJBreak) => {
    setSpeakingBreakId(b.id);
    if (onSpeakOverMusic) {
      onSpeakOverMusic(b.scriptText);
    }
  };

  const getCategoryBadge = (cat: string) => {
    const colors: Record<string, string> = {
      news: 'bg-blue-950/70 border-blue-800 text-blue-300',
      sports: 'bg-emerald-950/70 border-emerald-800 text-emerald-300',
      'movies-tv-arts': 'bg-purple-950/70 border-purple-800 text-purple-300',
      music: 'bg-amber-950/70 border-amber-700 text-amber-300',
      business: 'bg-cyan-950/70 border-cyan-800 text-cyan-300',
      other: 'bg-zinc-900 border-zinc-700 text-zinc-400',
    };
    return (
      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono border ${colors[cat] || colors.other}`}>
        {cat}
      </span>
    );
  };

  return (
    <div className="bg-[#13161f] border border-amber-500/50 rounded-lg p-5 shadow-2xl space-y-6 font-mono text-xs">
      {/* Header */}
      <div className="border-b border-zinc-800 pb-3 flex flex-col md:flex-row md:items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <Mic2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold tracking-wider text-amber-400 uppercase">
              DJ BREAK GENERATOR TEST
            </h2>
            <p className="text-[11px] text-zinc-400">
              Generates 3 authentic period-accurate radio breaks in 2 model calls with dual anachronism verification.
            </p>
          </div>
        </div>

        {/* Text Model Call Session Pill */}
        <div className="flex items-center gap-3 bg-[#0a0c10] border border-zinc-800 rounded px-3 py-1.5 text-[11px]">
          <span className="text-zinc-500 uppercase font-semibold">Gemini Text Model Calls:</span>
          <span className="text-zinc-300">
            Session Calls: <strong className="text-amber-400">{sessionStats.textModelCalls}</strong>
          </span>
          <span className="text-zinc-700">&bull;</span>
          <span className="text-zinc-300">
            Cache Hits: <strong className="text-emerald-400">{sessionStats.cacheHits}</strong>
          </span>
        </div>
      </div>

      {/* Date Presets Row */}
      <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded space-y-2">
        <span className="text-[10px] uppercase text-zinc-400 font-bold block">
          Historical Date Presets:
        </span>
        <div className="flex flex-wrap gap-2">
          {HISTORICAL_PRESET_DATES.map((preset) => {
            const isSelected = selectedDate === preset.date;
            return (
              <button
                key={preset.date}
                onClick={() => {
                  setSelectedDate(preset.date);
                  handleGenerate(preset.date);
                }}
                disabled={isGenerating}
                className={`px-2.5 py-1.5 rounded text-[11px] font-mono transition-colors border cursor-pointer ${
                  isSelected
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                    : 'bg-zinc-900/80 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
                }`}
              >
                <span>{preset.date}</span>
                <span className="text-zinc-500 text-[10px] ml-1">
                  ({preset.label.split('(')[1]?.replace(')', '') || ''})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Inputs Grid */}
      <div className="p-4 bg-[#0a0c10] border border-zinc-800 rounded space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {/* Target Date Input */}
          <div>
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Target Date (YYYY-MM-DD):
            </label>
            <input
              type="text"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value.trim())}
              placeholder="1985-07-13"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
            />
          </div>

          {/* Personality */}
          <div>
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Station Personality:
            </label>
            <select
              value={personality}
              onChange={(e) => setPersonality(e.target.value as StationPersonalityId)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500 cursor-pointer"
            >
              <option value="mike">Mike (Male, Late 30s, Dry Humor, Irreverent)</option>
              <option value="lisa">Lisa (Female, Early 20s, Energetic, Pop-Culture)</option>
            </select>
          </div>

          {/* Time of Day */}
          <div>
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Time of Day:
            </label>
            <select
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value as TimeOfDay)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500 cursor-pointer"
            >
              <option value="morning">Morning (Drive Time)</option>
              <option value="afternoon">Afternoon</option>
              <option value="evening">Evening</option>
              <option value="late night">Late Night</option>
            </select>
          </div>

          {/* Radio Format */}
          <div>
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Station Format:
            </label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as RadioFormat)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500 cursor-pointer"
            >
              <option value="Top 40">Top 40 (Contemporary Hit Radio)</option>
            </select>
          </div>
        </div>

        {/* Songs & Time Available */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 pt-1">
          <div className="sm:col-span-5">
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Song Just Finished:
            </label>
            <input
              type="text"
              value={songPlayed}
              onChange={(e) => setSongPlayed(e.target.value)}
              placeholder="e.g. Wham! - Wake Me Up Before You Go-Go"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="sm:col-span-5">
            <label className="text-[11px] text-zinc-400 font-semibold block mb-1 uppercase">
              Next Song Starting:
            </label>
            <input
              type="text"
              value={songNext}
              onChange={(e) => setSongNext(e.target.value)}
              placeholder="e.g. Dire Straits - Money for Nothing"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="sm:col-span-2">
            <div className="flex justify-between items-center mb-1">
              <label className="text-[11px] text-zinc-400 font-semibold uppercase">
                Airtime:
              </label>
              <span className="text-amber-400 font-bold">{secondsAvailable}s</span>
            </div>
            <input
              type="range"
              min="5"
              max="20"
              value={secondsAvailable}
              onChange={(e) => setSecondsAvailable(Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
            <span className="text-[10px] text-zinc-500 block text-center">
              ~{Math.round(secondsAvailable * 2.5)} words
            </span>
          </div>
        </div>

        {/* Submit, Retrying Notice, & Options */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-zinc-800">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-zinc-300 select-none">
              <input
                type="checkbox"
                checked={nationalFocus}
                onChange={(e) => setNationalFocus(e.target.checked)}
                className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 cursor-pointer"
              />
              <span className="flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-amber-400" />
                <span>National focus (exclude NYC-local)</span>
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-zinc-300 select-none">
              <input
                type="checkbox"
                checked={forceFresh}
                onChange={(e) => setForceFresh(e.target.checked)}
                className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 cursor-pointer"
              />
              <span>Force fresh (bypass cache)</span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            {retryStatusText && (
              <span className="text-amber-400 font-semibold flex items-center gap-1.5 text-xs animate-pulse">
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
                <span>{retryStatusText}</span>
              </span>
            )}

            <button
              onClick={() => handleGenerate()}
              disabled={isGenerating || !selectedDate}
              className="px-6 py-2.5 rounded bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>
                {isGenerating
                  ? retryStatusText || 'Generating 3 Breaks (2 calls)...'
                  : 'Generate 3 Breaks'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Model Busy Banner (Amber with Retry button) */}
      {isModelBusy && (
        <div className="p-3.5 rounded bg-amber-950/70 border border-amber-600/80 text-amber-200 text-xs flex items-center justify-between gap-3 shadow-lg">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <strong className="uppercase font-bold tracking-wider text-amber-300 block mb-0.5">
                Model is busy right now, try again in a few minutes
              </strong>
              <p className="text-[11px] text-amber-200/90 leading-relaxed">
                The Gemini model returned temporary 503 unavailable errors after automatic retry attempts. This error is not cached.
              </p>
            </div>
          </div>
          <button
            onClick={() => handleGenerate()}
            disabled={isGenerating}
            className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs uppercase transition-colors shrink-0 cursor-pointer shadow"
          >
            Retry Now
          </button>
        </div>
      )}

      {/* Quota Error Banner (Red/Amber without retry button) */}
      {quotaExceeded && (
        <div className="p-3.5 rounded bg-rose-950/60 border border-rose-700 text-rose-200 text-xs flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
          <div className="space-y-1">
            <strong className="uppercase font-bold tracking-wider text-rose-300">
              Gemini Text Model Quota Limit Exceeded (429)
            </strong>
            <p className="leading-relaxed text-[11px] text-rose-200/90">
              {errorMsg}
            </p>
            <p className="text-[10px] text-zinc-400">
              Daily quota limit reached. Cached runs for tested dates will still load without consuming API quota.
            </p>
          </div>
        </div>
      )}

      {/* General Error Banner */}
      {!quotaExceeded && !isModelBusy && errorMsg && (
        <div className="p-3.5 rounded bg-rose-950/60 border border-rose-800 text-rose-300 text-xs flex items-start gap-2">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Generated 3 Breaks Output Display */}
      {result && result.breaks && result.breaks.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-400" />
              <span className="text-zinc-200 font-bold uppercase tracking-wider">
                GENERATED BREAK VARIATIONS ({result.breaks.length}) &bull; {result.targetDate}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                result.nationalFocusEnabled !== false
                  ? 'bg-amber-500/10 border-amber-500/40 text-amber-300'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-400'
              }`}>
                Filter: {result.nationalFocusEnabled !== false ? 'National Focus (NYC Excluded)' : 'All Items'}
              </span>
              <span>&bull;</span>
              <span>Persona: <strong className="text-amber-400 capitalize">{result.personality}</strong> ({result.timeOfDay})</span>
              <span>&bull;</span>
              <span>Target: <strong className="text-zinc-200">{result.secondsAvailable}s</strong></span>
              <span>&bull;</span>
              <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 text-[10px]">
                Model: <strong className="text-amber-300">{result.modelUsed || 'Gemini'}</strong> ({result.callsUsedThisRun || 2} calls)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {result.breaks.map((b) => {
              const isPass = b.anachronismCheck?.status === 'PASS';
              const isSpeaking = speakingBreakId === b.id;

              return (
                <div
                  key={b.id}
                  className="p-4 bg-[#0a0c10] border border-zinc-800 rounded-lg flex flex-col justify-between space-y-4 hover:border-zinc-700 transition-colors shadow-lg"
                >
                  <div className="space-y-3">
                    {/* Card Header */}
                    <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-amber-400 font-bold text-xs">
                          Break #{b.breakNumber}
                        </span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-mono border ${
                          result.nationalFocusEnabled !== false
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                        }`}>
                          {result.nationalFocusEnabled !== false ? 'National Focus' : 'All NYT'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                        <span>{b.wordCount} words</span>
                        <span>&bull;</span>
                        <span className="text-zinc-300 font-semibold">
                          ~{b.estimatedSeconds}s (at 2.5 wps)
                        </span>
                      </div>
                    </div>

                    {/* Script Text */}
                    <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded text-zinc-100 text-xs leading-relaxed font-sans italic">
                      "{b.scriptText}"
                    </div>

                    {/* Anachronism Check Pill */}
                    <div
                      className={`p-2 rounded border text-[11px] space-y-1 ${
                        isPass
                          ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                          : 'bg-rose-950/60 border-rose-800 text-rose-300'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span className="flex items-center gap-1.5">
                          {isPass ? (
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                          )}
                          <span>Chronological Audit: {b.anachronismCheck.status}</span>
                        </span>
                      </div>
                      <p className="text-[10px] leading-normal text-zinc-300 font-mono">
                        {b.anachronismCheck.notes}
                      </p>
                      {b.anachronismCheck.flaggedPhrases && b.anachronismCheck.flaggedPhrases.length > 0 && (
                        <div className="text-[10px] text-rose-400">
                          Flagged: {b.anachronismCheck.flaggedPhrases.join(', ')}
                        </div>
                      )}
                    </div>

                    {/* Fact Items Drawn From */}
                    <div className="space-y-1">
                      <span className="text-[10px] uppercase font-bold text-zinc-500 block">
                        Fact Packet Citations:
                      </span>
                      {b.citedItems && b.citedItems.length > 0 ? (
                        <div className="space-y-1">
                          {b.citedItems.map((c, cIdx) => (
                            <div
                              key={cIdx}
                              className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300"
                            >
                              <div className="font-semibold text-amber-300/90 truncate" title={c.headline}>
                                &bull; {c.headline}
                              </div>
                              <div className="text-zinc-500 text-[9px] mt-0.5">
                                Published: {c.publishedDate}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-600 italic">
                          No direct headline cited; drew from general period context.
                        </span>
                      )}
                    </div>

                    {/* Show the Fact Selection: All fact packet items provided to the model */}
                    <div className="pt-2 border-t border-zinc-850 space-y-1.5">
                      <div className="flex items-center justify-between text-[10px] text-zinc-400">
                        <span className="uppercase font-bold text-zinc-500">
                          Full Fact Selection Provided ({result.providedFactItems?.length || 0}):
                        </span>
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1 bg-zinc-950/70 p-1.5 rounded border border-zinc-900">
                        {result.providedFactItems && result.providedFactItems.length > 0 ? (
                          result.providedFactItems.map((item, fIdx) => (
                            <div
                              key={fIdx}
                              className="text-[10px] text-zinc-400 leading-snug flex items-start gap-1.5"
                            >
                              <span className="shrink-0">{getCategoryBadge(item.category)}</span>
                              <span className="text-zinc-300 truncate" title={item.headline}>
                                {item.headline}
                              </span>
                            </div>
                          ))
                        ) : (
                          <span className="text-[10px] text-zinc-600 italic">
                            No external items provided.
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Audio Playback Action Buttons */}
                  <div className="pt-2 border-t border-zinc-800 flex flex-col gap-2">
                    <button
                      onClick={() => handleSpeakSolo(b)}
                      className="w-full py-2 px-3 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{isSpeaking ? 'Speaking Solo...' : 'Speak Solo'}</span>
                    </button>

                    <button
                      onClick={() => handleSpeakOverMusicMix(b)}
                      disabled={isMixingAudio}
                      className="w-full py-2 px-3 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/60 disabled:opacity-50 text-amber-300 text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Radio className={`w-3.5 h-3.5 text-amber-400 ${isMixingAudio ? 'animate-spin' : ''}`} />
                      <span>{isMixingAudio ? 'Mixing Audio...' : 'Speak Over Music (Ducking)'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

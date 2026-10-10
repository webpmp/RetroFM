/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState, useEffect, useRef } from 'react';
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
  const [currentStep, setCurrentStep] = useState<1 | 2 | null>(null);
  const [stepElapsedSeconds, setStepElapsedSeconds] = useState<number>(0);
  const [activeModelName, setActiveModelName] = useState<string>('gemini-3.8-flash');
  const [retryStatusText, setRetryStatusText] = useState<string | null>(null);
  const [result, setResult] = useState<BreakGeneratorResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isModelBusy, setIsModelBusy] = useState<boolean>(false);
  const [quotaExceeded, setQuotaExceeded] = useState<boolean>(false);
  const [sessionStats, setSessionStats] = useState<DJBreakSessionStats>({
    textModelCalls: 0,
    cacheHits: 0,
  });

  // Call Activity Log state
  const [callLogs, setCallLogs] = useState<
    Array<{
      id: string;
      step: string;
      startTime: string;
      durationSec: number;
      model: string;
      status: 'SUCCESS' | 'FAILED';
      details: string;
    }>
  >([]);

  // Refs for timers and cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  const elapsedTimerRef = useRef<any>(null);

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
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    setIsGenerating(false);
    setCurrentStep(null);
    setRetryStatusText(null);

    // If step 1 already produced breaks, keep them displayed with "Audit unavailable"
    setResult((prev) => {
      if (!prev || !prev.breaks || prev.breaks.length === 0) return null;
      return {
        ...prev,
        breaks: prev.breaks.map((b) => ({
          ...b,
          anachronismCheck:
            b.anachronismCheck?.status === 'CHECKING'
              ? {
                  status: 'UNAVAILABLE' as const,
                  notes: 'Audit cancelled by user.',
                  flaggedPhrases: [],
                }
              : b.anachronismCheck,
        })),
        auditUnavailable: true,
      };
    });

    onLogEvent?.('[DJ Break] Generation cancelled by user. Generate re-enabled.');
  };

  const handleGenerate = async (overrideDate?: string) => {
    const target = overrideDate || selectedDate;
    if (!target) return;

    setErrorMsg(null);
    setIsModelBusy(false);
    setQuotaExceeded(false);
    setRetryStatusText(null);

    // Start Step 1
    setIsGenerating(true);
    setCurrentStep(1);
    setStepElapsedSeconds(0);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Start live elapsed timer
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    const step1StartMs = Date.now();
    const step1StartTimeStr = new Date(step1StartMs).toLocaleTimeString();
    elapsedTimerRef.current = setInterval(() => {
      setStepElapsedSeconds((s) => s + 1);
    }, 1000);

    onLogEvent?.(
      `[DJ Break Step 1] Starting Step 1 of 2: writing 3 breaks for ${target} (${personality}, ${timeOfDay}, ${secondsAvailable}s, nationalFocus=${nationalFocus}, forceFresh=${forceFresh})...`
    );

    let step1Data: BreakGeneratorResult | null = null;

    try {
      const res = await fetch('/api/dj-break/step1-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
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

      const data = await res.json();
      const step1DurSec = Number(((Date.now() - step1StartMs) / 1000).toFixed(1));
      const model = data.modelUsed || activeModelName;
      if (model) setActiveModelName(model);

      if (data && data.stats) {
        setSessionStats(data.stats);
      }

      if (res.ok && data.success) {
        step1Data = data;

        // If returned from cache, both breaks and audits are already done!
        if (data.cached) {
          if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
          setIsGenerating(false);
          setCurrentStep(null);
          setResult(data);

          const logMsg = `[DJ Break Cache Hit] Started at ${step1StartTimeStr} | Model: ${model} | Duration: ${step1DurSec}s | Status: SUCCESS (loaded from disk cache)`;
          onLogEvent?.(logMsg);
          setCallLogs((prev) => [
            {
              id: `log_${Date.now()}`,
              step: 'Step 1: Write (Cache Hit)',
              startTime: step1StartTimeStr,
              durationSec: step1DurSec,
              model,
              status: 'SUCCESS',
              details: 'Loaded 3 breaks from disk cache.',
            },
            ...prev,
          ]);
          fetchStats();
          return;
        }

        // Step 1 Success: Log immediately
        const logMsg = `[DJ Break Step 1] Started at ${step1StartTimeStr} | Model: ${model} | Duration: ${step1DurSec}s | Status: SUCCESS (3 breaks generated)`;
        onLogEvent?.(logMsg);
        setCallLogs((prev) => [
          {
            id: `log_${Date.now()}`,
            step: 'Step 1: Write',
            startTime: step1StartTimeStr,
            durationSec: step1DurSec,
            model,
            status: 'SUCCESS',
            details: 'Successfully generated 3 breaks (audit status: checking…).',
          },
          ...prev,
        ]);

        // CRITICAL REQUIREMENT: Show breaks after step 1 immediately with status "checking..."
        setResult(data);
      } else {
        // Step 1 Failed or timed out
        if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
        setIsGenerating(false);
        setCurrentStep(null);

        const isQuota = res.status === 429 || data.quotaExceeded;
        const isTimeout = res.status === 504 || data.stepTimedOut === 'step1' || (data.error || '').toLowerCase().includes('timeout');
        const err = data.error || (isTimeout ? 'Step 1 (writing 3 breaks) timed out after 45s.' : 'Step 1 failed.');

        if (isQuota) setQuotaExceeded(true);
        setErrorMsg(err);

        const logMsg = `[DJ Break Step 1] Started at ${step1StartTimeStr} | Model: ${model} | Duration: ${step1DurSec}s | Status: FAILED - ${err}`;
        onLogEvent?.(logMsg);
        setCallLogs((prev) => [
          {
            id: `log_${Date.now()}`,
            step: 'Step 1: Write',
            startTime: step1StartTimeStr,
            durationSec: step1DurSec,
            model,
            status: 'FAILED',
            details: err,
          },
          ...prev,
        ]);
        fetchStats();
        return;
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        return; // Handled by handleCancel
      }
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      setIsGenerating(false);
      setCurrentStep(null);

      const step1DurSec = Number(((Date.now() - step1StartMs) / 1000).toFixed(1));
      const errMsg = err?.message || 'Network error during Step 1';
      setErrorMsg(errMsg);
      const logMsg = `[DJ Break Step 1] Started at ${step1StartTimeStr} | Model: ${activeModelName} | Duration: ${step1DurSec}s | Status: FAILED - ${errMsg}`;
      onLogEvent?.(logMsg);
      setCallLogs((prev) => [
        {
          id: `log_${Date.now()}`,
          step: 'Step 1: Write',
          startTime: step1StartTimeStr,
          durationSec: step1DurSec,
          model: activeModelName,
          status: 'FAILED',
          details: errMsg,
        },
        ...prev,
      ]);
      fetchStats();
      return;
    }

    // --- Transition to Step 2: checking for anachronisms ---
    if (!step1Data || !step1Data.breaks || step1Data.breaks.length === 0) {
      setIsGenerating(false);
      setCurrentStep(null);
      fetchStats();
      return;
    }

    setCurrentStep(2);
    setStepElapsedSeconds(0);

    const step2StartMs = Date.now();
    const step2StartTimeStr = new Date(step2StartMs).toLocaleTimeString();
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = setInterval(() => {
      setStepElapsedSeconds((s) => s + 1);
    }, 1000);

    onLogEvent?.(
      `[DJ Break Step 2] Starting Step 2 of 2: checking for anachronisms for ${target}...`
    );

    try {
      const auditRes = await fetch('/api/dj-break/step2-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          breaks: step1Data.breaks,
          targetDate: target,
          modelUsed: step1Data.modelUsed || activeModelName,
          personality,
          timeOfDay,
          format,
          songPlayed,
          songNext,
          secondsAvailable,
          nationalFocus,
          providedFactItems: step1Data.providedFactItems,
        }),
      });

      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      setIsGenerating(false);
      setCurrentStep(null);

      const auditData = await auditRes.json();
      const step2DurSec = Number(((Date.now() - step2StartMs) / 1000).toFixed(1));
      const model = auditData.modelUsed || step1Data.modelUsed || activeModelName;

      if (auditData && auditData.stats) {
        setSessionStats(auditData.stats);
      }

      if (auditRes.ok && auditData.success && !auditData.auditUnavailable) {
        // Step 2 Success: Update each card with audit findings
        setResult((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            breaks: auditData.breaks,
            callsUsedThisRun: 2,
            auditCompleted: true,
          };
        });

        const logMsg = `[DJ Break Step 2] Started at ${step2StartTimeStr} | Model: ${model} | Duration: ${step2DurSec}s | Status: SUCCESS (anachronism audit complete)`;
        onLogEvent?.(logMsg);
        setCallLogs((prev) => [
          {
            id: `log_${Date.now()}`,
            step: 'Step 2: Audit',
            startTime: step2StartTimeStr,
            durationSec: step2DurSec,
            model,
            status: 'SUCCESS',
            details: 'Anachronism audit completed for all 3 breaks.',
          },
          ...prev,
        ]);
      } else {
        // Step 2 failed or timed out: show breaks anyway with "Audit unavailable"
        const errReason =
          auditData.error ||
          (auditData.stepTimedOut === 'step2'
            ? 'Step 2 (anachronism audit) timed out after 45s.'
            : 'Audit unavailable');

        setResult((prev) => {
          if (!prev) return null;
          const fallbackBreaks = prev.breaks.map((b: any) => ({
            ...b,
            anachronismCheck: {
              status: 'UNAVAILABLE' as const,
              notes: `Audit unavailable: ${errReason}`,
              flaggedPhrases: [],
            },
          }));
          return {
            ...prev,
            breaks: fallbackBreaks,
            callsUsedThisRun: 2,
            auditUnavailable: true,
          };
        });

        const logMsg = `[DJ Break Step 2] Started at ${step2StartTimeStr} | Model: ${model} | Duration: ${step2DurSec}s | Status: FAILED - ${errReason}`;
        onLogEvent?.(logMsg);
        setCallLogs((prev) => [
          {
            id: `log_${Date.now()}`,
            step: 'Step 2: Audit',
            startTime: step2StartTimeStr,
            durationSec: step2DurSec,
            model,
            status: 'FAILED',
            details: errReason,
          },
          ...prev,
        ]);
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        return; // Handled by handleCancel
      }
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      setIsGenerating(false);
      setCurrentStep(null);

      const step2DurSec = Number(((Date.now() - step2StartMs) / 1000).toFixed(1));
      const errMsg = err?.message || 'Network error during Step 2';

      // Keep breaks displayed with "Audit unavailable"
      setResult((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          breaks: prev.breaks.map((b: any) => ({
            ...b,
            anachronismCheck: {
              status: 'UNAVAILABLE' as const,
              notes: `Audit unavailable: ${errMsg}`,
              flaggedPhrases: [],
            },
          })),
          auditUnavailable: true,
        };
      });

      const logMsg = `[DJ Break Step 2] Started at ${step2StartTimeStr} | Model: ${activeModelName} | Duration: ${step2DurSec}s | Status: FAILED - ${errMsg}`;
      onLogEvent?.(logMsg);
      setCallLogs((prev) => [
        {
          id: `log_${Date.now()}`,
          step: 'Step 2: Audit',
          startTime: step2StartTimeStr,
          durationSec: step2DurSec,
          model: activeModelName,
          status: 'FAILED',
          details: errMsg,
        },
        ...prev,
      ]);
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

          <div className="flex flex-wrap items-center gap-3">
            {retryStatusText && (
              <span className="text-amber-400 font-semibold flex items-center gap-1.5 text-xs animate-pulse">
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
                <span>{retryStatusText}</span>
              </span>
            )}

            {isGenerating && (
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2.5 rounded bg-red-950/80 hover:bg-red-900 border border-red-700 text-red-200 font-mono font-bold text-xs uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
                title="Stop waiting and re-enable Generate"
              >
                <XCircle className="w-4 h-4 text-red-400" />
                <span>Cancel</span>
              </button>
            )}

            <button
              onClick={() => handleGenerate()}
              disabled={isGenerating || !selectedDate}
              className="px-6 py-2.5 rounded bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
            >
              <Sparkles className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
              <span>
                {isGenerating
                  ? currentStep === 1
                    ? `Writing 3 Breaks (${stepElapsedSeconds}s)...`
                    : `Checking Anachronisms (${stepElapsedSeconds}s)...`
                  : 'Generate 3 Breaks'}
              </span>
            </button>
          </div>
        </div>

        {/* Live Step Progress Display */}
        {isGenerating && (
          <div className="mt-3 p-3 rounded-lg bg-amber-950/40 border border-amber-800/80 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-pulse">
            <div className="flex items-center gap-2.5">
              <RotateCw className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <div className="font-mono">
                <span className="text-amber-300 font-bold">
                  {currentStep === 1
                    ? `Step 1 of 2: writing 3 breaks (elapsed ${stepElapsedSeconds}s)`
                    : `Step 2 of 2: checking for anachronisms (elapsed ${stepElapsedSeconds}s)`}
                </span>
                <span className="text-zinc-500 mx-2">&bull;</span>
                <span className="text-zinc-400 text-[11px]">
                  Model: <strong className="text-zinc-200">{activeModelName}</strong>
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1 rounded bg-red-950 hover:bg-red-900 border border-red-700 text-red-200 text-xs font-mono font-semibold flex items-center gap-1.5 self-start sm:self-auto cursor-pointer"
            >
              <XCircle className="w-3.5 h-3.5 text-red-400" />
              <span>Cancel</span>
            </button>
          </div>
        )}
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
              const isChecking = b.anachronismCheck?.status === 'CHECKING' || (b.anachronismCheck?.status as any) === 'checking…';
              const isUnavailable = b.anachronismCheck?.status === 'UNAVAILABLE';
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
                      className={`p-2.5 rounded border text-[11px] space-y-1 transition-all ${
                        isChecking
                          ? 'bg-amber-950/40 border-amber-700/80 text-amber-300'
                          : isUnavailable
                          ? 'bg-zinc-900 border-zinc-700 text-zinc-300'
                          : isPass
                          ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                          : 'bg-rose-950/60 border-rose-800 text-rose-300'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span className="flex items-center gap-1.5">
                          {isChecking ? (
                            <RotateCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                          ) : isUnavailable ? (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          ) : isPass ? (
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                          )}
                          <span>
                            Chronological Audit:{' '}
                            {isChecking
                              ? 'checking…'
                              : isUnavailable
                              ? 'Audit unavailable'
                              : b.anachronismCheck?.status}
                          </span>
                        </span>
                      </div>
                      <p className="text-[10px] leading-normal text-zinc-300 font-mono">
                        {isChecking
                          ? `Auditing chronological authenticity for ${result.targetDate}...`
                          : b.anachronismCheck?.notes}
                      </p>
                      {b.anachronismCheck?.flaggedPhrases && b.anachronismCheck.flaggedPhrases.length > 0 && (
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
      {/* Model Call Activity Log */}
      {callLogs.length > 0 && (
        <div className="mt-4 pt-4 border-t border-zinc-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>Model Call Activity Log ({callLogs.length} logged)</span>
            </span>
            <button
              type="button"
              onClick={() => setCallLogs([])}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 font-mono transition-colors"
            >
              Clear log
            </button>
          </div>
          <div className="bg-[#0a0c10] border border-zinc-800 rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono">
                <thead>
                  <tr className="bg-zinc-900/80 border-b border-zinc-800 text-zinc-400">
                    <th className="py-1.5 px-3">Step</th>
                    <th className="py-1.5 px-3">Start Time</th>
                    <th className="py-1.5 px-3">Duration</th>
                    <th className="py-1.5 px-3">Model</th>
                    <th className="py-1.5 px-3">Status</th>
                    <th className="py-1.5 px-3">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-850">
                  {callLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-zinc-900/40">
                      <td className="py-1.5 px-3 text-zinc-300 font-semibold">{log.step}</td>
                      <td className="py-1.5 px-3 text-zinc-400">{log.startTime}</td>
                      <td className="py-1.5 px-3 text-zinc-300">{log.durationSec}s</td>
                      <td className="py-1.5 px-3 text-amber-300">{log.model}</td>
                      <td className="py-1.5 px-3">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            log.status === 'SUCCESS'
                              ? 'bg-emerald-950/70 border border-emerald-800 text-emerald-300'
                              : 'bg-rose-950/70 border border-rose-800 text-rose-300'
                          }`}
                        >
                          {log.status}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-zinc-400 truncate max-w-xs" title={log.details}>
                        {log.details}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

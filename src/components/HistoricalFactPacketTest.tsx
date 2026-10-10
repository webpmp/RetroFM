/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState, useEffect } from 'react';
import {
  Calendar,
  Play,
  RotateCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Code,
  Layers,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Table,
  Eye,
  RefreshCw,
  Clock,
  Sparkles,
  Filter,
} from 'lucide-react';
import {
  FactPacket,
  ProviderFactResult,
  ProviderStatus,
  FactItem,
  ExcludedFactItem,
  FactSessionStats,
} from '../services/news/types.js';

export const HISTORICAL_PRESET_DATES = [
  { date: '1969-07-21', label: '1969-07-21 (Apollo 11 Moon Landing)' },
  { date: '1977-05-26', label: '1977-05-26 (Star Wars Premieres & UK Punk Wave)' },
  { date: '1985-07-13', label: '1985-07-13 (Live Aid Global Concert)' },
  { date: '1986-05-20', label: '1986-05-20 (Mid-80s Billboard & Top Gun)' },
  { date: '1996-07-04', label: '1996-07-04 (Independence Day / Mid-90s)' },
];

const PROVIDER_INFO: Record<string, { name: string; keyName: string; note: string }> = {
  newsapi: {
    name: 'NewsAPI.org',
    keyName: 'NEWSAPI_KEY',
    note: 'Developer tier restricts /v2/everything to past 30 days. Historical queries (>1 mo) return out of range or empty without paid plan.',
  },
  newsdata: {
    name: 'NewsData.io',
    keyName: 'NEWSDATA_API_KEY',
    note: 'Standard tier searches recent articles (up to 48-72h); historical archive requires specialized plan.',
  },
  nyt: {
    name: 'New York Times (Archive API)',
    keyName: 'NYT_API_KEY',
    note: 'Full historical coverage from 1851 to present. Monthly endpoint filtered to target date plus 2 days prior. Spaced out calls to respect rate limits.',
  },
};

interface HistoricalFactPacketTestProps {
  onLogEvent?: (msg: string) => void;
}

export function HistoricalFactPacketTest({ onLogEvent }: HistoricalFactPacketTestProps) {
  const [selectedDate, setSelectedDate] = useState<string>('1985-07-13');
  const [forceFresh, setForceFresh] = useState<boolean>(false);
  const [nationalFocus, setNationalFocus] = useState<boolean>(true); // ON by default
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [factPacket, setFactPacket] = useState<FactPacket | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [providerConfig, setProviderConfig] = useState<Record<string, { configured: boolean; name: string }>>({});
  const [sessionStats, setSessionStats] = useState<FactSessionStats>({
    apiCalls: { newsapi: 0, newsdata: 0, nyt: 0 },
    cacheHits: { newsapi: 0, newsdata: 0, nyt: 0 },
  });

  // Track summary grid results per date: { [date]: { [provider]: { status, count } } }
  const [summaryGrid, setSummaryGrid] = useState<Record<string, Record<string, { status: ProviderStatus; count: number }>>>({});

  // Show raw JSON states per provider
  const [showRawJson, setShowRawJson] = useState<Record<string, boolean>>({
    newsapi: false,
    newsdata: false,
    nyt: false,
  });

  // Show excluded items accordion state
  const [showExcludedTable, setShowExcludedTable] = useState<boolean>(true);

  // Fetch initial configuration & session stats on mount
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/news/status');
      if (res.ok) {
        const data = await res.json();
        if (data.providers) setProviderConfig(data.providers);
        if (data.stats) setSessionStats(data.stats);
      }
    } catch (err) {
      console.warn('[HistoricalFactPacketTest] Could not fetch news status:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleRunTest = async (dateToRun?: string) => {
    const target = dateToRun || selectedDate;
    if (!target) return;

    setIsRunning(true);
    setTestError(null);
    onLogEvent?.(
      `[NEWS] Running Historical Fact Packet query for ${target} (nationalFocus=${nationalFocus}, forceFresh=${forceFresh})...`
    );

    try {
      const res = await fetch('/api/news/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDate: target,
          forceFresh,
          nationalFocus,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || `HTTP ${res.status}: Failed fetching facts`);
      }

      setFactPacket(data.packet);
      if (data.stats) {
        setSessionStats(data.stats);
      }

      // Update summary grid for this date
      if (data.packet?.results) {
        const gridEntry: Record<string, { status: ProviderStatus; count: number }> = {};
        for (const [pId, pRes] of Object.entries(data.packet.results as Record<string, ProviderFactResult>)) {
          gridEntry[pId] = {
            status: pRes.status,
            count: pRes.itemCount,
          };
        }
        setSummaryGrid((prev) => ({
          ...prev,
          [target]: gridEntry,
        }));
      }

      onLogEvent?.(
        `[NEWS] Fact Packet complete for ${target}: Kept ${data.packet?.keptCount ?? data.packet?.totalCount} items, Excluded ${data.packet?.excludedCount ?? 0} items (National focus: ${nationalFocus}).`
      );
    } catch (err: any) {
      const errMsg = err?.message || 'Error executing historical fact packet query';
      setTestError(errMsg);
      onLogEvent?.(`[NEWS] Error for ${target}: ${errMsg}`);
    } finally {
      setIsRunning(false);
      fetchStatus();
    }
  };

  const toggleRawJson = (provider: string) => {
    setShowRawJson((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  const getStatusBadge = (status: ProviderStatus) => {
    switch (status) {
      case 'OK':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-950/80 border border-emerald-700 text-emerald-300">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            OK
          </span>
        );
      case 'EMPTY':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-zinc-900 border border-zinc-700 text-zinc-400">
            <HelpCircle className="w-3 h-3 text-zinc-500" />
            EMPTY
          </span>
        );
      case 'NOT CONFIGURED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-950/60 border border-amber-800 text-amber-300">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            NOT CONFIGURED
          </span>
        );
      case 'OUT OF RANGE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-purple-950/60 border border-purple-800 text-purple-300">
            <Clock className="w-3 h-3 text-purple-400" />
            OUT OF RANGE
          </span>
        );
      case 'ERROR':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-rose-950/80 border border-rose-800 text-rose-300">
            <XCircle className="w-3 h-3 text-rose-400" />
            ERROR
          </span>
        );
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
            <Calendar className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold tracking-wider text-amber-400 uppercase">
              HISTORICAL FACT PACKET TEST
            </h2>
            <p className="text-[11px] text-zinc-400">
              Evaluates real historical events from the New York Times Archive API with national focus filtering.
            </p>
          </div>
        </div>

        {/* Running API Call Counter Pill */}
        <div className="flex items-center gap-3 bg-[#0a0c10] border border-zinc-800 rounded px-3 py-1.5 text-[11px]">
          <span className="text-zinc-500 uppercase font-semibold">Active Provider Calls:</span>
          <div className="flex items-center gap-2">
            <span title="NYT Archive API Calls" className="text-zinc-300">
              NYT Archive API: <strong className="text-amber-400">{sessionStats.apiCalls.nyt || 0}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Summary Grid for NYT Archive across 5 Dates */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
            <Table className="w-3.5 h-3.5 text-amber-400" />
            SUMMARY MATRIX (HISTORICAL DATES &times; NYT ARCHIVE)
          </span>
          <span className="text-[10px] text-zinc-500">
            (NewsAPI.org &amp; NewsData.io paused; NYT is the active historical news source)
          </span>
        </div>

        <div className="overflow-x-auto border border-zinc-800 rounded bg-[#0a0c10]">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400 uppercase tracking-wider text-[10px]">
                <th className="p-2.5 font-bold">Historical Date</th>
                <th className="p-2.5 font-bold">Active News Source (NYT Archive)</th>
                <th className="p-2.5 font-bold text-right">Quick Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {HISTORICAL_PRESET_DATES.map((preset) => {
                const row = summaryGrid[preset.date];
                const isCurrent = selectedDate === preset.date;
                return (
                  <tr
                    key={preset.date}
                    className={`hover:bg-zinc-800/30 transition-colors ${
                      isCurrent ? 'bg-amber-950/20' : ''
                    }`}
                  >
                    <td className="p-2.5 font-semibold text-zinc-200">
                      <div className="flex items-center gap-1.5">
                        <span className="text-amber-400">{preset.date}</span>
                        <span className="text-zinc-500 text-[10px] truncate max-w-[280px]">
                          ({preset.label.split('(')[1]?.replace(')', '') || ''})
                        </span>
                      </div>
                    </td>

                    {/* NYT Archive cell */}
                    <td className="p-2.5">
                      {row?.nyt ? (
                        <div className="flex items-center gap-1.5">
                          {getStatusBadge(row.nyt.status)}
                          <span className="text-zinc-400 font-bold">({row.nyt.count} items)</span>
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>

                    {/* Run Preset Button */}
                    <td className="p-2.5 text-right">
                      <button
                        onClick={() => {
                          setSelectedDate(preset.date);
                          handleRunTest(preset.date);
                        }}
                        disabled={isRunning}
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50 text-[10px] font-bold text-amber-300 transition-colors cursor-pointer"
                      >
                        {isRunning && selectedDate === preset.date ? 'Testing...' : 'Run Date'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Input Controls, National Focus Checkbox, & Date Presets */}
      <div className="p-4 bg-[#0a0c10] border border-zinc-800 rounded space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <label className="text-[11px] text-zinc-400 block mb-1 font-semibold uppercase">
                Target Date (YYYY-MM-DD):
              </label>
              <input
                type="text"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value.trim())}
                placeholder="1985-07-13"
                className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-amber-500 w-36"
              />
            </div>

            {/* National Focus Checkbox (ON by default) */}
            <div className="pt-4">
              <label className="flex items-center gap-2 cursor-pointer text-zinc-200 select-none bg-zinc-900/80 px-2.5 py-1.5 rounded border border-zinc-700 hover:border-amber-500 transition-colors">
                <input
                  type="checkbox"
                  checked={nationalFocus}
                  onChange={(e) => setNationalFocus(e.target.checked)}
                  className="rounded bg-black border-zinc-600 text-amber-500 focus:ring-0 cursor-pointer w-4 h-4"
                />
                <span className="font-bold text-amber-300 flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5" />
                  National focus (exclude NYC-local)
                </span>
              </label>
            </div>

            {/* Force Fresh Toggle */}
            <div className="pt-4">
              <label className="flex items-center gap-1.5 cursor-pointer text-zinc-400 select-none text-[11px]">
                <input
                  type="checkbox"
                  checked={forceFresh}
                  onChange={(e) => setForceFresh(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 cursor-pointer"
                />
                <span>Force fresh API query</span>
              </label>
            </div>
          </div>

          <button
            onClick={() => handleRunTest()}
            disabled={isRunning || !selectedDate}
            className="px-5 py-2.5 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Querying Cache...' : 'Run Fact Packet Query'}</span>
          </button>
        </div>

        {/* 5 Preset Buttons */}
        <div>
          <span className="text-[10px] uppercase text-zinc-500 font-bold block mb-1.5">
            Preset Test Dates:
          </span>
          <div className="flex flex-wrap gap-2">
            {HISTORICAL_PRESET_DATES.map((preset) => {
              const isActive = selectedDate === preset.date;
              return (
                <button
                  key={preset.date}
                  onClick={() => {
                    setSelectedDate(preset.date);
                    handleRunTest(preset.date);
                  }}
                  disabled={isRunning}
                  className={`px-2.5 py-1.5 rounded text-[11px] font-mono transition-colors border cursor-pointer ${
                    isActive
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                      : 'bg-zinc-900/80 hover:bg-zinc-800 border-zinc-800 text-zinc-300'
                  }`}
                >
                  {preset.date}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Global Error Banner */}
      {testError && (
        <div className="p-3 rounded bg-rose-950/60 border border-rose-800 text-rose-300 text-xs flex items-start gap-2">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
          <span>{testError}</span>
        </div>
      )}

      {/* Fact Packet Summary & Filter Tally Banner */}
      {factPacket && (
        <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span className="text-zinc-200 font-bold">
                FACT PACKET SUMMARY FOR {factPacket.targetDate}
              </span>
            </div>

            {/* Filter Tally Badges */}
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-800 text-emerald-300 font-bold text-xs">
                Kept: {factPacket.keptCount ?? factPacket.totalCount} items
              </span>
              {factPacket.nationalFocusEnabled && (
                <span className="px-2 py-0.5 rounded bg-rose-950/70 border border-rose-800 text-rose-300 font-bold text-xs">
                  Excluded (NYC-local): {factPacket.excludedCount ?? 0} items
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
            <span className="text-zinc-400">Categories (Kept):</span>
            {Object.entries(factPacket.countsPerCategory).map(([cat, count]) => (
              <span
                key={cat}
                className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 flex items-center gap-1.5"
              >
                <span className="capitalize">{cat}:</span>
                <strong className={count > 0 ? 'text-amber-400' : 'text-zinc-500'}>
                  {count}
                </strong>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Provider Details & Result Tables */}
      <div className="space-y-4">
        {(['nyt'] as const).map((pKey) => {
          const info = PROVIDER_INFO[pKey];
          const result = factPacket?.results?.[pKey];
          const isConfigured = providerConfig[pKey]?.configured;
          const status: ProviderStatus = result ? result.status : (isConfigured === false ? 'NOT CONFIGURED' : 'EMPTY');

          return (
            <div
              key={pKey}
              className="p-4 bg-[#0a0c10] border border-zinc-800 rounded-lg space-y-4"
            >
              {/* Provider Header Card */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800/60 pb-2">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold text-zinc-100 uppercase">
                      {info.name}
                    </h3>
                    <code className="text-[10px] text-zinc-500 px-1 py-0.5 bg-black/40 rounded border border-zinc-800">
                      {info.keyName}
                    </code>
                    {result?.nationalFocusEnabled && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/40 text-amber-300 text-[10px] font-bold">
                        National Focus Active
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-zinc-400 leading-normal max-w-2xl">
                    {info.note}
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-400 text-[10px] uppercase">Status:</span>
                    {getStatusBadge(result?.status || (isConfigured ? 'EMPTY' : 'NOT CONFIGURED'))}
                  </div>

                  <div className="text-zinc-300 text-xs">
                    Kept: <strong className="text-emerald-400">{result?.itemCount ?? 0}</strong>
                    {result?.excludedCount !== undefined && (
                      <span className="text-zinc-400 ml-1.5">
                        | Excluded: <strong className="text-rose-400">{result.excludedCount}</strong>
                      </span>
                    )}
                  </div>

                  {result && (
                    <button
                      onClick={() => toggleRawJson(pKey)}
                      className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 text-[10px] flex items-center gap-1 cursor-pointer transition-colors"
                      title="Toggle raw JSON response"
                    >
                      <Code className="w-3 h-3 text-amber-400" />
                      <span>{showRawJson[pKey] ? 'Hide JSON' : 'Raw JSON'}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Exact Error or Note Display */}
              {result?.error && (
                <div className="p-2.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-rose-300 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-rose-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Upstream Response / Limitation:</span>
                  </div>
                  <p className="text-zinc-300 font-mono break-words">{result.error}</p>
                </div>
              )}

              {/* Raw JSON View */}
              {showRawJson[pKey] && result && (
                <div className="p-2.5 bg-[#08090d] border border-zinc-900 rounded space-y-1">
                  <div className="flex justify-between items-center text-[10px] text-zinc-500">
                    <span>Raw Response Payload (Disk Cached: {String(result.cached)})</span>
                  </div>
                  <pre className="max-h-56 overflow-auto text-[10px] text-zinc-400 font-mono p-2 bg-black/60 rounded border border-zinc-900">
                    {JSON.stringify(result.rawResponse || result, null, 2)}
                  </pre>
                </div>
              )}

              {/* Table of First 15 Kept Items */}
              {result && result.items && result.items.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span className="font-bold text-zinc-300">
                      Kept Items (showing first {Math.min(15, result.items.length)} of {result.items.length}):
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      Target date &le; {factPacket?.targetDate} (3-day window)
                    </span>
                  </div>

                  <div className="overflow-x-auto border border-zinc-800/80 rounded bg-[#08090d]">
                    <table className="w-full text-left border-collapse text-[11px]">
                      <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-900/40 text-zinc-400 text-[10px] uppercase">
                          <th className="p-2 font-bold w-12">#</th>
                          <th className="p-2 font-bold w-28">Category</th>
                          <th className="p-2 font-bold">Headline &amp; Summary</th>
                          <th className="p-2 font-bold w-24">Date</th>
                          <th className="p-2 font-bold w-48">Keep Rule / Reason</th>
                          <th className="p-2 font-bold w-16 text-right">Link</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-850">
                        {result.items.slice(0, 15).map((item: FactItem, idx: number) => (
                          <tr key={idx} className="hover:bg-zinc-800/20 transition-colors">
                            <td className="p-2 text-zinc-500 font-mono">{idx + 1}</td>
                            <td className="p-2">{getCategoryBadge(item.category)}</td>
                            <td className="p-2">
                              <div className="font-semibold text-zinc-200 leading-snug">
                                {item.headline}
                              </div>
                              {item.summary && (
                                <div className="text-zinc-400 text-[10px] line-clamp-2 mt-0.5 leading-relaxed">
                                  {item.summary}
                                </div>
                              )}
                            </td>
                            <td className="p-2 text-zinc-400 whitespace-nowrap font-mono">
                              {item.publishedDate}
                            </td>
                            <td className="p-2 text-emerald-400 text-[10px] leading-tight">
                              {item.nationalFocusReason || item.desk || 'Qualified for national packet'}
                            </td>
                            <td className="p-2 text-right">
                              {item.url ? (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-0.5 text-[10px]"
                                >
                                  <span>View</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ) : (
                                <span className="text-zinc-600">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-[#08090d] border border-zinc-900 rounded text-center text-zinc-500 text-[11px]">
                  {result
                    ? 'No normalized items returned for this date from this provider.'
                    : 'Click "Run Fact Packet Query" or a preset date above to test this provider.'}
                </div>
              )}

              {/* Table of Excluded Items with Reason Review */}
              {result && result.excludedItems && result.excludedItems.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-zinc-800">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowExcludedTable(!showExcludedTable)}
                      className="text-xs font-bold uppercase tracking-wider text-rose-400 hover:text-rose-300 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Filter className="w-3.5 h-3.5" />
                      <span>
                        Excluded Items Review ({result.excludedItems.length} items filtered out)
                      </span>
                      {showExcludedTable ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <span className="text-[10px] text-zinc-500">
                      Review exclusion reasons against the rules
                    </span>
                  </div>

                  {showExcludedTable && (
                    <div className="overflow-x-auto border border-rose-950/70 rounded bg-[#08090d]">
                      <table className="w-full text-left border-collapse text-[11px]">
                        <thead>
                          <tr className="border-b border-zinc-800 bg-rose-950/20 text-zinc-400 text-[10px] uppercase">
                            <th className="p-2 font-bold w-12">#</th>
                            <th className="p-2 font-bold w-28">Category</th>
                            <th className="p-2 font-bold">Excluded Headline</th>
                            <th className="p-2 font-bold w-24">Date</th>
                            <th className="p-2 font-bold w-36">Desk / Section</th>
                            <th className="p-2 font-bold text-rose-300">Exclusion Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-850">
                          {result.excludedItems.slice(0, 30).map((ex: ExcludedFactItem, idx: number) => (
                            <tr key={idx} className="hover:bg-rose-950/10 transition-colors">
                              <td className="p-2 text-zinc-500 font-mono">{idx + 1}</td>
                              <td className="p-2">{getCategoryBadge(ex.category)}</td>
                              <td className="p-2 text-zinc-300 font-semibold leading-snug">
                                {ex.headline}
                              </td>
                              <td className="p-2 text-zinc-400 whitespace-nowrap font-mono">
                                {ex.publishedDate}
                              </td>
                              <td className="p-2 text-zinc-400 text-[10px]">
                                {ex.desk || ex.section || '—'}
                              </td>
                              <td className="p-2 text-rose-400 text-[10px] font-mono leading-tight">
                                {ex.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {result.excludedItems.length > 30 && (
                        <div className="p-2 text-center text-zinc-500 text-[10px] bg-zinc-950 border-t border-zinc-850">
                          Showing first 30 of {result.excludedItems.length} excluded items.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

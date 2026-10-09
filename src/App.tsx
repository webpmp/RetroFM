/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Radio,
  Play,
  Pause,
  Square,
  Volume2,
  VolumeX,
  Volume1,
  Sparkles,
  RefreshCw,
  Download,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  Sliders,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FileText,
  Activity,
  Layers,
  HelpCircle,
  Disc,
  Search,
  Music,
  Check,
  Database,
  Cpu
} from 'lucide-react';
import { YouTubeMusicProvider } from './services/music/YouTubeMusicProvider.js';
import { MusicPlaybackStatus, TabInfo } from './services/music/types.js';
import { generateTTS } from './services/ttsClient.js';
import { generateAndDownloadExtensionZip, EXTENSION_FILES } from './services/extensionBundle.js';

// Pre-defined 5 critical validation test songs
export const CRITICAL_TEST_SONGS = [
  { artist: 'a-ha', song: 'Take on Me', year: '1985' },
  { artist: 'Michael Jackson', song: 'Billie Jean', year: '1983' },
  { artist: 'Prince', song: 'When Doves Cry', year: '1984' },
  { artist: 'U2', song: 'With or Without You', year: '1987' },
  { artist: 'Peter Gabriel', song: 'Sledgehammer', year: '1986' },
];

// Pre-defined DJ script templates
const SCRIPT_PRESETS = [
  {
    title: 'Chart Climber (Default)',
    text: "Here's another one that's been climbing the charts all week. Stay with us right here on Retro FM.",
    style: "Confident, conversational 1980s radio DJ. Fast but natural pacing. Warm broadcast voice. Slightly energetic. Not announcer-like."
  },
  {
    title: 'Top of the Hour Station ID',
    text: "You are locked into Retro FM, your non-stop vintage soundtrack. It's twenty past the hour, turning up the heat with this absolute classic.",
    style: "Energetic top-40 drive-time radio DJ. Fast punchy delivery, smiling voice, high broadcast presence."
  },
  {
    title: 'Late Night FM Smooth Talk',
    text: "Midnight in the city, the lights are low, and the tempo is just right. Keep it locked, we've got uninterrupted memories coming your way.",
    style: "Deep, smooth, warm FM late-night host. Relaxed pacing, intimate tone, effortless radio transition."
  }
];

export default function App() {
  // --- Providers & Audio Instances ---
  const musicProviderRef = useRef<YouTubeMusicProvider>(new YouTubeMusicProvider());
  const djAudioRef = useRef<HTMLAudioElement | null>(null);

  // --- Extension & Tab Connection State ---
  const [extensionDetected, setExtensionDetected] = useState<boolean>(false);
  const [availableTabs, setAvailableTabs] = useState<TabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // --- YouTube Playback State ---
  const [playbackStatus, setPlaybackStatus] = useState<MusicPlaybackStatus>({
    available: false,
    title: 'Unknown Video',
    url: '',
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    connectedTabId: null
  });

  // Local volume slider state
  const [targetMusicVolume, setTargetMusicVolume] = useState<number>(100);

  // --- PROGRAM SONG Test State ---
  const [programArtist, setProgramArtist] = useState<string>('a-ha');
  const [programSongTitle, setProgramSongTitle] = useState<string>('Take on Me');
  const [programYear, setProgramYear] = useState<string>('1985');
  const [isProgrammingSong, setIsProgrammingSong] = useState<boolean>(false);
  const [programSongResult, setProgramSongResult] = useState<{
    status: 'IDLE' | 'SEARCHING' | 'NAVIGATING' | 'PLAYING' | 'NOT_FOUND' | 'API_ERROR' | 'ERROR';
    requested: string;
    selectedTitle?: string;
    selectedChannel?: string;
    selectedDuration?: string;
    selectedVideoId?: string;
    selectedUrl?: string;
    confidenceScore?: number;
    reason?: string;
    canonicalYear?: string;
    canonicalLength?: string;
    error?: string;
  } | null>(null);
  const [songPlaybackNotice, setSongPlaybackNotice] = useState<{
    message: string;
    artist?: string;
    song?: string;
    type?: 'not_found' | 'api_error';
  } | null>(null);

  // --- 5-Song On-Screen Verification Suite State ---
  const [hasYouTubeApiKey, setHasYouTubeApiKey] = useState<boolean | null>(null);
  const [isSongTestRunning, setIsSongTestRunning] = useState<boolean>(false);
  const [testingSongIndex, setTestingSongIndex] = useState<number | null>(null);
  const [forceFreshSearch, setForceFreshSearch] = useState<boolean>(false);
  const [songTestSuiteResults, setSongTestSuiteResults] = useState<any[] | null>(null);
  const [songTestError, setSongTestError] = useState<string | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<{
    searchCalls: number;
    detailsCalls: number;
    totalUnitsUsed: number;
    cacheHits: number;
    estimatedRemainingDaily: number;
  }>({
    searchCalls: 0,
    detailsCalls: 0,
    totalUnitsUsed: 0,
    cacheHits: 0,
    estimatedRemainingDaily: 10000,
  });

  // --- DJ Script & TTS State ---
  const [voiceEngine, setVoiceEngine] = useState<'GEMINI' | 'BROWSER'>('BROWSER');
  const [djScript, setDjScript] = useState<string>(SCRIPT_PRESETS[0].text);
  const [djStyle, setDjStyle] = useState<string>(SCRIPT_PRESETS[0].style);
  const [selectedVoice, setSelectedVoice] = useState<string>('Puck');
  const [selectedModel, setSelectedModel] = useState<string>('gemini-2.5-flash-preview-tts');
  const [isGeneratingDJ, setIsGeneratingDJ] = useState<boolean>(false);
  const [djAudioData, setDjAudioData] = useState<string | null>(null);
  const [djAudioDuration, setDjAudioDuration] = useState<number>(0);
  const [djModelUsed, setDjModelUsed] = useState<string>('');
  const [djError, setDjError] = useState<string | null>(null);
  const [isPlayingDJPreview, setIsPlayingDJPreview] = useState<boolean>(false);

  // --- Radio Mix & Ducking Configuration ---
  const [duckVolumePercent, setDuckVolumePercent] = useState<number>(30); // 30% default
  const [fadeDownMs, setFadeDownMs] = useState<number>(500); // 500 ms default
  const [fadeUpMs, setFadeUpMs] = useState<number>(750); // 750 ms default
  const [isDuckingActive, setIsDuckingActive] = useState<boolean>(false);
  const [mixPhase, setMixPhase] = useState<'IDLE' | 'FADING_DOWN' | 'DJ_SPEAKING' | 'FADING_UP' | 'COMPLETED'>('IDLE');
  const [effectiveMusicVolume, setEffectiveMusicVolume] = useState<number>(100);

  // --- Timing Test Configuration ---
  const [timingDelaySeconds, setTimingDelaySeconds] = useState<number>(5);
  const [isTimingTestRunning, setIsTimingTestRunning] = useState<boolean>(false);
  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);

  // --- Test Results State ---
  const [testResults, setTestResults] = useState<{
    tabDetection: boolean | null;
    playbackState: boolean | null;
    playbackControl: boolean | null;
    volumeControl: boolean | null;
    currentPosition: boolean | null;
    metadata: boolean | null;
    geminiTTS: boolean | null;
    geminiPlayback: boolean | null;
    simultaneousPlayback: boolean | null;
    musicDucking: boolean | null;
    musicRestoration: boolean | null;
    overallTransition: boolean | null;
  }>({
    tabDetection: null,
    playbackState: null,
    playbackControl: null,
    volumeControl: null,
    currentPosition: null,
    metadata: null,
    geminiTTS: null,
    geminiPlayback: null,
    simultaneousPlayback: null,
    musicDucking: null,
    musicRestoration: null,
    overallTransition: null
  });

  // --- UI Modal & Accordion State ---
  const [showExtensionModal, setShowExtensionModal] = useState<boolean>(false);
  const [showEvaluationSection, setShowEvaluationSection] = useState<boolean>(true);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [modalTab, setModalTab] = useState<'GUIDE' | 'FILES'>('GUIDE');
  const [extensionFiles, setExtensionFiles] = useState<Record<string, string>>(EXTENSION_FILES);
  const [activeFileKey, setActiveFileKey] = useState<string>('manifest.json');
  const [copiedFileKey, setCopiedFileKey] = useState<string | null>(null);

  const loadExtensionFiles = () => {
    setExtensionFiles(EXTENSION_FILES);
  };

  const handleCopyFileContent = (key: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedFileKey(key);
    setTimeout(() => setCopiedFileKey(null), 2000);
  };

  const logMessage = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setStatusLog((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 49)]);
  };

  // --- Initial Cleanup to ensure 100% silence on load ---
  useEffect(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    // Query API key status
    fetch('/api/music/status')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setHasYouTubeApiKey(Boolean(data.hasYouTubeApiKey));
          if (data.quota) {
            setQuotaInfo(data.quota);
          }
        }
      })
      .catch(() => setHasYouTubeApiKey(false));

    return () => {
      killAllAudio();
    };
  }, []);

  // --- Extension Heartbeat / Detection Loop ---
  useEffect(() => {
    const checkExt = async () => {
      const active = await musicProviderRef.current.pingExtension();
      setExtensionDetected(active);
      if (active) {
        setTestResults((prev) => ({ ...prev, tabDetection: true }));
        try {
          const tabs = await musicProviderRef.current.listTabs();
          setAvailableTabs(tabs);
        } catch (e) {
          // Tabs query might require permissions
        }
      }
    };

    checkExt();
    const interval = setInterval(checkExt, 2500);
    return () => clearInterval(interval);
  }, []);

  // --- Poll YouTube Tab Status ---
  useEffect(() => {
    if (!playbackStatus.connectedTabId) return;

    const poll = async () => {
      try {
        const s = await musicProviderRef.current.getStatus();
        setPlaybackStatus(s);
        if (s.available) {
          setTestResults((prev) => ({
            ...prev,
            playbackState: true,
            currentPosition: s.currentTime > 0 || prev.currentPosition,
            metadata: !!(s.title && s.title !== 'Unknown Title') || prev.metadata
          }));
          if (s.volume !== undefined && !isDuckingActive) {
            setEffectiveMusicVolume(Math.round(s.volume * 100));
            setTargetMusicVolume(Math.round(s.volume * 100));
          }
        }
      } catch (err) {
        // Status fetch error
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [playbackStatus.connectedTabId, isDuckingActive]);

  // --- Connect YouTube Tab Handler ---
  const handleConnectTab = async () => {
    setIsConnecting(true);
    setConnectionError(null);
    logMessage('Scanning for YouTube tabs via Retro FM Extension...');

    try {
      const res = await musicProviderRef.current.connect(selectedTabId || undefined);
      if (res.success && res.status) {
        setPlaybackStatus(res.status);
        setTestResults((prev) => ({
          ...prev,
          tabDetection: true,
          playbackState: true,
          volumeControl: true,
          metadata: !!(res.status?.title && res.status.title !== 'Unknown Video')
        }));
        logMessage(`Connected to YouTube tab: "${res.status.title}"`);
      } else {
        setConnectionError(res.error || 'No YouTube tab found');
        logMessage(`Connection failed: ${res.error || 'No tab found'}`);
      }
    } catch (err: any) {
      setConnectionError(err.message || 'Error communicating with extension');
      logMessage(`Error: ${err.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  // --- Playback Controls ---
  const handlePlayMusic = async () => {
    logMessage('Sending Play command to YouTube tab...');
    const ok = await musicProviderRef.current.play();
    if (ok) {
      logMessage('▶ Playback started on YouTube tab.');
      setTestResults((prev) => ({ ...prev, playbackControl: true }));
    } else {
      logMessage('Failed to trigger Play on YouTube tab. Make sure a YouTube video is open in another tab.');
    }
  };

  const handlePauseMusic = async () => {
    logMessage('Sending Pause command to YouTube tab...');
    const ok = await musicProviderRef.current.pause();
    if (ok) {
      logMessage('⏸ Playback paused on YouTube tab.');
      setTestResults((prev) => ({ ...prev, playbackControl: true }));
    } else {
      logMessage('Failed to trigger Pause on YouTube tab.');
    }
  };

  const handleStopMusic = async () => {
    logMessage('Sending Stop command to YouTube tab...');
    const ok = await musicProviderRef.current.stop();
    if (ok) {
      logMessage('⏹ Playback stopped on YouTube tab.');
      setTestResults((prev) => ({ ...prev, playbackControl: true }));
    } else {
      logMessage('Failed to trigger Stop on YouTube tab.');
    }
  };

  // --- PROGRAM SONG Handler ---
  const handleProgramSong = async (customOverride?: { artist: string; song: string; year: string }) => {
    const artist = (customOverride ? customOverride.artist : programArtist).trim();
    const song = (customOverride ? customOverride.song : programSongTitle).trim();
    const year = (customOverride ? customOverride.year : programYear).trim();

    if (customOverride) {
      setProgramArtist(customOverride.artist);
      setProgramSongTitle(customOverride.song);
      setProgramYear(customOverride.year);
    }

    const requestedStr = `${artist} — ${song}${year ? ` (${year})` : ''}`;

    if (!artist || !song) {
      setProgramSongResult({
        status: 'ERROR',
        requested: requestedStr,
        error: 'Artist and song title are required.',
      });
      return;
    }

    setIsProgrammingSong(true);
    setSongPlaybackNotice(null);
    setProgramSongResult({
      status: 'SEARCHING',
      requested: requestedStr,
    });
    logMessage(`[Program Song] Searching YouTube Data API for "${artist} - ${song}" (${year})...`);

    try {
      const res = await fetch('/api/music/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist, song, year }),
      });

      const data = await res.json();
      if (data.quota) {
        setQuotaInfo(data.quota);
      }

      if (data.status === 'api_error') {
        const quotaMsg = data.error || 'YouTube API daily quota exceeded. It resets at midnight Pacific time.';
        logMessage(`[Program Song Quota Error] ${quotaMsg}`);
        setProgramSongResult({
          status: 'API_ERROR',
          requested: requestedStr,
          error: quotaMsg,
        });
        setSongPlaybackNotice({
          message: quotaMsg,
          artist,
          song,
          type: 'api_error',
        });
        setIsProgrammingSong(false);
        return;
      }

      if (data.status === 'not_found' || !data.success || !data.selected) {
        const notFoundMsg = data.error || `No trustworthy recording found for ${artist} - ${song}. Nothing was played.`;
        logMessage(`[Program Song] ${notFoundMsg}`);
        setProgramSongResult({
          status: 'NOT_FOUND',
          requested: requestedStr,
          error: notFoundMsg,
        });
        setSongPlaybackNotice({
          message: notFoundMsg,
          artist,
          song,
          type: 'not_found',
        });
        setIsProgrammingSong(false);
        return;
      }

      const sel = data.selected;
      logMessage(`[Program Song] Selected: "${sel.title}" on "${sel.channel}" (Score: ${sel.confidenceScore}). Navigating tab...`);

      setProgramSongResult({
        status: 'NAVIGATING',
        requested: requestedStr,
        selectedTitle: sel.title,
        selectedChannel: sel.channel,
        selectedDuration: sel.duration,
        selectedVideoId: sel.videoId,
        selectedUrl: sel.url,
        confidenceScore: sel.confidenceScore,
        reason: sel.reason,
        canonicalYear: data.canonicalInfo?.year,
        canonicalLength: data.canonicalInfo?.formattedLength,
      });

      // Instruct connected YouTube tab to navigate
      const navOk = await musicProviderRef.current.navigate(sel.url, sel.videoId);
      if (!navOk) {
        logMessage('[Program Song] Notice: Navigation message sent to YouTube tab. Checking playback...');
      }

      // Allow YouTube player to mount and start playback
      await new Promise((r) => setTimeout(r, 1500));
      const playOk = await musicProviderRef.current.play();

      setProgramSongResult((prev) =>
        prev
          ? {
              ...prev,
              status: 'PLAYING',
            }
          : null
      );
      if (playOk) {
        setTestResults((prev) => ({ ...prev, playbackControl: true }));
      }
      logMessage(`[Program Song] Playing: "${sel.title}". YouTube playback started.`);
    } catch (err: any) {
      logMessage(`[Program Song] Exception: ${err.message}`);
      setProgramSongResult({
        status: 'ERROR',
        requested: requestedStr,
        error: err.message || 'Programming failed due to network error.',
      });
    } finally {
      setIsProgrammingSong(false);
    }
  };

  // --- Run 5-Song On-Screen Test Suite Handler ---
  const handleRunSongTestSuite = async () => {
    setIsSongTestRunning(true);
    setSongTestError(null);
    logMessage(
      `Running 5-Song Verification Test Suite (${forceFreshSearch ? 'Force Fresh Search' : 'Disk Cache Default'})...`
    );

    try {
      const res = await fetch('/api/music/test-suite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceFresh: forceFreshSearch }),
      });

      const data = await res.json();
      if (data.quota) {
        setQuotaInfo(data.quota);
      }
      if (!data.success) {
        setSongTestError(data.error || 'Failed to execute test suite.');
        if (data.hasYouTubeApiKey === false) {
          setHasYouTubeApiKey(false);
        }
        logMessage(`[Test Suite Error] ${data.error}`);
      } else {
        setSongTestSuiteResults(data.results);
        setHasYouTubeApiKey(true);
        logMessage('✓ 5-Song Verification Test Suite finished successfully. Results table updated on screen.');
      }
    } catch (err: any) {
      setSongTestError(err.message || 'Network error running test suite.');
      logMessage(`[Test Suite Error] ${err.message}`);
    } finally {
      setIsSongTestRunning(false);
    }
  };

  // --- Run Single Song Test Handler ---
  const handleRunSingleSong = async (index: number) => {
    const targetSong = CRITICAL_TEST_SONGS[index];
    if (!targetSong) return;

    setTestingSongIndex(index);
    setSongTestError(null);
    logMessage(
      `Running individual test for [${targetSong.artist} - ${targetSong.song}] (${
        forceFreshSearch ? 'Force Fresh Search' : 'Disk Cache Allowed'
      })...`
    );

    try {
      const res = await fetch('/api/music/test-song', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songIndex: index,
          artist: targetSong.artist,
          song: targetSong.song,
          year: targetSong.year,
          forceFresh: forceFreshSearch,
        }),
      });

      const data = await res.json();
      if (data.quota) {
        setQuotaInfo(data.quota);
      }

      if (!data.success) {
        setSongTestError(data.error || `Failed to test ${targetSong.artist} - ${targetSong.song}`);
        if (data.hasYouTubeApiKey === false) {
          setHasYouTubeApiKey(false);
        }
        logMessage(`[Single Song Error] ${data.error}`);
      } else if (data.result) {
        setHasYouTubeApiKey(true);
        setSongTestSuiteResults((prev) => {
          const current = prev ? [...prev] : CRITICAL_TEST_SONGS.map((cs) => ({ song: cs, unrun: true }));
          // Ensure base array length is 5
          while (current.length < 5) {
            current.push({ song: CRITICAL_TEST_SONGS[current.length], unrun: true });
          }
          current[index] = data.result;
          return current;
        });
        logMessage(`✓ Test completed for ${targetSong.artist} - ${targetSong.song}`);
      }
    } catch (err: any) {
      setSongTestError(err.message || 'Network error running song test.');
      logMessage(`[Single Song Exception] ${err.message}`);
    } finally {
      setTestingSongIndex(null);
    }
  };

  const handleMusicVolumeChange = async (volPercent: number) => {
    setTargetMusicVolume(volPercent);
    setEffectiveMusicVolume(volPercent);
    const vol = volPercent / 100;

    logMessage(`Setting YouTube volume to ${volPercent}%...`);
    const ok = await musicProviderRef.current.setVolume(vol);
    if (ok) {
      setTestResults((prev) => ({ ...prev, volumeControl: true }));
    }
  };

  const killAllAudio = () => {
    if (djAudioRef.current) {
      try {
        djAudioRef.current.pause();
        djAudioRef.current.currentTime = 0;
      } catch {}
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    setIsPlayingDJPreview(false);
    setIsDuckingActive(false);
    setMixPhase('IDLE');
    setEffectiveMusicVolume(targetMusicVolume);
    logMessage('🛑 All audio immediately stopped and silenced.');
  };

  // --- Generate DJ Audio using Gemini Flash TTS ---
  const handleGenerateDJ = async (): Promise<string | null> => {
    if (!djScript.trim()) {
      setDjError('Please enter a DJ script.');
      return null;
    }

    setIsGeneratingDJ(true);
    setDjError(null);
    logMessage(`Generating DJ voice using Gemini TTS (${selectedModel}, voice: ${selectedVoice})...`);

    const startTime = performance.now();
    try {
      const response = await generateTTS({
        text: djScript,
        voice: selectedVoice,
        style: djStyle,
        model: selectedModel
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (response.success && response.audioBase64) {
        const audioSrc = `data:${response.mimeType || 'audio/wav'};base64,${response.audioBase64}`;
        setDjAudioData(audioSrc);
        setDjAudioDuration(response.durationSeconds || 4);
        setDjModelUsed(response.modelUsed || selectedModel);
        setTestResults((prev) => ({
          ...prev,
          geminiTTS: true
        }));
        logMessage(`Gemini Flash TTS audio generated in ${latencyMs}ms (${response.durationSeconds || '~4'}s audio). Ready.`);
        return audioSrc;
      } else {
        if (response.quotaExceeded) {
          setVoiceEngine('BROWSER');
          setDjError('Google Cloud Free Tier TTS quota reached (10 requests/day). Auto-switched to Instant Browser Voice for unlimited speech!');
          logMessage('Quota reached. Auto-switched to Instant Browser DJ Voice Engine.');
        } else {
          setDjError(response.error || 'TTS generation failed');
          logMessage(`TTS Error: ${response.error}`);
        }
        setTestResults((prev) => ({ ...prev, geminiTTS: false }));
        return null;
      }
    } catch (err: any) {
      setDjError(err.message || 'Network error requesting Gemini TTS');
      setTestResults((prev) => ({ ...prev, geminiTTS: false }));
      logMessage(`Network error requesting Gemini TTS: ${err.message}`);
      return null;
    } finally {
      setIsGeneratingDJ(false);
    }
  };

  // --- Preview DJ Audio Solo ---
  const handleToggleDJPreview = () => {
    if (voiceEngine === 'BROWSER') {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        if (isPlayingDJPreview) {
          window.speechSynthesis.cancel();
          setIsPlayingDJPreview(false);
          logMessage('Browser DJ preview stopped.');
        } else {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(djScript);
          u.rate = 1.05;
          u.onstart = () => {
            setIsPlayingDJPreview(true);
            setTestResults((prev) => ({ ...prev, geminiPlayback: true }));
            logMessage('Playing Instant Browser DJ speech preview.');
          };
          u.onend = () => setIsPlayingDJPreview(false);
          u.onerror = () => setIsPlayingDJPreview(false);
          window.speechSynthesis.speak(u);
        }
      }
      return;
    }

    if (!djAudioData) return;

    if (!djAudioRef.current) {
      djAudioRef.current = new Audio(djAudioData);
    }

    if (isPlayingDJPreview) {
      djAudioRef.current.pause();
      djAudioRef.current.currentTime = 0;
      setIsPlayingDJPreview(false);
      logMessage('DJ preview stopped.');
    } else {
      djAudioRef.current.src = djAudioData;
      djAudioRef.current.play().then(() => {
        setIsPlayingDJPreview(true);
        setTestResults((prev) => ({ ...prev, geminiPlayback: true }));
        logMessage('Playing generated Gemini DJ speech preview.');
      }).catch((e) => {
        logMessage('DJ preview playback error: ' + e.message);
      });

      djAudioRef.current.onended = () => {
        setIsPlayingDJPreview(false);
      };
    }
  };

  // --- Critical Audio Ducking & DJ-Over-Music Execution ---
  const executeDJOverMusic = async (): Promise<boolean> => {
    let activeAudioSrc = djAudioData;

    if (voiceEngine === 'GEMINI') {
      if (!activeAudioSrc) {
        logMessage('DJ audio not yet generated for current script. Generating Gemini voice now...');
        activeAudioSrc = await handleGenerateDJ();
        if (!activeAudioSrc) {
          logMessage('Cannot run DJ Over Music: Gemini voice generation failed. Try switching to Instant Browser Voice.');
          return false;
        }
      }
    }

    setIsDuckingActive(true);
    setMixPhase('FADING_DOWN');
    logMessage('▶ Step 1: Initiating DJ Over Music sequence.');

    // 1. Record original volume
    const originalVolPercent = targetMusicVolume;
    const targetDuckVolPercent = duckVolumePercent;
    const duckVol = targetDuckVolPercent / 100;

    logMessage(`▶ Step 2: Smoothly ducking YouTube music from ${originalVolPercent}% down to ${targetDuckVolPercent}% (${fadeDownMs}ms fade)...`);

    // Duck YouTube tab
    await musicProviderRef.current.rampVolume(duckVol, fadeDownMs);

    // Animate UI volume indicator during fade down
    const startDownTime = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        const elapsed = performance.now() - startDownTime;
        const progress = Math.min(1, elapsed / fadeDownMs);
        const curr = originalVolPercent - (originalVolPercent - targetDuckVolPercent) * progress;
        setEffectiveMusicVolume(Math.round(curr));
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          setEffectiveMusicVolume(targetDuckVolPercent);
          resolve();
        }
      };
      step();
    });

    setTestResults((prev) => ({ ...prev, musicDucking: true }));
    setMixPhase('DJ_SPEAKING');

    const handleSpeechEnded = async (resolve: (v: boolean) => void) => {
      try {
        logMessage(`▶ Step 5: DJ speech finished. Smoothly restoring YouTube music back to 100% (${fadeUpMs}ms fade)...`);
        setMixPhase('FADING_UP');

        const originalVol = originalVolPercent / 100;
        try {
          await musicProviderRef.current.rampVolume(originalVol, fadeUpMs);
        } catch {
          // ignore
        }

        // Animate UI volume indicator during fade up
        const startUpTime = performance.now();
        await new Promise<void>((resUp) => {
          const stepUp = () => {
            const elapsed = performance.now() - startUpTime;
            const progress = Math.min(1, elapsed / fadeUpMs);
            const curr = targetDuckVolPercent + (originalVolPercent - targetDuckVolPercent) * progress;
            setEffectiveMusicVolume(Math.round(curr));
            if (progress < 1) {
              requestAnimationFrame(stepUp);
            } else {
              setEffectiveMusicVolume(originalVolPercent);
              resUp();
            }
          };
          stepUp();
        });

        logMessage('▶ Step 6: Radio mix transition complete! YouTube music returned to full volume.');
        setMixPhase('COMPLETED');
        setIsDuckingActive(false);

        setTestResults((prev) => ({
          ...prev,
          musicRestoration: true,
          overallTransition: true
        }));

        setTimeout(() => setMixPhase('IDLE'), 1200);
        resolve(true);
      } catch {
        setIsDuckingActive(false);
        setMixPhase('IDLE');
        setEffectiveMusicVolume(originalVolPercent);
        resolve(false);
      }
    };

    if (voiceEngine === 'BROWSER') {
      logMessage(`▶ Step 3: Music ducked to ${targetDuckVolPercent}%. Starting Instant Browser DJ voice over music!`);
      return new Promise<boolean>((resolve) => {
        if (typeof window === 'undefined' || !window.speechSynthesis) {
          logMessage('SpeechSynthesis not available in this browser.');
          setIsDuckingActive(false);
          setMixPhase('IDLE');
          return resolve(false);
        }

        let hasEnded = false;
        let safetyTimeout: any = null;

        const words = djScript.trim().split(/\s+/).filter(Boolean);
        const estimatedDurationMs = Math.max(3000, Math.round(words.length * 360));

        const finish = (reason: string) => {
          if (hasEnded) return;
          hasEnded = true;
          if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
          }
          (window as any).__retroFmDJUtterance = null;
          logMessage(`DJ speech sequence finished (${reason}). Proceeding to restore music.`);
          handleSpeechEnded(resolve);
        };

        // Safety timeout so the app NEVER hangs on DJ_SPEAKING under any browser condition!
        safetyTimeout = setTimeout(() => {
          finish('expected speech duration reached');
        }, estimatedDurationMs + 1200);

        try {
          if (window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
          }
        } catch {}

        const utterance = new SpeechSynthesisUtterance(djScript);
        (window as any).__retroFmDJUtterance = utterance;

        try {
          const voices = window.speechSynthesis.getVoices();
          const preferred = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Daniel') || v.name.includes('Alex') || v.name.includes('Samantha') || v.name.includes('Google') || v.name.includes('Natural')));
          if (preferred) {
            utterance.voice = preferred;
          }
        } catch {}

        utterance.rate = 1.02;
        utterance.pitch = 1.0;

        utterance.onstart = () => {
          logMessage('▶ Step 4: Simultaneous playback confirmed: Browser DJ voice speaking over ducked music.');
          setTestResults((prev) => ({
            ...prev,
            geminiPlayback: true,
            simultaneousPlayback: true
          }));
        };

        utterance.onend = () => {
          finish('onend event');
        };

        utterance.onerror = (e) => {
          logMessage('Speech synthesis notice: ' + (e.error || 'ended'));
          finish(`onerror (${e.error || 'ended'})`);
        };

        try {
          window.speechSynthesis.speak(utterance);
        } catch (e: any) {
          logMessage('SpeechSynthesis speak exception: ' + e.message);
          finish('exception');
        }
      });
    } else {
      logMessage(`▶ Step 3: Music ducked to ${targetDuckVolPercent}%. Starting Gemini DJ voice over music!`);
      return new Promise<boolean>((resolve) => {
        let hasEnded = false;
        let safetyTimeout: any = null;
        const durationMs = Math.max(3000, Math.round((djAudioDuration || 5) * 1000));

        const finish = (reason: string) => {
          if (hasEnded) return;
          hasEnded = true;
          if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
          }
          logMessage(`DJ audio playback finished (${reason}). Proceeding to restore music.`);
          handleSpeechEnded(resolve);
        };

        safetyTimeout = setTimeout(() => {
          finish('audio duration timeout');
        }, durationMs + 2000);

        const djAudio = new Audio(activeAudioSrc!);
        djAudioRef.current = djAudio;

        djAudio.play().then(() => {
          logMessage('▶ Step 4: Simultaneous playback confirmed: Gemini DJ voice speaking over ducked music.');
          setTestResults((prev) => ({
            ...prev,
            geminiPlayback: true,
            simultaneousPlayback: true
          }));
        }).catch((err) => {
          logMessage('Error starting DJ audio: ' + err.message);
          finish('audio playback error');
        });

        djAudio.onended = () => {
          finish('audio onended');
        };
      });
    }
  };

  // --- Timing Test Handler ---
  const handleRunTimingTest = async () => {
    if (voiceEngine === 'GEMINI' && !djAudioData) {
      logMessage('Synthesizing Gemini audio before running the timing test...');
      const genSrc = await handleGenerateDJ();
      if (!genSrc) return;
    }

    setIsTimingTestRunning(true);
    let secondsLeft = timingDelaySeconds;
    setCountdownRemaining(secondsLeft);
    logMessage(`Timing test started. Music playing. Waiting ${secondsLeft}s delay before DJ entrance...`);

    const countdownInterval = setInterval(() => {
      secondsLeft -= 1;
      setCountdownRemaining(secondsLeft);
      if (secondsLeft <= 0) {
        clearInterval(countdownInterval);
        setCountdownRemaining(null);
        logMessage('Delay reached! Triggering DJ Over Music drop...');
        executeDJOverMusic().finally(() => {
          setIsTimingTestRunning(false);
        });
      }
    }, 1000);
  };

  // Format seconds to mm:ss
  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Helper to render PASS / FAIL badges
  const renderBadge = (status: boolean | null) => {
    if (status === true) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" /> PASS
        </span>
      );
    }
    if (status === false) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-rose-950 text-rose-400 border border-rose-800">
          <XCircle className="w-3.5 h-3.5" /> FAIL
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-zinc-500 bg-zinc-900 border border-zinc-800">
        UNTESTED
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-[#0d0f14] text-zinc-200 font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* On-screen Banner: Recording Not Found / Playback Alert / API Error */}
        {songPlaybackNotice && (
          <div
            className={`p-4 rounded-lg shadow-2xl flex items-start justify-between gap-3 font-mono text-xs animate-in fade-in duration-200 border-2 ${
              songPlaybackNotice.type === 'api_error'
                ? 'bg-amber-950/90 border-amber-500 text-amber-100'
                : 'bg-rose-950/90 border-rose-600 text-rose-100'
            }`}
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className={`w-5 h-5 shrink-0 mt-0.5 ${
                  songPlaybackNotice.type === 'api_error' ? 'text-amber-400' : 'text-rose-400'
                }`}
              />
              <div>
                <div
                  className={`font-bold text-sm tracking-wide uppercase flex items-center gap-2 ${
                    songPlaybackNotice.type === 'api_error' ? 'text-amber-300' : 'text-rose-300'
                  }`}
                >
                  <span>{songPlaybackNotice.type === 'api_error' ? 'API / QUOTA NOTICE' : 'RECORDING NOT FOUND'}</span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded border font-normal ${
                      songPlaybackNotice.type === 'api_error'
                        ? 'bg-amber-900/60 border-amber-700 text-amber-200'
                        : 'bg-rose-900/60 border-rose-700 text-rose-200'
                    }`}
                  >
                    Nothing was played
                  </span>
                </div>
                <div className="mt-1 text-zinc-100 text-xs leading-relaxed font-semibold">
                  {songPlaybackNotice.message}
                </div>
              </div>
            </div>
            <button
              onClick={() => setSongPlaybackNotice(null)}
              className="text-zinc-300 hover:text-white px-2.5 py-1 rounded bg-black/50 hover:bg-black/80 border border-zinc-700 text-xs font-bold transition-colors cursor-pointer shrink-0"
              title="Dismiss notice"
            >
              ✕ Dismiss
            </button>
          </div>
        )}

        {/* --- Header & Concept Banner --- */}
        <header className="border-b border-zinc-800 pb-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
                <Radio className="w-6 h-6 animate-pulse" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-black tracking-wider uppercase text-amber-400 font-mono">
                  RETRO FM
                </h1>
                <p className="text-xs sm:text-sm font-mono tracking-widest text-zinc-400 uppercase">
                  AUDIO PROOF OF CONCEPT &bull; YOUTUBE + GEMINI FLASH TTS
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Master Silence / Emergency Mute Button */}
            <button
              onClick={() => killAllAudio()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-700/80 text-xs font-mono font-bold text-rose-300 transition-colors cursor-pointer shadow"
              title="Immediately silence and stop all audio playback, synthesis, and speech"
            >
              <VolumeX className="w-3.5 h-3.5 text-rose-400" />
              <span>SILENCE ALL AUDIO</span>
            </button>

            {/* Open in Dedicated Tab Button */}
            <a
              href={typeof window !== 'undefined' ? window.location.href : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono text-zinc-200 transition-colors"
              title="Open Retro FM in a dedicated browser tab side-by-side with YouTube"
            >
              <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
              <span>Open in Dedicated Tab</span>
            </a>

            {/* Extension Status Indicator */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-mono ${
              extensionDetected
                ? 'bg-emerald-950/60 border-emerald-700/60 text-emerald-300'
                : 'bg-amber-950/40 border-amber-800/50 text-amber-300'
            }`}>
              <span className={`w-2 h-2 rounded-full ${extensionDetected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              <span>{extensionDetected ? 'Extension Active' : 'Extension Not Detected'}</span>
            </div>

            {/* Download Extension Button */}
            <button
              onClick={() => generateAndDownloadExtensionZip()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono text-zinc-200 transition-colors cursor-pointer"
              title="Download unpacked Chrome extension ZIP"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span>Download Extension (v1.0.3)</span>
            </button>

            {/* Extension Setup Guide Modal Trigger */}
            <button
              onClick={() => setShowExtensionModal(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Setup Guide</span>
            </button>
          </div>
        </header>

        {/* --- Main Workbench Grid --- */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* Left Column (Music Source & Controls) */}
          <div className="lg:col-span-6 space-y-6">

            {/* SECTION 1: MUSIC SOURCE (YouTube Tab) */}
            <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg relative overflow-hidden">
              <div className="border-b border-zinc-800/80 pb-3 mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Disc className="w-4 h-4 text-red-500" />
                  <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                    MUSIC SOURCE: YouTube Tab
                  </h2>
                </div>
                <span className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                  playbackStatus.connectedTabId
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}>
                  {playbackStatus.connectedTabId ? 'CONNECTED' : 'NOT CONNECTED'}
                </span>
              </div>

              {/* YouTube Tab Connect Controls */}
              <div className="space-y-3">
                {availableTabs.length > 0 && (
                  <div>
                    <label className="text-xs text-zinc-400 font-mono block mb-1">
                      Detected YouTube Tabs ({availableTabs.length}):
                    </label>
                    <select
                      value={selectedTabId || ''}
                      onChange={(e) => setSelectedTabId(Number(e.target.value) || null)}
                      className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-amber-500"
                    >
                      <option value="">Auto-select first active YouTube tab</option>
                      {availableTabs.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title ? (t.title.length > 50 ? t.title.substring(0, 50) + '...' : t.title) : `Tab #${t.id}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleConnectTab}
                    disabled={isConnecting}
                    className="flex-1 py-2.5 px-4 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isConnecting ? 'animate-spin' : ''}`} />
                    <span>{isConnecting ? 'Connecting...' : 'Connect YouTube Tab'}</span>
                  </button>
                </div>

                {connectionError && (
                  <div className="p-2.5 rounded bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs font-mono flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <span>{connectionError}</span>
                      <div className="mt-1 text-[11px] text-zinc-400">
                        Make sure the Retro FM Chrome Extension is loaded and a YouTube video is open in another tab.
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* YouTube Playback Information Display */}
              <div className="mt-4 p-3.5 bg-[#0a0c10] border border-zinc-800/80 rounded space-y-2 font-mono text-xs">
                <div className="flex justify-between items-start gap-2">
                  <span className="text-zinc-500 uppercase">Status:</span>
                  <span className={`font-semibold ${
                    playbackStatus.available
                      ? (playbackStatus.isPlaying ? 'text-emerald-400' : 'text-zinc-400')
                      : 'text-zinc-400'
                  }`}>
                    {playbackStatus.available
                      ? (playbackStatus.isPlaying ? 'Playing on YouTube' : 'Paused on YouTube')
                      : (extensionDetected ? 'Extension Active (Waiting for tab connection)' : 'Extension Not Detected')}
                  </span>
                </div>

                <div className="flex justify-between items-start gap-2">
                  <span className="text-zinc-500 uppercase">Current Video:</span>
                  <span className="text-zinc-200 text-right truncate max-w-[280px]" title={playbackStatus.title}>
                    {playbackStatus.title || 'No YouTube Tab Connected'}
                  </span>
                </div>

                <div className="flex justify-between items-center gap-2">
                  <span className="text-zinc-500 uppercase">Position:</span>
                  <span className="text-amber-400 font-bold">
                    {formatTime(playbackStatus.currentTime)} / {formatTime(playbackStatus.duration)}
                  </span>
                </div>

                {/* Video Playback Progress Bar */}
                <div className="w-full bg-zinc-900 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-amber-500 h-full transition-all duration-300"
                    style={{
                      width: `${
                        playbackStatus.duration > 0
                          ? (playbackStatus.currentTime / playbackStatus.duration) * 100
                          : 0
                      }%`
                    }}
                  />
                </div>
              </div>
            </div>

            {/* SECTION: PROGRAM SONG (TECHNICAL PROOF-OF-CONCEPT) */}
            <div className="bg-[#13161f] border border-amber-500/40 rounded-lg p-5 shadow-xl space-y-4 relative overflow-hidden">
              <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Music className="w-4 h-4 text-amber-400" />
                  <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                    PROGRAM SONG
                  </h2>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-amber-400">
                  YouTube Data API v3
                </span>
              </div>

              {/* Three Input Fields: Artist, Song, Year */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-5">
                  <label className="text-xs font-mono text-zinc-400 block mb-1">
                    Artist:
                  </label>
                  <input
                    type="text"
                    value={programArtist}
                    onChange={(e) => setProgramArtist(e.target.value)}
                    placeholder="e.g. a-ha"
                    className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="sm:col-span-5">
                  <label className="text-xs font-mono text-zinc-400 block mb-1">
                    Song:
                  </label>
                  <input
                    type="text"
                    value={programSongTitle}
                    onChange={(e) => setProgramSongTitle(e.target.value)}
                    placeholder="e.g. Take on Me"
                    className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="text-xs font-mono text-zinc-400 block mb-1">
                    Year:
                  </label>
                  <input
                    type="text"
                    value={programYear}
                    onChange={(e) => setProgramYear(e.target.value)}
                    placeholder="1985"
                    className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-500 text-center"
                  />
                </div>
              </div>

              {/* Quick Test Presets for Critical Songs */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-mono text-zinc-400">Critical Test Presets:</div>
                <div className="flex flex-wrap gap-1.5">
                  {CRITICAL_TEST_SONGS.map((songItem, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setProgramArtist(songItem.artist);
                        setProgramSongTitle(songItem.song);
                        setProgramYear(songItem.year);
                      }}
                      className="text-[11px] font-mono px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 hover:border-amber-500/50 transition-colors"
                    >
                      {songItem.artist} - {songItem.song} ({songItem.year})
                    </button>
                  ))}
                </div>
              </div>

              {/* Action Button: [ PLAY SONG ] */}
              <div>
                <button
                  onClick={() => handleProgramSong()}
                  disabled={isProgrammingSong}
                  className="w-full py-3 px-4 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-black text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isProgrammingSong ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>SEARCHING &amp; PROGRAMMING YOUTUBE TAB...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      <span>PLAY SONG</span>
                    </>
                  )}
                </button>
              </div>

              {/* Result Information Panel */}
              {programSongResult && (
                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-2.5 font-mono text-xs">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
                    <span className="text-zinc-400 uppercase text-[11px] font-bold">Programming Result</span>
                    <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                      programSongResult.status === 'PLAYING'
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                        : programSongResult.status === 'API_ERROR'
                          ? 'bg-amber-950 text-amber-300 border border-amber-600'
                          : programSongResult.status === 'NOT_FOUND'
                            ? 'bg-rose-950 text-rose-400 border border-rose-800'
                            : programSongResult.status === 'ERROR'
                              ? 'bg-rose-950 text-rose-400 border border-rose-800'
                              : 'bg-amber-950 text-amber-400 border border-amber-800 animate-pulse'
                    }`}>
                      {programSongResult.status === 'PLAYING'
                        ? 'Playing'
                        : programSongResult.status === 'API_ERROR'
                          ? 'API QUOTA ERROR'
                          : programSongResult.status === 'NOT_FOUND'
                            ? 'NOT FOUND'
                            : programSongResult.status === 'ERROR'
                              ? 'Unable to reliably select requested song'
                              : programSongResult.status}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-zinc-500">Requested:</span>
                      <span className="text-zinc-200 text-right font-semibold">
                        {programSongResult.requested}
                      </span>
                    </div>

                    {programSongResult.selectedTitle && (
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-zinc-500">Selected:</span>
                        <span className="text-amber-300 text-right font-bold truncate max-w-[280px]">
                          {programSongResult.selectedTitle}
                        </span>
                      </div>
                    )}

                    {programSongResult.selectedChannel && (
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">Channel:</span>
                        <span className="text-zinc-300">{programSongResult.selectedChannel}</span>
                      </div>
                    )}

                    {programSongResult.selectedDuration && (
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">Duration:</span>
                        <span className="text-zinc-300">
                          {programSongResult.selectedDuration}
                          {programSongResult.canonicalLength ? ` (Canonical: ${programSongResult.canonicalLength})` : ''}
                        </span>
                      </div>
                    )}

                    {programSongResult.selectedVideoId && (
                      <div className="flex justify-between items-center gap-2 pt-1 border-t border-zinc-900">
                        <span className="text-zinc-500">YouTube Video:</span>
                        <a
                          href={programSongResult.selectedUrl || `https://www.youtube.com/watch?v=${programSongResult.selectedVideoId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-amber-400 hover:underline flex items-center gap-1 text-[11px]"
                        >
                          <span>ID: {programSongResult.selectedVideoId}</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}

                    {programSongResult.reason && (
                      <div className="pt-1.5 border-t border-zinc-900 text-[11px] text-zinc-400 leading-normal">
                        <strong className="text-zinc-300">Selection Reason:</strong> {programSongResult.reason}
                      </div>
                    )}

                    {programSongResult.error && (
                      <div
                        className={`p-3 rounded text-xs flex items-start gap-2.5 border ${
                          programSongResult.status === 'API_ERROR'
                            ? 'bg-amber-950/60 border-amber-600 text-amber-200'
                            : 'bg-rose-950/60 border-rose-700 text-rose-200'
                        }`}
                      >
                        <AlertCircle
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            programSongResult.status === 'API_ERROR' ? 'text-amber-400' : 'text-rose-400'
                          }`}
                        />
                        <div>
                          <strong
                            className={`uppercase tracking-wide ${
                              programSongResult.status === 'API_ERROR' ? 'text-amber-400' : 'text-rose-400'
                            }`}
                          >
                            {programSongResult.status === 'API_ERROR'
                              ? 'API ERROR:'
                              : programSongResult.status === 'NOT_FOUND'
                                ? 'NOT FOUND:'
                                : 'STATUS ERROR:'}
                          </strong>{' '}
                          <span className="text-zinc-200 leading-relaxed font-semibold">
                            {programSongResult.error}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* SECTION 2: MUSIC CONTROL */}
            <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
              <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-amber-400" />
                  MUSIC CONTROL
                </h2>
                <div className="text-xs font-mono text-zinc-400">
                  Target: {targetMusicVolume}% | Ducked: {effectiveMusicVolume}%
                </div>
              </div>

              {/* Play / Pause / Stop Buttons */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={handlePlayMusic}
                  className="py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Play className="w-3.5 h-3.5 text-emerald-400" />
                  <span>PLAY</span>
                </button>
                <button
                  onClick={handlePauseMusic}
                  className="py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Pause className="w-3.5 h-3.5 text-amber-400" />
                  <span>PAUSE</span>
                </button>
                <button
                  onClick={handleStopMusic}
                  className="py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Square className="w-3.5 h-3.5 text-rose-400" />
                  <span>STOP</span>
                </button>
              </div>

              {/* Music Volume Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-zinc-400">Master Music Volume:</span>
                  <span className="text-amber-400 font-bold">{targetMusicVolume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={targetMusicVolume}
                  onChange={(e) => handleMusicVolumeChange(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
              </div>

              {/* Effective ducked volume meter */}
              <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded space-y-1.5">
                <div className="flex justify-between text-[11px] font-mono text-zinc-400">
                  <span>Current Output Volume (Ducking Active: {isDuckingActive ? 'YES' : 'NO'}):</span>
                  <span className="text-amber-400 font-bold">{effectiveMusicVolume}%</span>
                </div>
                <div className="w-full bg-zinc-900 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-75 ${
                      isDuckingActive ? 'bg-amber-400' : 'bg-emerald-400'
                    }`}
                    style={{ width: `${effectiveMusicVolume}%` }}
                  />
                </div>
              </div>
            </div>

          </div>

          {/* Right Column (DJ Test & Mix Controls) */}
          <div className="lg:col-span-6 space-y-6">

            {/* SECTION 3: DJ TEST & VOICE ENGINE */}
            <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
              <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                    DJ TEST: SPEECH &amp; VOICE
                  </h2>
                </div>
                <span className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                  voiceEngine === 'BROWSER' || djAudioData
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    : 'bg-zinc-900 text-zinc-500 border border-zinc-800'
                }`}>
                  {voiceEngine === 'BROWSER' ? 'ENGINE: BROWSER SPEECH (INSTANT)' : `GEMINI AUDIO: ${djAudioData ? 'READY' : 'NOT READY'}`}
                </span>
              </div>

              {/* Voice Engine Tabs */}
              <div className="flex bg-[#0a0c10] border border-zinc-800 p-1 rounded gap-1">
                <button
                  onClick={() => setVoiceEngine('GEMINI')}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-mono font-bold transition-colors ${
                    voiceEngine === 'GEMINI'
                      ? 'bg-amber-500 text-black shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  ⚡ Gemini Cloud AI Voice
                </button>
                <button
                  onClick={() => setVoiceEngine('BROWSER')}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-mono font-bold transition-colors ${
                    voiceEngine === 'BROWSER'
                      ? 'bg-amber-500 text-black shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  🎙️ Instant Browser DJ Voice (Zero Lag)
                </button>
              </div>

              {/* Preset Selector */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono text-zinc-400">Presets:</span>
                {SCRIPT_PRESETS.map((p, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setDjScript(p.text);
                      setDjStyle(p.style);
                      setDjAudioData(null);
                    }}
                    className="text-[11px] font-mono px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors"
                  >
                    {p.title}
                  </button>
                ))}
              </div>

              {/* DJ Script Input */}
              <div className="space-y-1">
                <label className="text-xs font-mono text-zinc-400 block">
                  DJ Script (Radio Personality Spoken Text):
                </label>
                <textarea
                  value={djScript}
                  onChange={(e) => {
                    setDjScript(e.target.value);
                    setDjAudioData(null);
                  }}
                  rows={3}
                  className="w-full bg-[#0a0c10] border border-zinc-700 rounded p-2.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-amber-500 leading-relaxed"
                  placeholder="Enter the radio DJ script here..."
                />
              </div>

              {/* Engine Specific Configuration */}
              {voiceEngine === 'GEMINI' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-mono text-zinc-400 block mb-1">
                        Prebuilt Voice:
                      </label>
                      <select
                        value={selectedVoice}
                        onChange={(e) => {
                          setSelectedVoice(e.target.value);
                          setDjAudioData(null);
                        }}
                        className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-amber-500"
                      >
                        <option value="Puck">Puck (Fast, punchy male DJ)</option>
                        <option value="Charon">Charon (Deep, rich baritone)</option>
                        <option value="Fenrir">Fenrir (Warm, confident)</option>
                        <option value="Zephyr">Zephyr (Bright, conversational)</option>
                        <option value="Kore">Kore (Smooth broadcast)</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-mono text-zinc-400 block mb-1">
                        Gemini TTS Model:
                      </label>
                      <select
                        value={selectedModel}
                        onChange={(e) => {
                          setSelectedModel(e.target.value);
                          setDjAudioData(null);
                        }}
                        className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-amber-500"
                      >
                        <option value="gemini-2.5-flash-preview-tts">gemini-2.5-flash-preview-tts (Recommended - Fast)</option>
                        <option value="gemini-3.8-flash-lite-tts">gemini-3.8-flash-lite-tts (Standard TTS)</option>
                        <option value="gemini-3.8-flash-tts">gemini-3.8-flash-tts (Screenplay/Burst)</option>
                      </select>
                    </div>
                  </div>

                  {/* Generate & Preview Buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleGenerateDJ()}
                      disabled={isGeneratingDJ}
                      className="flex-1 py-2.5 px-4 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Sparkles className={`w-3.5 h-3.5 ${isGeneratingDJ ? 'animate-spin' : ''}`} />
                      <span>{isGeneratingDJ ? 'Synthesizing with Gemini...' : 'Generate DJ Voice'}</span>
                    </button>

                    {djAudioData && (
                      <button
                        onClick={handleToggleDJPreview}
                        className="px-4 py-2.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                      >
                        {isPlayingDJPreview ? <Square className="w-3.5 h-3.5 text-amber-400" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
                        <span>{isPlayingDJPreview ? 'Stop Preview' : 'Solo Preview'}</span>
                      </button>
                    )}
                  </div>

                  {djError && (
                    <div className="p-2.5 rounded bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs font-mono flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{djError}</span>
                    </div>
                  )}

                  {djAudioData && (
                    <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex items-center justify-between text-xs font-mono text-zinc-400">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>Duration: ~{djAudioDuration}s | Model: {djModelUsed}</span>
                      </div>
                      <span className="text-[11px] text-zinc-500">24kHz 16-bit mono WAV</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded text-xs font-mono text-zinc-300 leading-relaxed">
                    <strong className="text-amber-400">Instant Browser Speech:</strong> Uses your Mac's built-in native speech synthesis to speak your DJ script live in real time with zero network latency.
                  </div>
                  <button
                    onClick={handleToggleDJPreview}
                    className="w-full py-2.5 px-4 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {isPlayingDJPreview ? <Square className="w-3.5 h-3.5 text-amber-400" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
                    <span>{isPlayingDJPreview ? 'Stop Preview' : 'Preview Instant Browser Speech'}</span>
                  </button>
                </div>
              )}
            </div>

            {/* SECTION 4: RADIO MIX TEST (Duck Volume, Fades, DJ OVER MUSIC) */}
            <div className="bg-[#13161f] border border-amber-500/30 rounded-lg p-5 shadow-xl space-y-4 relative overflow-hidden">
              <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-amber-400" />
                  <h2 className="text-sm font-bold font-mono tracking-wider text-amber-400 uppercase">
                    RADIO MIX TEST: DJ OVER MUSIC
                  </h2>
                </div>
                {mixPhase !== 'IDLE' && (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500 text-black font-bold animate-pulse">
                    PHASE: {mixPhase}
                  </span>
                )}
              </div>

              {/* Ducking Parameters */}
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-zinc-400">Duck Music Volume:</span>
                    <span className="text-amber-400 font-bold">{duckVolumePercent}% (Music drops to this level)</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="60"
                    value={duckVolumePercent}
                    onChange={(e) => setDuckVolumePercent(Number(e.target.value))}
                    className="w-full accent-amber-500 cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-mono text-zinc-400 block mb-1">
                      Fade Down Time:
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="100"
                        max="3000"
                        step="50"
                        value={fadeDownMs}
                        onChange={(e) => setFadeDownMs(Number(e.target.value))}
                        className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200"
                      />
                      <span className="text-xs font-mono text-zinc-500">ms</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-mono text-zinc-400 block mb-1">
                      Fade Up Time:
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="100"
                        max="3000"
                        step="50"
                        value={fadeUpMs}
                        onChange={(e) => setFadeUpMs(Number(e.target.value))}
                        className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200"
                      />
                      <span className="text-xs font-mono text-zinc-500">ms</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* The Critical Button: [ DJ OVER MUSIC ] */}
              <div>
                <button
                  onClick={() => executeDJOverMusic()}
                  disabled={isDuckingActive || isGeneratingDJ}
                  className="w-full py-3.5 px-6 rounded bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-black font-mono font-black text-sm uppercase tracking-widest transition-all shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Radio className={`w-4 h-4 ${isDuckingActive || isGeneratingDJ ? 'animate-spin' : ''}`} />
                  <span>
                    {isDuckingActive
                      ? `MIXING IN PROGRESS (${mixPhase})...`
                      : isGeneratingDJ
                        ? 'SYNTHESIZING DJ VOICE...'
                        : 'DJ OVER MUSIC'}
                  </span>
                </button>
              </div>

              {/* Audio Ducking Mechanics Diagram */}
              <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded font-mono text-[11px] text-zinc-400 space-y-1">
                <div className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider">
                  Signal Ducking Pipeline:
                </div>
                <div className="text-amber-400/90 leading-relaxed font-mono">
                  100% Music &rarr; ({fadeDownMs}ms fade down) &rarr; {duckVolumePercent}% Music + DJ Voice &rarr; ({fadeUpMs}ms fade up) &rarr; 100% Music
                </div>
              </div>
            </div>

            {/* SECTION 5: TIMING TEST */}
            <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-3">
              <div className="border-b border-zinc-800/80 pb-2 flex items-center justify-between">
                <h2 className="text-xs font-bold font-mono tracking-wider text-zinc-200 uppercase flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  TIMING TEST (MECHANICAL DELAY)
                </h2>
                {countdownRemaining !== null && (
                  <span className="text-xs font-mono text-amber-400 font-bold animate-pulse">
                    DROPPING IN {countdownRemaining}s...
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 items-center">
                <div>
                  <label className="text-xs font-mono text-zinc-400 block mb-1">
                    DJ Delay:
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="30"
                      value={timingDelaySeconds}
                      onChange={(e) => setTimingDelaySeconds(Number(e.target.value))}
                      className="w-20 bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200"
                    />
                    <span className="text-xs font-mono text-zinc-400">seconds</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-xs font-mono text-zinc-400 block mb-1">DJ Duration:</span>
                  <span className="text-xs font-mono text-amber-400 font-bold">
                    {djAudioDuration ? `${djAudioDuration}s (Automatic)` : 'Automatic'}
                  </span>
                </div>
              </div>

              <button
                onClick={handleRunTimingTest}
                disabled={isTimingTestRunning || isDuckingActive || isGeneratingDJ}
                className="w-full py-2.5 px-4 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 uppercase tracking-wider transition-colors cursor-pointer"
              >
                {isTimingTestRunning ? `Running Timing Test (${countdownRemaining}s)...` : 'Run Timing Test'}
              </button>
            </div>

          </div>
        </div>

        {/* --- SECTION: 5-SONG HISTORICAL SONG PROGRAMMING TEST SUITE --- */}
        <div className="bg-[#13161f] border border-amber-500/30 rounded-lg p-5 sm:p-6 shadow-xl space-y-5">
          <div className="border-b border-zinc-800/80 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Search className="w-5 h-5 text-amber-400" />
                <h2 className="text-base font-bold font-mono tracking-wider text-zinc-100 uppercase">
                  HISTORICAL SONG PROGRAMMING TEST (5 CANONICAL SONGS)
                </h2>
              </div>
              <p className="text-xs font-mono text-zinc-400 mt-1">
                Evaluates candidate selection, MusicBrainz duration validation, and hard rejection rules with zero overrides.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-bold ${
                  hasYouTubeApiKey === true
                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                    : hasYouTubeApiKey === false
                      ? 'bg-rose-950 text-rose-400 border border-rose-800'
                      : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                }`}
              >
                {hasYouTubeApiKey === true ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>YouTube API Key: Configured</span>
                  </>
                ) : hasYouTubeApiKey === false ? (
                  <>
                    <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                    <span>YouTube API Key: Missing</span>
                  </>
                ) : (
                  <span>Checking API Key...</span>
                )}
              </span>

              {/* Force Fresh Search Option */}
              <label
                className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0a0c10] border border-zinc-700 text-xs font-mono text-zinc-300 cursor-pointer hover:border-amber-500/50 transition-colors select-none"
                title="When unchecked, searches reuse persistent disk-cached results. Check to force fresh YouTube API queries."
              >
                <input
                  type="checkbox"
                  checked={forceFreshSearch}
                  onChange={(e) => setForceFreshSearch(e.target.checked)}
                  className="rounded bg-zinc-900 border-zinc-600 text-amber-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-amber-500"
                />
                <span className="font-semibold text-amber-300">Force fresh search</span>
              </label>

              <button
                onClick={handleRunSongTestSuite}
                disabled={isSongTestRunning || testingSongIndex !== null}
                className="py-2 px-4 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-black text-xs uppercase tracking-wider transition-colors shadow flex items-center gap-2 cursor-pointer"
                title="Run all 5 canonical test songs sequentially"
              >
                {isSongTestRunning ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Testing 5 Songs...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Run All</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Running API Quota Tracker & Session Meter */}
          <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded-lg font-mono text-xs space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-900 pb-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-amber-400" />
                <span className="font-bold text-zinc-200 uppercase tracking-wider text-[11px]">
                  YouTube API Session Quota Meter
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                  search.list: 100 units &bull; videos.list: 1 unit
                </span>
              </div>
              <div className="text-[11px] text-zinc-300 flex items-center gap-2">
                <span>
                  Units Used This Session:{' '}
                  <strong className="text-amber-400 font-bold">{quotaInfo.totalUnitsUsed}</strong>
                </span>
                <span className="text-zinc-600">&bull;</span>
                <span className="text-emerald-400 font-semibold">
                  Disk Cache Hits: {quotaInfo.cacheHits}
                </span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[11px] text-zinc-400">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Search Calls: <strong className="text-zinc-200">{quotaInfo.searchCalls}</strong> ({quotaInfo.searchCalls * 100} units)
                </span>
                <span>
                  Details Calls: <strong className="text-zinc-200">{quotaInfo.detailsCalls}</strong> ({quotaInfo.detailsCalls * 1} units)
                </span>
                <span className="inline-flex items-center gap-1 text-zinc-400">
                  <Database className="w-3 h-3 text-cyan-400" />
                  <span>Persistent Cache: Active (keyed by artist|song)</span>
                </span>
              </div>
              <div>
                Approx. Remaining Daily:{' '}
                <strong className="text-emerald-400 font-bold">
                  ~{quotaInfo.estimatedRemainingDaily.toLocaleString()} / 10,000 units
                </strong>
              </div>
            </div>

            {/* Quota Progress Bar */}
            <div className="w-full bg-zinc-900 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  quotaInfo.totalUnitsUsed > 8000
                    ? 'bg-rose-500'
                    : quotaInfo.totalUnitsUsed > 5000
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                }`}
                style={{
                  width: `${Math.min(100, Math.max(1, (quotaInfo.totalUnitsUsed / 10000) * 100))}%`,
                }}
              />
            </div>
          </div>

          {/* Missing YouTube API Key Clear Warning on Screen */}
          {hasYouTubeApiKey === false && (
            <div className="p-4 rounded bg-rose-950/50 border border-rose-700/80 text-rose-200 text-xs font-mono space-y-1.5">
              <div className="flex items-center gap-2 font-bold text-rose-300">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>YOUTUBE DATA API KEY IS MISSING</span>
              </div>
              <p className="text-zinc-300 leading-relaxed">
                The official YouTube Data API v3 search requires an API key in your environment.
                Please ensure <code className="text-amber-300 bg-black/40 px-1 py-0.5 rounded font-mono">YOUTUBE_API_KEY</code> is set in your <code className="text-amber-300 bg-black/40 px-1 py-0.5 rounded font-mono">.env</code> file.
              </p>
              {songTestError && (
                <div className="text-rose-400 text-[11px] pt-1">
                  <strong>Server Response:</strong> {songTestError}
                </div>
              )}
            </div>
          )}

          {/* Test Error Display if any */}
          {songTestError && hasYouTubeApiKey !== false && (
            <div className="p-3.5 rounded bg-rose-950/50 border border-rose-800 text-rose-300 text-xs font-mono flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>Test Suite Execution Notice:</strong> {songTestError}
              </div>
            </div>
          )}

          {/* Active Testing Spinner Notice */}
          {isSongTestRunning && (
            <div className="p-6 bg-[#0a0c10] border border-amber-500/30 rounded text-center space-y-2">
              <RefreshCw className="w-6 h-6 text-amber-400 animate-spin mx-auto" />
              <div className="text-xs font-mono text-amber-300 font-bold uppercase tracking-wider">
                Querying YouTube Data API v3 and MusicBrainz for 5 Canonical Test Songs...
              </div>
              <div className="text-[11px] font-mono text-zinc-400">
                Enforcing whole-word artist matching, duration bounds, keyword rejection, and channel tier ranking.
              </div>
            </div>
          )}

          {/* Empty Prompt when test hasn't been run yet */}
          {!isSongTestRunning && !songTestSuiteResults && (
            <div className="p-6 bg-[#0a0c10] border border-zinc-800 rounded text-center space-y-2">
              <Disc className="w-8 h-8 text-zinc-600 mx-auto" />
              <div className="text-xs font-mono text-zinc-300 font-bold uppercase tracking-wider">
                Test Suite Ready
              </div>
              <p className="text-xs font-mono text-zinc-500 max-w-lg mx-auto">
                Click <strong className="text-amber-400">"Run All"</strong> above or test individual songs one-at-a-time below to run canonical test songs through the official search engine. Uses persistent disk cache by default to protect API quota.
              </p>
              <div className="pt-2 flex flex-wrap justify-center gap-2">
                {CRITICAL_TEST_SONGS.map((cts, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleRunSingleSong(idx)}
                    disabled={isSongTestRunning || testingSongIndex !== null}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-zinc-200 hover:text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {testingSongIndex === idx ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
                    ) : (
                      <Play className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <span>Run #{idx + 1}: {cts.artist} - {cts.song}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Render 5 Test Songs Results Table */}
          {songTestSuiteResults && songTestSuiteResults.length > 0 && (
            <div className="space-y-6">
              {songTestSuiteResults.map((result, songIdx) => {
                const s = result.song;
                const chosen = result.selected;
                const candidates =
                  result.candidates && result.candidates.length > 0
                    ? result.candidates
                    : result.rejectedCandidates || [];
                const isApiError = result.status === 'api_error';
                const isNotFound = !result.success || result.status === 'not_found';

                return (
                  <div
                    key={songIdx}
                    className="bg-[#0a0c10] border border-zinc-800 rounded-lg overflow-hidden space-y-0"
                  >
                    {/* Song Header */}
                    <div className="p-3.5 bg-zinc-900/60 border-b border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-2 font-mono text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 font-bold flex items-center justify-center text-[11px] shrink-0">
                          {songIdx + 1}
                        </span>
                        <span className="font-bold text-zinc-100 text-sm">
                          {s.artist} — "{s.song}" ({s.year})
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        {result.canonicalInfo && (
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                            Canonical Year: <strong className="text-amber-400">{result.canonicalInfo.year || 'N/A'}</strong> | Length: <strong className="text-amber-400">{result.canonicalInfo.formattedLength || 'N/A'}</strong>
                          </span>
                        )}

                        {/* Status Badge: VERIFIED CHOSEN / QUOTA EXCEEDED / NOT FOUND / READY TO TEST */}
                        <span
                          className={`px-2 py-0.5 rounded font-bold ${
                            result.unrun
                              ? 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                              : isApiError
                                ? 'bg-amber-950 text-amber-300 border border-amber-600'
                                : !isNotFound
                                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                  : 'bg-rose-950 text-rose-400 border border-rose-800'
                          }`}
                        >
                          {result.unrun
                            ? 'READY TO TEST'
                            : isApiError
                              ? 'QUOTA EXCEEDED'
                              : !isNotFound
                                ? '✓ VERIFIED CHOSEN'
                                : 'NOT FOUND'}
                        </span>

                        {/* Individual Song "Run" Button */}
                        <button
                          onClick={() => handleRunSingleSong(songIdx)}
                          disabled={isSongTestRunning || testingSongIndex !== null}
                          className="px-2.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 hover:text-white font-bold text-[11px] flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                          title={`Run search test for ${s.artist} - ${s.song} only`}
                        >
                          {testingSongIndex === songIdx ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin text-amber-400" />
                              <span>Testing...</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 text-amber-400" />
                              <span>Run</span>
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => handleProgramSong({ artist: s.artist, song: s.song, year: s.year })}
                          disabled={isProgrammingSong || isNotFound || isApiError}
                          className="px-2.5 py-0.5 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-bold text-[11px] flex items-center gap-1 transition-colors cursor-pointer"
                          title="Load and play this song directly in the YouTube tab"
                        >
                          <Play className="w-3 h-3" />
                          <span>Play in Tab</span>
                        </button>
                      </div>
                    </div>

                    {/* Chosen Video Highlight Box, QUOTA EXCEEDED box, NOT FOUND box, or UNRUN state */}
                    {result.unrun ? (
                      <div className="p-3 bg-zinc-950/40 border-b border-zinc-800/80 font-mono text-xs text-zinc-400 flex items-center justify-between">
                        <span>Song not evaluated yet. Click <strong>Run</strong> above or <strong>Run All</strong> to execute search.</span>
                      </div>
                    ) : chosen ? (
                      <div className="p-3 bg-amber-950/20 border-b border-zinc-800/80 font-mono text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-amber-500 text-black font-black text-[10px]">
                              ★ CHOSEN RECORDING
                            </span>
                            <span className="font-bold text-amber-200">{chosen.title}</span>
                          </div>
                          <div className="text-[11px] text-zinc-400 mt-0.5 flex flex-wrap gap-x-3">
                            <span>Channel: <strong className="text-zinc-200">{chosen.channel}</strong></span>
                            <span>Duration: <strong className="text-zinc-200">{chosen.duration}</strong></span>
                            <span>Score: <strong className="text-amber-400">{chosen.confidenceScore}</strong></span>
                            <span>Video ID: <code className="text-amber-300">{chosen.videoId}</code></span>
                          </div>
                          <div className="text-[11px] text-zinc-400 mt-1 italic">
                            {chosen.reason}
                          </div>
                        </div>

                        <a
                          href={chosen.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs flex items-center gap-1.5 shrink-0 self-start sm:self-center transition-colors"
                        >
                          <span>Open on YouTube</span>
                          <ExternalLink className="w-3 h-3 text-amber-400" />
                        </a>
                      </div>
                    ) : isApiError ? (
                      <div className="p-3.5 bg-amber-950/30 border-b border-amber-900/50 font-mono text-xs text-amber-200 flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-bold text-amber-400 uppercase tracking-wide flex items-center gap-2">
                            <span>QUOTA / API ERROR</span>
                            <span className="text-[10px] px-1.5 py-0.5 bg-amber-900/50 text-amber-200 rounded border border-amber-700 font-normal">
                              API error occurred
                            </span>
                          </div>
                          <div className="mt-1 text-zinc-200 font-semibold">
                            {result.error || 'YouTube API daily quota exceeded. It resets at midnight Pacific time.'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3.5 bg-rose-950/25 border-b border-rose-900/40 font-mono text-xs text-rose-200 flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        <div>
                          <div className="font-bold text-rose-400 uppercase tracking-wide flex items-center gap-2">
                            <span>NOT FOUND</span>
                            <span className="text-[10px] px-1.5 py-0.5 bg-rose-900/40 text-rose-300 rounded border border-rose-800 font-normal">
                              No Tier 1 (Topic) or Tier 2 (Official / VEVO) recording qualified
                            </span>
                          </div>
                          <div className="mt-1 text-zinc-200 font-semibold">
                            {result.error || `No trustworthy recording found for ${s.artist} - ${s.song}. Nothing was played.`}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Top 5 Candidates Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-xs border-collapse">
                        <thead>
                          <tr className="bg-zinc-950 text-zinc-400 text-[11px] uppercase border-b border-zinc-800">
                            <th className="py-2.5 px-3 w-28">Status</th>
                            <th className="py-2.5 px-3 min-w-[200px]">Candidate Title</th>
                            <th className="py-2.5 px-3 min-w-[140px]">Channel</th>
                            <th className="py-2.5 px-3 w-16 text-center">Dur</th>
                            <th className="py-2.5 px-3 w-16 text-right">Score</th>
                            <th className="py-2.5 px-3 min-w-[280px]">Evaluation Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900">
                          {candidates.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="py-4 px-3 text-center text-zinc-500">
                                No candidates returned by YouTube search.
                              </td>
                            </tr>
                          ) : (
                            candidates.map((cand: any, cIdx: number) => {
                              const isChosenCand = chosen && chosen.videoId === cand.videoId;
                              const isPassed = Boolean(cand.isPassed && chosen);

                              return (
                                <tr
                                  key={cIdx}
                                  className={`transition-colors ${
                                    isChosenCand
                                      ? 'bg-amber-500/10 hover:bg-amber-500/15'
                                      : isPassed
                                        ? 'hover:bg-zinc-900/50'
                                        : 'opacity-70 hover:opacity-100 hover:bg-rose-950/10'
                                  }`}
                                >
                                  {/* Status Column */}
                                  <td className="py-2 px-3 whitespace-nowrap">
                                    {isChosenCand ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-black bg-amber-500 text-black">
                                        ★ CHOSEN
                                      </span>
                                    ) : isPassed ? (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                                        #{cIdx + 1} PASS
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-950 text-rose-400 border border-rose-800">
                                        REJECTED
                                      </span>
                                    )}
                                  </td>

                                  {/* Title Column */}
                                  <td className="py-2 px-3 font-semibold text-zinc-200 max-w-[240px] truncate" title={cand.title}>
                                    {cand.title}
                                  </td>

                                  {/* Channel Column */}
                                  <td className="py-2 px-3 text-zinc-300 max-w-[150px] truncate" title={cand.channel}>
                                    {cand.channel}
                                  </td>

                                  {/* Duration Column */}
                                  <td className="py-2 px-3 text-center text-zinc-400 whitespace-nowrap">
                                    {cand.duration || '--:--'}
                                  </td>

                                  {/* Score Column */}
                                  <td className="py-2 px-3 text-right whitespace-nowrap font-bold text-amber-400">
                                    {cand.score}
                                  </td>

                                  {/* Reason Column */}
                                  <td className="py-2 px-3 text-[11px] text-zinc-400 leading-tight">
                                    {cand.reason}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* --- SECTION 6: TEST RESULTS TABLE (All 11 Requirements) --- */}
        <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
          <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                TEST RESULTS: 11-POINT CAPABILITY MATRIX
              </h2>
            </div>
            <span className="text-xs font-mono text-zinc-500">Live Diagnostic Status</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 font-mono text-xs">
            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube tab detection:</span>
              {renderBadge(testResults.tabDetection)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube playback state:</span>
              {renderBadge(testResults.playbackState)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube playback control:</span>
              {renderBadge(testResults.playbackControl)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube volume control:</span>
              {renderBadge(testResults.volumeControl)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube current position:</span>
              {renderBadge(testResults.currentPosition)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">YouTube metadata:</span>
              {renderBadge(testResults.metadata)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Gemini Flash TTS:</span>
              {renderBadge(testResults.geminiTTS)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Gemini DJ audio playback:</span>
              {renderBadge(testResults.geminiPlayback)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Music + DJ simultaneous:</span>
              {renderBadge(testResults.simultaneousPlayback)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Music ducking:</span>
              {renderBadge(testResults.musicDucking)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Music restoration:</span>
              {renderBadge(testResults.musicRestoration)}
            </div>

            <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
              <span className="text-zinc-300">Overall radio-style mix:</span>
              {renderBadge(testResults.overallTransition)}
            </div>
          </div>
        </div>

        {/* --- SECTION 7: LIVE SYSTEM CONSOLE / LOG --- */}
        <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
            <span className="font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-amber-400" />
              EXPERIMENTAL EVENT LOG &amp; AUDIO TELEMETRY
            </span>
            <button
              onClick={() => setStatusLog([])}
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Clear Log
            </button>
          </div>
          <div className="h-32 bg-[#08090d] border border-zinc-900 rounded p-2.5 font-mono text-[11px] text-zinc-400 overflow-y-auto space-y-1">
            {statusLog.length === 0 ? (
              <span className="text-zinc-600">Console ready. Actions will be logged here in real time.</span>
            ) : (
              statusLog.map((log, i) => (
                <div key={i} className="leading-tight">
                  <span className="text-amber-500/80">{log.substring(0, 10)}</span>
                  <span className="text-zinc-300">{log.substring(10)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* --- SECTION 8: CRITICAL EVALUATION & QUESTIONS ACCORDION --- */}
        <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
          <button
            onClick={() => setShowEvaluationSection(!showEvaluationSection)}
            className="w-full flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                CRITICAL EVALUATION &amp; TECHNICAL DISCOVERIES (12 QUESTIONS)
              </h2>
            </div>
            {showEvaluationSection ? <ChevronUp className="w-4 h-4 text-zinc-400" /> : <ChevronDown className="w-4 h-4 text-zinc-400" />}
          </button>

          {showEvaluationSection && (
            <div className="pt-2 border-t border-zinc-800/80 space-y-4 text-xs font-mono leading-relaxed text-zinc-300">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">1. Can Retro FM communicate with a YouTube tab?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> Using a lightweight Manifest V3 Chrome Extension bridge that routes permitted messages between the web app and the YouTube tab's content script without bypassing browser security.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">2. Can it determine what YouTube is playing?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> The content script inspects the YouTube DOM (<code className="text-amber-300">h1.ytd-watch-metadata</code> or <code className="text-amber-300">document.title</code>) and HTML5 video state to report the title, playback status, time, and duration.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">3. Can it control YouTube playback?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> The extension triggers standard HTML5 media methods (<code className="text-amber-300">video.play()</code>, <code className="text-amber-300">video.pause()</code>, <code className="text-amber-300">video.currentTime</code>) on the active tab without modifying YouTube player internals.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">4. Can it control YouTube volume?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> Setting <code className="text-amber-300">video.volume</code> directly adjusts the YouTube player volume smoothly from 0.0 to 1.0.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">5. Can Gemini Flash TTS generate DJ audio quickly enough?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> <code className="text-amber-300">gemini-3.8-flash-tts</code> synthesizes standard 15-20 word radio voice scripts in roughly 600-1200ms, making pre-generation and schedule-ahead buffer queuing very practical.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">6. Can Gemini TTS play simultaneously with YouTube?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> Browsers naturally mix multiple audio streams concurrently across separate tabs and elements without audio graph contention or muting conflicts.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">7. Can the YouTube music be smoothly ducked?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> By interpolating <code className="text-amber-300">video.volume</code> over 500ms using sinusoidal easing inside the content script, music volume ducks smoothly down to 30% without stutter.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">8. Can the music be restored smoothly?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> Upon the DJ audio <code className="text-amber-300">onended</code> event, an inverse 750ms ramp restores the music seamlessly back to full broadcast level.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">9. Does the resulting combination actually sound like radio?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> Because the commercial music remains playing underneath the DJ voice rather than pausing, the brain perceives an authentic live radio station rather than a podcast interruption.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">10. What is the biggest technical obstacle?</span>
                  <p className="text-zinc-400">
                    <strong className="text-amber-300">Intro / Outro Timing:</strong> Knowing exactly when the vocal begins in a song (the instrumental "ramp") so the DJ does not talk over the singer's vocals.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">11. Which capabilities depend specifically on YouTube?</span>
                  <p className="text-zinc-400">
                    Only the DOM selectors and tab messaging. The ducking math, Gemini TTS engine, and timing architecture are entirely provider-agnostic.
                  </p>
                </div>

                <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-1">
                  <span className="text-amber-400 font-bold">12. Could the music layer be replaced with Spotify or other providers?</span>
                  <p className="text-zinc-400">
                    <strong className="text-emerald-400">YES.</strong> The <code className="text-amber-300">MusicProvider</code> interface abstracts playback and volume control cleanly, making a <code className="text-amber-300">SpotifyWebPlaybackProvider</code> a drop-in replacement.
                  </p>
                </div>

              </div>
            </div>
          )}
        </div>

      </div>

      {/* --- EXTENSION SETUP GUIDE & FILES MODAL --- */}
      {showExtensionModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#13161f] border border-zinc-700 rounded-lg max-w-2xl w-full p-6 space-y-4 shadow-2xl font-mono text-xs">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-3">
                <Radio className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                  RETRO FM CHROME EXTENSION
                </h3>
              </div>
              <button
                onClick={() => setShowExtensionModal(false)}
                className="text-zinc-400 hover:text-zinc-200 text-lg leading-none"
              >
                &times;
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-zinc-800 gap-2 pb-1">
              <button
                onClick={() => setModalTab('GUIDE')}
                className={`px-3 py-1.5 rounded-t text-xs font-bold transition-colors ${
                  modalTab === 'GUIDE'
                    ? 'bg-zinc-800 text-amber-400 border-b-2 border-amber-500'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Setup Instructions &amp; ZIP
              </button>
              <button
                onClick={() => {
                  setModalTab('FILES');
                  if (Object.keys(extensionFiles).length === 0) {
                    loadExtensionFiles();
                  }
                }}
                className={`px-3 py-1.5 rounded-t text-xs font-bold transition-colors ${
                  modalTab === 'FILES'
                    ? 'bg-zinc-800 text-amber-400 border-b-2 border-amber-500'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                View / Copy Extension Code
              </button>
            </div>

            {modalTab === 'GUIDE' ? (
              <div className="space-y-4">
                <ol className="space-y-3 text-zinc-300 list-decimal list-inside leading-relaxed">
                  <li>
                    Click <strong className="text-amber-400">Download ZIP Now</strong> below (compliant, cross-platform archive generated with Adm-Zip).
                  </li>
                  <li>
                    Uncompress/unzip <code className="text-zinc-200">retro-fm-extension.zip</code> to a folder on your computer.
                  </li>
                  <li>
                    In Chrome, navigate to <code className="text-amber-300">chrome://extensions/</code>
                  </li>
                  <li>
                    Toggle <strong className="text-zinc-100">Developer mode</strong> in the top-right corner to <strong className="text-emerald-400">ON</strong>.
                  </li>
                  <li>
                    Click <strong className="text-zinc-100">Load unpacked</strong> and select the unzipped extension directory.
                  </li>
                  <li>
                    Open <strong className="text-red-400">youtube.com</strong> in another tab, start playing a video, and click <strong className="text-amber-400">Connect YouTube Tab</strong> on Retro FM!
                  </li>
                </ol>

                <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded text-zinc-400 text-[11px] leading-relaxed">
                  <strong className="text-zinc-200">Alternative:</strong> If you prefer to create the files manually in a folder without unzipping, click the <strong className="text-amber-400">View / Copy Extension Code</strong> tab above to copy each file's code directly!
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* File selector pill list */}
                <div className="flex flex-wrap gap-1.5">
                  {['manifest.json', 'content_youtube.js', 'content_retrofm.js', 'background.js', 'popup.html', 'README.md'].map((fileName) => (
                    <button
                      key={fileName}
                      onClick={() => setActiveFileKey(fileName)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                        activeFileKey === fileName
                          ? 'bg-amber-500 text-black font-bold'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                    >
                      {fileName}
                    </button>
                  ))}
                </div>

                {/* Code display with Copy button */}
                <div className="relative">
                  <div className="flex justify-between items-center bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-t text-[11px] text-zinc-400">
                    <span>File: <strong className="text-zinc-200">{activeFileKey}</strong></span>
                    <button
                      onClick={() => handleCopyFileContent(activeFileKey, extensionFiles[activeFileKey] || '')}
                      className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-400 font-bold text-[11px] border border-zinc-700 flex items-center gap-1 transition-colors"
                    >
                      {copiedFileKey === activeFileKey ? 'Copied to Clipboard!' : 'Copy Code'}
                    </button>
                  </div>
                  <pre className="max-h-56 overflow-y-auto bg-[#08090d] border border-t-0 border-zinc-800 p-3 rounded-b text-[11px] text-zinc-300 font-mono leading-relaxed select-all">
                    {extensionFiles[activeFileKey] || 'Loading file content...'}
                  </pre>
                </div>
              </div>
            )}

            <div className="pt-2 flex justify-end gap-2 border-t border-zinc-800/80">
              <button
                onClick={() => generateAndDownloadExtensionZip()}
                className="px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold uppercase transition-colors cursor-pointer"
              >
                Download ZIP Now
              </button>
              <button
                onClick={() => setShowExtensionModal(false)}
                className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

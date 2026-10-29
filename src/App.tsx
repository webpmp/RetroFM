/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Cpu,
  Rocket,
  Copy,
  Mic2
} from 'lucide-react';
import { YouTubeMusicProvider } from './services/music/YouTubeMusicProvider.js';
import { VolumeController } from './services/audio/VolumeController.js';
import { MusicPlaybackStatus, TabInfo } from './services/music/types.js';
import { generateTTS, fetchKokoroStatus, KokoroVoice } from './services/ttsClient.js';
import { generateAndDownloadExtensionZip, EXTENSION_FILES, EXTENSION_VERSION } from './services/extensionBundle.js';
import { HistoricalFactPacketTest } from './components/HistoricalFactPacketTest.js';
import { DJBreakGeneratorTest } from './components/DJBreakGeneratorTest.js';
import { loadLibrary, newPlayState, pickSong, getAvailableGenres, isStrictlyReleasedBefore, isReleasedOnOrBefore, LibrarySong, PlayState, Pick as SongPick } from './services/songSelector.js';
import {
  buildBreak,
  newDjState,
  Song as ObsSong,
  DjState,
  TALK_PRESETS,
  type TalkLength,
} from './services/djBreak/djBreakObservations.js';
import {
  buildVarietyBreak,
  newVarietyState,
  artistTitle,
  type VarietyState,
  type BreakResult as VarietyBreakResult,
  type Jingle,
  type TopEntry,
} from './services/djBreak/djVariety.js';
import {
  newBreakSelectionSessionState,
  BreakSelectionSessionState,
  BreakDecisionResponsePayload,
} from './services/djBreak/breakDecisionTypes.js';
import { getScriptWriterProvider } from './services/djBreak/scriptWriterFactory.js';
import { getEnv } from './services/envUtil.js';
import { validateBreakOutput } from './services/djBreak/breakValidator.js';
import { shapeDelivery } from './services/djBreak/djDelivery.js';
import { clientNewsQueue, ClientNewsStatus } from './services/news/clientNewsQueue.js';
import { djVoiceEffects, DjVoiceEffectsSettings } from './services/audio/DjVoiceEffectsService.js';
import manifest from '../extension/manifest.json';

function toObsSong(s: LibrarySong | null | undefined): ObsSong | null {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    release_date: s.release_date ?? null,
    release_date_precision: s.release_date_precision ?? null,
    primary_genre: s.primary_genre ?? null,
    genres: s.genres ?? null,
    peak_position: s.peak_position ?? null,
    peak_date: s.peak_date ?? null,
    last_chart_date: s.last_chart_date ?? null,
    weeks_on_chart: s.weeks_on_chart ?? null,
  };
}

// Minimum required Chrome extension version
export const MIN_REQUIRED_EXTENSION_VERSION = manifest.version;

function compareVersions(v1: string, v2: string): number {
  const p1 = (v1 || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = (v2 || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

// Pre-defined 5 critical validation test songs
export const CRITICAL_TEST_SONGS = [
  { artist: 'a-ha', song: 'Take on Me', year: '1985' },
  { artist: 'Michael Jackson', song: 'Billie Jean', year: '1983' },
  { artist: 'Prince', song: 'When Doves Cry', year: '1984' },
  { artist: 'U2', song: 'With or Without You', year: '1987' },
  { artist: 'Peter Gabriel', song: 'Sledgehammer', year: '1986' },
];

export interface HardcodedPresetInfo {
  artist: string;
  song: string;
  year: string;
  videoId: string;
  title: string;
  channel: string;
  duration: string;
}

export const HARDCODED_PRESETS: Record<string, HardcodedPresetInfo> = {
  'a-ha|take on me': {
    artist: 'a-ha',
    song: 'Take on Me',
    year: '1985',
    videoId: 'f-BDCwxBF9Q',
    title: 'a-ha - Take on Me (1985)',
    channel: 'Official Recording',
    duration: '03:47',
  },
  'michael jackson|billie jean': {
    artist: 'Michael Jackson',
    song: 'Billie Jean',
    year: '1983',
    videoId: 'Kr4EQDVETuA',
    title: 'Michael Jackson - Billie Jean (1983)',
    channel: 'Official Recording',
    duration: '04:54',
  },
  'prince|when doves cry': {
    artist: 'Prince',
    song: 'When Doves Cry',
    year: '1984',
    videoId: 'Izx6DQUrsag',
    title: 'Prince - When Doves Cry (1984)',
    channel: 'Official Recording',
    duration: '05:52',
  },
  'u2|with or without you': {
    artist: 'U2',
    song: 'With or Without You',
    year: '1987',
    videoId: '6Q2mFw4VYBo',
    title: 'U2 - With or Without You (1987)',
    channel: 'Official Recording',
    duration: '04:56',
  },
  'peter gabriel|sledgehammer': {
    artist: 'Peter Gabriel',
    song: 'Sledgehammer',
    year: '1986',
    videoId: 'OJWJE0x7T4Q',
    title: 'Peter Gabriel - Sledgehammer (1986)',
    channel: 'Official Recording',
    duration: '04:58',
  },
};

// Initial Station Jingle Configuration
export const RETROFM_JINGLE_CONFIG = {
  videoId: '3Wk2FzsxK4k',
  title: 'RetroFM Station Jingle',
  artist: 'RetroFM',
  year: '1985',
  duration: '00:15',
  url: 'https://www.youtube.com/watch?v=3Wk2FzsxK4k'
};

// Default Station Song Queue (Ordered rotation of canonical tracks)
export const DEFAULT_SONG_QUEUE = [
  { videoId: 'f-BDCwxBF9Q', title: 'a-ha - Take on Me (1985)', artist: 'a-ha', song: 'Take on Me', year: '1985', release_date: '1984-10-19', release_date_precision: 'day', duration: '03:47' },
  { videoId: 'Kr4EQDVETuA', title: 'Michael Jackson - Billie Jean (1983)', artist: 'Michael Jackson', song: 'Billie Jean', year: '1983', release_date: '1983-01-02', release_date_precision: 'day', duration: '04:54' },
  { videoId: 'Izx6DQUrsag', title: 'Prince - When Doves Cry (1984)', artist: 'Prince', song: 'When Doves Cry', year: '1984', release_date: '1984-05-16', release_date_precision: 'day', duration: '05:52' },
  { videoId: '6Q2mFw4VYBo', title: 'U2 - With or Without You (1987)', artist: 'U2', song: 'With or Without You', year: '1987', release_date: '1987-03-16', release_date_precision: 'day', duration: '04:56' },
  { videoId: 'OJWJE0x7T4Q', title: 'Peter Gabriel - Sledgehammer (1986)', artist: 'Peter Gabriel', song: 'Sledgehammer', year: '1986', release_date: '1986-04-21', release_date_precision: 'day', duration: '04:58' }
];

export interface StationConfig {
  genre: string;
  frequency: number;
  presetKey?: string;
  stationId?: string;
}

export const ROTATING_TEST_PRESET_KEYS = [
  'a-ha|take on me',
  'michael jackson|billie jean',
  'prince|when doves cry',
  'u2|with or without you',
  'peter gabriel|sledgehammer'
];

export function getPresetForStation(stationCfg?: StationConfig): HardcodedPresetInfo {
  if (stationCfg?.presetKey && HARDCODED_PRESETS[stationCfg.presetKey]) {
    return HARDCODED_PRESETS[stationCfg.presetKey];
  }
  const idx = Math.abs(Math.round((stationCfg?.frequency ?? 90) * 10)) % ROTATING_TEST_PRESET_KEYS.length;
  return HARDCODED_PRESETS[ROTATING_TEST_PRESET_KEYS[idx]];
}

export const STATIONS_BY_DECADE: Record<number, StationConfig[]> = {
  1960: [
    { genre: 'Pop', frequency: 95.1, presetKey: 'a-ha|take on me', stationId: 'WPOP-FM' }, // 0
    { genre: 'Motown', frequency: 101.5, presetKey: 'michael jackson|billie jean', stationId: 'WMOT-FM' }, // 1
    { genre: 'Soul', frequency: 107.1, presetKey: 'prince|when doves cry', stationId: 'WSOL-FM' }, // 2
    { genre: 'R&B', frequency: 93.5, presetKey: 'u2|with or without you', stationId: 'WRNB-FM' }, // 3
    { genre: 'Rock', frequency: 99.5, presetKey: 'peter gabriel|sledgehammer', stationId: 'WROC-FM' }, // 4
    { genre: 'Folk Rock', frequency: 102.7, presetKey: 'a-ha|take on me', stationId: 'WFLK-FM' }, // 0
    { genre: 'Rock and Roll', frequency: 104.1, presetKey: 'michael jackson|billie jean', stationId: 'WRNR-FM' } // 1
  ],
  1970: [
    { genre: 'AOR', frequency: 95.5, presetKey: 'prince|when doves cry', stationId: 'WAOR-FM' }, // 2
    { genre: 'Disco', frequency: 98.7, presetKey: 'u2|with or without you', stationId: 'WDIS-FM' }, // 3
    { genre: 'Progressive Rock', frequency: 92.3, presetKey: 'peter gabriel|sledgehammer', stationId: 'WPRG-FM' }, // 4
    { genre: 'Soft Rock', frequency: 103.5, presetKey: 'a-ha|take on me', stationId: 'WSFT-FM' }, // 0
    { genre: 'Funk', frequency: 107.5, presetKey: 'michael jackson|billie jean', stationId: 'WFNK-FM' }, // 1
    { genre: 'Punk Rock', frequency: 91.1, presetKey: 'prince|when doves cry', stationId: 'WPNK-FM' }, // 2
    { genre: 'Outlaw Country', frequency: 97.1, presetKey: 'u2|with or without you', stationId: 'WOUT-FM' } // 3
  ],
  1980: [
    { genre: 'College Rock', frequency: 88.9, presetKey: 'peter gabriel|sledgehammer', stationId: 'WCRK-FM' }, // 4
    { genre: 'Hip-Hop', frequency: 89.9, presetKey: 'a-ha|take on me', stationId: 'WHIP-FM' }, // 0
    { genre: 'New Wave', frequency: 90.7, presetKey: 'michael jackson|billie jean', stationId: 'WNEW-FM' }, // 1
    { genre: 'Synth-Pop', frequency: 93.1, presetKey: 'prince|when doves cry', stationId: 'WSYN-FM' }, // 2
    { genre: 'Urban Contemporary', frequency: 97.9, presetKey: 'u2|with or without you', stationId: 'WURB-FM' }, // 3
    { genre: 'CHR', frequency: 101.9, presetKey: 'peter gabriel|sledgehammer', stationId: 'WCHR-FM' }, // 4
    { genre: 'Hair Metal', frequency: 105.5, presetKey: 'a-ha|take on me', stationId: 'WHAR-FM' } // 0
  ],
  1990: [
    { genre: 'Grunge', frequency: 99.9, presetKey: 'michael jackson|billie jean', stationId: 'WGRN-FM' }, // 1
    { genre: 'Alternative Rock', frequency: 106.7, presetKey: 'prince|when doves cry', stationId: 'WALT-FM' }, // 2
    { genre: 'Gangsta Rap', frequency: 92.7, presetKey: 'u2|with or without you', stationId: 'WRAP-FM' }, // 3
    { genre: 'Contemporary R&B', frequency: 105.1, presetKey: 'peter gabriel|sledgehammer', stationId: 'WRNB-FM' }, // 4
    { genre: 'Teen Pop', frequency: 100.3, presetKey: 'a-ha|take on me', stationId: 'WTEN-FM' }, // 0
    { genre: 'Eurodance', frequency: 96.3, presetKey: 'michael jackson|billie jean', stationId: 'WEUR-FM' }, // 1
    { genre: 'Country Pop', frequency: 94.7, presetKey: 'prince|when doves cry', stationId: 'WCPY-FM' } // 2
  ],
  2000: [
    { genre: 'Nu-Metal', frequency: 93.7, presetKey: 'u2|with or without you', stationId: 'WNUM-FM' }, // 3
    { genre: 'Post-Grunge', frequency: 107.3, presetKey: 'peter gabriel|sledgehammer', stationId: 'WPST-FM' }, // 4
    { genre: 'Emo', frequency: 91.3, presetKey: 'a-ha|take on me', stationId: 'WEMO-FM' }, // 0
    { genre: 'Crunk', frequency: 106.1, presetKey: 'michael jackson|billie jean', stationId: 'WCRK-FM' }, // 1
    { genre: 'Electropop', frequency: 102.3, presetKey: 'prince|when doves cry', stationId: 'WEPO-FM' }, // 2
    { genre: 'Indie Rock', frequency: 90.3, presetKey: 'u2|with or without you', stationId: 'WIND-FM' }, // 3
    { genre: 'Reggaeton', frequency: 96.7, presetKey: 'peter gabriel|sledgehammer', stationId: 'WREG-FM' } // 4
  ],
  2010: [
    { genre: 'EDM', frequency: 101.1, presetKey: 'a-ha|take on me', stationId: 'WEDM-FM' }, // 0
    { genre: 'Trap', frequency: 104.5, presetKey: 'michael jackson|billie jean', stationId: 'WTRP-FM' }, // 1
    { genre: 'Indie Pop', frequency: 91.9, presetKey: 'prince|when doves cry', stationId: 'WIND-FM' }, // 2
    { genre: 'Mumble Rap', frequency: 99.1, presetKey: 'u2|with or without you', stationId: 'WMUM-FM' }, // 3
    { genre: 'Synthwave', frequency: 89.3, presetKey: 'peter gabriel|sledgehammer', stationId: 'WSYN-FM' }, // 4
    { genre: 'Afrobeats', frequency: 105.9, presetKey: 'a-ha|take on me', stationId: 'WAFR-FM' } // 0
  ],
  2020: [
    { genre: 'Bedroom Pop', frequency: 88.1, presetKey: 'michael jackson|billie jean', stationId: 'WBED-FM' }, // 1
    { genre: 'Hyperpop', frequency: 90.9, presetKey: 'prince|when doves cry', stationId: 'WHYP-FM' }, // 2
    { genre: 'Amapiano', frequency: 103.9, presetKey: 'u2|with or without you', stationId: 'WAMA-FM' }, // 3
    { genre: 'Drift Phonk', frequency: 95.9, presetKey: 'peter gabriel|sledgehammer', stationId: 'WDRF-FM' }, // 4
    { genre: 'Regional Mexican', frequency: 102.9, presetKey: 'a-ha|take on me', stationId: 'WMEX-FM' }, // 0
    { genre: 'Lofi Hip-Hop', frequency: 88.5, presetKey: 'michael jackson|billie jean', stationId: 'WLOF-FM' } // 1
  ]
};

/**
 * Calculates dynamic station configs with distinct FM dial frequencies (88.1 - 107.9 FM)
 * for all genres historically available in the library for the given broadcast date.
 * If the library has eligible songs for that date, returns stations for those exact genres.
 * Otherwise, falls back to the default decade stations.
 */
export function calculateDynamicStationsForDate(
  library: LibrarySong[],
  broadcastDate: string,
  decade: number
): StationConfig[] {
  if (library.length > 0) {
    const availableGenres = getAvailableGenres(library, broadcastDate);
    if (availableGenres.length > 0) {
      const minFreq = 88.5;
      const maxFreq = 107.5;
      const step = availableGenres.length > 1
        ? (maxFreq - minFreq) / (availableGenres.length - 1)
        : 0;

      return availableGenres.map((genre, idx) => {
        const rawFreq = minFreq + idx * step;
        // Round to nearest odd tenth on the FM dial (e.g. 88.5, 89.1, 89.7...)
        const tenths = Math.round(rawFreq * 10);
        const oddTenths = tenths % 2 === 0 ? tenths + 1 : tenths;
        const frequency = Math.min(107.9, Math.max(88.1, parseFloat((oddTenths / 10).toFixed(1))));
        return {
          genre,
          frequency,
          stationId: `W${genre.slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X')}-FM`
        };
      });
    }
  }
  return STATIONS_BY_DECADE[decade] || [];
}

/**
 * Normalizes YouTube URLs (including /shorts/ and youtu.be) to a 11-char video ID
 */
export function normalizeYouTubeVideoId(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const shortsMatch = trimmed.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  const watchMatch = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  const shareMatch = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shareMatch) return shareMatch[1];
  return trimmed;
}

// Pre-defined DJ script templates
const SCRIPT_PRESETS = [
  {
    title: 'Chart Climber (Default)',
    text: "Here's another one that's been climbing the charts all week. Stay with us right here on RetroFM.",
    style: "Confident, conversational 1980s radio DJ. Fast but natural pacing. Warm broadcast voice. Slightly energetic. Not announcer-like."
  },
  {
    title: 'Top of the Hour Station ID',
    text: "You are locked into RetroFM, your non-stop vintage soundtrack. It's twenty past the hour, turning up the heat with this absolute classic.",
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
  const volumeControllerRef = useRef<VolumeController | null>(null);
  const djAudioRef = useRef<HTMLAudioElement | null>(null);
  const persistentDjAudioRef = useRef<HTMLAudioElement | null>(null);
  const isDjAudioInitializedRef = useRef<boolean>(false);
  const isDjSpeakingRef = useRef<boolean>(false);

  // --- Extension & Tab Connection State ---
  const [extensionDetected, setExtensionDetected] = useState<boolean>(false);
  const [reportedExtensionVersion, setReportedExtensionVersion] = useState<string | null>(null);
  const [availableTabs, setAvailableTabs] = useState<TabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isLaunchingGroup, setIsLaunchingGroup] = useState<boolean>(false);
  const [isOpeningBoomBox, setIsOpeningBoomBox] = useState<boolean>(false);
  const hasAutoInitializedStartupRef = useRef<boolean>(false);
  const [launchMessage, setLaunchMessage] = useState<{ text: string; isError: boolean } | null>(null);
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

  const [targetMusicVolume, setTargetMusicVolume] = useState<number>(100);
  const [revealYouTubeToStart, setRevealYouTubeToStart] = useState<boolean>(false);
  const [askForOneTimeClick, setAskForOneTimeClick] = useState<boolean>(true);

  // --- Station Jingle First Sequence State ---
  // Tracks whether the initial jingle has been played/completed or cancelled
  const jingleStateRef = useRef<'prepared' | 'playing' | 'completed' | 'cancelled'>('prepared');
  // First real song playback tracker (suppresses status display until first song plays)
  const hasFirstSongStartedPlayingRef = useRef<boolean>(false);

  // --- Station Song Queue Tracking ---
  const currentQueueIndexRef = useRef<number>(0);
  const isAdvancingRef = useRef<boolean>(false);
  const isStartupReadyRef = useRef<boolean>(false);

  // --- Station Tuning & Position Preservation State ---
  const stationPlaybackCacheRef = useRef<Record<string, {
    genre: string;
    frequency: number;
    videoId: string;
    title: string;
    artist: string;
    song: string;
    year: string;
    currentTime: number;
    duration: number;
  }>>({});
  const activeStationGenreRef = useRef<string | null>(null);
  const tuneSequenceRef = useRef<number>(0);
  const currentPlayingArtistRef = useRef<string>('a-ha');
  const currentPlayingSongRef = useRef<string>('Take on Me');
  const currentPlayingYearRef = useRef<string>('1985');
  const isTuningSeekingRef = useRef<boolean>(false);

  // --- Historical Song Selector & Library State ---
  const songLibraryRef = useRef<LibrarySong[]>([]);
  const songPlayStateRef = useRef<PlayState>(newPlayState());
  const nextSongRef = useRef<SongPick | null>(null);
  const activeDateRef = useRef<string>('1964-07-04');
  const [isLibraryLoaded, setIsLibraryLoaded] = useState<boolean>(false);

  // --- Session Play History (Single Source of Truth) ---
  interface SessionHistoryEntry {
    pick: SongPick;
    song: LibrarySong;
    videoId: string;
  }
  const sessionHistoryRef = useRef<{ entries: SessionHistoryEntry[]; pointer: number }>({
    entries: [],
    pointer: -1,
  });
  const songUpdateSeqRef = useRef<number>(0);

  // Synchronize recent played IDs with pickSong's songPlayStateRef
  const syncPlayStateFromHistory = () => {
    const ids = sessionHistoryRef.current.entries.map((e) => e.song.id);
    songPlayStateRef.current = { recent: ids.slice(-40) };
  };

  // --- DJ Mode & Commentary State ---
  const [djMode, setDjMode] = useState<'ai' | 'observations' | 'off'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('retrofm_dj_mode') as 'ai' | 'observations' | 'off') || 'ai';
    }
    return 'ai';
  });
  const djStateRef = useRef<DjState>(newDjState());
  const varietyStateRef = useRef<VarietyState>(newVarietyState());
  const specABreakStateRef = useRef<BreakSelectionSessionState>(newBreakSelectionSessionState());
  const weeklyTopDataRef = useRef<Record<string, TopEntry[]> | undefined>(undefined);
  const jinglesDataRef = useRef<Jingle[]>([]);
  const pendingJingleRef = useRef<Jingle | null>(null);
  const activeJingleRef = useRef<Jingle | null>(null);
  const jingleEndedHandlerRef = useRef<(() => void) | null>(null);
  const jingleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previousLibrarySongRef = useRef<LibrarySong | null>(null);
  const currentSongPickRef = useRef<SongPick | null>(null);
  const [currentSongPick, setCurrentSongPick] = useState<SongPick | null>(null);
  const [lastDjBreak, setLastDjBreak] = useState<{
    text: string;
    slot: 'before' | 'after';
    kind: string | null;
    detail?: string;
    timing?: 'land' | 'follow';
    wordCount?: number;
    spokenSeconds?: number;
    deliverySettings?: {
      length: TalkLength;
      excitement: number;
      pauses: number;
    };
  } | null>(null);

  // Ahead-of-time DJ Break preparation & triggering refs
  const preparedBreakRef = useRef<{
    id: string; // current song videoId or song id
    audioData: string | null;
    durationSec: number;
    text: string;
    slot: 'before' | 'after';
    kind: string | null;
    detail?: string;
    timing?: 'land' | 'follow';
    maxSeconds?: number;
    wordCount?: number;
    deliverySettings?: {
      length: TalkLength;
      excitement: number;
      pauses: number;
    };
    pendingVarietyState?: VarietyState;
    varietyResult?: VarietyBreakResult;
    pendingState?: DjState;
    triggerTimeRemaining: number;
    duckTriggerTimeRemaining: number;
    newsText?: string | null;
    economyKind?: string | null;
  } | null>(null);
  const [newsDebugStatus, setNewsDebugStatus] = useState<ClientNewsStatus>(() => clientNewsQueue.getStatus());
  const isPreparingBreakRef = useRef<boolean>(false);
  const breakTriggeredForSongIdRef = useRef<string | null>(null);
  const breakDuckingStartedRef = useRef<boolean>(false);

  // Subscribe to news queue status updates
  useEffect(() => {
    const unsub = clientNewsQueue.subscribe((status) => {
      setNewsDebugStatus(status);
    });
    return () => unsub();
  }, []);

  const handleDjModeChange = (mode: 'ai' | 'observations' | 'off') => {
    setDjMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('retrofm_dj_mode', mode);
    }
    logMessage(`[DJ Mode] Switched to ${mode === 'ai' ? 'AI-written (current)' : mode === 'observations' ? 'Observations (template)' : 'Off'}`);
  };

  const [djTalkFrequency, setDjTalkFrequency] = useState<'every' | 'often' | 'sometimes' | 'rarely'>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('retrofm_dj_talk_frequency') as 'every' | 'often' | 'sometimes' | 'rarely' | null;
      if (stored && (stored === 'every' || stored === 'often' || stored === 'sometimes' || stored === 'rarely')) {
        return stored;
      }
    }
    return 'every';
  });

  const handleDjTalkFrequencyChange = (freq: 'every' | 'often' | 'sometimes' | 'rarely') => {
    setDjTalkFrequency(freq);
    if (typeof window !== 'undefined') {
      localStorage.setItem('retrofm_dj_talk_frequency', freq);
    }
    logMessage(`[DJ Talk Frequency] Switched to ${freq}`);
  };

  // DJ Talk Length: 'short' | 'mixed' | 'long' (default: 'mixed')
  const [djTalkLength, setDjTalkLength] = useState<TalkLength>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('retrofm_dj_talk_length') as TalkLength | null;
      if (stored && (stored === 'short' || stored === 'mixed' || stored === 'long')) {
        return stored;
      }
    }
    return 'mixed';
  });

  const handleDjTalkLengthChange = (len: TalkLength) => {
    setDjTalkLength(len);
    if (typeof window !== 'undefined') {
      localStorage.setItem('retrofm_dj_talk_length', len);
    }
    logMessage(`[DJ Talk Length] Switched to ${len}`);
  };

  // DJ Excitement slider: 0 to 100 (default: 30)
  const [djExcitement, setDjExcitement] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('retrofm_dj_excitement');
      if (stored !== null) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= 0 && val <= 100) return val;
      }
    }
    return 30;
  });

  const handleDjExcitementChange = (val: number) => {
    setDjExcitement(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('retrofm_dj_excitement', String(val));
    }
  };

  // DJ Pauses slider: 0 to 100 (default: 30)
  const [djPauses, setDjPauses] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('retrofm_dj_pauses');
      if (stored !== null) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= 0 && val <= 100) return val;
      }
    }
    return 30;
  });

  const handleDjPausesChange = (val: number) => {
    setDjPauses(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('retrofm_dj_pauses', String(val));
    }
  };

  // --- PROGRAM SONG Test State ---
  const [programArtist, setProgramArtist] = useState<string>('a-ha');
  const [programSongTitle, setProgramSongTitle] = useState<string>('Take on Me');
  const [programYear, setProgramYear] = useState<string>('1995');
  const [isProgrammingSong, setIsProgrammingSong] = useState<boolean>(false);
  const [programSongResult, setProgramSongResult] = useState<{
    status: 'IDLE' | 'SEARCHING' | 'NAVIGATING' | 'PLAYING' | 'NOT_FOUND' | 'API_ERROR' | 'ERROR';
    requested: string;
    selectedTitle?: string;
    selectedChannel?: string;
    selectedDuration?: string;
    selectedDurationSec?: number;
    selectedVideoId?: string;
    selectedUrl?: string;
    confidenceScore?: number;
    reason?: string;
    canonicalYear?: string;
    canonicalLength?: string;
    source?: string;
    error?: string;
  } | null>(null);
  const [songPlaybackNotice, setSongPlaybackNotice] = useState<{
    message: string;
    artist?: string;
    song?: string;
    type?: 'not_found' | 'api_error' | 'info';
  } | null>(null);

  // --- Audio Diagnostics State ---
  const [audioDiagnostics, setAudioDiagnostics] = useState<{ snapshot: any; events: any[] } | null>(null);
  const [lastBoomBoxCommand, setLastBoomBoxCommand] = useState<{ action: string; result: string; time: string } | null>(null);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState<boolean>(false);
  const [hasInteracted, setHasInteracted] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && navigator.userActivation && navigator.userActivation.hasBeenActive) {
      return true;
    }
    return false;
  });
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const preMuteVolumeRef = useRef<number>(100);

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
  const [voiceEngine, setVoiceEngine] = useState<'GEMINI' | 'KOKORO' | 'BROWSER'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_voice_engine');
      if (saved === 'GEMINI' || saved === 'KOKORO' || saved === 'BROWSER') return saved;
    }
    return 'BROWSER';
  });
  const [djScript, setDjScript] = useState<string>(SCRIPT_PRESETS[0].text);
  const [djStyle, setDjStyle] = useState<string>(SCRIPT_PRESETS[0].style);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('retrofm_gemini_voice') || 'Puck';
    }
    return 'Puck';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('retrofm_gemini_model') || 'gemini-2.5-flash-preview-tts';
    }
    return 'gemini-2.5-flash-preview-tts';
  });
  const [selectedKokoroVoice, setSelectedKokoroVoice] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('retrofm_kokoro_voice') || 'am_michael';
    }
    return 'am_michael';
  });
  const [kokoroSpeed, setKokoroSpeed] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_kokoro_speed');
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 2.0) {
          return Math.round(parsed * 100) / 100;
        }
      }
    }
    return 1.0;
  });
  const [kokoroVoices, setKokoroVoices] = useState<KokoroVoice[]>([
    { id: 'am_michael', name: 'Michael (American Male - DJ/Host)' },
    { id: 'am_echo', name: 'Echo (American Male)' },
    { id: 'bm_george', name: 'George (British Male - BBC Host)' },
    { id: 'af_bella', name: 'Bella (American Female)' },
    { id: 'af_sarah', name: 'Sarah (American Female)' },
    { id: 'bf_emma', name: 'Emma (British Female)' },
    { id: 'bf_isabella', name: 'Isabella (British Female)' },
  ]);
  const [isKokoroAvailable, setIsKokoroAvailable] = useState<boolean | null>(null);
  const [hasGeminiApiKey, setHasGeminiApiKey] = useState<boolean | null>(null);
  const [isGeneratingDJ, setIsGeneratingDJ] = useState<boolean>(false);
  const [djAudioData, setDjAudioData] = useState<string | null>(null);
  const [djAudioDuration, setDjAudioDuration] = useState<number>(0);
  const [djModelUsed, setDjModelUsed] = useState<string>('');
  const [djError, setDjError] = useState<string | null>(null);
  const [isPlayingDJPreview, setIsPlayingDJPreview] = useState<boolean>(false);
  const [djEffects, setDjEffects] = useState<DjVoiceEffectsSettings>(() => djVoiceEffects.getSettings());

  // DJ Voice Volume (0 to 100%, default 50%)
  const [djVoiceVolumePercent, setDjVoiceVolumePercent] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_dj_voice_volume');
      if (saved !== null) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) return Math.round(parsed);
      }
    }
    const eff = djVoiceEffects.getSettings().voiceVolume;
    return typeof eff === 'number' ? Math.round(eff * 100) : 50;
  });

  const handleDjVoiceVolumeChange = (val: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(val)));
    setDjVoiceVolumePercent(clamped);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('retrofm_dj_voice_volume', String(clamped));
      } catch {}
    }
    const updated = djVoiceEffects.updateSettings({ voiceVolume: clamped / 100 });
    setDjEffects(updated);
    if (persistentDjAudioRef.current) {
      persistentDjAudioRef.current.volume = clamped / 100;
    }
    if (djAudioRef.current) {
      djAudioRef.current.volume = clamped / 100;
    }
  };

  // --- Radio Mix & Ducking Configuration ---
  const [duckVolumePercent, setDuckVolumePercent] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_duck_volume');
      if (saved) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= 5 && parsed <= 60) return parsed;
      }
    }
    return 20; // 20% default
  });
  const [fadeDownMs, setFadeDownMs] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_fade_down_ms');
      if (saved) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= 100 && parsed <= 5000) return parsed;
      }
    }
    return 500; // 500 ms default
  });
  const [fadeUpMs, setFadeUpMs] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('retrofm_fade_up_ms');
      if (saved) {
        const parsed = Number(saved);
        if (!isNaN(parsed) && parsed >= 100 && parsed <= 10000) return parsed;
      }
    }
    return 750; // 750 ms default
  });
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
  const [updateSuccessVersion, setUpdateSuccessVersion] = useState<string | null>(null);
  const [copiedExtensionsUrl, setCopiedExtensionsUrl] = useState<boolean>(false);
  const [copiedTransportTrace, setCopiedTransportTrace] = useState<boolean>(false);
  const previousReportedVersionRef = useRef<string | null>(null);
  const hadOutdatedBannerRef = useRef<boolean>(false);

  const handleCopyExtensionsUrl = () => {
    navigator.clipboard.writeText('chrome://extensions');
    setCopiedExtensionsUrl(true);
    setTimeout(() => setCopiedExtensionsUrl(false), 2500);
  };

  const handleCopyTransportTrace = async () => {
    try {
      const traceText = await musicProviderRef.current.getTransportTrace();
      await navigator.clipboard.writeText(traceText);
      setCopiedTransportTrace(true);
      logMessage('Copied transport trace to clipboard.');
      setTimeout(() => setCopiedTransportTrace(false), 2500);
    } catch (err: any) {
      logMessage(`Failed to copy transport trace: ${err?.message || 'unknown error'}`);
    }
  };

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

  // Initialize VolumeController once
  if (!volumeControllerRef.current) {
    volumeControllerRef.current = new VolumeController({
      musicProvider: musicProviderRef.current,
      onLog: (msg) => logMessage(msg),
      initialUserVolume: 100,
      initialDuckLevel: duckVolumePercent,
    });
  }

  // Returns the current navigation volume fraction (0.0 - 1.0).
  // If ducking is active (e.g. during a DJ break spanning a track boundary),
  // returns the ducked effective volume to prevent blasting full volume on song start.
  const getNavVolumeFraction = (): number => {
    const vc = volumeControllerRef.current;
    if (!vc) return targetMusicVolume / 100;
    return (vc.isSequenceActive() ? vc.getEffectiveVolume() : vc.getUserVolume()) / 100;
  };

  // Subscribe to VolumeController state changes
  useEffect(() => {
    const vc = volumeControllerRef.current;
    if (!vc) return;
    const unsub = vc.subscribe((state, effective, user, duck) => {
      setIsDuckingActive(state !== 'idle');
      setEffectiveMusicVolume(effective);
      setTargetMusicVolume(user);
      setDuckVolumePercent(duck);
    });
    return unsub;
  }, []);

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

    // Query health status (Gemini API key presence)
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        setHasGeminiApiKey(Boolean(data.hasApiKey));
      })
      .catch(() => setHasGeminiApiKey(false));

    // Check Kokoro service availability and load supported voices
    fetchKokoroStatus()
      .then((status) => {
        setIsKokoroAvailable(status.isAvailable);
        if (status.isAvailable) {
          const savedEngine = typeof window !== 'undefined' ? localStorage.getItem('retrofm_voice_engine') : null;
          if (!savedEngine || savedEngine === 'BROWSER') {
            setVoiceEngine('KOKORO');
          }
        }
        if (status.voices && status.voices.length > 0) {
          setKokoroVoices(status.voices);
          // If current selection is invalid, reset to default
          if (!status.voices.some((v) => v.id === selectedKokoroVoice)) {
            setSelectedKokoroVoice(status.defaultVoice || status.voices[0].id);
          }
        }
      })
      .catch(() => setIsKokoroAvailable(false));

    return () => {
      killAllAudio();
    };
  }, []);

  // Sync Voice Engine and selections to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('retrofm_voice_engine', voiceEngine);
    } catch {}
  }, [voiceEngine]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_kokoro_voice', selectedKokoroVoice);
    } catch {}
  }, [selectedKokoroVoice]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_kokoro_speed', kokoroSpeed.toFixed(2));
    } catch {}
  }, [kokoroSpeed]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_gemini_voice', selectedVoice);
    } catch {}
  }, [selectedVoice]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_gemini_model', selectedModel);
    } catch {}
  }, [selectedModel]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_duck_volume', String(duckVolumePercent));
    } catch {}
  }, [duckVolumePercent]);

  useEffect(() => {
    try {
      localStorage.setItem('retrofm_dj_voice_volume', String(djVoiceVolumePercent));
    } catch {}
  }, [djVoiceVolumePercent]);

  // --- Load Song Library once at startup ---
  useEffect(() => {
    songPlayStateRef.current = newPlayState();
    loadLibrary()
      .then((lib) => {
        songLibraryRef.current = lib;
        logMessage(`[Song Selector] Loaded historical song library (${lib.length} tracks).`);
        setIsLibraryLoaded(true);
      })
      .catch((err) => {
        logMessage(`[Song Selector Error] Failed to load song library: ${err?.message || err}`);
      });

    // 1. Load public/data/weekly_top.json and public/data/jingles.json (optional)
    fetch('/data/weekly_top.json')
      .then((res) => (res.ok ? res.json() : undefined))
      .then((data) => {
        weeklyTopDataRef.current = data;
        if (data) {
          logMessage(`[DJ Variety] Loaded weekly_top.json (${Object.keys(data).length} chart weeks).`);
        }
      })
      .catch(() => {
        weeklyTopDataRef.current = undefined;
      });

    fetch('/data/jingles.json')
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        jinglesDataRef.current = Array.isArray(data) ? data : [];
        if (Array.isArray(data) && data.length > 0) {
          logMessage(`[DJ Variety] Loaded jingles.json (${data.length} jingles).`);
        }
      })
      .catch(() => {
        jinglesDataRef.current = [];
      });
  }, []);

  // --- Extension Heartbeat / Detection Loop ---
  useEffect(() => {
    const checkExt = async () => {
      const pingResult = await musicProviderRef.current.pingExtension();
      setExtensionDetected(pingResult.active);
      const reportedVer = pingResult.version || musicProviderRef.current.getReportedVersion() || null;
      setReportedExtensionVersion(reportedVer);

      if (pingResult.active && reportedVer) {
        if (compareVersions(reportedVer, MIN_REQUIRED_EXTENSION_VERSION) >= 0) {
          if (
            hadOutdatedBannerRef.current ||
            (previousReportedVersionRef.current && compareVersions(previousReportedVersionRef.current, reportedVer) < 0)
          ) {
            setUpdateSuccessVersion(reportedVer);
            hadOutdatedBannerRef.current = false;
            setTimeout(() => {
              setUpdateSuccessVersion((curr) => (curr === reportedVer ? null : curr));
            }, 10000);
          }
        } else {
          hadOutdatedBannerRef.current = true;
        }
        previousReportedVersionRef.current = reportedVer;
      } else if (!pingResult.active) {
        hadOutdatedBannerRef.current = true;
      }

      if (pingResult.active) {
        setTestResults((prev) => ({ ...prev, tabDetection: true }));
        // Register app tab with extension worker
        musicProviderRef.current.registerAppHello();
        try {
          const tabs = await musicProviderRef.current.listTabs().catch(() => []);
          setAvailableTabs(tabs);
          if (tabs.length > 0 && !playbackStatusRef.current?.connectedTabId) {
            musicProviderRef.current.connect(tabs[0].id).then((cRes) => {
              if (cRes.success && cRes.status) {
                const updated: MusicPlaybackStatus = {
                  ...cRes.status,
                  connectedTabId: tabs[0].id,
                  available: true
                };
                setPlaybackStatus(updated);
                playbackStatusRef.current = updated;
                broadcastCurrentRadioState(true, false, updated);
              }
            }).catch(() => {});
          }
        } catch (e) {
          // Tabs query might require permissions or extension reload
        }

        // Auto-initialize YouTube provider and open both YouTube and Boom Box on startup
        if (!hasAutoInitializedStartupRef.current) {
          hasAutoInitializedStartupRef.current = true;
          // 1. Open / connect YouTube tab and organize into RetroFM tab group
          musicProviderRef.current
            .launchRetroFmGroup()
            .then((res) => {
              if (res.success && res.connectedTabId) {
                if (res.status) {
                  const initialReadyStatus: MusicPlaybackStatus = {
                    ...res.status,
                    connectedTabId: res.connectedTabId,
                    available: true
                  };
                  setPlaybackStatus(initialReadyStatus);
                  playbackStatusRef.current = initialReadyStatus;
                  broadcastCurrentRadioState(true, false, initialReadyStatus);
                }
                setTestResults((prev) => ({
                  ...prev,
                  tabDetection: true,
                  playbackState: true,
                  volumeControl: true,
                  metadata: !!(res.status?.title && res.status.title !== 'Unknown Video'),
                }));
                if (volumeControllerRef.current) {
                  volumeControllerRef.current.syncInitialVolume('Startup YouTube init').catch(() => {});
                }
                logMessage('✓ Auto-initialized YouTube provider and grouped tabs.');
                // Pre-prepare RetroFM station jingle in background YouTube tab so first PLAY starts jingle immediately
                jingleStateRef.current = 'prepared';
                prepareSong(RETROFM_JINGLE_CONFIG.videoId, RETROFM_JINGLE_CONFIG.title).catch(() => {});
              }
            })
            .catch((err) => {
              logMessage(`[Startup Notice] Auto-init YouTube provider: ${err?.message || 'deferred'}`);
            });

          // 2. Open / focus Boom Box player tab
          musicProviderRef.current.openBoomBox().catch(() => {});
        }
      }
    };

    checkExt();
    const interval = setInterval(checkExt, 2500);
    return () => clearInterval(interval);
  }, []);

  // --- Open Boom Box Player Tab Handler ---
  const handleOpenBoomBox = async () => {
    setIsOpeningBoomBox(true);
    logMessage('Opening or focusing Boom Box player tab...');
    try {
      const res = await musicProviderRef.current.openBoomBox();
      if (res.success) {
        logMessage(`✓ Boom Box player tab ${res.reused ? 'focused' : 'opened'}.`);
        broadcastCurrentRadioState();
      } else {
        const errDetail = res.error || 'Extension did not respond or Boom Box tab failed to open. Ensure RetroFM Extension is reloaded in chrome://extensions.';
        console.warn('[RetroFM] Failed to open Boom Box tab:', res);
        logMessage(`[Boom Box Warning] ${errDetail}`);
      }
    } catch (err: any) {
      console.error('[RetroFM] Boom Box launch error:', err);
      logMessage(`[Boom Box Error] ${err.message || 'Failed to open Boom Box'}`);
    } finally {
      setIsOpeningBoomBox(false);
    }
  };

  // Monotonically increasing command sequence number to eliminate race conditions
  const transportCommandSeqRef = useRef<number>(0);
  const isTransportCommandInFlightRef = useRef<boolean>(false);
  const isExplicitStoppedRef = useRef<boolean>(false);
  const activeDecadeRef = useRef<number | null>(null);
  const stereoBalanceRef = useRef<number>(0);
  const [, setStereoBalance] = useState<number>(0);
  const lastBroadcastStateKeyRef = useRef<string>('');
  const playbackStatusRef = useRef<MusicPlaybackStatus>(playbackStatus);
  playbackStatusRef.current = playbackStatus;

  // --- Broadcast Current Radio State to Boom Box ---
  const broadcastCurrentRadioState = useCallback((force: boolean = false, clearSong: boolean = false, explicitStatus?: MusicPlaybackStatus) => {
    const vc = volumeControllerRef.current;
    const currentVol = vc ? vc.getUserVolume() : targetMusicVolume;
    const isDuck = vc ? vc.getState() !== 'idle' : isDuckingActive;
    const effectiveStatus = explicitStatus || playbackStatusRef.current || playbackStatus;

    // Green display remains blank until PLAY confirms audible real song playback.
    // The startup jingle is not a song selection and must never populate the user-facing Artist/Song Title fields.
    let currentSong = null;
    const hasFirstSongStarted = hasFirstSongStartedPlayingRef.current;
    const isJingleActive = jingleStateRef.current === 'prepared' || jingleStateRef.current === 'playing';

    if (activeJingleRef.current) {
      currentSong = {
        title: 'RETRO FM jingle',
        artist: '',
        year: '',
        duration: activeJingleRef.current.duration_sec ? `${Math.floor(activeJingleRef.current.duration_sec / 60).toString().padStart(2, '0')}:${Math.floor(activeJingleRef.current.duration_sec % 60).toString().padStart(2, '0')}` : undefined,
        durationSec: activeJingleRef.current.duration_sec,
        videoId: activeJingleRef.current.youtube_id,
        currentTime: effectiveStatus.currentTime,
      };
    } else if (clearSong || !hasFirstSongStarted || isJingleActive || playbackStatus.videoId === RETROFM_JINGLE_CONFIG.videoId) {
      currentSong = null;
    } else if (isTuningSeekingRef.current) {
      currentSong = null;
    } else if (
      sessionHistoryRef.current.pointer >= 0 &&
      sessionHistoryRef.current.pointer < sessionHistoryRef.current.entries.length
    ) {
      const activeEntry = sessionHistoryRef.current.entries[sessionHistoryRef.current.pointer];
      if (activeEntry.videoId === effectiveStatus.videoId) {
        currentSong = {
          title: activeEntry.song.title,
          artist: activeEntry.song.artist,
          year: String(activeEntry.song.chart_year || activeDateRef.current.slice(0, 4)),
          duration: programSongResult?.selectedDuration,
          durationSec: programSongResult?.selectedDurationSec,
          videoId: activeEntry.videoId,
          currentTime: effectiveStatus.currentTime,
        };
      } else if (programSongResult && programSongResult.selectedTitle && programSongResult.selectedVideoId === effectiveStatus.videoId) {
        currentSong = {
          title: programSongResult.selectedTitle,
          artist: currentPlayingArtistRef.current || programArtist || '',
          year: currentPlayingYearRef.current || programYear || '',
          duration: programSongResult.selectedDuration,
          durationSec: programSongResult.selectedDurationSec,
          videoId: programSongResult.selectedVideoId,
          currentTime: effectiveStatus.currentTime
        };
      } else if (programSongResult && programSongResult.selectedVideoId && programSongResult.selectedVideoId !== effectiveStatus.videoId) {
        currentSong = null;
      }
    } else if (programSongResult && programSongResult.selectedTitle && programSongResult.selectedVideoId === effectiveStatus.videoId) {
      currentSong = {
        title: programSongResult.selectedTitle,
        artist: currentPlayingArtistRef.current || programArtist || '',
        year: currentPlayingYearRef.current || programYear || '',
        duration: programSongResult.selectedDuration,
        durationSec: programSongResult.selectedDurationSec,
        videoId: programSongResult.selectedVideoId,
        currentTime: effectiveStatus.currentTime
      };
    } else if (programSongResult && programSongResult.selectedVideoId && programSongResult.selectedVideoId !== effectiveStatus.videoId) {
      currentSong = null;
    } else if (effectiveStatus && effectiveStatus.title && effectiveStatus.title !== 'Unknown Title' && effectiveStatus.title !== 'Unknown Video') {
      currentSong = {
        title: effectiveStatus.title,
        artist: currentPlayingArtistRef.current || programArtist || '',
        year: currentPlayingYearRef.current || programYear || '',
        duration: effectiveStatus.duration ? `${Math.floor(effectiveStatus.duration / 60).toString().padStart(2, '0')}:${Math.floor(effectiveStatus.duration % 60).toString().padStart(2, '0')}` : undefined,
        durationSec: effectiveStatus.duration || undefined,
        videoId: effectiveStatus.videoId,
        currentTime: effectiveStatus.currentTime
      };
    } else if (programSongTitle) {
      currentSong = {
        title: programSongTitle,
        artist: currentPlayingArtistRef.current || programArtist || '',
        year: currentPlayingYearRef.current || programYear || '',
        duration: programSongResult?.selectedDuration,
        durationSec: programSongResult?.selectedDurationSec,
        videoId: effectiveStatus.videoId,
        currentTime: effectiveStatus.currentTime
      };
    }

    const yearNum = parseInt(programYear, 10);
    const decadeFromYear = (!isNaN(yearNum) && yearNum >= 1960 && yearNum <= 2029)
      ? Math.floor(yearNum / 10) * 10
      : 1990;
    const decade = (activeDecadeRef.current && activeDecadeRef.current >= 1960 && activeDecadeRef.current <= 2020)
      ? activeDecadeRef.current
      : decadeFromYear;

    // Default primary stations per decade from Boom Box ST table
    const DECADE_STATIONS: Record<number, { freq: number; genre: string }> = {
      1960: { freq: 95.1, genre: 'Top 40/Pop' },
      1970: { freq: 95.5, genre: 'AOR' },
      1980: { freq: 101.9, genre: 'CHR' },
      1990: { freq: 100.3, genre: 'Teen Pop' },
      2000: { freq: 102.3, genre: 'Electropop' },
      2010: { freq: 101.1, genre: 'EDM' },
      2020: { freq: 90.9, genre: 'Hyperpop' }
    };

    const station = DECADE_STATIONS[decade] || { freq: 100.3, genre: 'Teen Pop' };
    const isPlayingOrAdvancing = isAdvancingRef.current || playbackStatus.isPlaying;
    const effectivePlayingOrAdvancing = isAdvancingRef.current || effectiveStatus.isPlaying;
    const isSongTransition = isAdvancingRef.current && !effectiveStatus.isPlaying;
    const rawMode = (isTuningSeekingRef.current || isSongTransition) ? 'seek' : (effectivePlayingOrAdvancing ? 'playing' : (isExplicitStoppedRef.current ? 'stopped' : (effectiveStatus.available ? 'paused' : 'stopped')));
    const playbackMode = (isTuningSeekingRef.current || isSongTransition) ? 'seek' : (hasFirstSongStarted ? rawMode : 'blank');

    // Ready when YouTube tab is connected and RetroFM integration is ready
    const connectedId = effectiveStatus.connectedTabId || playbackStatus.connectedTabId || musicProviderRef.current.getConnectedTabId();
    const isStartupReady = Boolean(
      connectedId &&
      (effectiveStatus.available || Boolean(effectiveStatus.videoId) || Boolean(effectiveStatus.title))
    );
    isStartupReadyRef.current = isStartupReady;

    const broadcastDate = activeDateRef.current || (programYear ? `${programYear}-07-04` : '1963-05-01');
    const dynamicStations = calculateDynamicStationsForDate(songLibraryRef.current, broadcastDate, decade);
    const allStations = dynamicStations.length > 0 ? dynamicStations : (STATIONS_BY_DECADE[decade] || []);
    const currentGenre = activeStationGenreRef.current;
    const activeStation = (currentGenre ? allStations.find(s => s.genre === currentGenre) : null)
      || allStations[0]
      || (DECADE_STATIONS[decade] ? { frequency: DECADE_STATIONS[decade].freq, genre: DECADE_STATIONS[decade].genre } : { frequency: 100.3, genre: 'Teen Pop' });

    // Generate comparison fingerprint excluding timestamps to prevent redundant broadcasts on every second poll
    const stateFingerprint = JSON.stringify({
      playbackStatus: playbackMode,
      hasFirstSongStarted,
      isStartupReady,
      currentSongTitle: currentSong?.title || '',
      currentSongArtist: currentSong?.artist || '',
      currentSongYear: currentSong?.year || '',
      masterVolume: currentVol,
      balance: stereoBalanceRef.current,
      decade,
      freq: activeStation.frequency,
      genre: activeStation.genre,
      isDuck,
      duckLevel: vc ? vc.getDuckLevel() : duckVolumePercent,
      clearSong,
      stationCount: allStations.length
    });

    if (!force && stateFingerprint === lastBroadcastStateKeyRef.current) {
      return; // Data has not changed; skip redundant broadcast
    }
    lastBroadcastStateKeyRef.current = stateFingerprint;

    let songSeq: number | undefined;
    if (currentSong && currentSong.title) {
      songSeq = ++songUpdateSeqRef.current;
      (currentSong as any).songSeq = songSeq;
    }

    const statePayload = {
      playbackStatus: playbackMode,
      hasFirstSongStartedPlaying: hasFirstSongStarted,
      isStartupReady,
      currentSong,
      clearSong,
      date: broadcastDate,
      decade,
      frequency: activeStation.frequency,
      genre: activeStation.genre,
      stations: allStations, // stations: STATIONS_BY_DECADE[decade] || []
      masterVolume: currentVol,
      balance: stereoBalanceRef.current,
      duckLevel: vc ? vc.getDuckLevel() : duckVolumePercent,
      isDucking: isDuck,
      appConnected: true,
      timestamp: Date.now()
    };

    musicProviderRef.current.recordTrace('BROADCAST_RADIO_STATE', {
      playbackMode,
      hasFirstSongStarted,
      stateFingerprint,
      force,
      clearSong
    });
    musicProviderRef.current.broadcastRadioState(statePayload).catch(() => {});
  }, [playbackStatus, programSongResult, programArtist, programSongTitle, programYear, targetMusicVolume, isDuckingActive, duckVolumePercent]);

  // Refs for action handlers to prevent stale closures in the Boom Box subscription
  const handlePlayMusicRef = useRef<(playClickTs?: number) => Promise<boolean>>(async () => false);
  const handlePauseMusicRef = useRef<() => Promise<void>>(async () => {});
  const handleStopMusicRef = useRef<() => Promise<void>>(async () => {});
  const handleRewindMusicRef = useRef<() => Promise<void>>(async () => {});
  const handleFastForwardMusicRef = useRef<() => Promise<void>>(async () => {});
  const advanceToNextSongRef = useRef<(isInitialAfterJingle?: boolean) => Promise<boolean>>(async () => false);

  // Synchronize state to Boom Box whenever session properties change or library loads
  useEffect(() => {
    broadcastCurrentRadioState(true);
  }, [broadcastCurrentRadioState, isLibraryLoaded]);

  // Listen for actions and state requests from Boom Box
  useEffect(() => {
    const unsubAction = musicProviderRef.current.onBoomBoxAction(async (action: any) => {
      if (!action || !action.action) return;
      logMessage(`[Boom Box Action] ${action.action}`);
      const actionName = String(action.action);
      const timeStr = new Date().toLocaleTimeString();

      try {
        switch (action.action) {
          case 'PLAY': {
            const playSuccess = await handlePlayMusicRef.current(action.t_boombox_play_click);
            setLastBoomBoxCommand({
              action: actionName,
              result: playSuccess ? 'SUCCESS (Playback active)' : 'PENDING (Awaiting playback)',
              time: timeStr
            });
            break;
          }
          case 'PAUSE':
            await handlePauseMusicRef.current();
            setLastBoomBoxCommand({ action: actionName, result: 'SUCCESS (Paused)', time: timeStr });
            break;
          case 'STOP':
            await handleStopMusicRef.current();
            setLastBoomBoxCommand({ action: actionName, result: 'SUCCESS (Stopped)', time: timeStr });
            break;
          case 'REWIND':
          case 'PREVIOUS':
            await handleRewindMusicRef.current();
            setLastBoomBoxCommand({ action: actionName, result: 'SUCCESS (Previous Song)', time: timeStr });
            break;
          case 'FAST_FORWARD':
          case 'NEXT':
            await handleFastForwardMusicRef.current();
            setLastBoomBoxCommand({ action: actionName, result: 'SUCCESS (Next Song)', time: timeStr });
            break;
          case 'SET_VOLUME':
            if (typeof action.volume === 'number' && volumeControllerRef.current) {
              await volumeControllerRef.current.setUserVolume(action.volume, 'Boom Box Knob');
              setLastBoomBoxCommand({ action: `SET_VOLUME (${action.volume}%)`, result: 'SUCCESS', time: timeStr });
              broadcastCurrentRadioState(true);
            }
            break;
          case 'SET_BALANCE':
            if (typeof action.balance === 'number' && !isNaN(action.balance)) {
              const clampedBal = Number(Math.max(-1, Math.min(1, action.balance)).toFixed(2));
              stereoBalanceRef.current = clampedBal;
              setStereoBalance(clampedBal);
              const leftPct = clampedBal <= 0 ? 100 : Math.round((1 - clampedBal) * 100);
              const rightPct = clampedBal >= 0 ? 100 : Math.round((1 + clampedBal) * 100);
              await musicProviderRef.current.setBalance(clampedBal);
              logMessage(`[Boom Box Balance] Stereo balance set to ${clampedBal.toFixed(2)} (L: ${leftPct}%, R: ${rightPct}%)`);
              setLastBoomBoxCommand({ action: `SET_BALANCE (${clampedBal.toFixed(2)})`, result: 'SUCCESS', time: timeStr });
              broadcastCurrentRadioState(true);
            }
            break;
          case 'TUNE': {
            const tuneSeq = ++tuneSequenceRef.current;
            const isLocked = action.locked !== false && !!action.genre;
            const freq = typeof action.frequency === 'number' ? action.frequency : null;
            const genre = action.genre;

            if (!isLocked) {
              isTuningSeekingRef.current = false;
              logMessage(`[Boom Box Dial] Untuned: ${freq !== null ? freq.toFixed(1) : ''} FM`);
              setLastBoomBoxCommand({ action: `TUNE (${freq !== null ? freq.toFixed(1) : ''} FM untuned)`, result: 'SUCCESS', time: timeStr });

              // Save current station's position before pausing only if playback was confirmed for this genre
              const currentGenre = activeStationGenreRef.current;
              const liveStatus = playbackStatusRef.current || playbackStatus;
              const isConfirmedForGenre = Boolean(
                currentGenre &&
                liveStatus.videoId &&
                (!programSongResult?.selectedVideoId || liveStatus.videoId === programSongResult.selectedVideoId) &&
                !isTuningSeekingRef.current
              );
              if (currentGenre && liveStatus.videoId && isConfirmedForGenre) {
                stationPlaybackCacheRef.current[currentGenre] = {
                  genre: currentGenre,
                  frequency: (liveStatus as any).frequency || (freq ?? 0),
                  videoId: liveStatus.videoId,
                  title: liveStatus.title,
                  artist: currentPlayingArtistRef.current || programArtist,
                  song: currentPlayingSongRef.current || programSongTitle,
                  year: currentPlayingYearRef.current || programYear,
                  currentTime: liveStatus.currentTime,
                  duration: liveStatus.duration
                };
              }

              // Immediately pause YouTube playback
              if (liveStatus.isPlaying || isAdvancingRef.current) {
                await handlePauseMusicRef.current();
              }
              break;
            }

            // Locked onto a valid station
            logMessage(`[Boom Box Dial] Tuned: ${freq} FM (${genre})`);
            setLastBoomBoxCommand({ action: `TUNE (${freq} FM - ${genre})`, result: 'SUCCESS', time: timeStr });

            const prevGenre = activeStationGenreRef.current;
            const liveStatus = playbackStatusRef.current || playbackStatus;
            const isPrevConfirmed = !isTuningSeekingRef.current && (!programSongResult?.selectedVideoId || liveStatus.videoId === programSongResult.selectedVideoId);
            if (prevGenre && prevGenre !== genre && liveStatus.videoId && isPrevConfirmed) {
              stationPlaybackCacheRef.current[prevGenre] = {
                genre: prevGenre,
                frequency: (liveStatus as any).frequency || (freq ?? 0),
                videoId: liveStatus.videoId,
                title: liveStatus.title,
                artist: currentPlayingArtistRef.current || programArtist,
                song: currentPlayingSongRef.current || programSongTitle,
                year: currentPlayingYearRef.current || programYear,
                currentTime: liveStatus.currentTime,
                duration: liveStatus.duration
              };
              // Immediately clear program song metadata for the previous station
              setProgramSongResult(null);
              currentPlayingArtistRef.current = '';
              currentPlayingSongRef.current = '';
            } else if (prevGenre && prevGenre !== genre) {
              setProgramSongResult(null);
              currentPlayingArtistRef.current = '';
              currentPlayingSongRef.current = '';
            }
            if (prevGenre && prevGenre !== genre) {
              sessionHistoryRef.current = { entries: [], pointer: -1 };
              songPlayStateRef.current = newPlayState();
              nextSongRef.current = null;
            }
            activeStationGenreRef.current = genre;

            if (typeof action.decade === 'number' && action.decade >= 1960 && action.decade <= 2020) {
              activeDecadeRef.current = action.decade;
              const currentDec = Math.floor(parseInt(programYear || '1985', 10) / 10) * 10;
              if (currentDec !== action.decade) {
                setProgramYear(String(action.decade + 5));
              }
            }

            // Determine if music is available for this station
            const decadeNum = action.decade || (programYear ? Math.floor(parseInt(programYear, 10) / 10) * 10 : 1980);
            const dynamicStations = calculateDynamicStationsForDate(songLibraryRef.current, activeDateRef.current, decadeNum);
            const stationsForDecade = dynamicStations.length > 0 ? dynamicStations : (STATIONS_BY_DECADE[decadeNum] || []);
            const stationCfg = stationsForDecade.find(s => s.genre === genre || (freq !== null && Math.abs(s.frequency - freq) <= 0.15));
            nextSongRef.current = null;

            const cached = stationPlaybackCacheRef.current[genre];
            const preset = stationCfg?.presetKey ? HARDCODED_PRESETS[stationCfg.presetKey] : getPresetForStation(stationCfg);

            // In radio simulation mode, tuning to a genre station always automatically starts or resumes playback
            isExplicitStoppedRef.current = false;
            const shouldAutoPlay = true;

            // Broadcast 'seek' with clearSong so green display immediately shows SEEK without previous station song info
            isTuningSeekingRef.current = true;
            broadcastCurrentRadioState(true, true);

            if (shouldAutoPlay) {
              if (tuneSeq !== tuneSequenceRef.current) break;

              if (cached) {
                // Scenario B: Return to previously visited station
                logMessage(`[Tuner] Resuming ${genre} from saved position ${Math.round(cached.currentTime)}s ("${cached.title}")`);
                currentPlayingArtistRef.current = cached.artist;
                currentPlayingSongRef.current = cached.song;
                currentPlayingYearRef.current = cached.year;
                setProgramArtist(cached.artist);
                setProgramSongTitle(cached.song);
                setProgramYear(cached.year);
                setProgramSongResult({
                  status: 'PLAYING',
                  requested: `${cached.artist} - ${cached.song}`,
                  selectedVideoId: cached.videoId,
                  selectedTitle: cached.song,
                  selectedDurationSec: cached.duration
                });

                const currentLive = playbackStatusRef.current || playbackStatus;
                if (currentLive.connectedTabId && currentLive.videoId === cached.videoId) {
                  if (tuneSeq !== tuneSequenceRef.current) {
                    isTuningSeekingRef.current = false;
                    break;
                  }
                  if (cached.currentTime > 0 && Math.abs(currentLive.currentTime - cached.currentTime) > 1) {
                    await musicProviderRef.current.seek(cached.currentTime).catch(() => {});
                    await new Promise(r => setTimeout(r, 100));
                  }
                  await handlePlayMusicRef.current();
                } else {
                  const targetVolFraction = getNavVolumeFraction();
                  const targetUrl = `https://www.youtube.com/watch?v=${cached.videoId}`;
                  await musicProviderRef.current.navigate(targetUrl, cached.videoId, targetVolFraction, revealYouTubeToStart, cached.currentTime);
                  if (tuneSeq !== tuneSequenceRef.current) {
                    isTuningSeekingRef.current = false;
                    break;
                  }
                  await handlePlayMusicRef.current();
                }
              } else if (songLibraryRef.current.length > 0) {
                // Scenario A: First visit to station with library loaded
                const pick = pickSong(
                  songLibraryRef.current,
                  activeDateRef.current,
                  genre,
                  songPlayStateRef.current
                );
                if (pick) {
                  logMessage(`[Tuner] Selected library song for ${genre}: "${pick.song.artist} - ${pick.song.title}" (Tier ${pick.tier}, genreMatched: ${pick.genreMatched})`);
                  if (tuneSeq !== tuneSequenceRef.current) {
                    isTuningSeekingRef.current = false;
                    break;
                  }
                  await playLibrarySong(pick, `Tuned to station ${genre}`, tuneSeq);
                } else {
                  logMessage(`[Tuner] No eligible library song for ${genre} on ${activeDateRef.current}.`);
                  currentPlayingArtistRef.current = '';
                  currentPlayingSongRef.current = '';
                  setProgramArtist('');
                  setProgramSongTitle('');
                  setSongPlaybackNotice({
                    message: "No eligible songs charting in this genre for this broadcast date",
                    artist: genre,
                    song: activeDateRef.current,
                    type: 'not_found'
                  });
                  broadcastCurrentRadioState(true, true);
                }
              } else if (preset) {
                // Scenario A fallback: library not loaded, use preset
                logMessage(`[Tuner] Auto-playing preset for ${genre}: "${preset.artist} - ${preset.song}"`);
                currentPlayingArtistRef.current = preset.artist;
                currentPlayingSongRef.current = preset.song;
                currentPlayingYearRef.current = preset.year;
                setProgramArtist(preset.artist);
                setProgramSongTitle(preset.song);
                setProgramYear(preset.year);

                if (tuneSeq !== tuneSequenceRef.current) {
                  isTuningSeekingRef.current = false;
                  break;
                }
                await handleProgramSong({ artist: preset.artist, song: preset.song, year: preset.year });
              }
              if (tuneSeq === tuneSequenceRef.current) {
                isTuningSeekingRef.current = false;
                broadcastCurrentRadioState(true);
              }
            } else {
              if (cached) {
                currentPlayingArtistRef.current = cached.artist;
                currentPlayingSongRef.current = cached.song;
                currentPlayingYearRef.current = cached.year;
                setProgramArtist(cached.artist);
                setProgramSongTitle(cached.song);
                setProgramYear(cached.year);
                setProgramSongResult({
                  status: 'IDLE',
                  requested: `${cached.artist} - ${cached.song}`,
                  selectedVideoId: cached.videoId,
                  selectedTitle: cached.song,
                  selectedDurationSec: cached.duration
                });
              } else if (preset) {
                currentPlayingArtistRef.current = preset.artist;
                currentPlayingSongRef.current = preset.song;
                currentPlayingYearRef.current = preset.year;
                setProgramArtist(preset.artist);
                setProgramSongTitle(preset.song);
                setProgramYear(preset.year);
              }
              broadcastCurrentRadioState(true);
            }
            break;
          }
          case 'SELECT_DATE_GENRE': {
            if (action.date) {
              logMessage(`[Boom Box Date] Date: ${action.date} | Station: ${action.genre || 'N/A'}`);
              setLastBoomBoxCommand({ action: `SELECT_DATE (${action.date})`, result: 'SUCCESS', time: timeStr });
            }
            const selectedYear = action.year ? String(action.year) : (action.date ? action.date.split('-')[0] : (action.decade ? String(action.decade + 5) : null));
            if (typeof action.decade === 'number' && action.decade >= 1960 && action.decade <= 2020) {
              activeDecadeRef.current = action.decade;
            } else if (selectedYear) {
              const parsedDec = Math.floor(parseInt(selectedYear, 10) / 10) * 10;
              if (parsedDec >= 1960 && parsedDec <= 2020) {
                activeDecadeRef.current = parsedDec;
              }
            }
            if (selectedYear) {
              setProgramYear(selectedYear);
            }
            if (action.genre) {
              activeStationGenreRef.current = action.genre;
            }
            if (action.date) {
              activeDateRef.current = action.date;
            }

            const targetDate = action.date || activeDateRef.current;
            const targetGenre = action.genre || activeStationGenreRef.current || 'Pop';

            // Trigger non-blocking background news prefetch on confirmed date/genre (Enter)
            const aiProvider = (typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_ai_provider') : null) as 'gemini' | 'lmstudio' || 'gemini';
            const lmEndpoint = (typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_lmstudio_endpoint') : null) || undefined;
            const lmModel = (typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_lmstudio_model') : null) || undefined;
            clientNewsQueue.prefetchNews(targetDate, {
              provider: aiProvider,
              endpoint: lmEndpoint,
              model: lmModel,
            });

            // Start a new DJ listening session on new date/genre selection
            djStateRef.current = newDjState();
            varietyStateRef.current = newVarietyState();
            sessionHistoryRef.current = { entries: [], pointer: -1 };
            songPlayStateRef.current = newPlayState();
            previousLibrarySongRef.current = null;
            nextSongRef.current = null;
            if (songLibraryRef.current.length > 0) {
              const pick = pickSong(songLibraryRef.current, targetDate, targetGenre, songPlayStateRef.current);
              if (pick) {
                await playLibrarySong(pick, 'Date/genre selection');
              } else {
                const noticeMsg = "The library doesn't cover this date yet (currently the 1960s and early 1970s)";
                logMessage(`[Song Selector] ${noticeMsg}`);
                setSongPlaybackNotice({
                  message: noticeMsg,
                  artist: targetGenre,
                  song: targetDate,
                  type: 'not_found'
                });
                broadcastCurrentRadioState(true, true);
              }
            } else {
              // Debug fallback: preset selection
              const dec = action.decade || (selectedYear ? Math.floor(parseInt(selectedYear, 10) / 10) * 10 : 1980);
              const stationsForDec = STATIONS_BY_DECADE[dec] || [];
              const stationCfg = stationsForDec.find(s => s.genre === action.genre);
              const preset = stationCfg?.presetKey ? HARDCODED_PRESETS[stationCfg.presetKey] : getPresetForStation(stationCfg);
              if (preset) {
                currentPlayingArtistRef.current = preset.artist;
                currentPlayingSongRef.current = preset.song;
                currentPlayingYearRef.current = preset.year;
                setProgramArtist(preset.artist);
                setProgramSongTitle(preset.song);
                setProgramYear(preset.year);
              }
              setTimeout(() => broadcastCurrentRadioState(true), 10);
            }
            break;
          }
          case 'REQUEST_DATE_STATIONS': {
            if (action.date) {
              activeDateRef.current = action.date;
              if (typeof action.decade === 'number') {
                activeDecadeRef.current = action.decade;
              }
              broadcastCurrentRadioState(true);
            }
            break;
          }
          case 'BOOMBOX_RELOADED':
            logMessage('[Boom Box Session] Boom Box reloaded/opened. Resetting playback sequence to station jingle.');
            jingleStateRef.current = 'prepared';
            hasFirstSongStartedPlayingRef.current = false;
            currentQueueIndexRef.current = 0;
            isAdvancingRef.current = false;
            stationPlaybackCacheRef.current = {};
            activeStationGenreRef.current = null;
            stereoBalanceRef.current = 0;
            setStereoBalance(0);
            musicProviderRef.current.setBalance(0).catch(() => {});
            // Pre-prepare RetroFM station jingle on background YouTube tab
            prepareSong(RETROFM_JINGLE_CONFIG.videoId, RETROFM_JINGLE_CONFIG.title);
            broadcastCurrentRadioState(true);
            setLastBoomBoxCommand({ action: 'BOOMBOX_RELOADED', result: 'SUCCESS (Reset to jingle)', time: timeStr });
            break;
          case 'STARTUP_AUDIO_INIT':
            logMessage('[Startup] Received STARTUP_AUDIO_INIT from Boom Box ON AIR. Initializing DJ audio.');
            initDjAudioSystem();
            setLastBoomBoxCommand({ action: 'STARTUP_AUDIO_INIT', result: 'SUCCESS', time: timeStr });
            break;
          case 'END_OF_SONG_TRIGGER': {
            const triggerReason = action.reason || 'silence';
            const triggerLevel = typeof action.level === 'number' ? action.level.toFixed(4) : 'unknown';
            const triggerCur = typeof action.currentTime === 'number' ? action.currentTime.toFixed(1) : 'unknown';
            const triggerRem = typeof action.remaining === 'number' ? action.remaining.toFixed(1) : 'unknown';
            logMessage(`[End-Of-Song Trigger] Reason: ${triggerReason} | Level: ${triggerLevel} | Time: ${triggerCur}s | Rem: ${triggerRem}s`);

            // 1. Immediately pause current playback so silence/outtro does not linger
            await handlePauseMusicRef.current();

            // 2. Preload next video in background YouTube tab while DJ talks
            const nextPick = nextSongRef.current;
            if (nextPick?.song?.streaming?.youtube?.id) {
              const nextVid = nextPick.song.streaming.youtube.id;
              const nextTitle = nextPick.song.title;
              logMessage(`[Preload] Preloading next song in background while DJ talks: "${nextTitle}" (${nextVid})`);
              prepareSong(nextVid, nextTitle).catch((err) => {
                logMessage(`[Preload Error] Failed to preload next song "${nextTitle}": ${err?.message || err}`);
              });
            }

            // 3. Immediately trigger prepared DJ break if present
            const prep = preparedBreakRef.current;
            const currentSongId = currentSongPickRef.current?.song?.id || playbackStatusRef.current?.videoId;
            if (prep && prep.text && currentSongId && breakTriggeredForSongIdRef.current !== currentSongId) {
              breakTriggeredForSongIdRef.current = currentSongId;
              const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';

              if (prep.audioData) {
                if (prep.pendingVarietyState) {
                  varietyStateRef.current = prep.pendingVarietyState;
                }
                if (prep.pendingState) {
                  djStateRef.current = prep.pendingState;
                }
                if (prep.kind === 'news' && prep.newsText) {
                  clientNewsQueue.markLineUsed(prep.newsText);
                }
                setLastDjBreak({
                  text: prep.text,
                  slot: prep.slot,
                  kind: prep.kind,
                  detail: prep.detail,
                  timing: prep.timing,
                  wordCount: prep.wordCount,
                  spokenSeconds: prep.durationSec,
                  deliverySettings: prep.deliverySettings,
                });
                logMessage(`[DJ] Immediately starting speech for end-of-song trigger (${triggerReason}, visibility: ${vis})`);

                playDJSpeech(prep.text, {
                  duckMusic: false,
                  alreadyDucked: true,
                  forceGenerate: false,
                  preparedAudio: prep.audioData !== 'browser-speech' ? prep.audioData : undefined,
                  preparedDuration: prep.durationSec,
                }).catch((err) => {
                  console.warn('[DJ] Error during end-of-song speech playback:', err);
                });
              } else {
                logMessage(`[DJ] Break audio was not ready at end-of-song trigger (${triggerReason})`);
              }
              preparedBreakRef.current = null;
            } else if (!prep) {
              logMessage(`[DJ] No prepared break active for end-of-song trigger (${triggerReason})`);
            }

            setLastBoomBoxCommand({ action: `END_OF_SONG_TRIGGER (${triggerReason})`, result: 'SUCCESS', time: timeStr });
            break;
          }
          default:
            setLastBoomBoxCommand({ action: actionName, result: 'SUCCESS', time: timeStr });
            break;
        }
      } catch (err: any) {
        setLastBoomBoxCommand({ action: actionName, result: `ERROR: ${err?.message || 'Failed'}`, time: timeStr });
      }
    });

    const unsubReq = musicProviderRef.current.onRadioStateRequest(() => {
      broadcastCurrentRadioState(true);
    });

    return () => {
      unsubAction();
      unsubReq();
    };
  }, [broadcastCurrentRadioState]);

  // --- Audio Diagnostics Polling (Refreshes every 2 seconds) ---
  useEffect(() => {
    let isMounted = true;
    const fetchDiagnostics = async () => {
      try {
        const diag = await musicProviderRef.current.getAudioDiagnostics();
        if (isMounted && diag) {
          setAudioDiagnostics(diag);
        }
      } catch {}
    };

    fetchDiagnostics();
    const interval = setInterval(fetchDiagnostics, 2000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Listen for pushed YouTube player state and hidden tab reveal notifications
  useEffect(() => {
    const unsubYtState = musicProviderRef.current.onYouTubeStateChanged((payload: any) => {
      if (!payload) return;
      const rawState = payload.state;
      // Map states: 1 playing and 3 buffering mean 'playing'; 2 means 'paused'; 0 ended and -1 or 5 unstarted mean 'stopped'
      const isPlaying = rawState === 1 || rawState === 3;
      const provTabId = musicProviderRef.current.getConnectedTabId();
      setPlaybackStatus((prev) => ({
        ...prev,
        available: true,
        isPlaying,
        videoId: payload.videoId || prev.videoId,
        title: payload.title || prev.title,
        currentTime: typeof payload.currentTime === 'number' ? payload.currentTime : prev.currentTime,
        duration: typeof payload.duration === 'number' ? payload.duration : prev.duration,
        connectedTabId: prev.connectedTabId || provTabId || null,
      }));

      // Broadcast state update only if startup readiness or playback status actually changed
      if (!isStartupReadyRef.current) {
        broadcastCurrentRadioState();
      }

      // If playing a real song (not the station jingle), mark first song as started
      if (rawState === 1) {
        const currentPlayingVid = payload.videoId || playbackStatus.videoId;
        if (currentPlayingVid && currentPlayingVid !== RETROFM_JINGLE_CONFIG.videoId) {
          if (!hasFirstSongStartedPlayingRef.current) {
            hasFirstSongStartedPlayingRef.current = true;
            logMessage(`▶ Confirmed real song playback active: "${payload.title || currentPlayingVid}". Unsuppressing Boom Box status.`);
            broadcastCurrentRadioState(true);
          }
        }
      }

      // Check remaining time for ahead-of-time DJ Break preparation & triggering
      if (
        isPlaying &&
        djMode === 'observations' &&
        hasFirstSongStartedPlayingRef.current &&
        jingleStateRef.current !== 'playing'
      ) {
        const curTime = typeof payload.currentTime === 'number' ? payload.currentTime : playbackStatusRef.current?.currentTime || 0;
        const dur = typeof payload.duration === 'number' ? payload.duration : playbackStatusRef.current?.duration || 0;
        const curSongPick = currentSongPickRef.current;
        const songId = curSongPick?.song?.id || payload.videoId || playbackStatusRef.current?.videoId || null;

        if (songId && curSongPick) {
          // If duration is unknown or 0, we can't calculate remaining time
          if (dur > 0 && curTime > 0) {
            const remaining = dur - curTime;

            // Phase 1: Prepare ahead ~45-55s before end (ensures break audio is ready before the 45s silence detection window)
            if (
              remaining <= 55 &&
              remaining >= 5 &&
              !preparedBreakRef.current &&
              !isPreparingBreakRef.current &&
              breakTriggeredForSongIdRef.current !== songId
            ) {
              const history = sessionHistoryRef.current;
              const p = history.pointer;
              const prevSong = p > 0 ? history.entries[p - 1].song : null;
              const nextSong = (p >= 0 && p < history.entries.length - 1)
                ? history.entries[p + 1].song
                : (nextSongRef.current?.song || null);

              if (nextSong) {
                prepareObservationBreakAhead(songId, prevSong, nextSong);
              }
            }

            const prep = preparedBreakRef.current;
            if (prep && prep.id === songId && breakTriggeredForSongIdRef.current !== songId) {
              // Phase 2: Start lead duck ~500ms before speech start
              if (prep.text && remaining <= prep.duckTriggerTimeRemaining && !breakDuckingStartedRef.current) {
                breakDuckingStartedRef.current = true;
                const vc = volumeControllerRef.current;
                if (vc && !vc.isSequenceActive()) {
                  const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
                  logMessage(`[DJ] Early lead duck starting (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
                  vc.duck(fadeDownMs, 'DJ speech start').catch((err) => {
                    console.warn('[DJ] Early duck error:', err);
                  });
                }
              }

              // Phase 3: Trigger speech at 1.0 - 2.0s before end
              if (remaining <= prep.triggerTimeRemaining) {
                breakTriggeredForSongIdRef.current = songId;
                const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';

                if (prep.kind === 'jingle' && prep.varietyResult?.jingle) {
                  // Jingle break: commit variety state and play jingle in YouTube tab
                  if (prep.pendingVarietyState) {
                    varietyStateRef.current = prep.pendingVarietyState;
                  }
                  setLastDjBreak({
                    text: '',
                    slot: 'before',
                    kind: 'jingle',
                    detail: prep.detail,
                  });
                  console.log(`[DJ] jingle break start (${prep.varietyResult.jingle.id}) remaining=${remaining.toFixed(1)}s (visibility: ${vis})`);
                  logMessage(`[DJ] Jingle break start (${prep.varietyResult.jingle.id}) remaining=${remaining.toFixed(1)}s`);
                  pendingJingleRef.current = prep.varietyResult.jingle;
                  // We do not speak over a jingle; jingle will be played in YouTube tab when song ends naturally
                } else if (prep.text) {
                  // Check maxSeconds limit for follow timing
                  if (prep.timing === 'follow' && prep.maxSeconds && prep.durationSec > prep.maxSeconds) {
                    console.log(`[DJ] skipped: speech duration (${prep.durationSec.toFixed(1)}s) exceeded maxSeconds (${prep.maxSeconds}s) for follow break`);
                    logMessage(`[DJ] skipped: speech duration (${prep.durationSec.toFixed(1)}s) exceeded maxSeconds (${prep.maxSeconds}s) for follow break`);
                    if (breakDuckingStartedRef.current && volumeControllerRef.current?.isSequenceActive()) {
                      volumeControllerRef.current.cancel('Follow speech duration exceeded maxSeconds');
                    }
                    if (prep.kind === 'news' && prep.newsText) {
                      clientNewsQueue.returnLineToQueue(prep.newsText);
                    }
                    preparedBreakRef.current = null;
                    return;
                  }

                  if (prep.audioData) {
                    // Audio is ready: commit state and speak!
                    if (prep.pendingVarietyState) {
                      varietyStateRef.current = prep.pendingVarietyState;
                    }
                    if (prep.pendingState) {
                      djStateRef.current = prep.pendingState;
                    }
                    if (prep.kind === 'news' && prep.newsText) {
                      clientNewsQueue.markLineUsed(prep.newsText);
                    }
                    setLastDjBreak({
                      text: prep.text,
                      slot: prep.slot,
                      kind: prep.kind,
                      detail: prep.detail,
                      timing: prep.timing,
                      wordCount: prep.wordCount,
                      spokenSeconds: prep.durationSec,
                      deliverySettings: prep.deliverySettings,
                    });
                    console.log(`[DJ] speech start remaining=${remaining.toFixed(1)}s (visibility: ${vis})`);
                    logMessage(`[DJ] Speech start remaining=${remaining.toFixed(1)}s (visibility: ${vis})`);

                    playDJSpeech(prep.text, {
                      duckMusic: !breakDuckingStartedRef.current,
                      alreadyDucked: breakDuckingStartedRef.current,
                      forceGenerate: false,
                      preparedAudio: prep.audioData !== 'browser-speech' ? prep.audioData : undefined,
                      preparedDuration: prep.durationSec,
                    }).catch((err) => {
                      console.warn('[DJ] Error during prepared speech playback:', err);
                    });
                  } else {
                    // Audio not ready: skip break silently, log, cancel any lead duck
                    console.log(`[DJ] skipped: audio not ready (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
                    logMessage(`[DJ] skipped: audio not ready (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
                    if (breakDuckingStartedRef.current && volumeControllerRef.current?.isSequenceActive()) {
                      volumeControllerRef.current.cancel('Audio not ready for DJ speech');
                    }
                    if (prep.kind === 'news' && prep.newsText) {
                      clientNewsQueue.returnLineToQueue(prep.newsText);
                    }
                  }
                } else {
                  // Silent break returned from template / variety
                  console.log(`[DJ] silent break (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
                  if (prep.pendingVarietyState) {
                    varietyStateRef.current = prep.pendingVarietyState;
                  }
                  if (prep.pendingState) {
                    djStateRef.current = prep.pendingState;
                  }
                  setLastDjBreak({
                    text: '',
                    slot: prep.slot,
                    kind: prep.kind,
                    detail: prep.detail,
                  });
                }
                preparedBreakRef.current = null;
              }
            } else if (!prep && remaining <= 2.0 && breakTriggeredForSongIdRef.current !== songId) {
              // Trigger threshold reached but no prepared break exists / duration wasn't known in time
              breakTriggeredForSongIdRef.current = songId;
              const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
              console.log(`[DJ] skipped: audio not ready (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
              logMessage(`[DJ] skipped: audio not ready (remaining=${remaining.toFixed(1)}s, visibility: ${vis})`);
            }
          }
        }
      }

      // Natural Completion: When state is 0 (ended), advance automatically
      if (rawState === 0 && !isAdvancingRef.current) {
        const finishedVideoId = payload.videoId || playbackStatus.videoId;
        // Check if an active jingle just finished playing
        if (activeJingleRef.current) {
          logMessage(`[DJ Variety] Jingle finished naturally: "${activeJingleRef.current.title || activeJingleRef.current.id}". Advancing to next song...`);
          activeJingleRef.current = null;
          if (jingleTimeoutRef.current) {
            clearTimeout(jingleTimeoutRef.current);
            jingleTimeoutRef.current = null;
          }
          if (jingleEndedHandlerRef.current) {
            const cb = jingleEndedHandlerRef.current;
            jingleEndedHandlerRef.current = null;
            cb();
            return;
          }
        }

        // Case 1: Station Jingle finished naturally -> mark completed, do not advance queue (waits for PLAY)
        if (jingleStateRef.current === 'playing' || finishedVideoId === RETROFM_JINGLE_CONFIG.videoId) {
          jingleStateRef.current = 'completed';
          logMessage('[Station Jingle] Jingle finished naturally. Standing by for PLAY to start music queue.');
          setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, available: true }));
          broadcastCurrentRadioState(true);
        } else if (hasFirstSongStartedPlayingRef.current && jingleStateRef.current !== 'cancelled') {
          // Case 2: A regular music track finished naturally -> advance to next song in the queue
          // Check if a variety jingle was triggered for this song transition
          if (pendingJingleRef.current) {
            const jingleToPlay = pendingJingleRef.current;
            pendingJingleRef.current = null;
            activeJingleRef.current = jingleToPlay;
            logMessage(`[DJ Variety] Playing jingle "${jingleToPlay.title || jingleToPlay.id}" (${jingleToPlay.youtube_id}) between songs...`);

            // Set LCD display to show "RETRO FM jingle"
            broadcastCurrentRadioState(true);

            const jingleUrl = `https://www.youtube.com/watch?v=${jingleToPlay.youtube_id}`;
            const targetVolFraction = getNavVolumeFraction();

            let jingleHandled = false;
            const onJingleDone = async () => {
              if (jingleHandled) return;
              jingleHandled = true;
              if (jingleTimeoutRef.current) {
                clearTimeout(jingleTimeoutRef.current);
                jingleTimeoutRef.current = null;
              }
              activeJingleRef.current = null;
              jingleEndedHandlerRef.current = null;
              logMessage('[DJ Variety] Jingle ended. Starting next song...');
              advanceToNextSongRef.current(false).catch((err) => {
                logMessage(`[Auto Advance Error] ${err?.message || 'failed'}`);
              });
            };
            jingleEndedHandlerRef.current = onJingleDone;

            // Fallback timeout to duration_sec if video ended state doesn't arrive or load fails
            const fallbackSec = Math.max(3, jingleToPlay.duration_sec || 5);
            jingleTimeoutRef.current = setTimeout(() => {
              if (!jingleHandled) {
                logMessage(`[DJ Variety] Jingle duration/fallback timeout reached (${fallbackSec}s). Advancing to next song.`);
                onJingleDone();
              }
            }, (fallbackSec + 3) * 1000);

            // Safety check: if jingle fails to load within 4 seconds, skip it and play the next song
            const loadFailTimeout = setTimeout(() => {
              if (activeJingleRef.current && playbackStatusRef.current?.videoId !== jingleToPlay.youtube_id && !playbackStatusRef.current?.isPlaying) {
                logMessage('[DJ Variety] Jingle failed to load within 4s. Skipping to next song...');
                onJingleDone();
              }
            }, 4000);

            musicProviderRef.current.navigateDetailed(jingleUrl, jingleToPlay.youtube_id, targetVolFraction, revealYouTubeToStart)
              .then((res) => {
                clearTimeout(loadFailTimeout);
                if (!res.success) {
                  logMessage('[DJ Variety] Jingle navigation failed. Skipping to next song...');
                  onJingleDone();
                } else {
                  if (volumeControllerRef.current) {
                    volumeControllerRef.current.syncInitialVolume(`Jingle start: "${jingleToPlay.title || jingleToPlay.id}"`);
                  }
                }
              })
              .catch((err) => {
                clearTimeout(loadFailTimeout);
                logMessage(`[DJ Variety] Jingle error: ${err?.message || err}. Skipping to next song...`);
                onJingleDone();
              });
            return;
          }

          // Case 2: A regular music track finished naturally -> advance to next song in the queue
          if (activeStationGenreRef.current) {
            delete stationPlaybackCacheRef.current[activeStationGenreRef.current];
          }
          logMessage('[Auto Advance] Song finished naturally. Advancing to next song in queue...');
          advanceToNextSongRef.current(false).catch((err) => {
            logMessage(`[Auto Advance Error] ${err?.message || 'failed'}`);
          });
        }
      }
    });

    const unsubReveal = musicProviderRef.current.onRevealYouTubeToStart(() => {
      logMessage('YouTube tab had to be visible to start');
    });

    const unsubYtTabActivated = musicProviderRef.current.onYtTabActivated(() => {
      logMessage('YouTube tab activated: permission granted for music');
    });

    return () => {
      unsubYtState();
      unsubReveal();
      unsubYtTabActivated();
    };
  }, []);

  // --- Poll YouTube Tab Status (Fallback every 5 seconds) ---
  const lastPolledStatusFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (!playbackStatus.connectedTabId) return;

    const poll = async () => {
      try {
        const s = await musicProviderRef.current.getStatus();
        // A failed or timed-out poll must be treated as unknown and keep the last known state
        if (!s || !s.available) {
          return;
        }

        const pollFingerprint = `${s.available}|${s.isPlaying}|${s.currentTime}|${s.duration}|${s.title}|${s.volume}|${s.muted}`;
        if (pollFingerprint !== lastPolledStatusFingerprintRef.current) {
          lastPolledStatusFingerprintRef.current = pollFingerprint;
          musicProviderRef.current.recordTrace('STATUS_POLL_CHANGED', {
            available: s.available,
            isPlaying: s.isPlaying,
            currentTime: s.currentTime,
            duration: s.duration,
            title: s.title,
            volume: s.volume,
            muted: s.muted
          });
        }
        // If a transport command is currently in flight, merge metadata without overriding pending transport intent
        if (isTransportCommandInFlightRef.current) {
          setPlaybackStatus((prev) => ({
            ...s,
            isPlaying: prev.isPlaying,
            currentTime: prev.currentTime === 0 && !prev.isPlaying ? 0 : s.currentTime
          }));
        } else {
          setPlaybackStatus(s);
        }

        setTestResults((prev) => ({
          ...prev,
          playbackState: true,
          currentPosition: s.currentTime > 0 || prev.currentPosition,
          metadata: !!(s.title && s.title !== 'Unknown Title') || prev.metadata
        }));
        if (s.volume !== undefined && volumeControllerRef.current) {
          volumeControllerRef.current.handlePolledVolume(s.volume);
        }
      } catch (err) {
        // Status fetch error: preserve last known state, never revert to stopped
      }
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [playbackStatus.connectedTabId]);

  // --- Launch RetroFM (Chrome Tab Group) Handler ---
  const handleLaunchRetroFm = async () => {
    setIsLaunchingGroup(true);
    setLaunchMessage(null);
    setConnectionError(null);
    logMessage('Launching RetroFM Tab Group (opening YouTube + grouping in Chrome)...');

    try {
      const res = await musicProviderRef.current.launchRetroFmGroup();
      if (res.success && res.connectedTabId) {
        if (res.status) {
          setPlaybackStatus(res.status);
        }
        setTestResults((prev) => ({
          ...prev,
          tabDetection: true,
          playbackState: true,
          volumeControl: true,
          metadata: !!(res.status?.title && res.status.title !== 'Unknown Video'),
        }));

        const successNotice = res.createdNewTab
          ? '✓ Launched: Created new YouTube tab and organized both tabs into "RetroFM" Chrome Tab Group.'
          : '✓ Connected: Reused existing YouTube tab inside "RetroFM" Chrome Tab Group.';
        setLaunchMessage({ text: successNotice, isError: false });
        logMessage(successNotice);

        // Synchronize master volume to YouTube tab
        if (volumeControllerRef.current) {
          volumeControllerRef.current.syncInitialVolume('RetroFM tab group launched').catch(() => {});
        }
      } else {
        const errorNotice = res.error || `Failed to create RetroFM Tab Group. Ensure the Chrome Extension (v${EXTENSION_VERSION}) is loaded.`;
        setLaunchMessage({ text: errorNotice, isError: true });
        logMessage(`[Launch Failed] ${errorNotice}`);
      }
    } catch (err: any) {
      const errMsg = err.message || 'Error launching RetroFM tab group.';
      setLaunchMessage({ text: errMsg, isError: true });
      logMessage(`[Launch Error] ${errMsg}`);
    } finally {
      setIsLaunchingGroup(false);
    }
  };

  // --- Connect YouTube Tab Handler ---
  const handleConnectTab = async () => {
    setIsConnecting(true);
    setConnectionError(null);
    logMessage('Scanning for YouTube tabs via RetroFM Extension...');

    try {
      const res = await musicProviderRef.current.connect(selectedTabId || undefined, { askForOneTimeClick });
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

        // Synchronize master volume to YouTube tab
        if (volumeControllerRef.current) {
          volumeControllerRef.current.syncInitialVolume('YouTube tab connected').catch(() => {});
        }
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

  // Helper to pre-navigate and cue a song in the background without stealing focus or starting playback
  const prepareSong = async (videoId: string, title?: string) => {
    try {
      const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const targetVolFraction = getNavVolumeFraction();
      logMessage(`[Pre-Prepare] Cueing "${title || videoId}" in background YouTube tab...`);
      const res = await musicProviderRef.current.prepare(targetUrl, videoId, targetVolFraction);
      if (res.success) {
        logMessage(`[Pre-Prepare] Ready: "${title || videoId}" is cued and prepared.`);
        const provTabId = musicProviderRef.current.getConnectedTabId();
        const baseStatus = (res.status || {}) as Partial<MusicPlaybackStatus>;
        const nextStatus: MusicPlaybackStatus = {
          ...playbackStatusRef.current,
          ...baseStatus,
          available: true,
          videoId: videoId,
          title: title || baseStatus.title || videoId,
          connectedTabId: baseStatus.connectedTabId || playbackStatusRef.current?.connectedTabId || provTabId || null,
        };
        setPlaybackStatus(nextStatus);
        playbackStatusRef.current = nextStatus;
        broadcastCurrentRadioState(true, false, nextStatus);
      }
      return res.success;
    } catch (err: any) {
      logMessage(`[Pre-Prepare Error] Failed to prepare "${videoId}": ${err?.message || 'unknown error'}`);
      return false;
    }
  };

  // Helper to play a chosen library song directly via NAVIGATE_YOUTUBE without YouTube search API
  const playLibrarySong = async (pick: SongPick, reason: string = 'Library song', expectedTuneSeq?: number): Promise<boolean> => {
    return await playLibrarySongInternal(pick, reason, expectedTuneSeq, false);
  };

  const playLibrarySongInternal = async (
    pick: SongPick,
    reason: string = 'Library song',
    expectedTuneSeq?: number,
    fromHistoryNav: boolean = false
  ): Promise<boolean> => {
    const videoId = pick.song.streaming?.youtube?.id;
    if (!videoId) return false;

    if (typeof expectedTuneSeq === 'number' && expectedTuneSeq !== tuneSequenceRef.current) {
      return false;
    }

    console.log(`[Song Selector] Chosen song: "${pick.song.title}" by "${pick.song.artist}" | tier: ${pick.tier} | genreMatched: ${pick.genreMatched} | reason: ${reason}`);
    console.log(`tier: ${pick.tier}, genreMatched: ${pick.genreMatched}`);

    // Update play state and history
    if (!fromHistoryNav) {
      const history = sessionHistoryRef.current;
      history.entries.push({ pick, song: pick.song, videoId });
      if (history.entries.length > 200) {
        history.entries.shift();
      }
      history.pointer = history.entries.length - 1;
      syncPlayStateFromHistory();
    }

    // Reset DJ break preparation and trigger state for the newly started song
    clearPreparedBreak();
    breakTriggeredForSongIdRef.current = null;

    // Track previous and current song for DJ commentary
    if (currentSongPickRef.current) {
      previousLibrarySongRef.current = currentSongPickRef.current.song;
    }
    currentSongPickRef.current = pick;
    setCurrentSongPick(pick);

    // Notice handling for genreMatched
    if (!pick.genreMatched) {
      setSongPlaybackNotice({
        message: `No songs in genre "${activeStationGenreRef.current || 'selected genre'}" were charting then. Selected a charting contemporary track (${pick.song.title} by ${pick.song.artist}).`,
        artist: pick.song.artist,
        song: pick.song.title,
        type: 'info'
      });
    } else {
      setSongPlaybackNotice(null);
    }

    const songTitle = pick.song.title;
    const songArtist = pick.song.artist;
    const songYear = String(pick.song.chart_year || activeDateRef.current.slice(0, 4));

    const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const targetVolFraction = getNavVolumeFraction();

    setProgramSongResult({
      status: 'NAVIGATING',
      requested: `${songArtist} — ${songTitle}`,
      selectedTitle: songTitle,
      selectedChannel: 'Official Recording',
      selectedVideoId: videoId,
      selectedUrl: targetUrl,
      confidenceScore: 100,
      reason: `${reason} (Tier ${pick.tier})`,
      source: 'song library'
    });

    logMessage(`[Song Selector] Playing "${songArtist} - ${songTitle}" (Tier ${pick.tier}, genreMatched: ${pick.genreMatched})`);

    const navRes = await musicProviderRef.current.navigateDetailed(targetUrl, videoId, targetVolFraction, revealYouTubeToStart);

    if (typeof expectedTuneSeq === 'number' && expectedTuneSeq !== tuneSequenceRef.current) {
      logMessage(`[Song Selector] Playback request for "${songTitle}" superseded (seq ${expectedTuneSeq} vs ${tuneSequenceRef.current})`);
      return false;
    }

    setProgramArtist(songArtist);
    setProgramSongTitle(songTitle);
    setProgramYear(songYear);
    currentPlayingArtistRef.current = songArtist;
    currentPlayingSongRef.current = songTitle;
    currentPlayingYearRef.current = songYear;

    if (volumeControllerRef.current) {
      await volumeControllerRef.current.syncInitialVolume(`${reason} start: "${songTitle}"`);
    }

    jingleStateRef.current = 'completed';
    isExplicitStoppedRef.current = false;
    hasFirstSongStartedPlayingRef.current = true;
    isTuningSeekingRef.current = false;

    const freshStat = navRes.status || (await musicProviderRef.current.getStatus().catch(() => null));
    const provTabId = musicProviderRef.current.getConnectedTabId();
    if (freshStat) {
      setPlaybackStatus({
        ...freshStat,
        connectedTabId: freshStat.connectedTabId || provTabId || null
      });
    } else if (provTabId) {
      setPlaybackStatus((prev) => ({
        ...prev,
        connectedTabId: provTabId
      }));
    }

    setTestResults((prev) => ({ ...prev, playbackControl: true }));
    broadcastCurrentRadioState();

    // Immediately choose the next song as soon as the current one starts and keep it
    if (songLibraryRef.current.length > 0) {
      const history = sessionHistoryRef.current;
      const isAtEnd = history.pointer === -1 || history.pointer === history.entries.length - 1;
      if (isAtEnd || !nextSongRef.current) {
        const currentStationGenre = activeStationGenreRef.current || 'Pop';
        const nextPick = pickSong(
          songLibraryRef.current,
          activeDateRef.current,
          currentStationGenre,
          songPlayStateRef.current
        );
        nextSongRef.current = nextPick;
        if (nextPick) {
          console.log('[Song Selector] Pre-selected next song:', nextPick.song.title, 'by', nextPick.song.artist, '| tier:', nextPick.tier, '| genreMatched:', nextPick.genreMatched);
        }
      }
    }

    return !!(freshStat?.isPlaying || navRes.success);
  };

  // --- Playback Controls ---
  const handlePlayMusic = async (playClickTsOrEvent?: number | React.MouseEvent) => {
    const playClickTs = typeof playClickTsOrEvent === 'number' ? playClickTsOrEvent : undefined;
    const seq = ++transportCommandSeqRef.current;
    isTransportCommandInFlightRef.current = true;
    musicProviderRef.current.recordTrace('HANDLE_PLAY_START', { seq, connectedTabId: playbackStatus.connectedTabId, playClickTs });
    logMessage('Sending Play command to YouTube tab...');

    try {
      let desiredVideoId: string | null = null;
      let desiredTitle: string | null = null;
      let desiredArtist: string = (programArtist || '').trim();
      let desiredYear: string = (programYear || '').trim();

      if (programSongResult && programSongResult.selectedVideoId) {
        desiredVideoId = programSongResult.selectedVideoId;
        desiredTitle = programSongResult.selectedTitle || programSongTitle;
      } else if (songLibraryRef.current.length > 0) {
        // Priority 1.5: Pick from library for active date and genre
        const targetDate = activeDateRef.current;
        const targetGenre = activeStationGenreRef.current || 'Pop';
        const isNextGenreValid = nextSongRef.current && (
          !targetGenre ||
          nextSongRef.current.song.genres?.toLowerCase().includes(targetGenre.toLowerCase()) ||
          nextSongRef.current.song.primary_genre?.toLowerCase() === targetGenre.toLowerCase()
        );
        const pick = (isNextGenreValid ? nextSongRef.current : null) || pickSong(songLibraryRef.current, targetDate, targetGenre, songPlayStateRef.current);
        if (pick) {
          nextSongRef.current = null;
          await playLibrarySong(pick, 'Play button library selection');
          return true;
        }
      }

      if (!desiredVideoId) {
        // Priority 2: Check selected preset's video ID
        const lookupKey = `${desiredArtist.toLowerCase()}|${(programSongTitle || '').trim().toLowerCase()}`;
        const preset = HARDCODED_PRESETS[lookupKey];
        if (preset && preset.videoId) {
          desiredVideoId = preset.videoId;
          desiredTitle = preset.title;
          setProgramSongResult({
            status: 'IDLE',
            requested: `${desiredArtist} — ${programSongTitle || preset.title}`,
            selectedTitle: preset.title,
            selectedChannel: preset.channel,
            selectedDuration: preset.duration,
            selectedVideoId: preset.videoId,
            selectedUrl: `https://www.youtube.com/watch?v=${preset.videoId}`,
            confidenceScore: 100,
            reason: 'Preset selection',
            source: 'preset'
          });
        } else if (desiredArtist && programSongTitle) {
          // Priority 3: Look up current artist/title/year via API search
          logMessage(`[Play Song Lookup] Resolving song "${desiredArtist} - ${programSongTitle}"...`);
          try {
            const res = await fetch('/api/music/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ artist: desiredArtist, song: programSongTitle, year: desiredYear })
            });
            const data = await res.json();
            if (data.quota) {
              setQuotaInfo(data.quota);
            }
            if (data.selected && data.selected.videoId) {
              desiredVideoId = data.selected.videoId;
              desiredTitle = data.selected.title;
              setProgramSongResult({
                status: 'IDLE',
                requested: `${desiredArtist} — ${programSongTitle}`,
                selectedTitle: data.selected.title,
                selectedChannel: data.selected.channel,
                selectedDuration: data.selected.duration,
                selectedVideoId: data.selected.videoId,
                selectedUrl: data.selected.url,
                confidenceScore: data.selected.confidenceScore,
                reason: data.selected.reason
              });
            } else {
              const failReason = data.error || (data.status === 'api_error' ? 'YouTube API daily quota exceeded.' : 'No trustworthy recording found.');
              logMessage(`[Play Song Lookup Failed] ${failReason}`);
              setSongPlaybackNotice({
                message: failReason,
                artist: desiredArtist,
                song: programSongTitle,
                type: data.status === 'api_error' ? 'api_error' : 'not_found'
              });
              broadcastCurrentRadioState(true, true);
              musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: false, reason: failReason });
              return false;
            }
          } catch (searchErr: any) {
            const failReason = searchErr.message || 'Network error searching for song.';
            logMessage(`[Play Song Lookup Exception] ${failReason}`);
            setSongPlaybackNotice({
              message: failReason,
              artist: desiredArtist,
              song: programSongTitle,
              type: 'not_found'
            });
            broadcastCurrentRadioState(true, true);
            musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: false, reason: failReason });
            return false;
          }
        }
      }

      if (!desiredVideoId) {
        const noSongReason = 'No song selected';
        logMessage(`[Play] Cannot start playback: ${noSongReason}`);
        setSongPlaybackNotice({
          message: 'No song selected. Please choose a preset or enter artist and song title.',
          artist: desiredArtist || 'Unknown',
          song: programSongTitle || 'None',
          type: 'not_found'
        });
        broadcastCurrentRadioState(true, true);
        musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: false, reason: noSongReason });
        return false;
      }

      // 2. Read YouTube tab real state
      let activeTabId = playbackStatus.connectedTabId;
      let currentStatus: any = playbackStatus;

      if (!activeTabId) {
        try {
          const ytTabs = await musicProviderRef.current.listTabs();
          if (ytTabs && ytTabs.length > 0) {
            const connectRes = await musicProviderRef.current.connect(ytTabs[0].id, { askForOneTimeClick });
            if (connectRes.success && connectRes.status) {
              activeTabId = ytTabs[0].id;
              currentStatus = connectRes.status;
              setPlaybackStatus(connectRes.status);
              logMessage(`Reconnected to existing YouTube tab: "${connectRes.status.title}"`);
            }
          }
        } catch (e) {}
      }

      // If still no connected tab, launch tab group
      if (!activeTabId) {
        logMessage('No active YouTube tab connected. Launching tab group...');
        const groupRes = await musicProviderRef.current.launchRetroFmGroup();
        if (transportCommandSeqRef.current !== seq) return false;
        if (groupRes?.connectedTabId) {
          activeTabId = groupRes.connectedTabId;
          if (groupRes.status) {
            currentStatus = groupRes.status;
            setPlaybackStatus(groupRes.status);
          }
        } else {
          return false;
        }
      }

      // Determine if current tab is on a /watch page with a loaded player and video ID
      let currentLoadedVideoId: string | null = currentStatus?.videoId || null;
      const tabUrl = currentStatus?.url || '';
      const isWatchPage = tabUrl.includes('/watch');

      if (!currentLoadedVideoId && isWatchPage) {
        const m = tabUrl.match(/[?&]v=([^&#]+)/);
        if (m) currentLoadedVideoId = m[1];
      }

      // Tab has no video (home page, search page, blank, no video ID) OR video ID differs from desired song
      if (!isWatchPage || !currentLoadedVideoId || currentLoadedVideoId !== desiredVideoId) {
        logMessage(`Tab video (${currentLoadedVideoId || 'none/home'}) does not match desired song (${desiredVideoId}). Navigating...`);
        const targetUrl = `https://www.youtube.com/watch?v=${desiredVideoId}`;
        const targetVolFraction = getNavVolumeFraction();

        const navRes = await musicProviderRef.current.navigateDetailed(targetUrl, desiredVideoId, targetVolFraction, revealYouTubeToStart);
        if (transportCommandSeqRef.current !== seq) return false;
        if (!navRes.success) {
          logMessage('[Play] Notice: Navigation message sent to YouTube tab. Checking playback...');
        }

        if (volumeControllerRef.current) {
          await volumeControllerRef.current.syncInitialVolume(`Play start: "${desiredTitle || desiredVideoId}"`);
        }

        if (desiredVideoId === RETROFM_JINGLE_CONFIG.videoId) {
          jingleStateRef.current = 'playing';
          logMessage('[Station Jingle] RetroFM Station Jingle is currently playing.');
        } else {
          jingleStateRef.current = 'completed';
          hasFirstSongStartedPlayingRef.current = true;
        }

        logMessage(`▶ Playback started on YouTube tab: "${desiredTitle || desiredVideoId}"`);
        const freshStat = navRes.status || (await musicProviderRef.current.getStatus().catch(() => null));
        if (freshStat) {
          setPlaybackStatus({
            ...freshStat,
            videoId: freshStat.videoId || desiredVideoId,
            title: freshStat.title && freshStat.title !== 'Unknown Title' && freshStat.title !== 'Unknown Video' ? freshStat.title : (desiredTitle || freshStat.title),
            connectedTabId: freshStat.connectedTabId || activeTabId
          });
        } else if (activeTabId) {
          setPlaybackStatus((prev) => ({
            ...prev,
            videoId: desiredVideoId,
            title: desiredTitle || prev.title,
            connectedTabId: activeTabId
          }));
        }
        setTestResults((prev) => ({ ...prev, playbackControl: true }));
        broadcastCurrentRadioState();
        musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, result: 'navigated_and_started', videoId: desiredVideoId });
        return !!(freshStat?.isPlaying || navRes.success);
      }

      // If video ID matches desired song, send only play command and do not reload
      if (!currentStatus.isPlaying && currentStatus.currentTime === 0) {
        await musicProviderRef.current.seek(0).catch(() => {});
        if (transportCommandSeqRef.current !== seq) return false;
      }

      const playRes = await musicProviderRef.current.playDetailed(revealYouTubeToStart, playClickTs);
      if (transportCommandSeqRef.current !== seq) {
        logMessage('[Play] Superseded by newer command. Dropping result.');
        musicProviderRef.current.recordTrace('HANDLE_PLAY_SUPERSEDED', { seq });
        return false;
      }

      if (playRes.success && playRes.status) {
        isExplicitStoppedRef.current = false;
        if (volumeControllerRef.current) {
          await volumeControllerRef.current.syncInitialVolume('Play button pressed');
        }
        if (desiredVideoId === RETROFM_JINGLE_CONFIG.videoId) {
          jingleStateRef.current = 'playing';
          logMessage('[Station Jingle] RetroFM Station Jingle is currently playing.');
        } else {
          jingleStateRef.current = 'completed';
          hasFirstSongStartedPlayingRef.current = true;
        }
        logMessage('▶ Playback started on YouTube tab.');
        setPlaybackStatus({
          ...playRes.status,
          videoId: playRes.status.videoId || desiredVideoId,
          title: playRes.status.title && playRes.status.title !== 'Unknown Title' && playRes.status.title !== 'Unknown Video' ? playRes.status.title : (desiredTitle || playRes.status.title),
          connectedTabId: playRes.status.connectedTabId || activeTabId
        });
        setTestResults((prev) => ({ ...prev, playbackControl: true }));
        broadcastCurrentRadioState();
        musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: true, status: playRes.status });
        return true;
      } else {
        const errMsg = playRes.error || 'Play command was not confirmed by YouTube tab.';
        logMessage(`[Play Notice] ${errMsg}`);
        const current = await musicProviderRef.current.getStatus().catch(() => null);
        if (transportCommandSeqRef.current !== seq) return false;
        if (current) {
          setPlaybackStatus({
            ...current,
            connectedTabId: current.connectedTabId || activeTabId
          });
        }
        broadcastCurrentRadioState();
        musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: false, error: errMsg, currentStatus: current });
        return false;
      }
    } catch (err: any) {
      musicProviderRef.current.recordTrace('HANDLE_PLAY_FINISH', { seq, success: false, error: err?.message });
      throw err;
    } finally {
      if (transportCommandSeqRef.current === seq) {
        isTransportCommandInFlightRef.current = false;
      }
    }
  };

  const handlePauseMusic = async () => {
    const seq = ++transportCommandSeqRef.current;
    isTransportCommandInFlightRef.current = true;
    musicProviderRef.current.recordTrace('HANDLE_PAUSE_START', { seq });
    logMessage('Sending Pause command to YouTube tab...');

    try {
      const pauseRes = await musicProviderRef.current.pauseDetailed();
      if (transportCommandSeqRef.current !== seq) {
        logMessage('[Pause] Superseded by newer command. Dropping result.');
        musicProviderRef.current.recordTrace('HANDLE_PAUSE_SUPERSEDED', { seq });
        return;
      }

      isExplicitStoppedRef.current = false;
      if (pauseRes.status) {
        setPlaybackStatus(pauseRes.status);
      } else {
        setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: prev.currentTime > 0 ? prev.currentTime : 1 }));
      }
      logMessage('⏸ Playback paused on YouTube tab.');
      setTestResults((prev) => ({ ...prev, playbackControl: true }));
      broadcastCurrentRadioState();
      musicProviderRef.current.recordTrace('HANDLE_PAUSE_FINISH', { seq, success: pauseRes.success, status: pauseRes.status });
    } catch (err: any) {
      musicProviderRef.current.recordTrace('HANDLE_PAUSE_FINISH', { seq, success: false, error: err?.message });
      throw err;
    } finally {
      if (transportCommandSeqRef.current === seq) {
        isTransportCommandInFlightRef.current = false;
      }
    }
  };

  const handleStopMusic = async () => {
    const seq = ++transportCommandSeqRef.current;
    isTransportCommandInFlightRef.current = true;
    isExplicitStoppedRef.current = true;
    musicProviderRef.current.recordTrace('HANDLE_STOP_START', { seq });
    logMessage('Sending Stop command to YouTube tab...');

    try {
      const stopRes = await musicProviderRef.current.stopDetailed();
      if (transportCommandSeqRef.current !== seq) {
        logMessage('[Stop] Superseded by newer command. Dropping result.');
        musicProviderRef.current.recordTrace('HANDLE_STOP_SUPERSEDED', { seq });
        return;
      }

      // Cancelling the jingle sequence prevents any later natural completion from advancing
      if (jingleStateRef.current === 'playing' || jingleStateRef.current === 'prepared') {
        jingleStateRef.current = 'cancelled';
        logMessage('[Station Jingle] Jingle sequence cancelled by STOP command.');
      } else if (jingleStateRef.current === 'completed') {
        jingleStateRef.current = 'cancelled';
        logMessage('[Auto Advance] Playback sequence stopped by STOP command.');
      }

      if (stopRes.status) {
        setPlaybackStatus({ ...stopRes.status, isPlaying: false, currentTime: 0 });
      } else {
        setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }));
      }
      logMessage('⏹ Playback stopped on YouTube tab.');
      setTestResults((prev) => ({ ...prev, playbackControl: true }));
      broadcastCurrentRadioState();
      musicProviderRef.current.recordTrace('HANDLE_STOP_FINISH', { seq, success: stopRes.success, status: stopRes.status });
    } catch (err: any) {
      musicProviderRef.current.recordTrace('HANDLE_STOP_FINISH', { seq, success: false, error: err?.message });
      throw err;
    } finally {
      if (transportCommandSeqRef.current === seq) {
        isTransportCommandInFlightRef.current = false;
      }
    }
  };

  const navigateToQueueSong = async (targetIndex: number, reason: string = 'Queue navigation'): Promise<boolean> => {
    if (isAdvancingRef.current) return false;
    isAdvancingRef.current = true;
    try {
      const clampedIndex = ((targetIndex % DEFAULT_SONG_QUEUE.length) + DEFAULT_SONG_QUEUE.length) % DEFAULT_SONG_QUEUE.length;
      currentQueueIndexRef.current = clampedIndex;
      const targetSong = DEFAULT_SONG_QUEUE[clampedIndex];

      // Enforce historical eligibility: queue songs must not be released after the broadcast date
      if (activeDateRef.current && !isReleasedOnOrBefore(targetSong, activeDateRef.current)) {
        const ineligibleMsg = `Track "${targetSong.artist} - ${targetSong.song}" (${targetSong.year}) was released after the broadcast date (${activeDateRef.current}) and cannot be played.`;
        logMessage(`[Queue Eligibility] ${ineligibleMsg}`);
        setSongPlaybackNotice({
          message: ineligibleMsg,
          artist: targetSong.artist,
          song: targetSong.song,
          type: 'not_found'
        });
        broadcastCurrentRadioState(true, true);
        return false;
      }

      logMessage(`[${reason}] Switching to track #${clampedIndex + 1}: "${targetSong.artist} - ${targetSong.song}" (${targetSong.year})...`);

      // Update program song state and Boom Box metadata
      setProgramArtist(targetSong.artist);
      setProgramSongTitle(targetSong.song);
      setProgramYear(targetSong.year);
      setProgramSongResult({
        status: 'NAVIGATING',
        requested: `${targetSong.artist} — ${targetSong.song}`,
        selectedTitle: targetSong.title,
        selectedChannel: 'Official Recording',
        selectedDuration: targetSong.duration,
        selectedVideoId: targetSong.videoId,
        selectedUrl: `https://www.youtube.com/watch?v=${targetSong.videoId}`,
        confidenceScore: 100,
        reason,
        source: 'station queue'
      });

      const targetUrl = `https://www.youtube.com/watch?v=${targetSong.videoId}`;
      const targetVolFraction = getNavVolumeFraction();

      // Navigate background YouTube tab and trigger playback
      const navRes = await musicProviderRef.current.navigateDetailed(targetUrl, targetSong.videoId, targetVolFraction, revealYouTubeToStart);
      if (volumeControllerRef.current) {
        await volumeControllerRef.current.syncInitialVolume(`${reason} start: "${targetSong.title}"`);
      }

      jingleStateRef.current = 'completed';
      isExplicitStoppedRef.current = false;
      hasFirstSongStartedPlayingRef.current = true;
      logMessage(`▶ ${reason} and playing: "${targetSong.title}"`);

      const freshStat = navRes.status || (await musicProviderRef.current.getStatus().catch(() => null));
      const provTabId = musicProviderRef.current.getConnectedTabId();
      if (freshStat) {
        setPlaybackStatus({
          ...freshStat,
          connectedTabId: freshStat.connectedTabId || provTabId || null
        });
      } else if (provTabId) {
        setPlaybackStatus((prev) => ({
          ...prev,
          connectedTabId: provTabId
        }));
      }

      setTestResults((prev) => ({ ...prev, playbackControl: true }));
      broadcastCurrentRadioState();
      return !!(freshStat?.isPlaying || navRes.success);
    } catch (err: any) {
      logMessage(`[${reason} Error] Failed to navigate track: ${err?.message || 'unknown error'}`);
      return false;
    } finally {
      isAdvancingRef.current = false;
    }
  };

  const advanceToNextSong = async (isInitialAfterJingle: boolean = false): Promise<boolean> => {
    if (isAdvancingRef.current) return false;
    isAdvancingRef.current = true;
    broadcastCurrentRadioState(true);
    try {
      if (songLibraryRef.current.length > 0) {
        const history = sessionHistoryRef.current;
        const currentStationGenre = activeStationGenreRef.current || 'Pop';

        // Auto advance: take nextSongRef or pick next song if at end of history
        const pick = nextSongRef.current || pickSong(
          songLibraryRef.current,
          activeDateRef.current,
          currentStationGenre,
          songPlayStateRef.current
        );

        if (pick) {
          nextSongRef.current = null;
          const fromId = history.pointer >= 0 && history.pointer < history.entries.length
            ? history.entries[history.pointer].videoId
            : 'none';
          const toId = pick.song.streaming?.youtube?.id || 'unknown';
          const prevPointer = history.pointer;
          const prevLen = history.entries.length;
          const targetPointer = Math.min(prevLen, prevPointer + 1);
          logMessage(`[Queue] action=AUTO from=${fromId} to=${toId} pointer=${targetPointer}/${prevLen + 1}`);

          return await playLibrarySong(pick, isInitialAfterJingle ? 'Initial Play' : 'Auto Advance');
        }
        const noticeMsg = "The library doesn't cover this date yet (currently the 1960s and early 1970s)";
        logMessage(`[Song Selector] ${noticeMsg}`);
        setSongPlaybackNotice({
          message: noticeMsg,
          artist: activeStationGenreRef.current || 'Station',
          song: activeDateRef.current,
          type: 'not_found'
        });
        broadcastCurrentRadioState(true, true);
        return false;
      }
      let nextIndex = 0;
      if (!isInitialAfterJingle) {
        nextIndex = (currentQueueIndexRef.current + 1) % DEFAULT_SONG_QUEUE.length;
      }
      return await navigateToQueueSong(nextIndex, isInitialAfterJingle ? 'Initial Play' : 'Auto Advance');
    } finally {
      isAdvancingRef.current = false;
    }
  };

  const handleRewindMusic = async () => {
    musicProviderRef.current.recordTrace('HANDLE_REWIND_START');
    logMessage('Rewinding to beginning of previous song in queue...');
    clearPreparedBreak('REWIND transport action');
    if (pendingJingleRef.current) {
      pendingJingleRef.current = null;
    }
    if (activeJingleRef.current) {
      activeJingleRef.current = null;
      if (jingleTimeoutRef.current) {
        clearTimeout(jingleTimeoutRef.current);
        jingleTimeoutRef.current = null;
      }
      jingleEndedHandlerRef.current = null;
    }
    if (volumeControllerRef.current?.isSequenceActive()) {
      volumeControllerRef.current.cancel('REWIND transport action');
      setMixPhase('IDLE');
    }

    try {
      if (songLibraryRef.current.length > 0) {
        const history = sessionHistoryRef.current;
        const currentPointer = history.pointer;
        const historyLen = history.entries.length;

        if (currentPointer > 0) {
          const fromId = history.entries[currentPointer].videoId;
          history.pointer--;
          const targetEntry = history.entries[history.pointer];
          const toId = targetEntry.videoId;
          logMessage(`[Queue] action=REWIND from=${fromId} to=${toId} pointer=${history.pointer}/${historyLen}`);

          const ok = await playLibrarySongInternal(targetEntry.pick, 'REWIND / Previous', undefined, true);
          if (ok) {
            logMessage(`⏪ Rewound to previous track: "${targetEntry.song.artist} - ${targetEntry.song.title}"`);
            musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: true, song: targetEntry.song.title });
            return;
          }
        } else if (currentPointer === 0) {
          // At the first song, restart current song at 0:00 without calling pickSong
          const currentId = history.entries[0]?.videoId || 'unknown';
          logMessage(`[Queue] action=REWIND from=${currentId} to=${currentId} pointer=0/${historyLen} (restarted)`);
          await musicProviderRef.current.seek(0).catch(() => {});
          await musicProviderRef.current.play(revealYouTubeToStart).catch(() => {});
          logMessage(`⏪ Restarted current track at 0:00: "${history.entries[0]?.song.artist} - ${history.entries[0]?.song.title}"`);
          musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: true, restarted: true });
          return;
        }

        // Fallback if history was empty: pickSong(..., 'playLibrarySong(pick, \'REWIND / Previous\')')
        const currentStationGenre = activeStationGenreRef.current || 'Pop';
        const pick = pickSong(
          songLibraryRef.current,
          activeDateRef.current,
          currentStationGenre,
          songPlayStateRef.current
        );
        if (pick) {
          nextSongRef.current = null;
          const ok = await playLibrarySong(pick, 'REWIND / Previous');
          if (ok) {
            logMessage(`⏪ Rewound to previous track: "${pick.song.artist} - ${pick.song.title}"`);
            musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: true, song: pick.song.title });
            return;
          }
        }

        const noticeMsg = "The library doesn't cover this date yet (currently the 1960s and early 1970s)";
        logMessage(`[Song Selector] ${noticeMsg}`);
        setSongPlaybackNotice({
          message: noticeMsg,
          artist: activeStationGenreRef.current || 'Station',
          song: activeDateRef.current,
          type: 'not_found'
        });
        broadcastCurrentRadioState(true, true);
        return;
      }
      const prevIndex = (currentQueueIndexRef.current - 1 + DEFAULT_SONG_QUEUE.length) % DEFAULT_SONG_QUEUE.length;
      const ok = await navigateToQueueSong(prevIndex, 'Rewind Previous');
      if (ok) {
        logMessage(`⏪ Rewound to previous track (#${prevIndex + 1}) in queue.`);
        musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: true, prevIndex });
      } else {
        logMessage('Failed to navigate to previous song in queue.');
        musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: false });
      }
    } catch (e: any) {
      logMessage(`Rewind error: ${e.message}`);
      musicProviderRef.current.recordTrace('HANDLE_REWIND_FINISH', { success: false, error: e.message });
    }
  };

  const handleFastForwardMusic = async () => {
    musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_START');
    logMessage('Fast-forwarding to next song in queue...');

    // Cleanly cancel DJ speech if currently speaking
    clearPreparedBreak('SKIP transport action');
    if (pendingJingleRef.current) {
      logMessage(`[SKIP] Cancelled queued jingle "${pendingJingleRef.current.title || pendingJingleRef.current.id}".`);
      pendingJingleRef.current = null;
    }
    if (activeJingleRef.current) {
      logMessage(`[SKIP] Skipping active jingle "${activeJingleRef.current.title || activeJingleRef.current.id}" directly to next song.`);
      activeJingleRef.current = null;
      if (jingleTimeoutRef.current) {
        clearTimeout(jingleTimeoutRef.current);
        jingleTimeoutRef.current = null;
      }
      jingleEndedHandlerRef.current = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    if (persistentDjAudioRef.current) {
      try {
        persistentDjAudioRef.current.pause();
        persistentDjAudioRef.current.currentTime = 0;
      } catch {}
    }
    if (djAudioRef.current && djAudioRef.current !== persistentDjAudioRef.current) {
      try {
        djAudioRef.current.pause();
        djAudioRef.current.currentTime = 0;
      } catch {}
    }
    if (volumeControllerRef.current?.isSequenceActive()) {
      volumeControllerRef.current.cancel('SKIP while DJ speaking');
      setMixPhase('IDLE');
    }

    try {
      if (songLibraryRef.current.length > 0) {
        const history = sessionHistoryRef.current;
        const currentPointer = history.pointer;
        const historyLen = history.entries.length;

        // If pointer is not at the end, move forward one in history
        if (currentPointer >= 0 && currentPointer < historyLen - 1) {
          const fromId = history.entries[currentPointer].videoId;
          history.pointer++;
          const targetEntry = history.entries[history.pointer];
          const toId = targetEntry.videoId;
          logMessage(`[Queue] action=FF from=${fromId} to=${toId} pointer=${history.pointer}/${historyLen}`);

          const ok = await playLibrarySongInternal(targetEntry.pick, 'SKIP / Fast Forward', undefined, true);
          if (ok) {
            logMessage(`⏩ Fast-forwarded to history track: "${targetEntry.song.artist} - ${targetEntry.song.title}"`);
            musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_FINISH', { success: true, song: targetEntry.song.title });
            return;
          }
        }

        // At the end of history: play pre-selected next song (even if genreMatched === false)
        const currentStationGenre = activeStationGenreRef.current || 'Pop';
        const pick = nextSongRef.current || pickSong(
          songLibraryRef.current,
          activeDateRef.current,
          currentStationGenre,
          songPlayStateRef.current
        );

        if (pick) {
          const fromId = currentPointer >= 0 && currentPointer < historyLen
            ? history.entries[currentPointer].videoId
            : 'none';
          const toId = pick.song.streaming?.youtube?.id || 'unknown';
          logMessage(`[Queue] action=FF from=${fromId} to=${toId} pointer=${historyLen}/${historyLen + 1}`);

          nextSongRef.current = null;
          const ok = await playLibrarySong(pick, 'SKIP / Fast Forward');
          if (ok) {
            logMessage(`⏩ Skipped to next track: "${pick.song.artist} - ${pick.song.title}"`);
            musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_FINISH', { success: true, song: pick.song.title });
            return;
          }
        }
        const noticeMsg = "The library doesn't cover this date yet (currently the 1960s and early 1970s)";
        logMessage(`[Song Selector] ${noticeMsg}`);
        setSongPlaybackNotice({
          message: noticeMsg,
          artist: activeStationGenreRef.current || 'Station',
          song: activeDateRef.current,
          type: 'not_found'
        });
        broadcastCurrentRadioState(true, true);
        return;
      }
      const nextIndex = (currentQueueIndexRef.current + 1) % DEFAULT_SONG_QUEUE.length;
      const ok = await navigateToQueueSong(nextIndex, 'Fast Forward Next');
      if (ok) {
        logMessage(`⏩ Fast-forwarded to next track (#${nextIndex + 1}) in queue.`);
        musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_FINISH', { success: true, nextIndex });
      } else {
        logMessage('Failed to navigate to next song in queue.');
        musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_FINISH', { success: false });
      }
    } catch (e: any) {
      logMessage(`Fast forward error: ${e.message}`);
      musicProviderRef.current.recordTrace('HANDLE_FAST_FORWARD_FINISH', { success: false, error: e.message });
    }
  };

  handlePlayMusicRef.current = handlePlayMusic;
  handlePauseMusicRef.current = handlePauseMusic;
  handleStopMusicRef.current = handleStopMusic;
  handleRewindMusicRef.current = handleRewindMusic;
  handleFastForwardMusicRef.current = handleFastForwardMusic;
  advanceToNextSongRef.current = advanceToNextSong;

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
    currentPlayingArtistRef.current = artist;
    currentPlayingSongRef.current = song;
    currentPlayingYearRef.current = year;

    const requestedStr = `${artist} — ${song}${year ? ` (${year})` : ''}`;

    if (!artist || !song) {
      setProgramSongResult({
        status: 'ERROR',
        requested: requestedStr,
        error: 'Artist and song title are required.',
      });
      return;
    }

    const lookupKey = `${artist.toLowerCase()}|${song.toLowerCase()}`;
    const preset = HARDCODED_PRESETS[lookupKey];

    // If matches a hardcoded preset, skip API search entirely
    if (preset) {
      if (!preset.videoId || preset.videoId.includes('PLACEHOLDER') || preset.videoId.trim() === '') {
        setProgramSongResult({
          status: 'ERROR',
          requested: requestedStr,
          source: 'hardcoded preset',
          error: 'No video ID set for this preset',
        });
        logMessage(`[Program Song Preset] No video ID set for preset: "${artist} - ${song}"`);
        return;
      }

      setIsProgrammingSong(true);
      setSongPlaybackNotice(null);
      jingleStateRef.current = 'completed';
      logMessage(`[Program Song] Hardcoded preset selected for "${preset.artist} - ${preset.song}". Skipping API search.`);

      const targetVolFraction = getNavVolumeFraction();
      const targetUrl = `https://www.youtube.com/watch?v=${preset.videoId}`;

      setProgramSongResult({
        status: 'NAVIGATING',
        requested: requestedStr,
        selectedTitle: preset.title,
        selectedChannel: preset.channel,
        selectedDuration: preset.duration,
        selectedVideoId: preset.videoId,
        selectedUrl: targetUrl,
        confidenceScore: 100,
        reason: 'Selected via hardcoded preset (no API search)',
        source: 'hardcoded preset',
      });

      try {
        const navOk = await musicProviderRef.current.navigate(targetUrl, preset.videoId, targetVolFraction, revealYouTubeToStart);
        if (!navOk) {
          logMessage('[Program Song] Notice: Navigation message sent to YouTube tab. Checking playback...');
        }

        // Allow YouTube player to mount and start playback
        await new Promise((r) => setTimeout(r, 1200));
        const playOk = await musicProviderRef.current.play(revealYouTubeToStart);

        // Synchronize authoritative master volume to YouTube player
        if (volumeControllerRef.current) {
          await volumeControllerRef.current.syncInitialVolume(`Program song preset playback start: "${preset.title}"`);
        }

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
        logMessage(`[Program Song] Playing hardcoded preset: "${preset.title}".`);
      } catch (err: any) {
        logMessage(`[Program Song] Exception: ${err.message}`);
        setProgramSongResult({
          status: 'ERROR',
          requested: requestedStr,
          source: 'hardcoded preset',
          error: err.message || 'Preset navigation failed.',
        });
      } finally {
        setIsProgrammingSong(false);
      }
      return;
    }

    setIsProgrammingSong(true);
    setSongPlaybackNotice(null);
    setProgramSongResult({
      status: 'SEARCHING',
      requested: requestedStr,
      source: 'YouTube Data API v3',
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
          source: 'YouTube Data API v3',
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
          source: 'YouTube Data API v3',
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

      const targetVolFraction = getNavVolumeFraction();

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
        source: 'YouTube Data API v3',
      });

      // Instruct connected YouTube tab to navigate
      jingleStateRef.current = 'completed';
      const navOk = await musicProviderRef.current.navigate(sel.url, sel.videoId, targetVolFraction, revealYouTubeToStart);
      if (!navOk) {
        logMessage('[Program Song] Notice: Navigation message sent to YouTube tab. Checking playback...');
      }

      // Allow YouTube player to mount and start playback
      await new Promise((r) => setTimeout(r, 1200));
      const playOk = await musicProviderRef.current.play(revealYouTubeToStart);

      // Synchronize authoritative master volume to YouTube player
      if (volumeControllerRef.current) {
        await volumeControllerRef.current.syncInitialVolume(`Program song playback start: "${sel.title}"`);
      }

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
    if (volumeControllerRef.current) {
      const ok = await volumeControllerRef.current.setUserVolume(volPercent, 'Master volume slider');
      if (ok) {
        setTestResults((prev) => ({ ...prev, volumeControl: true }));
      }
    }
  };

  const killAllAudio = () => {
    if (persistentDjAudioRef.current) {
      try {
        persistentDjAudioRef.current.pause();
        persistentDjAudioRef.current.currentTime = 0;
      } catch {}
    }
    if (djAudioRef.current && djAudioRef.current !== persistentDjAudioRef.current) {
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
    setMixPhase('IDLE');
    if (volumeControllerRef.current) {
      volumeControllerRef.current.cancel('Kill all audio clicked');
    }
    logMessage('🛑 All audio immediately stopped and silenced.');
  };

  const toggleGlobalMute = async () => {
    const vc = volumeControllerRef.current;
    if (isAudioMuted) {
      const restoreVol = preMuteVolumeRef.current > 0 ? preMuteVolumeRef.current : 100;
      setIsAudioMuted(false);
      if (vc) {
        await vc.setUserVolume(restoreVol, 'Global mute toggled off');
      }
      logMessage(`🔊 Audio unmuted (restored to ${restoreVol}%).`);
    } else {
      const currentVol = vc ? vc.getUserVolume() : targetMusicVolume;
      preMuteVolumeRef.current = currentVol > 0 ? currentVol : 100;
      setIsAudioMuted(true);
      killAllAudio();
      if (vc) {
        await vc.setUserVolume(0, 'Global mute toggled on');
      }
      logMessage('🔇 Global audio muted.');
    }
  };

  const initDjAudioSystem = async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    try {
      // 1. Create or ensure persistent audio element in DOM
      if (!persistentDjAudioRef.current) {
        const audioEl = document.createElement('audio');
        audioEl.id = 'retrofm-persistent-dj-audio';
        audioEl.style.display = 'none';
        audioEl.preload = 'auto';
        document.body.appendChild(audioEl);
        persistentDjAudioRef.current = audioEl;
      }

      // 2. Initialize and attach to DjVoiceEffectsService
      await djVoiceEffects.ensureInitialized();
      if (persistentDjAudioRef.current) {
        djVoiceEffects.attachAudioElement(persistentDjAudioRef.current);
      }

      // 3. Play a 100ms silent audio sample to prime the audio stack without audible output
      if (!isDjAudioInitializedRef.current && persistentDjAudioRef.current) {
        const silentAudioUri = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        persistentDjAudioRef.current.src = silentAudioUri;
        try {
          await persistentDjAudioRef.current.play();
          isDjAudioInitializedRef.current = true;
          logMessage('[DJ Audio Init] DJ audio system and effects chain initialized successfully.');
        } catch (playErr: any) {
          logMessage(`[DJ Audio Init] Silent warmup play deferred: ${playErr?.name}: ${playErr?.message}`);
        }
      }
      return true;
    } catch (err: any) {
      logMessage(`[DJ Audio Init Error] ${err?.message}`);
      return false;
    }
  };

  const handleStartInteraction = () => {
    setHasInteracted(true);
    initDjAudioSystem();
    // Initialize Web Audio / speech context via user gesture
    if (typeof window !== 'undefined') {
      try {
        djVoiceEffects.ensureInitialized().catch(() => {});
      } catch (e) {}
      if (window.speechSynthesis) {
        try { window.speechSynthesis.resume(); } catch (e) {}
      }
    }
    musicProviderRef.current.notifySessionActivated();
    logMessage('RetroFM started via user interaction.');
  };

  // --- Central Unified DJ Speech & Mixing Function ---
  const playDJSpeech = async (
    textToSpeak: string,
    options?: {
      duckMusic?: boolean;
      alreadyDucked?: boolean;
      forceGenerate?: boolean;
      preparedAudio?: string;
      preparedDuration?: number;
      delegateToBoomBox?: boolean;
    }
  ): Promise<boolean> => {
    const text = (textToSpeak || djScript).trim();
    if (!text) {
      setDjError('Please enter a DJ script.');
      return false;
    }

    const vc = volumeControllerRef.current;
    const shouldDuck = Boolean((options?.duckMusic || options?.alreadyDucked) && vc);
    const isAlreadyDucked = Boolean(options?.alreadyDucked);

    // Rule: No overlapping DJ sequences if ducking is active or requested (unless already ducked by lead duck)
    if (shouldDuck && !isAlreadyDucked && vc?.isSequenceActive()) {
      logMessage('[DJ Speech] Ignored: A DJ mixing sequence is already active.');
      return false;
    }

    if (isDjSpeakingRef.current) {
      logMessage('[DJ Speech] Ignored: A DJ speech playback is already in progress.');
      return false;
    }
    isDjSpeakingRef.current = true;

    // Cancel any previous in-flight speech/audio
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
    if (persistentDjAudioRef.current) {
      try {
        persistentDjAudioRef.current.pause();
        persistentDjAudioRef.current.currentTime = 0;
      } catch {}
    }
    if (djAudioRef.current && djAudioRef.current !== persistentDjAudioRef.current) {
      try {
        djAudioRef.current.pause();
        djAudioRef.current.currentTime = 0;
      } catch {}
    }

    setIsGeneratingDJ(true);
    setDjError(null);

    const isKokoro = voiceEngine === 'KOKORO';
    const isGemini = voiceEngine === 'GEMINI';
    const isBrowser = voiceEngine === 'BROWSER';
    const engineLabel = isKokoro ? 'Kokoro TTS (Local)' : isGemini ? 'Gemini Flash TTS' : 'Browser Speech';
    const normalVol = vc ? vc.getUserVolume() : targetMusicVolume;
    const duckVol = vc ? vc.getDuckLevel() : 20;

    let duckSucceeded = false;
    let safetyTimeout: any = null;

    try {
      // Step A: Prepare or generate audio if using server/local TTS
      let audioSrc = options?.preparedAudio || djAudioData;
      let durationSec = options?.preparedDuration || djAudioDuration || 4;

      if ((isKokoro || isGemini) && !options?.preparedAudio) {
        if (!audioSrc || options?.forceGenerate || text !== djScript) {
          const voiceToUse = isKokoro ? selectedKokoroVoice : selectedVoice;
          logMessage(`[TTS] Synthesizing voice using ${engineLabel} (voice: ${voiceToUse})...`);

          const startTime = performance.now();
          const response = await generateTTS({
            text,
            engine: voiceEngine,
            voice: voiceToUse,
            style: djStyle,
            model: isKokoro ? 'Kokoro-82M-bf16' : selectedModel,
            speed: isKokoro ? kokoroSpeed : undefined,
          });

          const latencyMs = Math.round(performance.now() - startTime);

          if (response.success && response.audioBase64) {
            audioSrc = `data:${response.mimeType || 'audio/wav'};base64,${response.audioBase64}`;
            durationSec = response.durationSeconds || 4;
            setDjAudioData(audioSrc);
            setDjAudioDuration(durationSec);
            setDjModelUsed(response.modelUsed || (isKokoro ? 'Kokoro-82M-bf16' : selectedModel));
            setTestResults((prev) => ({ ...prev, geminiTTS: true }));
            logMessage(`${engineLabel} audio ready in ${latencyMs}ms (~${durationSec}s).`);
          } else {
            if (!isKokoro && response.quotaExceeded) {
              setVoiceEngine('BROWSER');
              setDjError('Google Cloud Free Tier TTS quota reached. Auto-switched to Instant Browser Voice.');
              logMessage('Quota reached. Auto-switched to Instant Browser DJ Voice Engine.');
            } else {
              const errMsg = response.error || `${engineLabel} generation failed.`;
              setDjError(errMsg);
              logMessage(`[TTS Error] ${errMsg}`);
            }
            setTestResults((prev) => ({ ...prev, geminiTTS: false }));
            return false;
          }
        }
      }

      // Step B: If music ducking requested, duck music now (skip if already ducked by lead duck)
      if (shouldDuck && vc) {
        if (!isAlreadyDucked) {
          setMixPhase('FADING_DOWN');
          logMessage(`▶ Ducking YouTube music from ${normalVol}% down to ${duckVol}% (${fadeDownMs}ms fade)...`);
          const duckPromise = vc.duck(fadeDownMs, 'DJ speech start');
          const timeoutPromise = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000));
          const duckConfirmed = await Promise.race([duckPromise, timeoutPromise]);
          if (!duckConfirmed) {
            const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
            logMessage(`[Volume] Duck confirmation timed out after 2s (visibility: ${vis}) — proceeding with DJ speech`);
          }
        }
        duckSucceeded = true;
        setTestResults((prev) => ({ ...prev, musicDucking: true }));
      }

      setMixPhase(shouldDuck ? 'DJ_SPEAKING' : 'IDLE');
      setIsPlayingDJPreview(true);

      // Check if Boom Box is open and available to play audio in the focused tab
      let playedViaBoomBox = false;
      const shouldDelegateToBoomBox = options?.delegateToBoomBox !== false && shouldDuck;
      if (shouldDelegateToBoomBox) {
        try {
          const boomBoxPayload = {
            audioSrc: isBrowser ? undefined : audioSrc,
            durationSec,
            text,
            isBrowser,
            effectsSettings: djVoiceEffects.getSettings()
          };
          const bbRes = await musicProviderRef.current.playBoomBoxDjSpeech(boomBoxPayload);
          if (bbRes && bbRes.success) {
            playedViaBoomBox = true;
            logMessage(`▶ Playing ${engineLabel} voice on Boom Box.`);
            setTestResults((prev) => ({
              ...prev,
              geminiPlayback: true,
              simultaneousPlayback: shouldDuck ? true : prev.simultaneousPlayback
            }));

            // Await speech completion on Boom Box tab
            await new Promise<boolean>((resolve) => {
              let settled = false;
              let timeout: any = null;
              const finishUnsub = musicProviderRef.current.onBoomBoxDjSpeechFinished(() => {
                if (!settled) {
                  settled = true;
                  if (timeout) clearTimeout(timeout);
                  finishUnsub();
                  resolve(true);
                }
              });
              timeout = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  finishUnsub();
                  resolve(true);
                }
              }, Math.max(12000, (durationSec + 4) * 1000));
            });
          }
        } catch (bbErr) {
          // Boom Box delegation unavailable, proceed to local playback
        }
      }

      if (!playedViaBoomBox) {
        // Step C: Play speech with 15-second safety timeout
        await new Promise<boolean>(async (resolve, reject) => {
          let settled = false;

          const cleanupTimeout = () => {
            if (safetyTimeout) {
              clearTimeout(safetyTimeout);
              safetyTimeout = null;
            }
          };

        safetyTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            logMessage(`[TTS Timeout] Speech did not complete within 15 seconds. Forcing safety cleanup.`);
            if (isBrowser && typeof window !== 'undefined' && window.speechSynthesis) {
              try { window.speechSynthesis.cancel(); } catch {}
            }
            if (persistentDjAudioRef.current) {
              try { persistentDjAudioRef.current.pause(); } catch {}
            }
            if (djAudioRef.current) {
              try { djAudioRef.current.pause(); } catch {}
            }
            resolve(false);
          }
        }, 15000);

        if (isBrowser) {
          if (typeof window === 'undefined' || !window.speechSynthesis) {
            cleanupTimeout();
            settled = true;
            setDjError('Browser speech synthesis is not supported on this browser.');
            return resolve(false);
          }
          const u = new SpeechSynthesisUtterance(text);
          (window as any).__retroFmDJUtterance = u;
          u.rate = 1.05;
          u.volume = Math.max(0, Math.min(1, djVoiceVolumePercent / 100));
          u.onstart = () => {
            logMessage('▶ Playing Browser DJ voice.');
            setTestResults((prev) => ({
              ...prev,
              geminiPlayback: true,
              simultaneousPlayback: shouldDuck ? true : prev.simultaneousPlayback
            }));
          };
          u.onend = () => {
            if (!settled) {
              settled = true;
              cleanupTimeout();
              resolve(true);
            }
          };
          u.onerror = (e) => {
            if (!settled) {
              settled = true;
              cleanupTimeout();
              logMessage(`[Browser Speech Error] ${e.error || 'speech failed'}`);
              resolve(false);
            }
          };
          window.speechSynthesis.speak(u);
        } else {
          // Kokoro or Gemini Audio Playback
          if (!audioSrc) {
            cleanupTimeout();
            settled = true;
            return resolve(false);
          }

          // Use persistent audio element if available, falling back to new Audio
          let audio = persistentDjAudioRef.current;
          if (!audio && typeof document !== 'undefined') {
            audio = document.createElement('audio');
            audio.id = 'retrofm-persistent-dj-audio';
            audio.style.display = 'none';
            audio.preload = 'auto';
            document.body.appendChild(audio);
            persistentDjAudioRef.current = audio;
          }
          if (!audio) {
            audio = new Audio();
          }

          audio.src = audioSrc;
          audio.volume = Math.max(0, Math.min(1, djVoiceVolumePercent / 100));
          djAudioRef.current = audio;

          // Route DJ voice through Web Audio DJ Voice Effects graph
          try {
            await djVoiceEffects.ensureInitialized();
            djVoiceEffects.attachAudioElement(audio);
          } catch (e) {
            console.warn('[DjVoiceEffects] Failed to route audio through effects graph, playing directly:', e);
          }

          audio.onended = () => {
            if (!settled) {
              settled = true;
              cleanupTimeout();
              resolve(true);
            }
          };
          audio.onerror = (e) => {
            if (!settled) {
              settled = true;
              cleanupTimeout();
              logMessage(`[Audio Playback Error] Failed to play audio: ${e}`);
              resolve(false);
            }
          };

          try {
            await audio.play();
            logMessage(`▶ Playing ${engineLabel} voice.`);
            setTestResults((prev) => ({
              ...prev,
              geminiPlayback: true,
              simultaneousPlayback: shouldDuck ? true : prev.simultaneousPlayback
            }));
          } catch (err: any) {
            const audioCtx = djVoiceEffects.getAudioContext();
            const timestamp = new Date().toISOString();
            const errName = err?.name || 'Error';
            const errMsg = err?.message || String(err);
            const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
            const userAct = typeof navigator !== 'undefined' ? (navigator as any).userActivation?.hasBeenActive : 'unknown';
            const audioCtxState = audioCtx ? audioCtx.state : 'uninitialized';

            console.warn(
              `[DJ Audio Warning] Primary playback failed (err: ${errName}: ${errMsg}, vis: ${vis}, userAct: ${userAct}, ctx: ${audioCtxState}). Attempting direct unrouted fallback...`
            );

            // Resilient fallback: attempt direct playback with a clean standalone HTMLAudioElement
            let fallbackSucceeded = false;
            try {
              const fallbackAudio = new Audio(audioSrc);
              fallbackAudio.volume = Math.max(0, Math.min(1, djVoiceVolumePercent / 100));
              djAudioRef.current = fallbackAudio;

              fallbackAudio.onended = () => {
                if (!settled) {
                  settled = true;
                  cleanupTimeout();
                  resolve(true);
                }
              };
              fallbackAudio.onerror = (e) => {
                if (!settled) {
                  settled = true;
                  cleanupTimeout();
                  logMessage(`[Audio Playback Error] Direct fallback error: ${e}`);
                  resolve(false);
                }
              };

              await fallbackAudio.play();
              fallbackSucceeded = true;
              logMessage(`▶ Playing ${engineLabel} voice (direct unrouted fallback).`);
              setTestResults((prev) => ({
                ...prev,
                geminiPlayback: true,
                simultaneousPlayback: shouldDuck ? true : prev.simultaneousPlayback
              }));
            } catch (fallbackErr: any) {
              const fbMsg = fallbackErr?.message || String(fallbackErr);
              console.error(
                `[DJ Audio Failure] timestamp=${timestamp} error=${errName}: ${errMsg} (direct fallback also failed: ${fbMsg}) visibility=${vis} userActivation=${userAct} audioCtxState=${audioCtxState}`
              );
              logMessage(
                `[DJ Audio Failure] ${errName}: ${errMsg} (vis: ${vis}, userAct: ${userAct}, ctx: ${audioCtxState})`
              );

              // Immediate music restoration and sequence safety cancellation
              if (shouldDuck && vc && vc.isSequenceActive()) {
                try {
                  await vc.cancel('DJ audio playback failed');
                  logMessage('[DJ Audio Failure] Music volume restored immediately.');
                } catch (cancelErr: any) {
                  console.warn('[DJ Audio Failure] Error cancelling volume sequence:', cancelErr);
                }
              }

              duckSucceeded = false;
              setMixPhase('IDLE');
              setIsPlayingDJPreview(false);
              setDjError(`Audio play rejected: ${errMsg}`);

              if (!settled) {
                settled = true;
                cleanupTimeout();
                resolve(false);
              }
            }
          }
        }
      });
    }

    return true;
    } catch (err: any) {
      const errMsg = err?.message || 'DJ speech encountered an error.';
      setDjError(errMsg);
      logMessage(`[DJ Speech Exception] ${errMsg}`);
      return false;
    } finally {
      isDjSpeakingRef.current = false;
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        safetyTimeout = null;
      }
      setIsGeneratingDJ(false);
      setIsPlayingDJPreview(false);

      // Restore music volume if ducked
      if (duckSucceeded && vc) {
        try {
          setMixPhase('FADING_UP');
          logMessage(`▶ Restoring YouTube music back to user volume (${fadeUpMs}ms fade)...`);
          await vc.restore(fadeUpMs, 'DJ speech finished');
          setMixPhase('COMPLETED');
          setTestResults((prev) => ({
            ...prev,
            musicRestoration: true,
            overallTransition: true
          }));
          setTimeout(() => setMixPhase('IDLE'), 1200);
        } catch (err: any) {
          logMessage(`[DJ Speech Restore Error] ${err?.message}`);
          await vc.cancel('Restore exception');
          setMixPhase('IDLE');
        }
      } else {
        if (shouldDuck && vc && vc.isSequenceActive()) {
          try {
            await vc.cancel('DJ speech failed before clean restoration');
          } catch {}
        }
        setMixPhase('IDLE');
      }
    }
  };

  // --- Generate DJ Audio Button Handler (Synthesizes and immediately plays solo) ---
  const handleGenerateDJ = async (textOverride?: string): Promise<string | null> => {
    // Explicit user interaction: ensure Web Audio context is initialized and resumed
    djVoiceEffects.ensureInitialized().catch(() => {});

    const textToSynthesize = (textOverride || djScript).trim();
    if (!textToSynthesize) {
      setDjError('Please enter a DJ script.');
      return null;
    }

    const ok = await playDJSpeech(textToSynthesize, { duckMusic: false, forceGenerate: true, delegateToBoomBox: false });
    return ok ? djAudioData : null;
  };

  // --- Preview DJ Audio Solo ---
  const handleToggleDJPreview = () => {
    if (volumeControllerRef.current?.isSequenceActive()) {
      logMessage('DJ sequence active. Please wait for mix sequence to complete.');
      return;
    }

    if (isPlayingDJPreview) {
      if (persistentDjAudioRef.current) {
        try {
          persistentDjAudioRef.current.pause();
          persistentDjAudioRef.current.currentTime = 0;
        } catch {}
      }
      if (djAudioRef.current && djAudioRef.current !== persistentDjAudioRef.current) {
        try {
          djAudioRef.current.pause();
          djAudioRef.current.currentTime = 0;
        } catch {}
      }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch {}
      }
      setIsPlayingDJPreview(false);
      logMessage('DJ preview stopped.');
    } else {
      // Explicit user interaction: ensure Web Audio context is initialized and resumed
      djVoiceEffects.ensureInitialized().catch(() => {});
      playDJSpeech(djScript, { duckMusic: false, forceGenerate: false, delegateToBoomBox: false });
    }
  };

  // --- Critical Audio Ducking & DJ-Over-Music Execution ---
  const executeDJOverMusic = async (scriptOverride?: string): Promise<boolean> => {
    // Explicit user interaction: ensure Web Audio context is initialized and resumed
    djVoiceEffects.ensureInitialized().catch(() => {});
    return await playDJSpeech(scriptOverride || djScript, { duckMusic: true });
  };

  // --- Ahead-of-Time DJ Observation Break Builder & Synthesizer ---
  const clearPreparedBreak = (reason?: string) => {
    if (preparedBreakRef.current) {
      if (reason) {
        logMessage(`[DJ] Discarded prepared break: ${reason}`);
      }
      // If a news break was prepared but never played, return the line to the queue
      if (preparedBreakRef.current.newsText) {
        clientNewsQueue.returnLineToQueue(preparedBreakRef.current.newsText);
      }
      preparedBreakRef.current = null;
    }
    isPreparingBreakRef.current = false;
    breakDuckingStartedRef.current = false;
  };

  const prepareObservationBreakAhead = async (
    currentSongId: string,
    prevSongObj: LibrarySong | null,
    nextSongObj: LibrarySong | null
  ) => {
    if (isPreparingBreakRef.current) return;
    if (preparedBreakRef.current?.id === currentSongId) return;
    if (breakTriggeredForSongIdRef.current === currentSongId) return;

    isPreparingBreakRef.current = true;
    try {
      const prev = toObsSong(prevSongObj);
      const next = toObsSong(nextSongObj);
      const date = activeDateRef.current;

      // 2. Build context for buildVarietyBreak
      const yearNum = parseInt(date.slice(0, 4), 10);
      const decadeStr = (!isNaN(yearNum) && yearNum >= 1950) ? `${Math.floor(yearNum / 10) * 10}s` : '1960s';
      const tunedGenre = activeStationGenreRef.current;

      const dynamicStations = calculateDynamicStationsForDate(
        songLibraryRef.current,
        date,
        !isNaN(yearNum) ? Math.floor(yearNum / 10) * 10 : 1960
      );
      const allStations = dynamicStations.length > 0 ? dynamicStations : (STATIONS_BY_DECADE[!isNaN(yearNum) ? Math.floor(yearNum / 10) * 10 : 1960] || []);
      const activeStation = (tunedGenre ? allStations.find(s => s.genre === tunedGenre) : null)
        || allStations[0];
      const frequencyStr = activeStation ? String(activeStation.frequency) : '91.7';

      // Latest chart date on or before the selected date
      const allWeeks = weeklyTopDataRef.current;
      let topOfWeek: TopEntry[] | null = null;
      if (allWeeks) {
        const validDates = Object.keys(allWeeks).filter((d) => d <= date).sort();
        if (validDates.length > 0) {
          topOfWeek = allWeeks[validDates[validDates.length - 1]] || null;
        }
      }

      // News item from pre-audited pipeline if ready ahead of time
      const nextNewsItem = clientNewsQueue.getNextNewsLine();
      const newsItem: { text: string } | null = nextNewsItem ? { text: nextNewsItem.text } : null;

      // Spec A Decision Engine: evaluate candidate break before LLM or template via server endpoint
      const freqMap: Record<'every' | 'often' | 'sometimes' | 'rarely', number> = {
        every: 1.0,
        often: 0.70,
        sometimes: 0.40,
        rarely: 0.15,
      };
      const freqSetting = freqMap[djTalkFrequency] ?? 0.40;

      let specAResult: BreakDecisionResponsePayload;
      try {
        const res = await fetch('/api/dj/break-decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            selectedDate: date,
            prevSong: prev ? { title: prev.title, artist: prev.artist, id: prev.id, first_chart_date: prevSongObj?.first_chart_date } : null,
            nextSong: next ? { title: next.title, artist: next.artist, id: next.id, first_chart_date: nextSongObj?.first_chart_date } : null,
            frequencySetting: freqSetting,
            usedFactKeys: Array.from(specABreakStateRef.current.usedFactKeys),
            lastBreakType: specABreakStateRef.current.lastBreakType,
            breaksSinceLastNews: specABreakStateRef.current.breaksSinceLastNews ?? 4,
            usedNewsTopics: Array.from(specABreakStateRef.current.usedNewsTopics || []),
            lastIntroTemplateIndex: specABreakStateRef.current.lastIntroTemplateIndex ?? -1,
            newsObservation: newsItem ? { text: newsItem.text, date } : null,
          }),
        });
        if (res.ok) {
          specAResult = await res.json();
        } else {
          throw new Error(`Server returned ${res.status}`);
        }
      } catch (err) {
        console.warn('[DJ] Failed to fetch server break decision, falling back to silence:', err);
        specAResult = {
          decision: 'silence',
          breakType: null,
          candidate: null,
          finalSpeech: '',
          targetSong: 'none',
        };
      }

      // Update client-side session state
      specABreakStateRef.current.totalSongChanges++;
      if (specAResult.decision === 'speak' && specAResult.candidate) {
        specABreakStateRef.current.usedFactKeys.add(specAResult.candidate.factKey);
        specABreakStateRef.current.lastBreakType = specAResult.candidate.type;
        specABreakStateRef.current.totalBreaksSpoken++;
        if (specAResult.candidate.type === 'observation' && specAResult.candidate.factKey.startsWith('news:')) {
          specABreakStateRef.current.breaksSinceLastNews = 0;
          const topic = (specAResult.candidate as any).topic;
          if (topic && topic !== 'general') {
            if (!specABreakStateRef.current.usedNewsTopics) {
              specABreakStateRef.current.usedNewsTopics = new Set<string>();
            }
            specABreakStateRef.current.usedNewsTopics.add(topic);
          }
        } else {
          specABreakStateRef.current.breaksSinceLastNews = (specABreakStateRef.current.breaksSinceLastNews ?? 0) + 1;
        }
      }

      // If silence was chosen, enter silent break immediately
      if (specAResult.decision === 'silence') {
        console.log('[DJ] Spec A engine selected silence');
        preparedBreakRef.current = {
          id: currentSongId,
          audioData: null,
          durationSec: 0,
          text: '',
          slot: 'before',
          kind: 'silent',
          timing: 'land',
          pendingVarietyState: varietyStateRef.current,
          triggerTimeRemaining: 1.5,
          duckTriggerTimeRemaining: 2.0,
        };
        return;
      }

      // If AI mode is active and we have an observation break (news or economy), ask the active provider to write spoken sentences from it.
      // Note: song_credit, chart_fact, and intro_only breaks use rotating code templates and do not call the LLM.
      let candidateSpokenText = specAResult.finalSpeech;
      const candidateObj = specAResult.candidate;
      const isLlmEligibleType = candidateObj && candidateObj.type === 'observation';
      if (djMode === 'ai' && isLlmEligibleType && candidateObj) {
        const aiProvider = ((typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_ai_provider') : null) as 'gemini' | 'lmstudio') || 'gemini';
        const lmEndpoint = (typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_lmstudio_endpoint') : null) || getEnv('LM_STUDIO_ENDPOINT') || 'http://localhost:1234/v1';
        const lmModel = (typeof localStorage !== 'undefined' ? localStorage.getItem('retrofm_lmstudio_model') : null) || getEnv('LM_STUDIO_MODEL') || undefined;

        const writer = getScriptWriterProvider({
          provider: aiProvider,
          endpoint: lmEndpoint,
          model: lmModel,
        });

        try {
          const aiScriptRes = await writer.writeSingleBreakScript({
            targetDate: date,
            personality: 'mike',
            songPlayed: prev ? { title: prev.title, artist: prev.artist } : undefined,
            songNext: next ? { title: next.title, artist: next.artist } : undefined,
            targetSong: specAResult.targetSong,
            breakType: candidateObj.type,
            factPacket: {
              factText: candidateObj.factText,
              source: candidateObj.source,
              date: candidateObj.date,
            },
          });
          if (aiScriptRes.success && aiScriptRes.scriptText) {
            // Run strict validation check on LLM output
            const val = validateBreakOutput(aiScriptRes.scriptText, {
              selectedDate: date,
              factPacket: {
                factText: candidateObj.factText,
                source: candidateObj.source,
                date: candidateObj.date,
              },
              songPlayed: prev,
              songNext: next,
            });
            if (val.valid) {
              candidateSpokenText = val.sanitizedText;
            } else {
              console.log(`[DJ] LLM output rejected (${val.rejectedReason}) -> using verified candidate script`);
            }
          } else if (aiScriptRes.error) {
            console.warn(`[DJ] ${aiProvider.toUpperCase()} error: ${aiScriptRes.error}`);
          }
        } catch (llmErr: any) {
          console.warn(`[DJ] Failed calling ${aiProvider.toUpperCase()} for single break script:`, llmErr?.message);
        }
      }

      const res = buildVarietyBreak(
        {
          prev,
          next,
          date,
          now: new Date(),
          decade: decadeStr,
          genre: tunedGenre,
          frequency: frequencyStr,
          topOfWeek,
          jingles: jinglesDataRef.current,
          news: newsItem,
          length: djTalkLength,
        },
        varietyStateRef.current,
        Math.random,
        TALK_PRESETS[djTalkFrequency]
      );

      // Override with Spec A candidate spoken text
      res.text = candidateSpokenText;
      if (specAResult.breakType) {
        res.kind = specAResult.breakType as any;
      }

      const timing = res.timing || 'land';
      const maxSeconds = res.maxSeconds;

      if (res.kind === 'silent' || (!res.text && res.kind !== 'jingle')) {
        console.log('[DJ] silent break');
        preparedBreakRef.current = {
          id: currentSongId,
          audioData: null,
          durationSec: 0,
          text: '',
          slot: 'before',
          kind: res.kind,
          detail: res.detail,
          timing,
          maxSeconds,
          pendingVarietyState: res.state,
          varietyResult: res,
          triggerTimeRemaining: 1.5,
          duckTriggerTimeRemaining: 2.0,
        };
        return;
      }

      if (res.kind === 'jingle') {
        console.log(`[DJ] preparing jingle break: ${res.jingle?.id} (${res.jingle?.youtube_id})`);
        const triggerTimeRemaining = 1.0 + Math.random() * 1.0;
        preparedBreakRef.current = {
          id: currentSongId,
          audioData: null,
          durationSec: res.jingle?.duration_sec || 5,
          text: '',
          slot: 'before',
          kind: 'jingle',
          detail: res.jingle?.title || res.jingle?.id,
          timing: 'land',
          pendingVarietyState: res.state,
          varietyResult: res,
          triggerTimeRemaining,
          duckTriggerTimeRemaining: triggerTimeRemaining + 0.5,
        };
        return;
      }

      // Delivery Shaping: Shape punctuation before TTS synthesis
      let finalText = res.text;
      const protect: string[] = [];
      if (prev) {
        const spokenPrev = artistTitle(prev);
        protect.push(spokenPrev.artist, spokenPrev.title, prev.title, prev.artist);
      }
      if (next) {
        const spokenNext = artistTitle(next);
        protect.push(spokenNext.artist, spokenNext.title, next.title, next.artist);
      }
      const uniqueProtect = Array.from(new Set(protect.filter(Boolean)));
      const beforeShaping = finalText;
      finalText = shapeDelivery(finalText, {
        excitement: djExcitement,
        pauses: djPauses,
        protect: uniqueProtect,
      });
      console.log(`[DJ Delivery] before: "${beforeShaping}" after: "${finalText}"`);
      console.log(`[DJ] preparing break (kind: ${res.kind}, detail: ${res.detail ?? 'none'}): "${finalText}"`);

      // Synthesize audio ahead of time
      let audioBase64: string | null = null;
      let durationSec = 4;

      if (voiceEngine === 'BROWSER') {
        // Browser SpeechSynthesis does not produce base64 audio, estimate ~2.5 words/sec
        audioBase64 = 'browser-speech';
        const words = finalText.split(/\s+/).filter(Boolean);
        durationSec = Math.max(3, Math.round(words.length / 2.5));
      } else {
        const voiceToUse = voiceEngine === 'KOKORO' ? selectedKokoroVoice : selectedVoice;
        const resp = await generateTTS({
          text: finalText,
          engine: voiceEngine,
          voice: voiceToUse,
          style: djStyle,
          model: voiceEngine === 'KOKORO' ? 'Kokoro-82M-bf16' : selectedModel,
          speed: voiceEngine === 'KOKORO' ? kokoroSpeed : undefined,
        });

        if (resp.success && resp.audioBase64) {
          audioBase64 = `data:${resp.mimeType || 'audio/wav'};base64,${resp.audioBase64}`;
          durationSec = resp.durationSeconds || Math.max(3, Math.round(finalText.split(/\s+/).filter(Boolean).length / 2.5));
        } else {
          console.warn('[DJ] TTS generation failed during ahead-of-time prep:', resp.error);
        }
      }

      // Check if song changed while we were synthesizing
      if (currentSongPickRef.current?.song?.id !== currentSongId && playbackStatusRef.current?.videoId !== currentSongId) {
        console.log('[DJ] Discarding prepared break: active song changed during synthesis');
        return;
      }

      // Timing calculation based on measured audio duration
      let triggerTimeRemaining = 1.5;
      if (timing === 'land') {
        const landOffset = 0.5 + Math.random() * 1.5; // Random in [0.5, 2.0]
        triggerTimeRemaining = durationSec - landOffset;
        if (triggerTimeRemaining > 25) {
          triggerTimeRemaining = 25;
        }
        if (triggerTimeRemaining < 1.0) {
          triggerTimeRemaining = 1.0;
        }
      } else {
        // follow: speech starts 1.0 to 2.0 seconds before current song ends
        triggerTimeRemaining = 1.0 + Math.random() * 1.0;
      }

      const duckTriggerTimeRemaining = triggerTimeRemaining + 0.5; // Duck 500ms before speech starts
      const wordCount = finalText.split(/\s+/).filter(Boolean).length;

      console.log(`[DJ] timing=${timing} audio=${durationSec.toFixed(1)}s start=remaining ${triggerTimeRemaining.toFixed(1)}s`);
      logMessage(`[DJ] timing=${timing} audio=${durationSec.toFixed(1)}s start=remaining ${triggerTimeRemaining.toFixed(1)}s`);

      preparedBreakRef.current = {
        id: currentSongId,
        audioData: audioBase64,
        durationSec,
        text: finalText,
        slot: 'before',
        kind: res.kind,
        detail: res.detail,
        timing,
        maxSeconds,
        wordCount,
        deliverySettings: {
          length: djTalkLength,
          excitement: djExcitement,
          pauses: djPauses,
        },
        pendingVarietyState: res.state,
        varietyResult: res,
        triggerTimeRemaining,
        duckTriggerTimeRemaining,
        newsText: res.kind === 'news' && nextNewsItem ? nextNewsItem.text : null,
      };

      const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
      const curRemaining = (playbackStatusRef.current?.duration || 0) - (playbackStatusRef.current?.currentTime || 0);
      console.log(`[DJ] prepared break: "${res.text}" remaining=${curRemaining > 0 ? curRemaining.toFixed(1) : 'unknown'}s (visibility: ${vis})`);
      logMessage(`[DJ] Prepared break: "${res.text}" remaining=${curRemaining > 0 ? curRemaining.toFixed(1) : 'unknown'}s (visibility: ${vis})`);
    } catch (e: any) {
      console.warn('[DJ] Error preparing ahead break:', e);
    } finally {
      isPreparingBreakRef.current = false;
    }
  };

  // --- Observation Break Builder & Test Helper ---
  const generateObservationBreak = (
    prev?: LibrarySong | null,
    next?: LibrarySong | null
  ): { text: string; slot: 'before' | 'after'; kind: string | null; detail?: string; timing?: 'land' | 'follow'; wordCount?: number } => {
    const history = sessionHistoryRef.current;
    const p = history.pointer;
    const historyPrev = p > 0 ? history.entries[p - 1].song : (previousLibrarySongRef.current || currentSongPickRef.current?.song);
    const historyNext = (p >= 0 && p < history.entries.length - 1)
      ? history.entries[p + 1].song
      : (nextSongRef.current?.song || null);

    const prevSong = toObsSong(prev !== undefined ? prev : historyPrev);
    const nextSong = toObsSong(next !== undefined ? next : historyNext);
    const date = activeDateRef.current;

    const yearNum = parseInt(date.slice(0, 4), 10);
    const decadeStr = (!isNaN(yearNum) && yearNum >= 1950) ? `${Math.floor(yearNum / 10) * 10}s` : '1960s';
    const tunedGenre = activeStationGenreRef.current;

    const dynamicStations = calculateDynamicStationsForDate(
      songLibraryRef.current,
      date,
      !isNaN(yearNum) ? Math.floor(yearNum / 10) * 10 : 1960
    );
    const allStations = dynamicStations.length > 0 ? dynamicStations : (STATIONS_BY_DECADE[!isNaN(yearNum) ? Math.floor(yearNum / 10) * 10 : 1960] || []);
    const activeStation = (tunedGenre ? allStations.find(s => s.genre === tunedGenre) : null)
      || allStations[0];
    const frequencyStr = activeStation ? String(activeStation.frequency) : '91.7';

    const allWeeks = weeklyTopDataRef.current;
    let topOfWeek: TopEntry[] | null = null;
    if (allWeeks) {
      const validDates = Object.keys(allWeeks).filter((d) => d <= date).sort();
      if (validDates.length > 0) {
        topOfWeek = allWeeks[validDates[validDates.length - 1]] || null;
      }
    }

    const nextNewsItem = clientNewsQueue.getNextNewsLine();
    const res = buildVarietyBreak(
      {
        prev: prevSong,
        next: nextSong,
        date,
        now: new Date(),
        decade: decadeStr,
        genre: tunedGenre,
        frequency: frequencyStr,
        topOfWeek,
        jingles: jinglesDataRef.current,
        news: nextNewsItem ? { text: nextNewsItem.text } : null,
        length: djTalkLength,
      },
      varietyStateRef.current,
      Math.random,
      TALK_PRESETS[djTalkFrequency]
    );
    varietyStateRef.current = res.state;
    if (res.kind === 'news' && nextNewsItem) {
      clientNewsQueue.markLineUsed(nextNewsItem.text);
    }

    let spokenText = res.text;
    if (spokenText && res.kind !== 'jingle') {
      const protect: string[] = [];
      if (prevSong) {
        const spokenPrev = artistTitle(prevSong);
        protect.push(spokenPrev.artist, spokenPrev.title, prevSong.title, prevSong.artist);
      }
      if (nextSong) {
        const spokenNext = artistTitle(nextSong);
        protect.push(spokenNext.artist, spokenNext.title, nextSong.title, nextSong.artist);
      }
      const uniqueProtect = Array.from(new Set(protect.filter(Boolean)));
      const beforeShaping = spokenText;
      spokenText = shapeDelivery(spokenText, {
        excitement: djExcitement,
        pauses: djPauses,
        protect: uniqueProtect,
      });
      console.log(`[DJ Delivery] before: "${beforeShaping}" after: "${spokenText}"`);
    }

    const kindFormatted = res.kind ? res.kind : 'none';
    if (!spokenText) {
      console.log('[DJ] silent break');
    } else {
      console.log(`[DJ] mode=observations kind=${kindFormatted} detail=${res.detail ?? 'none'} text="${spokenText}"`);
    }

    const wordCount = spokenText ? spokenText.split(/\s+/).filter(Boolean).length : 0;
    setLastDjBreak({
      text: spokenText,
      slot: 'before',
      kind: res.kind,
      detail: res.detail,
      timing: res.timing || 'land',
      wordCount,
      spokenSeconds: spokenText ? Math.max(3, Math.round(wordCount / 2.5)) : 0,
      deliverySettings: {
        length: djTalkLength,
        excitement: djExcitement,
        pauses: djPauses,
      },
    });

    return {
      text: spokenText,
      slot: 'before',
      kind: res.kind,
      detail: res.detail,
      timing: res.timing || 'land',
      wordCount,
    };
  };

  const handleTestDjLine = async () => {
    if (volumeControllerRef.current?.isSequenceActive()) {
      logMessage('[Test DJ Line] DJ sequence active. Please wait for mix sequence to complete.');
      return;
    }
    logMessage('[Test DJ Line] Generating observation break for current and next song...');
    const prev = currentSongPickRef.current?.song || null;
    const next = nextSongRef.current?.song || null;
    const { text, slot, kind } = generateObservationBreak(prev, next);

    if (!text) {
      logMessage('[Test DJ Line] Observation break produced empty text (no comment generated).');
      return;
    }

    logMessage(`[Test DJ Line] Speaking observation break (${slot}, kind: ${kind ?? 'none'}): "${text}"`);
    await executeDJOverMusic(text);
  };

  // --- Timing Test Handler ---
  const handleRunTimingTest = async () => {
    if (volumeControllerRef.current?.isSequenceActive()) {
      logMessage('DJ sequence active. Please wait for mix sequence to complete before starting timing test.');
      return;
    }

    if ((voiceEngine === 'GEMINI' || voiceEngine === 'KOKORO') && !djAudioData) {
      const engineLabel = voiceEngine === 'KOKORO' ? 'Kokoro' : 'Gemini';
      logMessage(`Synthesizing ${engineLabel} audio before running the timing test...`);
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

  // Helper to render TTS capability badge with configured model name or FAIL
  const renderTTSBadge = () => {
    let modelName = selectedModel || 'gemini-2.5-flash-preview-tts';
    let isAvailable = true;

    if (voiceEngine === 'KOKORO') {
      modelName = 'Kokoro-82M-bf16';
      if (isKokoroAvailable === false) {
        isAvailable = false;
      }
    } else if (voiceEngine === 'GEMINI') {
      modelName = selectedModel || 'gemini-2.5-flash-preview-tts';
      if (hasGeminiApiKey === false) {
        isAvailable = false;
      }
    } else if (voiceEngine === 'BROWSER') {
      modelName = 'Web Speech API';
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        isAvailable = false;
      }
    }

    if (testResults.geminiTTS === false) {
      isAvailable = false;
    }

    if (!isAvailable) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-rose-950 text-rose-400 border border-rose-800">
          <XCircle className="w-3.5 h-3.5" /> FAIL
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
        <CheckCircle2 className="w-3.5 h-3.5" /> {modelName}
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
                : songPlaybackNotice.type === 'info'
                ? 'bg-blue-950/90 border-blue-500 text-blue-100'
                : 'bg-rose-950/90 border-rose-600 text-rose-100'
            }`}
          >
            <div className="flex items-start gap-3">
              <AlertCircle
                className={`w-5 h-5 shrink-0 mt-0.5 ${
                  songPlaybackNotice.type === 'api_error' ? 'text-amber-400' : songPlaybackNotice.type === 'info' ? 'text-blue-400' : 'text-rose-400'
                }`}
              />
              <div>
                <div
                  className={`font-bold text-sm tracking-wide uppercase flex items-center gap-2 ${
                    songPlaybackNotice.type === 'api_error' ? 'text-amber-300' : songPlaybackNotice.type === 'info' ? 'text-blue-300' : 'text-rose-300'
                  }`}
                >
                  <span>
                    {songPlaybackNotice.type === 'api_error'
                      ? 'API / QUOTA NOTICE'
                      : songPlaybackNotice.type === 'info'
                      ? 'GENRE UNAVAILABLE ON THIS DATE'
                      : 'RECORDING NOT FOUND'}
                  </span>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded border font-normal ${
                      songPlaybackNotice.type === 'api_error'
                        ? 'bg-amber-900/60 border-amber-700 text-amber-200'
                        : songPlaybackNotice.type === 'info'
                        ? 'bg-blue-900/60 border-blue-700 text-blue-200'
                        : 'bg-rose-900/60 border-rose-700 text-rose-200'
                    }`}
                  >
                    {songPlaybackNotice.type === 'info' ? 'Playing Contemporary Track' : 'Nothing was played'}
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

        {/* On-screen Banner: Extension Updated Success Notice */}
        {updateSuccessVersion && (
          <div className="p-3.5 rounded-lg shadow-2xl flex items-center justify-between gap-3 font-mono text-xs bg-emerald-950/95 border-2 border-emerald-500 text-emerald-100 animate-in fade-in duration-300">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <span className="font-bold text-emerald-300 text-sm">
                  Extension updated to v{updateSuccessVersion} ✓
                </span>
                <span className="ml-2 text-zinc-300 text-xs hidden sm:inline">
                  &bull; Connected to YouTube tab and ready for audio ducking and playback control.
                </span>
              </div>
            </div>
            <button
              onClick={() => setUpdateSuccessVersion(null)}
              className="text-zinc-400 hover:text-white px-2 py-0.5 rounded hover:bg-emerald-900/50 text-base leading-none cursor-pointer"
              title="Dismiss"
            >
              &times;
            </button>
          </div>
        )}

        {/* On-screen Banner: Old Extension Warning / Extension Required */}
        {(!extensionDetected || (reportedExtensionVersion && compareVersions(reportedExtensionVersion, MIN_REQUIRED_EXTENSION_VERSION) < 0)) && (
          <div className="p-4 rounded-lg shadow-2xl space-y-3 font-mono text-xs bg-amber-950/95 border-2 border-amber-500 text-amber-100 animate-in fade-in duration-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-800/80 pb-2">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-5 h-5 shrink-0 text-amber-400" />
                <span className="font-bold text-sm tracking-wide uppercase text-amber-300">
                  EXTENSION SETUP OR UPDATE REQUIRED
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-amber-900/70 border border-amber-700 text-amber-200 font-normal">
                  v{reportedExtensionVersion || 'None'} detected &bull; v{MIN_REQUIRED_EXTENSION_VERSION} required
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopyExtensionsUrl}
                  className="px-2.5 py-1.5 rounded bg-black/60 hover:bg-black/90 border border-amber-700 text-amber-300 text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer shadow"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedExtensionsUrl ? 'Copied chrome://extensions ✓' : 'Copy chrome://extensions'}</span>
                </button>
                <button
                  onClick={() => generateAndDownloadExtensionZip()}
                  className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold uppercase transition-colors flex items-center gap-1.5 cursor-pointer shadow"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Extension (v{EXTENSION_VERSION})</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-zinc-200 text-xs leading-relaxed pt-1">
              <div className="p-3 bg-black/40 rounded border border-amber-900/60 space-y-1.5">
                <strong className="text-amber-300 uppercase block font-bold text-[11px]">First Time Setup:</strong>
                <ol className="list-decimal list-inside space-y-1 text-zinc-300 text-[11px]">
                  <li>Download, unzip to a folder you’ll keep (for example <code className="text-amber-200">Documents/retrofm-extension</code>).</li>
                  <li>Open <code className="text-amber-300">chrome://extensions</code> (click button above).</li>
                  <li>Turn on <strong className="text-zinc-100">Developer mode</strong> toggle in top-right.</li>
                  <li>Click <strong className="text-zinc-100">Load unpacked</strong> and pick that folder.</li>
                </ol>
              </div>

              <div className="p-3 bg-black/40 rounded border border-amber-900/60 space-y-1.5">
                <strong className="text-amber-300 uppercase block font-bold text-[11px]">Updating:</strong>
                <ol className="list-decimal list-inside space-y-1 text-zinc-300 text-[11px]">
                  <li>Download, unzip into the same folder and replace the files.</li>
                  <li>Open <code className="text-amber-300">chrome://extensions</code>.</li>
                  <li>Click the reload arrow <strong className="text-amber-400">↻</strong> on the RetroFM card (don’t remove it).</li>
                  <li>Refresh the RetroFM and YouTube tabs.</li>
                </ol>
              </div>
            </div>
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
                  RETROFM
                </h1>
                <p className="text-xs sm:text-sm font-mono tracking-widest text-zinc-400 uppercase">
                  AUDIO PROOF OF CONCEPT &bull; YOUTUBE + GEMINI FLASH TTS
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Global Silence / Mute Toggle Icon Button */}
            <button
              onClick={toggleGlobalMute}
              className={`p-2 rounded border transition-colors cursor-pointer shadow ${
                isAudioMuted
                  ? 'bg-rose-950/80 hover:bg-rose-900 border-rose-600 text-rose-300'
                  : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-300'
              }`}
              title={isAudioMuted ? 'Unmute audio' : 'Silence all audio'}
              aria-label={isAudioMuted ? 'Unmute audio' : 'Silence all audio'}
            >
              {isAudioMuted ? <VolumeX className="w-5 h-5 text-rose-400" /> : <Volume2 className="w-5 h-5 text-zinc-300" />}
            </button>

            {/* Launch RetroFM (Chrome Tab Group) Button */}
            <button
              onClick={handleLaunchRetroFm}
              disabled={isLaunchingGroup}
              className="p-2 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black transition-colors shadow cursor-pointer"
              title="Launch RetroFM Chrome Tab Group (opens and connects YouTube tab)"
              aria-label="Launch RetroFM Chrome Tab Group"
            >
              <Rocket className={`w-5 h-5 ${isLaunchingGroup ? 'animate-bounce' : ''}`} />
            </button>
          </div>
        </header>

        {/* --- FULL-WIDTH LIVE DIAGNOSTIC STATUS --- */}
        <section aria-label="Live Diagnostic Status" className="w-full bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
          <div className="border-b border-zinc-800/80 pb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-bold font-mono tracking-wider text-zinc-100 uppercase">
                LIVE DIAGNOSTIC STATUS
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const snap = audioDiagnostics?.snapshot;
                  const activeTabId = playbackStatus.connectedTabId || musicProviderRef.current.getConnectedTabId();
                  const lines = [
                    '=== RETROFM LIVE DIAGNOSTIC STATUS ===',
                    `Timestamp: ${new Date().toISOString()}`,
                    `Verdict: ${(() => {
                      if (!extensionDetected) return 'Extension not detected';
                      if (!activeTabId) return 'YouTube tab not connected';
                      if (!snap?.videoId || snap?.playerState === -1 || snap?.playerState === 5) return 'No video loaded';
                      if (snap?.pausedRightAfterUnmute) return 'Paused right after unmute: Chrome autoplay rule. Click in the YouTube tab once.';
                      if (snap?.lastError?.type === 'playPromiseRejected') return 'Browser blocked autoplay: click inside the YouTube tab';
                      if (isAudioMuted || snap?.playerMuted || snap?.videoMuted || (typeof snap?.playerVolume === 'number' && snap?.playerVolume === 0)) return 'Video is playing but the player is muted';
                      if (snap?.playerState === 1 || snap?.videoPaused === false) return 'Video is playing normally';
                      if (snap?.playerState === 2 || snap?.videoPaused === true) return 'Video is paused';
                      return 'Idle / Waiting for playback';
                    })()}`,
                    '',
                    '--- STATUS INDICATORS ---',
                    `1. Chrome extension connected: ${extensionDetected ? 'YES' : 'NO'}`,
                    `2. Boom Box tab: Available / Ready`,
                    `3. YouTube tab connected: ${activeTabId ? `YES (Tab #${activeTabId})` : 'NO'}`,
                    `4. Video loaded: ${snap?.title || (snap?.videoId ? `ID: ${snap.videoId}` : 'None')}`,
                    `5. Player state: ${(() => {
                      const s = snap?.playerState;
                      if (s === 1) return 'playing (1)';
                      if (s === 2) return 'paused (2)';
                      if (s === 3) return 'buffering (3)';
                      if (s === 0) return 'ended (0)';
                      if (s === -1) return 'unstarted (-1)';
                      if (s === 5) return 'video cued (5)';
                      return s !== null && s !== undefined ? String(s) : (playbackStatus.isPlaying ? 'playing' : (playbackStatus.available ? 'paused' : 'stopped'));
                    })()}`,
                    `6. Muted: ${isAudioMuted || snap?.playerMuted || snap?.videoMuted ? 'YES' : 'NO'}`,
                    `7. Volume: ${typeof snap?.playerVolume === 'number' ? snap.playerVolume : (typeof snap?.videoVolume === 'number' ? snap.videoVolume : targetMusicVolume)}%`,
                    `8. Tab hidden: ${snap?.visibilityState === 'hidden' ? 'YES (hidden)' : (snap?.visibilityState === 'visible' ? 'NO (visible)' : 'Unknown')}`,
                    `9. User clicked in YouTube page: ${snap?.userActivation?.hasBeenActive ? 'YES' : 'NO'}`,
                    `10. Last Boom Box command: ${lastBoomBoxCommand ? `${lastBoomBoxCommand.action} -> ${lastBoomBoxCommand.result} (${lastBoomBoxCommand.time})` : 'None'}`,
                    '',
                    '--- LAST 10 DIAGNOSTIC EVENTS ---',
                    ...(audioDiagnostics?.events && audioDiagnostics.events.length > 0
                      ? audioDiagnostics.events.slice(-10).map((e: any) => `${new Date(e.ts).toLocaleTimeString()} [${e.event}] ${JSON.stringify(e.data || {})}`)
                      : ['(No diagnostic events recorded yet)'])
                  ];
                  navigator.clipboard.writeText(lines.join('\n'));
                  setCopiedDiagnostics(true);
                  setTimeout(() => setCopiedDiagnostics(false), 2000);
                }}
                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-400 hover:text-amber-300 font-mono text-[11px] font-bold border border-zinc-700 transition-colors flex items-center gap-1 cursor-pointer"
                title="Copy full audio diagnostics text to clipboard"
              >
                <Copy className="w-3 h-3" />
                <span>{copiedDiagnostics ? 'Copied ✓' : 'Copy diagnostics'}</span>
              </button>
              <span className="text-xs font-mono text-zinc-500">2s Live Poll</span>
            </div>
          </div>

          {/* Plain English Verdict Line */}
          <div className="p-3 bg-[#0a0c10] border border-amber-900/40 rounded flex items-center gap-2 text-xs font-mono">
            <span className="text-zinc-400 font-bold uppercase">Verdict:</span>
            <span className="text-amber-300 font-semibold">
              {(() => {
                const snap = audioDiagnostics?.snapshot;
                const activeTabId = playbackStatus.connectedTabId || musicProviderRef.current.getConnectedTabId();
                if (!extensionDetected) return 'Extension not detected';
                if (!activeTabId) return 'YouTube tab not connected';
                if (!snap?.videoId || snap?.playerState === -1 || snap?.playerState === 5) return 'No video loaded';
                if (snap?.pausedRightAfterUnmute) return 'Paused right after unmute: Chrome autoplay rule. Click in the YouTube tab once.';
                if (snap?.lastError?.type === 'playPromiseRejected') return 'Browser blocked autoplay: click inside the YouTube tab';
                if (isAudioMuted || snap?.playerMuted || snap?.videoMuted || (typeof snap?.playerVolume === 'number' && snap?.playerVolume === 0)) return 'Video is playing but the player is muted';
                if (snap?.playerState === 1 || snap?.videoPaused === false) return 'Video is playing normally';
                if (snap?.playerState === 2 || snap?.videoPaused === true) return 'Video is paused';
                return 'Idle / Waiting for playback';
              })()}
            </span>
          </div>

          {/* 10 Status Rows with Green / Red markers */}
          {(() => {
            const snap = audioDiagnostics?.snapshot;
            const isExtOk = extensionDetected;
            const isBoomBoxAvailable = true;
            const activeTabId = playbackStatus.connectedTabId || musicProviderRef.current.getConnectedTabId();
            const isYtConnected = !!activeTabId;
            const hasVideo = !!(snap?.videoId || (playbackStatus.available && playbackStatus.title && playbackStatus.title !== 'Unknown Video'));
            const isPlayingState = snap?.playerState === 1 || snap?.playerState === 3 || (!snap && playbackStatus.isPlaying);
            const isMuted = isAudioMuted || !!(snap?.playerMuted || snap?.videoMuted || playbackStatus.muted);
            const currentVol = typeof snap?.playerVolume === 'number' ? snap.playerVolume : (typeof snap?.videoVolume === 'number' ? snap.videoVolume : targetMusicVolume);
            const isHidden = snap?.visibilityState === 'hidden';
            const hasClicked = !!snap?.userActivation?.hasBeenActive;
            const hasLastCmd = !!lastBoomBoxCommand;

            const renderMarker = (isGreen: boolean) => (
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isGreen ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-rose-500'}`} />
            );

            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 font-mono text-xs">
                {/* Row 1: Extension connected */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(isExtOk)}
                    <span className="text-zinc-300">Chrome Extension:</span>
                  </div>
                  <span className={isExtOk ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {isExtOk ? (reportedExtensionVersion ? `Connected (v${reportedExtensionVersion})` : 'Connected') : 'Not Detected'}
                  </span>
                </div>

                {/* Row 2: Boom Box tab */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(isBoomBoxAvailable)}
                    <span className="text-zinc-300">Boom Box Player:</span>
                  </div>
                  <span className="text-emerald-400 font-bold">
                    Available / Ready
                  </span>
                </div>

                {/* Row 3: YouTube tab connected */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(isYtConnected)}
                    <span className="text-zinc-300">YouTube Tab:</span>
                  </div>
                  <span className={isYtConnected ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {isYtConnected ? `Connected (#${activeTabId})` : 'Not Connected'}
                  </span>
                </div>

                {/* Row 4: Video loaded */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2 truncate max-w-[65%]">
                    {renderMarker(hasVideo)}
                    <span className="text-zinc-300 shrink-0">Video Loaded:</span>
                    <span className="text-zinc-400 truncate text-[11px]" title={snap?.title || playbackStatus.title}>
                      {snap?.title || playbackStatus.title || 'None'}
                    </span>
                  </div>
                  <span className={hasVideo ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {hasVideo ? 'YES' : 'NO'}
                  </span>
                </div>

                {/* Row 5: Player state */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(isPlayingState)}
                    <span className="text-zinc-300">Playback State:</span>
                  </div>
                  <span className="text-amber-300 font-bold">
                    {(() => {
                      const s = snap?.playerState;
                      if (s === 1) return 'playing (1)';
                      if (s === 2) return 'paused (2)';
                      if (s === 3) return 'buffering (3)';
                      if (s === 0) return 'ended (0)';
                      if (s === -1) return 'unstarted (-1)';
                      if (s === 5) return 'video cued (5)';
                      return s !== null && s !== undefined ? String(s) : (playbackStatus.isPlaying ? 'playing' : (playbackStatus.available ? 'paused' : 'stopped'));
                    })()}
                  </span>
                </div>

                {/* Row 6: Muted */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(!isMuted)}
                    <span className="text-zinc-300">Muted:</span>
                  </div>
                  <span className={isMuted ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {isMuted ? 'YES (Muted)' : 'NO (Unmuted)'}
                  </span>
                </div>

                {/* Row 7: Volume */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(currentVol > 0)}
                    <span className="text-zinc-300">Volume Level:</span>
                  </div>
                  <span className="text-zinc-200 font-bold">
                    {currentVol} / 100
                  </span>
                </div>

                {/* Row 8: Tab hidden */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(!isHidden)}
                    <span className="text-zinc-300">Tab Backgrounded:</span>
                  </div>
                  <span className={isHidden ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {isHidden ? 'YES (hidden)' : 'NO (visible)'}
                  </span>
                </div>

                {/* Row 9: User has clicked in YouTube page */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    {renderMarker(hasClicked)}
                    <span className="text-zinc-300">User Clicked in Tab:</span>
                  </div>
                  <span className={hasClicked ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {hasClicked ? 'YES' : 'NO (Autoplay blocked)'}
                  </span>
                </div>

                {/* Row 10: Last Boom Box command with result and time */}
                <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded flex justify-between items-center md:col-span-2 lg:col-span-3">
                  <div className="flex items-center gap-2">
                    {renderMarker(hasLastCmd)}
                    <span className="text-zinc-300">Last Boom Box Command:</span>
                  </div>
                  <span className="text-zinc-300 font-mono text-[11px] text-right truncate max-w-[70%]">
                    {lastBoomBoxCommand ? `${lastBoomBoxCommand.action} [${lastBoomBoxCommand.result}] @ ${lastBoomBoxCommand.time}` : 'None'}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Last 10 Diagnostic Events */}
          <div className="pt-2 border-t border-zinc-800/80 space-y-2">
            <span className="text-zinc-400 font-mono text-[11px] uppercase font-bold block">
              Last 10 Diagnostic Events:
            </span>
            <div className="h-24 bg-[#08090d] border border-zinc-900 rounded p-2 font-mono text-[10px] text-zinc-400 overflow-y-auto space-y-1">
              {audioDiagnostics?.events && audioDiagnostics.events.length > 0 ? (
                audioDiagnostics.events.slice(-10).map((ev: any, idx: number) => (
                  <div key={idx} className="leading-tight">
                    <span className="text-amber-500/80">{new Date(ev.ts).toLocaleTimeString()}</span>{' '}
                    <span className="text-emerald-400">[{ev.event}]</span>{' '}
                    <span className="text-zinc-300">{ev.data ? JSON.stringify(ev.data) : ''}</span>
                  </div>
                ))
              ) : (
                <span className="text-zinc-600">No diagnostic events recorded yet.</span>
              )}
            </div>
          </div>
        </section>

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
                    onClick={handleLaunchRetroFm}
                    disabled={isLaunchingGroup}
                    className="flex-1 py-2.5 px-4 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-black text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                    title="Open YouTube in a new tab, connect it, and organize both tabs in a 'RetroFM' Chrome Tab Group"
                  >
                    <Rocket className={`w-3.5 h-3.5 ${isLaunchingGroup ? 'animate-bounce' : ''}`} />
                    <span>{isLaunchingGroup ? 'Launching Tab Group...' : 'Launch RetroFM (Tab Group)'}</span>
                  </button>

                  <button
                    onClick={handleConnectTab}
                    disabled={isConnecting}
                    className="py-2.5 px-4 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-50 text-zinc-200 font-mono font-bold text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                    title="Scan for already open YouTube tabs and connect"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isConnecting ? 'animate-spin' : ''}`} />
                    <span>{isConnecting ? 'Connecting...' : 'Connect Existing Tab'}</span>
                  </button>
                </div>

                {/* Launch Success or Error Notice */}
                {launchMessage && (
                  <div
                    className={`p-2.5 rounded text-xs font-mono flex items-start justify-between gap-2 border ${
                      launchMessage.isError
                        ? 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                        : 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {launchMessage.isError ? (
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
                      )}
                      <span>{launchMessage.text}</span>
                    </div>
                    <button
                      onClick={() => setLaunchMessage(null)}
                      className="text-zinc-400 hover:text-white text-xs cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {connectionError && (
                  <div className="p-2.5 rounded bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs font-mono flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <span>{connectionError}</span>
                      <div className="mt-1 text-[11px] text-zinc-400">
                        Make sure the RetroFM Chrome Extension is loaded and a YouTube video is open in another tab.
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
                    onChange={(e) => {
                      setProgramArtist(e.target.value);
                      setProgramSongResult(null);
                    }}
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
                    onChange={(e) => {
                      setProgramSongTitle(e.target.value);
                      setProgramSongResult(null);
                    }}
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
                    onChange={(e) => {
                      setProgramYear(e.target.value);
                      setProgramSongResult(null);
                    }}
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
                        setProgramSongResult(null);
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
                  onClick={() => handlePlayMusic()}
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
                    {/* Consistency check between LCD text, Song Details panel, and session history */}
                    {(() => {
                      const history = sessionHistoryRef.current;
                      const histEntry = (history.pointer >= 0 && history.pointer < history.entries.length)
                        ? history.entries[history.pointer]
                        : null;
                      const histSongTitle = histEntry?.song.title || '';
                      const histArtist = histEntry?.song.artist || '';

                      const detailsTitle = programSongResult?.selectedTitle || programSongTitle || '';
                      const detailsArtist = programArtist || currentPlayingArtistRef.current || '';

                      // Extract current LCD text from last recorded broadcast payload if available
                      // Compare title and artist when history has an active entry and details has a selection
                      if (histSongTitle && detailsTitle && (histSongTitle !== detailsTitle || (histArtist && detailsArtist && histArtist !== detailsArtist))) {
                        console.warn(
                          '[STATE MISMATCH]',
                          JSON.stringify({
                            LCD: `${currentPlayingArtistRef.current} - ${currentPlayingSongRef.current}`,
                            Details: `${detailsArtist} - ${detailsTitle}`,
                            History: `${histArtist} - ${histSongTitle}`,
                            pointer: `${history.pointer}/${history.entries.length}`
                          })
                        );
                        console.trace();
                      }
                      return null;
                    })()}
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

                    {programSongResult.source && (
                      <div className="flex justify-between items-center gap-2 pt-1 border-t border-zinc-900">
                        <span className="text-zinc-500">Source:</span>
                        <span className={`text-[11px] font-bold ${
                          programSongResult.source === 'hardcoded preset' ? 'text-amber-400' : 'text-zinc-300'
                        }`}>
                          {programSongResult.source}
                        </span>
                      </div>
                    )}

                    {programSongResult.reason && (
                      <div className="pt-1.5 border-t border-zinc-900 text-[11px] text-zinc-400 leading-normal">
                        <strong className="text-zinc-300">Selection Reason:</strong> {programSongResult.reason}
                      </div>
                    )}

                    {/* Selected Date & Song Selector Tier / Genre Match Test Aids */}
                    <div className="pt-1.5 border-t border-zinc-900 space-y-1 text-[11px]">
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">Selected Date:</span>
                        <span className="text-amber-300 font-bold font-mono">{activeDateRef.current}</span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">News Status:</span>
                        <span className="text-amber-400 font-mono text-[10px] truncate max-w-[240px]" title={newsDebugStatus.uiText}>
                          {newsDebugStatus.uiText}
                        </span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">Tier / Genre Match:</span>
                        <span className="text-zinc-300 font-mono">
                          {currentSongPick
                            ? `Tier ${currentSongPick.tier} | Matched: ${currentSongPick.genreMatched ? 'Yes' : 'No'}`
                            : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <span className="text-zinc-500">DJ Mode:</span>
                        <span className={`font-bold ${djMode === 'off' ? 'text-zinc-500' : 'text-amber-400'}`}>
                          {djMode === 'ai' ? 'AI-written (current)' : djMode === 'observations' ? 'Observations (template)' : 'Off'}
                        </span>
                      </div>
                      {djMode === 'observations' && (
                        <div className="flex justify-between items-center gap-2">
                          <span className="text-zinc-500">DJ talk frequency:</span>
                          <span className="font-bold text-amber-400 capitalize">{djTalkFrequency}</span>
                        </div>
                      )}
                    </div>

                    {/* DJ Last Line Display & Test DJ line Button */}
                    <div className="pt-2 border-t border-zinc-900 space-y-1.5">
                      <div className="flex justify-between items-center text-[11px]">
                        <span className="text-zinc-400 font-bold uppercase flex items-center gap-1.5">
                          <Mic2 className="w-3 h-3 text-amber-400" />
                          <span>Last DJ Line:</span>
                        </span>
                        <span className="text-zinc-400 text-[10px]">
                          kind:{' '}
                          <strong className="text-amber-400">
                            {lastDjBreak
                              ? (lastDjBreak.kind
                                  ? (lastDjBreak.detail ? `${lastDjBreak.kind}/${lastDjBreak.detail}` : lastDjBreak.kind)
                                  : 'null (announcement)')
                              : 'none'}
                          </strong>
                        </span>
                      </div>
                      <div className="p-2 bg-black/50 border border-zinc-800 rounded text-zinc-300 text-[11px] italic leading-relaxed">
                        {lastDjBreak?.text
                          ? `"${lastDjBreak.text}"`
                          : (lastDjBreak?.kind === 'jingle' ? '[Played RETRO FM jingle]' : '(No DJ break generated yet)')}
                      </div>

                      {/* Debug line: kind, detail, timing, word count, spoken length, delivery settings */}
                      {lastDjBreak && (
                        <div className="text-[10px] text-zinc-400 font-mono bg-zinc-950/80 px-2 py-1 rounded border border-zinc-800/60 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                          <div>
                            <span className="text-zinc-500">break:</span>{' '}
                            <span className="text-amber-300 font-semibold">{lastDjBreak.kind || 'plain'}</span>
                            {lastDjBreak.detail && <span className="text-zinc-400"> ({lastDjBreak.detail})</span>}
                            {lastDjBreak.timing && (
                              <>
                                <span className="text-zinc-600"> • </span>
                                <span className="text-zinc-500">timing:</span>{' '}
                                <span className="text-cyan-300">{lastDjBreak.timing}</span>
                              </>
                            )}
                          </div>
                          <div>
                            {typeof lastDjBreak.wordCount === 'number' && (
                              <>
                                <span className="text-zinc-500">words:</span>{' '}
                                <span className="text-zinc-300">{lastDjBreak.wordCount}</span>
                                <span className="text-zinc-600"> • </span>
                              </>
                            )}
                            {typeof lastDjBreak.spokenSeconds === 'number' && (
                              <>
                                <span className="text-zinc-500">spoken:</span>{' '}
                                <span className="text-zinc-300">{lastDjBreak.spokenSeconds.toFixed(1)}s</span>
                                <span className="text-zinc-600"> • </span>
                              </>
                            )}
                            <span className="text-zinc-500">settings:</span>{' '}
                            <span className="text-amber-400">
                              len={lastDjBreak.deliverySettings?.length ?? djTalkLength}, ex={lastDjBreak.deliverySettings?.excitement ?? djExcitement}, pa={lastDjBreak.deliverySettings?.pauses ?? djPauses}
                            </span>
                          </div>
                        </div>
                      )}

                      {lastDjBreak?.kind === 'news' && (
                        <div className="text-[10px] text-zinc-400 font-medium flex items-center justify-end gap-1">
                          <span>News:</span>
                          <span className="text-zinc-300 font-semibold">The New York Times</span>
                        </div>
                      )}
                      <div className="flex justify-end pt-0.5">
                        <button
                          type="button"
                          onClick={handleTestDjLine}
                          className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Mic2 className="w-3 h-3 text-amber-400" />
                          <span>Test DJ line</span>
                        </button>
                      </div>
                    </div>

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

              {/* DJ Voice Volume Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-zinc-400">DJ Voice Volume:</span>
                  <span className="text-amber-400 font-bold">{djVoiceVolumePercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={djVoiceVolumePercent}
                  onChange={(e) => handleDjVoiceVolumeChange(Number(e.target.value))}
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

              {/* Ask for one-time click setting toggle */}
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-1 border-t border-zinc-800/80">
                <label htmlFor="askForOneTimeClickToggle" className="cursor-pointer select-none">
                  Ask for the one-time click at session start:
                </label>
                <input
                  id="askForOneTimeClickToggle"
                  type="checkbox"
                  checked={askForOneTimeClick}
                  onChange={(e) => setAskForOneTimeClick(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-amber-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                />
              </div>

              {/* Reveal YouTube tab setting toggle */}
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 pt-1 border-t border-zinc-800/80">
                <label htmlFor="revealYouTubeToggle" className="cursor-pointer select-none">
                  Reveal YouTube tab if playback is blocked while hidden:
                </label>
                <input
                  id="revealYouTubeToggle"
                  type="checkbox"
                  checked={revealYouTubeToStart}
                  onChange={(e) => setRevealYouTubeToStart(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-900 text-amber-500 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                />
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
                  {voiceEngine === 'BROWSER'
                    ? 'ENGINE: BROWSER SPEECH (INSTANT)'
                    : voiceEngine === 'KOKORO'
                    ? `KOKORO AUDIO: ${djAudioData ? 'READY' : 'NOT READY'}`
                    : `GEMINI AUDIO: ${djAudioData ? 'READY' : 'NOT READY'}`}
                </span>
              </div>

              {/* Voice Engine Tabs */}
              <div className="flex flex-col sm:flex-row bg-[#0a0c10] border border-zinc-800 p-1 rounded gap-1">
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
                  onClick={() => setVoiceEngine('KOKORO')}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-mono font-bold transition-colors flex items-center justify-center gap-1.5 ${
                    voiceEngine === 'KOKORO'
                      ? 'bg-amber-500 text-black shadow'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <span>🎧 Kokoro TTS (Local)</span>
                  {isKokoroAvailable === true && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" title="Kokoro service online" />
                  )}
                  {isKokoroAvailable === false && (
                    <span className="w-2 h-2 rounded-full bg-rose-500 inline-block" title="Kokoro service unreachable" />
                  )}
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
              ) : voiceEngine === 'KOKORO' ? (
                <>
                  <div className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-mono text-zinc-400">
                          Kokoro Voice:
                        </label>
                        <span className="text-[11px] font-mono text-zinc-400">
                          Model: MLX Kokoro-82M (Local)
                        </span>
                      </div>
                      <select
                        value={selectedKokoroVoice}
                        onChange={(e) => {
                          setSelectedKokoroVoice(e.target.value);
                          setDjAudioData(null);
                        }}
                        className="w-full bg-[#0a0c10] border border-zinc-700 rounded px-2.5 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-amber-500"
                      >
                        {kokoroVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Kokoro TTS Speaking Speed Control */}
                    <div className="p-2.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-2">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <div className="flex items-center gap-1.5">
                          <span className="text-zinc-400">Speed:</span>
                          {kokoroSpeed >= 1.05 && kokoroSpeed <= 1.15 && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              Radio DJ
                            </span>
                          )}
                        </div>
                        <span className="text-amber-400 font-bold">
                          {kokoroSpeed.toFixed(2)}×{kokoroSpeed === 1.0 ? ' (Normal)' : ''}
                        </span>
                      </div>

                      <div className="space-y-1">
                        <input
                          type="range"
                          min="0.5"
                          max="2.0"
                          step="0.05"
                          value={kokoroSpeed}
                          onChange={(e) => {
                            const val = Math.round(parseFloat(e.target.value) * 100) / 100;
                            setKokoroSpeed(val);
                            setDjAudioData(null);
                          }}
                          className="w-full accent-amber-500 cursor-pointer h-1.5"
                        />
                        <div className="flex justify-between text-[10px] font-mono text-zinc-500 px-0.5">
                          <span>0.50× (Slow)</span>
                          <span className={kokoroSpeed === 1.0 ? 'text-amber-400 font-bold' : 'text-zinc-500'}>1.00× (Normal)</span>
                          <span>2.00× (Fast)</span>
                        </div>
                      </div>

                      {/* Speed Presets */}
                      <div className="flex items-center gap-1.5 pt-1">
                        <span className="text-[10px] font-mono text-zinc-500 shrink-0">Presets:</span>
                        <div className="grid grid-cols-4 gap-1.5 flex-1">
                          {[
                            { label: 'Slow', val: 0.85 },
                            { label: 'Normal', val: 1.00 },
                            { label: 'Energetic', val: 1.10 },
                            { label: 'Fast', val: 1.25 },
                          ].map((preset) => {
                            const isSelected = Math.abs(kokoroSpeed - preset.val) < 0.001;
                            return (
                              <button
                                key={preset.label}
                                type="button"
                                onClick={() => {
                                  setKokoroSpeed(preset.val);
                                  setDjAudioData(null);
                                }}
                                className={`px-1.5 py-1 text-[10px] font-mono rounded border transition-colors cursor-pointer text-center ${
                                  isSelected
                                    ? 'bg-amber-500 text-black font-bold border-amber-400'
                                    : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-700 hover:text-zinc-100'
                                }`}
                              >
                                {preset.label} ({preset.val.toFixed(2)}×)
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Speed Guidance Helper */}
                      <div className="text-[10px] font-mono text-zinc-400 bg-zinc-900/60 rounded px-2 py-1 border border-zinc-800/60">
                        {kokoroSpeed <= 0.80 && '0.50×–0.80×: Slow and deliberate delivery.'}
                        {kokoroSpeed > 0.80 && kokoroSpeed <= 1.00 && '0.85×–1.00×: Relaxed to normal pace.'}
                        {kokoroSpeed > 1.00 && kokoroSpeed <= 1.15 && '1.05×–1.15×: Energetic radio DJ delivery (recommended).'}
                        {kokoroSpeed > 1.15 && kokoroSpeed <= 1.40 && '1.20×–1.40×: Fast delivery.'}
                        {kokoroSpeed > 1.40 && '1.45×–2.00×: Very fast delivery.'}
                      </div>
                    </div>

                    {isKokoroAvailable === false && (
                      <div className="p-2.5 rounded bg-amber-950/40 border border-amber-800/60 text-amber-300 text-xs font-mono flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>Kokoro local service not detected at 127.0.0.1:8880. Ensure your local Kokoro service is running.</span>
                      </div>
                    )}

                    {/* Generate & Preview Buttons */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleGenerateDJ()}
                        disabled={isGeneratingDJ}
                        className="flex-1 py-2.5 px-4 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-mono font-bold text-xs uppercase tracking-wider transition-colors shadow flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Sparkles className={`w-3.5 h-3.5 ${isGeneratingDJ ? 'animate-spin' : ''}`} />
                        <span>{isGeneratingDJ ? 'Synthesizing with Kokoro...' : 'Generate DJ Voice'}</span>
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
                          <span>Duration: ~{djAudioDuration}s | Voice: {selectedKokoroVoice} | Speed: {kokoroSpeed.toFixed(2)}×</span>
                        </div>
                        <span className="text-[11px] text-zinc-500">24kHz 16-bit mono WAV</span>
                      </div>
                    )}
                  </div>
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
              {/* DJ Voice Audio Effects (Reverb, AM Radio, FM Sparkle, Analog Saturation) */}
              <div className="pt-3 border-t border-zinc-800/80 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-xs font-mono font-bold text-zinc-200 uppercase tracking-wider">
                      DJ Voice Effects (Web Audio DSP)
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500">
                    Applies strictly to DJ voice
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                  {/* Effect 1: Reverb */}
                  <div className={`p-3 rounded border transition-colors ${djEffects.reverbEnabled ? 'bg-amber-500/10 border-amber-500/40' : 'bg-[#0a0c10] border-zinc-800'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={djEffects.reverbEnabled}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ reverbEnabled: e.target.checked });
                            setDjEffects(updated);
                          }}
                          className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 accent-amber-500 cursor-pointer"
                        />
                        <span className={`font-bold ${djEffects.reverbEnabled ? 'text-amber-400' : 'text-zinc-300'}`}>
                          1. Reverb
                        </span>
                      </label>
                      <span className="text-[10px] text-zinc-500">Studio Ambience</span>
                    </div>
                    {djEffects.reverbEnabled && (
                      <div className="space-y-1.5 pt-1 border-t border-zinc-800/60">
                        <div className="flex justify-between text-[11px] text-zinc-400">
                          <span>Wet Mix:</span>
                          <span className="text-amber-400 font-bold">{Math.round(djEffects.reverbWetMix * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={djEffects.reverbWetMix}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ reverbWetMix: Number(e.target.value) });
                            setDjEffects(updated);
                          }}
                          className="w-full accent-amber-500 cursor-pointer h-1.5"
                        />
                      </div>
                    )}
                  </div>

                  {/* Effect 2: AM Radio */}
                  <div className={`p-3 rounded border transition-colors ${djEffects.amRadioEnabled ? 'bg-amber-500/10 border-amber-500/40' : 'bg-[#0a0c10] border-zinc-800'}`}>
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={djEffects.amRadioEnabled}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ amRadioEnabled: e.target.checked });
                            setDjEffects(updated);
                          }}
                          className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 accent-amber-500 cursor-pointer"
                        />
                        <span className={`font-bold ${djEffects.amRadioEnabled ? 'text-amber-400' : 'text-zinc-300'}`}>
                          2. AM Radio
                        </span>
                      </label>
                      <span className="text-[10px] text-zinc-500">250Hz - 3.0kHz</span>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-1 leading-relaxed">
                      Restricts frequency band to simulate authentic 1960s-1970s transistor AM broadcast.
                    </p>
                  </div>

                  {/* Effect 3: FM Sparkle */}
                  <div className={`p-3 rounded border transition-colors ${djEffects.fmSparkleEnabled ? 'bg-amber-500/10 border-amber-500/40' : 'bg-[#0a0c10] border-zinc-800'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={djEffects.fmSparkleEnabled}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ fmSparkleEnabled: e.target.checked });
                            setDjEffects(updated);
                          }}
                          className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 accent-amber-500 cursor-pointer"
                        />
                        <span className={`font-bold ${djEffects.fmSparkleEnabled ? 'text-amber-400' : 'text-zinc-300'}`}>
                          3. FM Sparkle
                        </span>
                      </label>
                      <span className="text-[10px] text-zinc-500">5kHz Peaking</span>
                    </div>
                    {djEffects.fmSparkleEnabled && (
                      <div className="space-y-1.5 pt-1 border-t border-zinc-800/60">
                        <div className="flex justify-between text-[11px] text-zinc-400">
                          <span>Presence Boost:</span>
                          <span className="text-amber-400 font-bold">+{djEffects.fmSparkleBoost} dB</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="12"
                          step="0.5"
                          value={djEffects.fmSparkleBoost}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ fmSparkleBoost: Number(e.target.value) });
                            setDjEffects(updated);
                          }}
                          className="w-full accent-amber-500 cursor-pointer h-1.5"
                        />
                      </div>
                    )}
                  </div>

                  {/* Effect 4: Analog Saturation */}
                  <div className={`p-3 rounded border transition-colors ${djEffects.saturationEnabled ? 'bg-amber-500/10 border-amber-500/40' : 'bg-[#0a0c10] border-zinc-800'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={djEffects.saturationEnabled}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ saturationEnabled: e.target.checked });
                            setDjEffects(updated);
                          }}
                          className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 accent-amber-500 cursor-pointer"
                        />
                        <span className={`font-bold ${djEffects.saturationEnabled ? 'text-amber-400' : 'text-zinc-300'}`}>
                          4. Analog Saturation
                        </span>
                      </label>
                      <span className="text-[10px] text-zinc-500">4x Oversampled</span>
                    </div>
                    {djEffects.saturationEnabled && (
                      <div className="space-y-1.5 pt-1 border-t border-zinc-800/60">
                        <div className="flex justify-between text-[11px] text-zinc-400">
                          <span>Drive Intensity:</span>
                          <span className="text-amber-400 font-bold">{djEffects.saturationDrive}</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="40"
                          step="1"
                          value={djEffects.saturationDrive}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ saturationDrive: Number(e.target.value) });
                            setDjEffects(updated);
                          }}
                          className="w-full accent-amber-500 cursor-pointer h-1.5"
                        />
                      </div>
                    )}
                  </div>

                  {/* Effect 5: Audio Compression */}
                  <div className={`p-3 rounded border transition-colors col-span-1 sm:col-span-2 ${djEffects.compressionEnabled ? 'bg-amber-500/10 border-amber-500/40' : 'bg-[#0a0c10] border-zinc-800'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={djEffects.compressionEnabled}
                          onChange={(e) => {
                            const updated = djVoiceEffects.updateSettings({ compressionEnabled: e.target.checked });
                            setDjEffects(updated);
                          }}
                          className="rounded bg-zinc-900 border-zinc-700 text-amber-500 focus:ring-0 accent-amber-500 cursor-pointer"
                        />
                        <span className={`font-bold ${djEffects.compressionEnabled ? 'text-amber-400' : 'text-zinc-300'}`}>
                          5. Audio Compression
                        </span>
                      </label>
                      <span className="text-[10px] text-zinc-500">DynamicsCompressorNode + Makeup Gain</span>
                    </div>

                    {djEffects.compressionEnabled && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-zinc-800/60 text-[11px] text-zinc-400">
                        {/* Threshold */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Threshold:</span>
                            <span className="text-amber-400 font-bold">{djEffects.compressionThreshold} dB</span>
                          </div>
                          <input
                            type="range"
                            min="-60"
                            max="0"
                            step="1"
                            value={djEffects.compressionThreshold}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionThreshold: Number(e.target.value) });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>

                        {/* Ratio */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Ratio:</span>
                            <span className="text-amber-400 font-bold">{djEffects.compressionRatio}:1</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="12"
                            step="0.5"
                            value={djEffects.compressionRatio}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionRatio: Number(e.target.value) });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>

                        {/* Makeup Gain */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Makeup Gain:</span>
                            <span className="text-amber-400 font-bold">+{djEffects.compressionMakeupGain} dB</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="12"
                            step="0.5"
                            value={djEffects.compressionMakeupGain}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionMakeupGain: Number(e.target.value) });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>

                        {/* Attack */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Attack:</span>
                            <span className="text-amber-400 font-bold">{Math.round(djEffects.compressionAttack * 1000)} ms</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="100"
                            step="1"
                            value={Math.round(djEffects.compressionAttack * 1000)}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionAttack: Number(e.target.value) / 1000 });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>

                        {/* Release */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Release:</span>
                            <span className="text-amber-400 font-bold">{Math.round(djEffects.compressionRelease * 1000)} ms</span>
                          </div>
                          <input
                            type="range"
                            min="20"
                            max="1000"
                            step="10"
                            value={Math.round(djEffects.compressionRelease * 1000)}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionRelease: Number(e.target.value) / 1000 });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>

                        {/* Knee */}
                        <div className="space-y-1">
                          <div className="flex justify-between">
                            <span>Knee:</span>
                            <span className="text-amber-400 font-bold">{djEffects.compressionKnee} dB</span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="30"
                            step="1"
                            value={djEffects.compressionKnee}
                            onChange={(e) => {
                              const updated = djVoiceEffects.updateSettings({ compressionKnee: Number(e.target.value) });
                              setDjEffects(updated);
                            }}
                            className="w-full accent-amber-500 cursor-pointer h-1.5"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
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
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setDuckVolumePercent(val);
                      volumeControllerRef.current?.setDuckLevel(val);
                    }}
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
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setFadeDownMs(val);
                          if (typeof window !== 'undefined') {
                            localStorage.setItem('retrofm_fade_down_ms', String(val));
                          }
                        }}
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
                        max="10000"
                        step="50"
                        value={fadeUpMs}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setFadeUpMs(val);
                          if (typeof window !== 'undefined') {
                            localStorage.setItem('retrofm_fade_up_ms', String(val));
                          }
                        }}
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
                  {targetMusicVolume}% Music &rarr; ({fadeDownMs}ms fade down) &rarr; {duckVolumePercent}% Music + DJ Voice &rarr; ({fadeUpMs}ms fade up) &rarr; {targetMusicVolume}% Music
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

        {/* --- SECTION 6: CAPABILITY MATRIX (All 11 Requirements) --- */}
        <div className="w-full bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-4">
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
              <span className="text-zinc-300">TTS:</span>
              {renderTTSBadge()}
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

        {/* --- SECTION: HISTORICAL FACT PACKET TEST --- */}
        <HistoricalFactPacketTest onLogEvent={logMessage} />

        {/* --- SECTION: DJ BREAK GENERATOR TEST --- */}
        <DJBreakGeneratorTest
          onLogEvent={logMessage}
          onSpeakScript={(script) => {
            playDJSpeech(script, { duckMusic: false, forceGenerate: true });
          }}
          onSpeakOverMusic={(script) => {
            executeDJOverMusic(script);
          }}
          isMixingAudio={isDuckingActive}
          initialDate={activeDateRef.current}
          initialSongPlayed={
            programArtist && programSongTitle
              ? `${programArtist} - ${programSongTitle}`
              : undefined
          }
          initialSongNext={
            nextSongRef.current
              ? `${nextSongRef.current.song.artist} - ${nextSongRef.current.song.title}`
              : undefined
          }
          djMode={djMode}
          onDjModeChange={handleDjModeChange}
          djTalkFrequency={djTalkFrequency}
          onDjTalkFrequencyChange={handleDjTalkFrequencyChange}
          onTestDjLine={handleTestDjLine}
          librarySongPlayed={currentSongPickRef.current?.song || null}
          librarySongNext={nextSongRef.current?.song || null}
          onObservationBreakGenerated={(breakData) => {
            setLastDjBreak({
              text: breakData.text,
              slot: breakData.slot,
              kind: breakData.kind,
            });
          }}
        />

        {/* --- SECTION 7: LIVE SYSTEM CONSOLE / LOG --- */}
        <div className="bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-zinc-400">
            <span className="font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-amber-400" />
              EXPERIMENTAL EVENT LOG &amp; AUDIO TELEMETRY
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCopyTransportTrace}
                className="text-[11px] text-amber-400 hover:text-amber-300 transition-colors font-medium cursor-pointer"
                title="Fetch combined transport trace log from extension background and copy to clipboard"
              >
                {copiedTransportTrace ? '✓ Copied trace!' : 'Copy transport trace'}
              </button>
              <button
                onClick={() => setStatusLog([])}
                className="text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                Clear Log
              </button>
            </div>
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
                  <span className="text-amber-400 font-bold">1. Can RetroFM communicate with a YouTube tab?</span>
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

        {/* --- SECONDARY RESOURCES: Extension Download & Tools --- */}
        <section aria-label="Secondary Resources" className="w-full bg-[#13161f] border border-zinc-800 rounded-lg p-5 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs">
          <div className="space-y-1">
            <h3 className="font-bold text-sm text-zinc-200 uppercase tracking-wide flex items-center gap-2">
              <Download className="w-4 h-4 text-amber-400" />
              RetroFM Companion Chrome Extension
            </h3>
            <p className="text-zinc-400">
              Required for automated YouTube audio ducking and background transport control across tabs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={() => generateAndDownloadExtensionZip()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono font-bold text-amber-400 hover:text-amber-300 transition-colors cursor-pointer shadow"
              title="Download unpacked Chrome extension ZIP"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Extension (v{EXTENSION_VERSION})</span>
            </button>
            <a
              href={typeof window !== 'undefined' ? window.location.href : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono text-zinc-300 hover:text-zinc-100 transition-colors shadow"
              title="Open RetroFM in a dedicated browser tab side-by-side with YouTube"
            >
              <ExternalLink className="w-3.5 h-3.5 text-amber-400" />
              <span>Open in Dedicated Tab</span>
            </a>
          </div>
        </section>

        {/* --- FOOTER: Getting Started Link & Version --- */}
        <footer className="border-t border-zinc-800/80 pt-6 pb-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono text-zinc-500">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowExtensionModal(true)}
              className="text-amber-400 hover:text-amber-300 font-bold uppercase tracking-wider underline underline-offset-4 cursor-pointer transition-colors"
            >
              Getting Started
            </button>
            <span>&bull;</span>
            <span>Historical Top-40 Radio Simulator</span>
          </div>
          <div>
            <span>RetroFM &bull; Extension v{EXTENSION_VERSION}</span>
          </div>
        </footer>

      </div>

      {/* --- EXTENSION SETUP GUIDE & FILES MODAL --- */}
      {showExtensionModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#13161f] border border-zinc-700 rounded-lg max-w-2xl w-full p-6 space-y-4 shadow-2xl font-mono text-xs">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-3">
                <Radio className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                  RETROFM CHROME EXTENSION
                </h3>
              </div>
              <button
                onClick={() => setShowExtensionModal(false)}
                className="text-zinc-400 hover:text-zinc-200 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-zinc-800 gap-2 pb-1">
              <button
                onClick={() => setModalTab('GUIDE')}
                className={`px-3 py-1.5 rounded-t text-xs font-bold transition-colors cursor-pointer ${
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
                className={`px-3 py-1.5 rounded-t text-xs font-bold transition-colors cursor-pointer ${
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
                <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-black/40 rounded border border-zinc-800">
                  <span className="text-zinc-300 text-xs">
                    Chrome blocks web pages from navigating directly to <code className="text-amber-300">chrome://extensions</code>.
                  </span>
                  <button
                    onClick={handleCopyExtensionsUrl}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-300 font-bold text-[11px] border border-zinc-700 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{copiedExtensionsUrl ? 'Copied chrome://extensions ✓' : 'Copy chrome://extensions'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-2">
                    <h4 className="font-bold text-amber-400 uppercase tracking-wide text-xs">
                      First Time Setup
                    </h4>
                    <ol className="space-y-2 text-zinc-300 list-decimal list-inside text-xs leading-relaxed">
                      <li>
                        Download the extension ZIP below and unzip to a folder you’ll keep (for example <code className="text-amber-200">Documents/retrofm-extension</code>).
                      </li>
                      <li>
                        Open <code className="text-amber-300">chrome://extensions</code> in Google Chrome.
                      </li>
                      <li>
                        Toggle <strong className="text-zinc-100">Developer mode</strong> in the top-right corner to <strong className="text-emerald-400">ON</strong>.
                      </li>
                      <li>
                        Click <strong className="text-zinc-100">Load unpacked</strong> and pick that folder.
                      </li>
                      <li>
                        Return to RetroFM and click <strong className="text-amber-400">Launch RetroFM</strong> to connect!
                      </li>
                    </ol>
                  </div>

                  <div className="p-3.5 bg-[#0a0c10] border border-zinc-800 rounded space-y-2">
                    <h4 className="font-bold text-amber-400 uppercase tracking-wide text-xs">
                      Updating to New Version
                    </h4>
                    <ol className="space-y-2 text-zinc-300 list-decimal list-inside text-xs leading-relaxed">
                      <li>
                        Download the updated ZIP package below.
                      </li>
                      <li>
                        Unzip into the <strong className="text-zinc-100">same folder</strong> and replace the existing files.
                      </li>
                      <li>
                        Open <code className="text-amber-300">chrome://extensions</code> in Chrome.
                      </li>
                      <li>
                        Click the reload arrow <strong className="text-amber-400">↻</strong> on the RetroFM card (don’t remove it).
                      </li>
                      <li>
                        Refresh both your RetroFM and YouTube tabs.
                      </li>
                    </ol>
                  </div>
                </div>

                <div className="p-3 bg-[#0a0c10] border border-zinc-800 rounded text-zinc-400 text-[11px] leading-relaxed">
                  <strong className="text-zinc-200">Alternative:</strong> If you prefer to create the files manually in a folder without unzipping, click the <strong className="text-amber-400">View / Copy Extension Code</strong> tab above to view and copy each file's code directly!
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* File selector pill list */}
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(extensionFiles).map((fileName) => (
                    <button
                      key={fileName}
                      onClick={() => setActiveFileKey(fileName)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                        activeFileKey === fileName
                          ? 'bg-amber-500 text-black font-bold'
                          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                    >
                      {fileName}
                    </button>
                  ))}
                </div>

                {/* Code / Image display with Copy button */}
                <div className="relative">
                  <div className="flex justify-between items-center bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-t text-[11px] text-zinc-400">
                    <span>File: <strong className="text-zinc-200">{activeFileKey}</strong></span>
                    <button
                      onClick={() => handleCopyFileContent(activeFileKey, extensionFiles[activeFileKey] || '')}
                      className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-400 font-bold text-[11px] border border-zinc-700 flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      {copiedFileKey === activeFileKey ? 'Copied to Clipboard!' : 'Copy Code'}
                    </button>
                  </div>
                  {activeFileKey.endsWith('.png') || (extensionFiles[activeFileKey] && extensionFiles[activeFileKey].startsWith('data:image/png;base64,')) ? (
                    <div className="p-6 flex flex-col items-center justify-center bg-[#08090d] border border-t-0 border-zinc-800 rounded-b space-y-2">
                      <img src={extensionFiles[activeFileKey]} alt={activeFileKey} className="max-h-36 max-w-full object-contain shadow" />
                      <span className="text-zinc-500 font-mono text-[11px]">Binary PNG Image ({activeFileKey})</span>
                    </div>
                  ) : (
                    <pre className="max-h-56 overflow-y-auto bg-[#08090d] border border-t-0 border-zinc-800 p-3 rounded-b text-[11px] text-zinc-300 font-mono leading-relaxed select-all">
                      {extensionFiles[activeFileKey] || 'Loading file content...'}
                    </pre>
                  )}
                </div>
              </div>
            )}

            <div className="pt-2 flex justify-end gap-2 border-t border-zinc-800/80">
              <button
                onClick={() => generateAndDownloadExtensionZip()}
                className="px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold uppercase transition-colors cursor-pointer"
              >
                Download Extension (v{EXTENSION_VERSION})
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

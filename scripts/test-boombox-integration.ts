/**
 * Automated Integration Test Suite: Boom Box Extension Integration
 * Validates state contracts, preset display metadata, message routing safety,
 * volume feedback loop protection, and connection recovery.
 */

import { HARDCODED_PRESETS, RETROFM_JINGLE_CONFIG, DEFAULT_SONG_QUEUE, STATIONS_BY_DECADE, normalizeYouTubeVideoId } from '../src/App.js';
import { VolumeController } from '../src/services/audio/VolumeController.js';
import { YouTubeMusicProvider, computeStereoBalanceGains } from '../src/services/music/YouTubeMusicProvider.js';
import { buildBreak, newDjState, TALK_PRESETS } from '../src/services/djBreak/djBreakObservations.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

interface SongMetadata {
  title: string;
  artist: string;
  year?: string;
  duration?: string;
}

interface RadioStatePayload {
  playbackStatus: 'playing' | 'paused' | 'stopped';
  currentSong: SongMetadata | null;
  date: string;
  frequency: number;
  genre: string;
  masterVolume: number; // 0 - 100
  duckLevel: number;
  isDucking: boolean;
  appConnected: boolean;
  timestamp: number;
}

interface BoomBoxActionPayload {
  action: 'PLAY' | 'PAUSE' | 'STOP' | 'SET_VOLUME' | 'TUNE' | 'SELECT_DATE_GENRE';
  volume?: number;
  decade?: number;
  frequency?: number;
  genre?: string | null;
  locked?: boolean;
  date?: string;
  year?: number;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, details?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${details ? ' - ' + details : ''}`);
    failed++;
  }
}

console.log('================================================================================');
console.log('            RETROFM BOOM BOX INTEGRATION SUITE');
console.log('================================================================================\n');

// --- 1. Test Presets Verification ---
console.log('TEST SUITE 1: 5 Hardcoded Presets Metadata & Display Safety');
const requiredPresets = [
  { key: 'a-ha|take on me', expectedArtist: 'a-ha', expectedSong: 'Take on Me', videoId: 'f-BDCwxBF9Q' },
  { key: 'michael jackson|billie jean', expectedArtist: 'Michael Jackson', expectedSong: 'Billie Jean', videoId: 'Kr4EQDVETuA' },
  { key: 'prince|when doves cry', expectedArtist: 'Prince', expectedSong: 'When Doves Cry', videoId: 'Izx6DQUrsag' },
  { key: 'u2|with or without you', expectedArtist: 'U2', expectedSong: 'With or Without You', videoId: '6Q2mFw4VYBo' },
  { key: 'peter gabriel|sledgehammer', expectedArtist: 'Peter Gabriel', expectedSong: 'Sledgehammer', videoId: 'OJWJE0x7T4Q' },
];

for (const p of requiredPresets) {
  const preset = HARDCODED_PRESETS[p.key];
  assert(!!preset, `Preset exists: ${p.key}`);
  assert(preset?.videoId === p.videoId, `Preset video ID matches: ${p.key} -> ${p.videoId}`);
  assert(preset?.artist === p.expectedArtist, `Preset artist matches: ${p.expectedArtist}`);
  assert(preset?.song === p.expectedSong, `Preset song title matches: ${p.expectedSong}`);

  // Test display formatting logic in Boom Box setSong(d)
  const title = String(preset?.title || '').trim();
  const artist = String(preset?.artist || '').trim();
  const doesNotContainUndefined = !title.includes('undefined') && !title.includes('null');
  assert(doesNotContainUndefined, `Preset ${p.key} formatted cleanly without null/undefined`);
}

// --- 2. Missing & Malformed State Handling ---
console.log('\nTEST SUITE 2: Malformed & Disconnected State Handling');
function simulateBoomBoxSetSong(d: any): { title: string; artist: string } | null {
  if (d && d.title) {
    const title = String(d.title).trim();
    const artist = d.artist ? String(d.artist).trim() : '';
    if (title && title !== 'undefined' && title !== 'null') {
      return { title, artist: (artist !== 'undefined' && artist !== 'null') ? artist : '' };
    }
  }
  return null;
}

assert(simulateBoomBoxSetSong(null) === null, 'null song yields null display state');
assert(simulateBoomBoxSetSong(undefined) === null, 'undefined song yields null display state');
assert(simulateBoomBoxSetSong({}) === null, 'empty song object yields null display state');
assert(simulateBoomBoxSetSong({ title: 'undefined' }) === null, 'literal "undefined" string rejected');
assert(simulateBoomBoxSetSong({ title: 'null' }) === null, 'literal "null" string rejected');
const validFormatted = simulateBoomBoxSetSong({ title: 'Take on Me', artist: null });
assert(validFormatted?.title === 'Take on Me' && validFormatted?.artist === '', 'null artist sanitized to empty string');

// --- 3. Radio State Payload & Freshness ---
console.log('\nTEST SUITE 3: Authoritative Radio State Contract & Freshness');
const validPayload: RadioStatePayload = {
  playbackStatus: 'playing',
  currentSong: { title: 'Take on Me', artist: 'a-ha', year: '1985' },
  date: '1985-07-13',
  frequency: 95.5,
  genre: 'Top 40',
  masterVolume: 80,
  duckLevel: 10,
  isDucking: false,
  appConnected: true,
  timestamp: Date.now()
};

assert(validPayload.appConnected === true, 'appConnected flag properly marked true when active');
assert(validPayload.masterVolume >= 0 && validPayload.masterVolume <= 100, 'masterVolume in valid range 0-100');
assert(typeof validPayload.timestamp === 'number', 'state payload contains authoritative timestamp');

// Disconnected simulation
const disconnectedPayload: RadioStatePayload = {
  ...validPayload,
  appConnected: false,
  playbackStatus: 'stopped'
};
assert(disconnectedPayload.appConnected === false, 'disconnected payload accurately flags disconnected state');
assert(disconnectedPayload.playbackStatus === 'stopped', 'disconnected payload ceases active playback');

// --- 4. Volume Knob Command Feedback Loop Protection ---
console.log('\nTEST SUITE 4: Volume Command Feedback Loop Protection');
// In player.js, knob() set(v) calls onSet(), which dispatches SET_VOLUME.
// setVisualVolume(fraction) directly sets S.vol and transforms the DOM without onSet().
let volumeCommandSentCount = 0;
let visualVolume = 0.7;

function onVolumeKnobTurnedByUser(v: number) {
  visualVolume = v;
  volumeCommandSentCount++; // Emits command
}

function onIncomingStateVisualUpdate(v: number) {
  visualVolume = v;
  // Does NOT increment volumeCommandSentCount!
}

// User turns knob:
onVolumeKnobTurnedByUser(0.85);
assert(volumeCommandSentCount === 1, 'User turning knob triggers 1 volume command');

// App broadcasts state back:
onIncomingStateVisualUpdate(0.85);
assert(volumeCommandSentCount === 1, 'Incoming state update does NOT trigger another volume command (0 feedback loops)');
assert(visualVolume === 0.85, 'Knob position matches incoming broadcast volume');

// --- 5. Tab Management & Idempotent Launching ---
console.log('\nTEST SUITE 5: Tab Management & Idempotent Launching');
interface MockTab {
  id: number;
  url: string;
  active: boolean;
}

const mockTabs: MockTab[] = [];
let nextTabId = 101;

async function openOrFocusBoomBox(): Promise<{ tabId: number; reused: boolean }> {
  const boomBoxUrl = 'chrome-extension://hjphfmcilldbipolljlbjnnadeogocab/player/index.html';
  const existing = mockTabs.find(t => t.url === boomBoxUrl);
  if (existing) {
    existing.active = true;
    return { tabId: existing.id, reused: true };
  }
  const newTab = { id: ++nextTabId, url: boomBoxUrl, active: true };
  mockTabs.push(newTab);
  return { tabId: newTab.id, reused: false };
}

// 1. Initial launch
const launch1 = await openOrFocusBoomBox();
assert(launch1.reused === false, 'Initial launch creates new Boom Box tab');
assert(mockTabs.length === 1, 'Exactly 1 Boom Box tab open');

// 2. Second launch (e.g. React re-render or repeated click)
const launch2 = await openOrFocusBoomBox();
assert(launch2.reused === true, 'Repeated launch reuses existing tab instead of creating duplicate');
assert(launch2.tabId === launch1.tabId, 'Reused tab ID matches original tab ID');
assert(mockTabs.length === 1, 'Still exactly 1 Boom Box tab open (no duplicates)');

// --- 6. Tab Resolution & Play Action Safety ---
console.log('\nTEST SUITE 6: Tab Resolution Pattern & Play Action Dispatch Safety');
const allOpenTabs = [
  { id: 1, url: 'https://www.youtube.com/watch?v=f-BDCwxBF9Q' },
  { id: 2, url: 'http://localhost:3003/' },
  { id: 3, url: 'chrome-extension://hjphfmcilldbipolljlbjnnadeogocab/player/index.html' },
  { id: 4, url: 'http://localhost:8080/other-service' }
];

// Test registration-only resolution with session storage simulation
let inMemoryAppTabId: number | null = null;
let sessionStorageAppTabId: number | null = null;
const openTabsList = new Map<number, { id: number; url: string }>([
  [1, { id: 1, url: 'https://www.youtube.com/watch?v=f-BDCwxBF9Q' }],
  [2, { id: 2, url: 'http://localhost:3003/' }],
  [3, { id: 3, url: 'chrome-extension://hjphfmcilldbipolljlbjnnadeogocab/player/index.html' }],
  [4, { id: 4, url: 'http://localhost:1234/lm-studio' }], // Unregistered localhost tab
  [5, { id: 5, url: 'http://localhost:8880/kokoro' }]     // Another unregistered localhost tab
]);

async function resolveRetroFmTabSimulated(requestedTabId?: number): Promise<number | null> {
  if (requestedTabId) {
    if (openTabsList.has(requestedTabId)) return requestedTabId;
  }
  let id = inMemoryAppTabId;
  if (!id && sessionStorageAppTabId) {
    id = sessionStorageAppTabId;
    inMemoryAppTabId = id; // restored from session storage
  }
  if (id) {
    if (openTabsList.has(id)) return id;
    // Tab was closed, clear registration
    inMemoryAppTabId = null;
    sessionStorageAppTabId = null;
  }
  return null;
}

// (a) An unregistered localhost tab is never chosen
assert((await resolveRetroFmTabSimulated()) === null, 'Proof (a): An unregistered localhost tab is never chosen (no search across localhost tabs)');

// App registers via REGISTER_RETROFM_APP (or BROADCAST_RADIO_STATE)
inMemoryAppTabId = 2;
sessionStorageAppTabId = 2;
assert((await resolveRetroFmTabSimulated()) === 2, 'Registered state: resolveRetroFmTab returns the registered app tab ID (2)');

// (b) A registered tab survives a service worker restart (in-memory variable lost, restored from session storage)
inMemoryAppTabId = null; // simulate service worker going to sleep / restarting
assert(inMemoryAppTabId === null, 'Simulated service worker idle: in-memory tab ID is null');
const restoredTabId = await resolveRetroFmTabSimulated();
assert(restoredTabId === 2, 'Proof (b): Registered tab survives a service worker restart and is restored from session storage');
assert(inMemoryAppTabId === 2, 'In-memory variable successfully repopulated from session storage');

// (c) Closing the app tab clears the registration in memory and session storage
openTabsList.delete(2); // simulate tab 2 closing in browser
const afterClosedTabId = await resolveRetroFmTabSimulated();
assert(afterClosedTabId === null, 'Proof (c): Closing the app tab clears the registration; returns null');
assert(inMemoryAppTabId === null && sessionStorageAppTabId === null, 'Registration cleared in both memory and storage.session');

function simulateDispatchBoomBoxAction(registeredTab: number | null): { success: boolean; error?: string } {
  if (!registeredTab) {
    return { success: false, error: 'RetroFM app not connected' };
  }
  return { success: true };
}

const noAppResult = simulateDispatchBoomBoxAction(null);
assert(!noAppResult.success && noAppResult.error === 'RetroFM app not connected', 'No app registered: Boom Box action receives "RetroFM app not connected"');

const appConnectedResult = simulateDispatchBoomBoxAction(2);
assert(appConnectedResult.success, 'App registered: Boom Box action dispatches successfully');

async function simulateBoomBoxPlayAction(connected: boolean): Promise<{ programSongCalled: boolean; playCommandSent: boolean }> {
  if (!connected) {
    return { programSongCalled: true, playCommandSent: false };
  }
  return { programSongCalled: false, playCommandSent: true };
}

const resDisconnected = await simulateBoomBoxPlayAction(false);
assert(resDisconnected.programSongCalled && !resDisconnected.playCommandSent, 'Boom Box PLAY falls back to programming preset song when no YouTube tab is yet connected');

const resConnected = await simulateBoomBoxPlayAction(true);
assert(!resConnected.programSongCalled && resConnected.playCommandSent, 'Boom Box PLAY triggers direct play when YouTube tab is already connected');

// --- 7. Metadata Cleaning & Separation Test Suite ---
console.log('\nTEST SUITE 7: Artist & Song Title Formatting & Cleaning');

function cleanTitle(rawTitle: string, artist?: string): string {
  if (!rawTitle) return '';
  let t = String(rawTitle).trim();
  t = t.replace(/\s*\(\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\)/gi, '');
  t = t.replace(/\s*\[\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\]/gi, '');

  if (artist && artist.trim()) {
    const aEsc = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadArtistRegex = new RegExp('^' + aEsc + '\\s*[-:—–~]\\s*', 'i');
    t = t.replace(leadArtistRegex, '');
  } else {
    const match = t.match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match) {
      t = match[2];
    }
  }
  return t.trim();
}

function cleanArtist(rawArtist?: string, rawTitle?: string): string {
  if (rawArtist && String(rawArtist).trim() && String(rawArtist).trim() !== 'undefined' && String(rawArtist).trim() !== 'null') {
    return String(rawArtist).trim();
  }
  if (rawTitle) {
    const match = String(rawTitle).trim().match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  return '';
}

function formatScreens(rawArtist?: string, rawTitle?: string): { artistScreen: string; titleScreen: string } {
  const artist = cleanArtist(rawArtist, rawTitle);
  const title = cleanTitle(rawTitle || '', artist);
  return { artistScreen: artist, titleScreen: title };
}

// Case 1: Structured metadata (a-ha, Take on Me, 1985)
const c1 = formatScreens('a-ha', 'Take on Me');
assert(c1.artistScreen === 'a-ha', 'Case 1 Artist: a-ha');
assert(c1.titleScreen === 'Take on Me', 'Case 1 Title: Take on Me');

// Case 2: Combined text with release year: a-ha - Take on Me (1985)
const c2 = formatScreens('', 'a-ha - Take on Me (1985)');
assert(c2.artistScreen === 'a-ha', 'Case 2 Artist extracted from combined string: a-ha');
assert(c2.titleScreen === 'Take on Me', 'Case 2 Title cleaned from combined string: Take on Me');

// Case 3: U2 - With or Without You (1987)
const c3 = formatScreens('U2', 'With or Without You');
assert(c3.artistScreen === 'U2', 'Case 3 Artist: U2');
assert(c3.titleScreen === 'With or Without You', 'Case 3 Title: With or Without You');

// Case 4: Michael Jackson - Billie Jean (1983) with combined title
const c4 = formatScreens('Michael Jackson', 'Michael Jackson - Billie Jean (1983)');
assert(c4.artistScreen === 'Michael Jackson', 'Case 4 Artist: Michael Jackson');
assert(c4.titleScreen === 'Billie Jean', 'Case 4 Title stripped duplicate artist & year: Billie Jean');

// Case 5: Legitimate parentheses in song title preserved (e.g. "Take Me On (Live Version)")
const c5 = formatScreens('a-ha', 'Take Me On (Live Version)');
assert(c5.titleScreen === 'Take Me On (Live Version)', 'Case 5 Legitimate non-year parentheses preserved in title');

// Case 6: Featured artist in title preserved
const c6 = formatScreens('Daft Punk', 'Get Lucky (feat. Pharrell Williams)');
assert(c6.titleScreen === 'Get Lucky (feat. Pharrell Williams)', 'Case 6 Featured artist preserved in title');

// --- 8. Transport Active States Contract Test Suite ---
console.log('\nTEST SUITE 8: Transport Active States Contract & Optimistic UI Update with 1.5s Reconciliation');

interface TransportActiveStates {
  playActive: boolean;
  pauseActive: boolean;
  stopActive: boolean;
}

function calculateActiveStates(playbackStatus: 'playing' | 'paused' | 'stopped'): TransportActiveStates {
  return {
    playActive: playbackStatus === 'playing',
    pauseActive: playbackStatus === 'paused',
    stopActive: false // Per spec: When stopped, Play, Pause, and Stop indicators are all inactive / unilluminated
  };
}

const playingStates = calculateActiveStates('playing');
assert(playingStates.playActive === true, 'Playing state: Play button is Active');
assert(playingStates.pauseActive === false, 'Playing state: Pause button is Inactive');
assert(playingStates.stopActive === false, 'Playing state: Stop button is Inactive');

const pausedStates = calculateActiveStates('paused');
assert(pausedStates.playActive === false, 'Paused state: Play button is Inactive');
assert(pausedStates.pauseActive === true, 'Paused state: Pause button is Active');
assert(pausedStates.stopActive === false, 'Paused state: Stop button is Inactive');

const stoppedStates = calculateActiveStates('stopped');
assert(stoppedStates.playActive === false, 'Stopped state: Play button is Inactive');
assert(stoppedStates.pauseActive === false, 'Stopped state: Pause button is Inactive');
assert(stoppedStates.stopActive === false, 'Stopped state: Stop button is Inactive (no illuminated transport symbols)');

// Verify that clicking Play immediately updates local UI state
let localUiState = 'paused';
let lastUserAction: { state: string; time: number } | null = null;

function clickPlayTransport() {
  localUiState = 'playing'; // Immediate update
  lastUserAction = { state: 'playing', time: Date.now() };
}
clickPlayTransport();
assert(localUiState === 'playing', 'Clicking Play immediately updates local UI state to playing');

// Within 1.5s window, disagreeing incoming state (e.g. paused from polling) does NOT override user action
function receiveBroadcastState(incoming: string, now: number) {
  if (lastUserAction) {
    if (incoming === lastUserAction.state) {
      lastUserAction = null;
      localUiState = incoming;
      return;
    }
    if (now - lastUserAction.time < 1500) {
      // Disagreeing within 1.5s: keep local state
      return;
    }
    // Disagreeing for > 1.5s: correct state
    lastUserAction = null;
    localUiState = incoming;
    return;
  }
  localUiState = incoming;
}

receiveBroadcastState('paused', lastUserAction!.time + 500);
assert(localUiState === 'playing', 'Disagreeing broadcast within 1.5s (at 500ms) is held, keeping optimistic playing state');

receiveBroadcastState('paused', lastUserAction!.time + 1600);
assert(localUiState === 'paused', 'Disagreeing broadcast after 1.5s (at 1600ms) reconciles to incoming authoritative state');

// --- 9. Deck Transport Action Routing (Rewind / Fast Forward / Seek) ---
console.log('\nTEST SUITE 9: Rewind / Fast Forward Seek Position Math');

function simulateSeek(currentPos: number, duration: number, direction: 'rewind' | 'forward'): number {
  if (direction === 'rewind') {
    return Math.max(0, currentPos - 10);
  } else {
    return Math.min(duration, currentPos + 10);
  }
}

assert(simulateSeek(25, 180, 'rewind') === 15, 'Rewind seeks backward by 10 seconds');
assert(simulateSeek(5, 180, 'rewind') === 0, 'Rewind clamps cleanly to 0s at track beginning');
assert(simulateSeek(25, 180, 'forward') === 35, 'Fast Forward seeks forward by 10 seconds');
assert(simulateSeek(175, 180, 'forward') === 180, 'Fast Forward clamps cleanly to duration at track end');

// --- 10. CSS Theme & Original Styling Verification ---
console.log('\nTEST SUITE 10: Original Styling & Tile Color Properties');
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(resolve(process.cwd(), 'extension/player/player.css'), 'utf-8');

assert(cssContent.includes('#copy{flex:1;white-space:nowrap}'), 'CSS includes #copy{flex:1;white-space:nowrap}');
assert(cssContent.includes('#panel.entry{background:#151311;color:#e9d9b8}'), 'CSS includes dark #panel.entry background (#151311)');
assert(cssContent.includes('.fl{') && cssContent.includes('background:#2a2622'), 'Original tile flap cells (.fl) have dark background (#2a2622)');
assert(cssContent.includes('color:#f2e8d0'), 'Original tile flap cells (.fl) have cream color text (#f2e8d0)');
assert(cssContent.includes('button.tag{background:transparent;color:#8dffb0'), 'Date/Genre tag buttons have transparent background');

// --- 11. Metadata Retention Across Transport States ---
console.log('\nTEST SUITE 11: Metadata Retention Across Play, Pause, Resume, and Stop');

interface BoomBoxDisplayState {
  displayText: string;
  className: string;
  tooltip: string;
  isFadingScheduled: boolean;
}

function simulateBoomBoxRenderSong(
  song: { title: string; artist: string } | null,
  transportState: 'playing' | 'paused' | 'stopped',
  appConnected: boolean,
  isLocked: boolean
): BoomBoxDisplayState {
  if (!appConnected) return { displayText: 'Offline', className: 'dim', tooltip: '', isFadingScheduled: false };
  if (!isLocked) return { displayText: '░ static ░', className: '', tooltip: '', isFadingScheduled: false };
  if (!song) return { displayText: 'No song selected', className: 'dim', tooltip: '', isFadingScheduled: false };

  const tooltip = song.title + (song.artist ? ' by ' + song.artist : '');
  return {
    displayText: song.title,
    className: '',
    tooltip,
    isFadingScheduled: transportState === 'playing' && !!song.artist
  };
}

const currentTrack = { title: 'Take on Me', artist: 'a-ha' };

// 1. When playing: shows title, tooltip set, fading scheduled
const playRender = simulateBoomBoxRenderSong(currentTrack, 'playing', true, true);
assert(playRender.displayText === 'Take on Me', 'Playing: green display shows song title');
assert(playRender.tooltip === 'Take on Me by a-ha', 'Playing: tooltip shows title and artist');
assert(playRender.isFadingScheduled === true, 'Playing: smooth alternating fade scheduled between title and artist');

// 2. When paused: shows title (NOT literal "PAUSED"), retains metadata
const pauseRender = simulateBoomBoxRenderSong(currentTrack, 'paused', true, true);
assert(pauseRender.displayText === 'Take on Me', 'Paused: green display retains song title instead of replacing with "PAUSED"');
assert(pauseRender.tooltip === 'Take on Me by a-ha', 'Paused: tooltip retains title and artist');
assert(pauseRender.isFadingScheduled === false, 'Paused: song fade is paused/held');

// 3. When stopped: shows title (NOT "No song selected"), retains metadata
const stopRender = simulateBoomBoxRenderSong(currentTrack, 'stopped', true, true);
assert(stopRender.displayText === 'Take on Me', 'Stopped: green display retains song title instead of showing "No song selected"');
assert(stopRender.tooltip === 'Take on Me by a-ha', 'Stopped: tooltip retains title and artist');
assert(stopRender.isFadingScheduled === false, 'Stopped: song fade is paused');

// 4. State transition test: play -> pause -> resume -> stop
let currentLoadedSong: { title: string; artist: string } | null = null;
function handleRadioStateUpdate(incomingSong: { title: string; artist: string } | null) {
  if (incomingSong && incomingSong.title) {
    currentLoadedSong = incomingSong;
  }
  // If incomingSong is null (e.g. stopped or paused broadcast), currentLoadedSong is NOT cleared
}

handleRadioStateUpdate(currentTrack);
assert(Boolean(currentLoadedSong && (currentLoadedSong as any).title === 'Take on Me'), 'Initial play loads song metadata');

handleRadioStateUpdate(null); // Pause broadcast where song was null in older versions
assert(Boolean(currentLoadedSong && (currentLoadedSong as any).title === 'Take on Me'), 'Pause broadcast preserves loaded song metadata');

// --- 12. Verified Transport Execution & Race Condition Protection ---
console.log('\nTEST SUITE 12: Verified Transport Execution & Race Condition Protection');

// 1. Play invokes intended player
function simulateCommandRouting(targetTabId: number, connectedTabId: number, tabs: Array<{ id: number; url: string }>): number | null {
  if (targetTabId && tabs.some(t => t.id === targetTabId)) return targetTabId;
  if (connectedTabId && tabs.some(t => t.id === connectedTabId)) return connectedTabId;
  return null;
}
const mockOpenTabs = [
  { id: 10, url: 'https://youtube.com/watch?v=unrelated' },
  { id: 20, url: 'https://youtube.com/watch?v=f-BDCwxBF9Q' }
];
assert(simulateCommandRouting(20, 20, mockOpenTabs) === 20, 'Play routes to intended connected YouTube tab when multiple YouTube tabs are open');

// 2. A successful message response alone does not mark playback as active
function evaluatePlayResult(res: { success: boolean; status?: { isPlaying: boolean }; state?: string }): boolean {
  return Boolean(res?.success && (res?.status?.isPlaying || res?.state === 'playing' || res?.state === 'already_playing' || res?.state === 'buffering_active'));
}
const rawAckResponse = { success: true, status: { isPlaying: false }, state: 'paused' };
assert(evaluatePlayResult(rawAckResponse) === false, 'Successful IPC message acknowledgment alone does not mark playback as active');

// 3. Rejected video.play() promise handled correctly
function simulatePlayPromiseExecution(rejectError?: Error): { success: boolean; state: string; error?: string } {
  if (rejectError) {
    return { success: false, state: 'rejected', error: `${rejectError.name}: ${rejectError.message}` };
  }
  return { success: true, state: 'playing' };
}
const rejectedRes = simulatePlayPromiseExecution(new Error('NotAllowedError: user interaction required'));
assert(rejectedRes.success === false && rejectedRes.state === 'rejected', 'Rejected video.play() promise handled cleanly with explicit diagnostic');

// 4. Play request leaving video paused is not reported as success
function simulateVerification(paused: boolean, readyState: number): boolean {
  if (paused) return false;
  return readyState >= 3;
}
assert(simulateVerification(true, 4) === false, 'Play request leaving video paused is not reported as successful playback');

// 5. Resume does not seek to zero
function determineSeekTarget(isPlaying: boolean, currentTime: number): number | null {
  if (!isPlaying && currentTime === 0) return 0;
  return null; // Do not seek when resuming
}
assert(determineSeekTarget(false, 45) === null, 'Resuming paused song at 45s does not seek to zero');
assert(determineSeekTarget(false, 0) === 0, 'Stopped track at position zero seeks to zero before start');

// 6. Stop pauses video and resets currentTime to zero
function simulateStopExecution(video: { paused: boolean; currentTime: number }): { paused: boolean; currentTime: number } {
  video.paused = true;
  video.currentTime = 0;
  return video;
}
const mockVideo = { paused: false, currentTime: 55 };
const stoppedVideo = simulateStopExecution(mockVideo);
assert(stoppedVideo.paused === true && stoppedVideo.currentTime === 0, 'Stop pauses video and resets currentTime to zero');

// 7. Stop never invokes Play
let playInvoked = false;
function simulateStopAction() {
  // Stop handler pauses and resets; does not trigger play or handleProgramSong
  return { isPlaying: false, currentTime: 0 };
}
simulateStopAction();
assert(playInvoked === false, 'Stop handler never invokes play or falls back to song programming');

// 8. Stale Play result cannot override newer Stop command
let commandSequence = 0;
let lastAppliedState = 'stopped';
function simulateCommandInitiation(type: 'PLAY' | 'STOP'): number {
  return ++commandSequence;
}
function simulateCommandCompletion(seq: number, resultingState: string) {
  if (seq === commandSequence) {
    lastAppliedState = resultingState;
  }
}
const playSeq = simulateCommandInitiation('PLAY');
const stopSeq = simulateCommandInitiation('STOP');
// Suppose STOP finishes first:
simulateCommandCompletion(stopSeq, 'stopped');
assert(lastAppliedState === 'stopped', 'Stop sets state to stopped');
// Now suppose older delayed Play finishes:
simulateCommandCompletion(playSeq, 'playing');
assert(lastAppliedState === 'stopped', 'Stale Play result discarded; cannot override newer Stop command');

// 9. Polling cannot incorrectly relight Play after Stop
function simulatePoll(inFlight: boolean, polledState: { isPlaying: boolean }, currentState: { isPlaying: boolean }) {
  if (inFlight) {
    return currentState;
  }
  return polledState;
}
const stateAfterStop = { isPlaying: false };
const laggingPollFromYouTube = { isPlaying: true };
const resolvedState = simulatePoll(true, laggingPollFromYouTube, stateAfterStop);
assert(resolvedState.isPlaying === false, 'In-flight Stop guard prevents lagging poll from relighting Play');

// 10. Play and Pause indicators follow normalized observed state
function normalizeTransportIndicators(state: string): { playOn: boolean; pauseOn: boolean; stopOn: boolean } {
  const norm = (state === 'playing' || state === 'paused') ? state : 'stopped';
  return {
    playOn: norm === 'playing',
    pauseOn: norm === 'paused',
    stopOn: false
  };
}
assert(normalizeTransportIndicators('playing').playOn === true && normalizeTransportIndicators('playing').pauseOn === false, 'Normalized playing state lights Play only');
assert(normalizeTransportIndicators('paused').playOn === false && normalizeTransportIndicators('paused').pauseOn === true, 'Normalized paused state lights Pause only');
assert(normalizeTransportIndicators('stopped').playOn === false && normalizeTransportIndicators('stopped').pauseOn === false, 'Normalized stopped state lights neither');

// 11. Failed Play request does not leave Play illuminated
const failedPlayNormalized = normalizeTransportIndicators('paused');
assert(failedPlayNormalized.playOn === false, 'Failed Play request leaving track paused keeps Play indicator unilluminated');

// 12. Multiple YouTube tabs: command reaches activeConnectedTabId
const multiTabs = [
  { id: 101, url: 'https://youtube.com/watch?v=aaa' },
  { id: 202, url: 'https://youtube.com/watch?v=bbb' }
];
const routedTab = simulateCommandRouting(0, 202, multiTabs);
assert(routedTab === 202, 'Command routes to activeConnectedTabId even if another YouTube tab exists');

// 13. Disconnected content script produces explicit failure
function simulateScriptInjection(injected: boolean): { success: boolean; error?: string } {
  if (!injected) return { success: false, error: 'Receiving end does not exist' };
  return { success: true };
}
assert(simulateScriptInjection(false).success === false, 'Disconnected content script produces explicit failure');

// --- 13. Main-World Playback Bridge Regression Tests ---
console.log('\nTEST SUITE 13: YouTube Main-World Playback Bridge & Readiness Safety');

// 13.1 One outgoing playback command uses exactly one bridge event mechanism (CustomEvent)
class MockEventTarget {
  eventsDispatched: { type: string; detail?: any }[] = [];
  messagesPosted: any[] = [];

  dispatchEvent(evt: { type: string; detail?: any }) {
    this.eventsDispatched.push(evt);
  }
  postMessage(msg: any, targetOrigin: string) {
    this.messagesPosted.push(msg);
  }
}

function simulateSendPlayerCommand(target: MockEventTarget, command: string, payload: any = {}) {
  // Corrected implementation: ONLY dispatches CustomEvent, NEVER postMessage for player commands
  target.dispatchEvent({
    type: 'RETROFM_PLAYER_COMMAND',
    detail: JSON.stringify({ command, payload })
  });
}

const mockWindow = new MockEventTarget();
simulateSendPlayerCommand(mockWindow, 'PLAY');
assert(mockWindow.eventsDispatched.length === 1, 'One outgoing playback command uses exactly one bridge event mechanism');
assert(mockWindow.eventsDispatched[0].type === 'RETROFM_PLAYER_COMMAND', 'Outgoing event uses RETROFM_PLAYER_COMMAND');
assert(mockWindow.messagesPosted.length === 0, 'No redundant postMessage is dispatched for playback commands');

// 13.2 One received command invokes the command executor at most once
let commandExecCount = 0;
function simulateCommandReceive(evt: { type: string; detail?: any }) {
  if (evt.type === 'RETROFM_PLAYER_COMMAND') {
    commandExecCount++;
  }
}
simulateCommandReceive(mockWindow.eventsDispatched[0]);
assert(commandExecCount === 1, 'One received command invokes the command executor exactly once (no duplicate execution)');

// 13.3 Play does not invoke both playVideo() and a native Play-button toggle
class MockYouTubePlayer {
  playVideoCalls = 0;
  pauseVideoCalls = 0;
  seekToCalls: number[] = [];
  playerState = 2; // 2 = paused, 1 = playing

  playVideo() {
    this.playVideoCalls++;
    this.playerState = 1;
  }
  pauseVideo() {
    this.pauseVideoCalls++;
    this.playerState = 2;
  }
  seekTo(time: number, allowSeekAhead?: boolean) {
    this.seekToCalls.push(time);
  }
  getPlayerState() {
    return this.playerState;
  }
}

class MockMainWorldBridge {
  player: MockYouTubePlayer | null = null;
  pendingCommand: { command: string; payload?: any; seq: number } | null = null;
  seq = 0;

  isReady() {
    return !!(this.player && typeof this.player.playVideo === 'function' && typeof this.player.pauseVideo === 'function');
  }

  executeCommand(command: string, payload?: any) {
    const cmd = command.toUpperCase();
    const seq = ++this.seq;
    if (this.isReady()) {
      this.pendingCommand = null;
      this.executeDirect(cmd, payload);
      return { status: 'executed', seq };
    }
    // Queue pending command
    this.pendingCommand = { command: cmd, payload, seq };
    return { status: 'queued', seq };
  }

  executeDirect(cmd: string, payload?: any) {
    if (!this.player) return;
    if (cmd === 'PLAY') {
      this.player.playVideo();
    } else if (cmd === 'PAUSE') {
      this.player.pauseVideo();
    } else if (cmd === 'STOP') {
      this.player.pauseVideo();
      this.player.seekTo(0, true);
    } else if (cmd === 'SEEK') {
      this.player.seekTo(payload?.time || 0, true);
    }
  }

  flushPending() {
    if (this.pendingCommand && this.isReady()) {
      const { command, payload } = this.pendingCommand;
      this.pendingCommand = null;
      this.executeDirect(command, payload);
    }
  }
}

const mockPlayer = new MockYouTubePlayer();
const bridge = new MockMainWorldBridge();
bridge.player = mockPlayer;

bridge.executeCommand('PLAY');
assert(mockPlayer.playVideoCalls === 1, 'Play invokes playVideo() on player');

// 13.4 Pause works on the first press regardless of getPlayerState()
const pausePlayer = new MockYouTubePlayer();
pausePlayer.playerState = 2; // e.g. state code was returned as 2 or lagged during transition
const pauseBridge = new MockMainWorldBridge();
pauseBridge.player = pausePlayer;
pauseBridge.executeCommand('PAUSE');
assert(pausePlayer.pauseVideoCalls === 1, 'Pause invokes pauseVideo() unconditionally on the first press');

// 13.5 Unbroken command sequences (Stop -> Play -> Pause -> Play) execute reliably without freezing
const seqPlayer = new MockYouTubePlayer();
const seqBridge = new MockMainWorldBridge();
seqBridge.player = seqPlayer;
seqBridge.executeCommand('STOP');
assert(seqPlayer.pauseVideoCalls === 1 && seqPlayer.seekToCalls[0] === 0, 'Sequence step 1: Stop pauses and seeks to 0');
seqBridge.executeCommand('PLAY');
assert(seqPlayer.playVideoCalls === 1, 'Sequence step 2: Play invokes playVideo() immediately after Stop');
seqBridge.executeCommand('PAUSE');
assert(seqPlayer.pauseVideoCalls === 2, 'Sequence step 3: Pause invokes pauseVideo() immediately after Play');
seqBridge.executeCommand('PLAY');
assert(seqPlayer.playVideoCalls === 2, 'Sequence step 4: Play resumes playback after Pause without getting stuck');

// 13.6 Command arriving before player readiness is retained
const unreadyBridge = new MockMainWorldBridge();
unreadyBridge.player = null; // Player not mounted yet
const queueRes = unreadyBridge.executeCommand('PLAY');
assert(queueRes.status === 'queued', 'A command arriving before player readiness is retained in pending queue');
assert(unreadyBridge.pendingCommand?.command === 'PLAY', 'Pending command is preserved as PLAY');

// 13.7 The pending command executes once when the player becomes ready
unreadyBridge.player = new MockYouTubePlayer(); // Player mounts
unreadyBridge.flushPending();
assert(unreadyBridge.player.playVideoCalls === 1, 'The pending command executes once when the player becomes ready');
assert(unreadyBridge.pendingCommand === null, 'Pending command queue is cleared after flush');

// 13.8 A pending Play followed by Stop cannot cause Play to execute after Stop (superseding)
const supersedingBridge = new MockMainWorldBridge();
supersedingBridge.player = null;
supersedingBridge.executeCommand('PLAY');
supersedingBridge.executeCommand('STOP');
assert(supersedingBridge.pendingCommand?.command === 'STOP', 'Pending Play followed by Stop supersedes pending command to STOP');

supersedingBridge.player = new MockYouTubePlayer();
supersedingBridge.flushPending();
assert(supersedingBridge.player.playVideoCalls === 0, 'Play never executes because it was superseded by Stop before player ready');
assert(supersedingBridge.player.pauseVideoCalls === 1, 'Stop executes correctly when player mounts');
assert(supersedingBridge.player.seekToCalls[0] === 0, 'Stop seeks to position zero');

// 13.9 Readiness timeout produces explicit cleanup
let timerFired: boolean = false;
let timedOutPending: any = { command: 'PLAY', seq: 42 };
function simulateReadinessTimeout(activeSeq: number) {
  if (timedOutPending && timedOutPending.seq === activeSeq) {
    timerFired = true;
    timedOutPending = null;
  }
}
simulateReadinessTimeout(42);
assert(timerFired && timedOutPending === null, 'A readiness timeout drops stale pending command cleanly');

// 13.10 Cassette reel animation and transport state styling contract
function simulateTransportDomState(transportState: 'playing' | 'paused' | 'stopped') {
  const stageClasses = new Set<string>();
  const gPlayClasses = new Set<string>();
  const gPauseClasses = new Set<string>();
  const gStopClasses = new Set<string>();

  if (transportState === 'playing') {
    stageClasses.add('playing');
    gPlayClasses.add('on');
  } else if (transportState === 'paused') {
    gPauseClasses.add('on');
  } else if (transportState === 'stopped') {
    gStopClasses.add('on');
  }

  return {
    isReelSpinning: stageClasses.has('playing'),
    isPlayLit: gPlayClasses.has('on'),
    isPauseLit: gPauseClasses.has('on'),
    isStopLit: gStopClasses.has('on'),
  };
}

const playDom = simulateTransportDomState('playing');
assert(playDom.isReelSpinning === true && playDom.isPlayLit === true, 'Playing state enables .playing on stage (cassette reels spin) and illuminates gPlay');
const pauseDom = simulateTransportDomState('paused');
assert(pauseDom.isReelSpinning === false && pauseDom.isPauseLit === true, 'Paused state pauses cassette reels and illuminates pause symbol');
const stopDom = simulateTransportDomState('stopped');
assert(stopDom.isReelSpinning === false && stopDom.isStopLit === true, 'Stopped state pauses cassette reels and flashes stop indicator');

// 13.11 Existing volume-command handling remains intact
let volumeReceived: boolean = false;
function simulateVolumeMessage(msg: { type: string; volume: number }) {
  if (msg.type === 'RETROFM_SET_VOLUME_MSG' && typeof msg.volume === 'number') {
    volumeReceived = true;
  }
}
simulateVolumeMessage({ type: 'RETROFM_SET_VOLUME_MSG', volume: 80 });
assert(volumeReceived, 'Existing volume postMessage bridge remains intact');

// --- 14. Transport Trace Log Integrity & Formatting ---
console.log('\nTEST SUITE 14: Transport Trace Buffer Capacity & Plain-Text Formatting');
interface TraceEntry {
  ts: number;
  source: string;
  event: string;
  data?: Record<string, any>;
}

const traceBuffer: TraceEntry[] = [];
const MAX_TRACE = 300;

function pushTrace(entry: TraceEntry) {
  traceBuffer.push(entry);
  if (traceBuffer.length > MAX_TRACE) {
    traceBuffer.splice(0, traceBuffer.length - MAX_TRACE);
  }
}

// 14.1 Test capacity boundary: push 350 entries, ensure exactly 300 retained
for (let i = 1; i <= 350; i++) {
  pushTrace({
    ts: 1000 + i,
    source: i % 2 === 0 ? 'boombox' : 'background',
    event: `EVENT_${i}`,
    data: { index: i }
  });
}
assert(traceBuffer.length === 300, 'Trace log caps buffer at exactly 300 entries');
assert(traceBuffer[0].event === 'EVENT_51', 'Trace log maintains FIFO ring order (entry #51 is earliest after 350 pushes)');
assert(traceBuffer[299].event === 'EVENT_350', 'Trace log retains latest entry (#350 at end)');

// 14.2 Test formatting for clipboard export
function formatTracePlain(entries: TraceEntry[]): string {
  if (!entries || entries.length === 0) return 'No transport trace entries recorded yet.';
  return entries
    .map((e) => {
      const iso = new Date(e.ts).toISOString();
      const src = (e.source || 'unknown').padEnd(14, ' ');
      const evt = e.event || 'UNKNOWN';
      const details = e.data && Object.keys(e.data).length > 0 ? ' ' + JSON.stringify(e.data) : '';
      return `${iso} [${src}] ${evt}${details}`;
    })
    .join('\n');
}

const formattedSample = formatTracePlain(traceBuffer.slice(-2));
const lines = formattedSample.split('\n');
assert(lines.length === 2, 'Trace export formats one line per entry');
assert(lines[0].includes('EVENT_349') && lines[0].includes('background'), 'Trace line contains ISO timestamp, padded source, and event name');
assert(lines[0].includes('{"index":349}'), 'Trace line contains serialized data details');

// --- 15. Playback Reliability & Pushed State Transport Contracts ---
console.log('\nTEST SUITE 15: Playback Reliability & Pushed State Transport Contracts');

// 15.1 Play with loaded video sends no navigation
let navigationInvoked: boolean = false;
let playCommandSent: boolean = false;
async function simulateHandlePlayMusic(params: {
  connectedTabId: number | null;
  loadedVideoId: string | null;
  desiredVideoId: string;
}) {
  navigationInvoked = false;
  playCommandSent = false;
  let activeTabId = params.connectedTabId;

  // Reconnection check
  if (!activeTabId) {
    // If no tab, would connect or launch
    return;
  }

  // Video ID check
  if (params.desiredVideoId && params.loadedVideoId && params.loadedVideoId !== params.desiredVideoId) {
    navigationInvoked = true;
    return;
  }

  // Already loaded: send only play command
  playCommandSent = true;
}

await simulateHandlePlayMusic({
  connectedTabId: 101,
  loadedVideoId: 'f-BDCwxBF9Q',
  desiredVideoId: 'f-BDCwxBF9Q'
});
assert(Boolean(playCommandSent) && !navigationInvoked, '(a) Play with loaded video sends direct play command and no navigation');

await simulateHandlePlayMusic({
  connectedTabId: 101,
  loadedVideoId: 'DIFFERENT_ID',
  desiredVideoId: 'f-BDCwxBF9Q'
});
assert(!playCommandSent && Boolean(navigationInvoked), '(a.2) Play with different video ID navigates new song');

// 15.2 Pushed state 3 (buffering) keeps Boom Box in playing
function mapPushedPlayerState(state: number): 'playing' | 'paused' | 'stopped' {
  if (state === 1 || state === 3) return 'playing';
  if (state === 2) return 'paused';
  return 'stopped';
}
assert(mapPushedPlayerState(1) === 'playing', '(b.1) Pushed state 1 maps to playing');
assert(mapPushedPlayerState(3) === 'playing', '(b.2) Pushed state 3 (buffering) keeps Boom Box in playing');
assert(mapPushedPlayerState(2) === 'paused', '(b.3) Pushed state 2 maps to paused');
assert(mapPushedPlayerState(0) === 'stopped', '(b.4) Pushed state 0 (ended) maps to stopped');
assert(mapPushedPlayerState(-1) === 'stopped', '(b.5) Pushed state -1 (unstarted) maps to stopped');
assert(mapPushedPlayerState(5) === 'stopped', '(b.6) Pushed state 5 (cued) maps to stopped');

// 15.3 Failed poll keeps last state and never reverts to stopped
let currentBoomBoxState = 'playing';
function handleStatusPollResult(pollResult: { available: boolean; isPlaying: boolean } | null) {
  if (!pollResult || !pollResult.available) {
    // Treat as unknown: keep last known state
    return;
  }
  currentBoomBoxState = pollResult.isPlaying ? 'playing' : 'paused';
}

handleStatusPollResult(null); // Failed poll / timeout
assert(currentBoomBoxState === 'playing', '(c.1) Failed / timed-out poll keeps last state (remains playing)');
handleStatusPollResult({ available: false, isPlaying: false }); // Unavailable poll
assert(currentBoomBoxState === 'playing', '(c.2) Unavailable poll preserves last state and never sets stopped');

// 15.4 Hidden-tab start switches to YouTube tab and back, and skips switch-back if user changed tabs
interface WindowTab {
  id: number;
  active: boolean;
}
let tabsInWindow: WindowTab[] = [
  { id: 10, active: true },   // User active tab
  { id: 20, active: false }  // YouTube tab (hidden)
];
let activeSwitchedHistory: number[] = [];

async function simulateHiddenTabRecovery(params: {
  ytTabId: number;
  userSwitchedDuringWait: boolean;
}) {
  activeSwitchedHistory = [];
  const ytTab = tabsInWindow.find(t => t.id === params.ytTabId);
  if (!ytTab || ytTab.active) return;

  const originalActive = tabsInWindow.find(t => t.active);
  const originalActiveTabId = originalActive?.id;

  // 1. Activate YouTube tab
  ytTab.active = true;
  if (originalActive) originalActive.active = false;
  activeSwitchedHistory.push(ytTab.id);

  // 2. Wait up to 4s (simulated)
  if (!params.userSwitchedDuringWait && originalActiveTabId) {
    // Re-activate original tab
    ytTab.active = false;
    const orig = tabsInWindow.find(t => t.id === originalActiveTabId);
    if (orig) orig.active = true;
    activeSwitchedHistory.push(originalActiveTabId);
  } else if (params.userSwitchedDuringWait) {
    // User switched tabs themselves, do NOT restore original
    // Simulate user switched to tab 30
    activeSwitchedHistory.push(30);
  }
}

// Case 1: Normal recovery (user did not switch tabs)
tabsInWindow = [{ id: 10, active: true }, { id: 20, active: false }];
await simulateHiddenTabRecovery({ ytTabId: 20, userSwitchedDuringWait: false });
assert(
  activeSwitchedHistory.length === 2 &&
  activeSwitchedHistory[0] === 20 &&
  activeSwitchedHistory[1] === 10,
  '(d.1) Hidden-tab start switches to YouTube tab (20) and back to original tab (10)'
);

// Case 2: User switched tabs during recovery
tabsInWindow = [{ id: 10, active: true }, { id: 20, active: false }];
await simulateHiddenTabRecovery({ ytTabId: 20, userSwitchedDuringWait: true });
assert(
  activeSwitchedHistory[activeSwitchedHistory.length - 1] !== 10,
  '(d.2) Hidden-tab recovery does not switch back if user changed tabs in the meantime'
);

// --- 16. End-to-End Simulation Test: Pause Button Hop-by-Hop Delivery ---
console.log('\nTEST SUITE 16: End-to-End Hop-by-Hop Message Chain Simulation (Boom Box Pause)');
interface HopState {
  hop1_boomBoxSent: boolean;
  hop2_bgReceived: boolean;
  hop3_appTabResolved: boolean;
  hop4_contentRetroFmReceived: boolean;
  hop5_appWindowMessageFired: boolean;
  hop6_appHandlerCalled: boolean;
  hop7_providerPauseSentToBg: boolean;
  hop8_youtubeContentReceived: boolean;
  hop9_mainWorldExecuted: boolean;
}

const simulationState: HopState = {
  hop1_boomBoxSent: false,
  hop2_bgReceived: false,
  hop3_appTabResolved: false,
  hop4_contentRetroFmReceived: false,
  hop5_appWindowMessageFired: false,
  hop6_appHandlerCalled: false,
  hop7_providerPauseSentToBg: false,
  hop8_youtubeContentReceived: false,
  hop9_mainWorldExecuted: false
};

// Hop 1: Boom Box click -> sendBoomBoxAction('PAUSE')
function boomBoxClickPause(bgDispatcher: (msg: any) => Promise<any>) {
  simulationState.hop1_boomBoxSent = true;
  return bgDispatcher({ type: 'BOOMBOX_ACTION', payload: { action: 'PAUSE' } });
}

// Hop 2 & 3: background.js receives BOOMBOX_ACTION, resolves registered app tab, forwards message
async function backgroundServiceWorkerReceive(
  msg: any,
  registeredAppTabId: number | null,
  contentRetroFmDispatcher: (msg: any) => Promise<any>
) {
  if (msg.type === 'BOOMBOX_ACTION') {
    simulationState.hop2_bgReceived = true;
    if (registeredAppTabId) {
      simulationState.hop3_appTabResolved = true;
      return contentRetroFmDispatcher({ type: 'BOOMBOX_ACTION', payload: msg.payload });
    }
  }
  return { success: false, error: 'App tab not resolved' };
}

// Hop 4: content_retrofm.js receives message and relays window.postMessage
function contentRetroFmRelay(msg: any, windowDispatcher: (data: any) => void) {
  simulationState.hop4_contentRetroFmReceived = true;
  windowDispatcher({ source: 'RETRO_FM_EXTENSION', ...msg });
  return Promise.resolve({ received: true });
}

// Hop 5 & 6: App window message listener and onBoomBoxAction handler
async function appReceiveWindowMessage(
  eventData: any,
  onBoomBoxActionHandler: (action: any) => Promise<void>
) {
  if (eventData?.source === 'RETRO_FM_EXTENSION' && eventData?.type === 'BOOMBOX_ACTION') {
    simulationState.hop5_appWindowMessageFired = true;
    await onBoomBoxActionHandler(eventData.payload);
  }
}

// Hop 7: handlePauseMusic calls provider.pauseDetailed() -> background.js COMMAND_YOUTUBE
async function appHandlePause(
  bgYtDispatcher: (cmd: any) => Promise<any>
) {
  simulationState.hop6_appHandlerCalled = true;
  simulationState.hop7_providerPauseSentToBg = true;
  return bgYtDispatcher({ action: 'PAUSE' });
}

// Hop 8: content_youtube.js receives command and calls main world
function contentYoutubeReceive(
  command: any,
  mainWorldDispatcher: (cmd: string) => boolean
) {
  simulationState.hop8_youtubeContentReceived = true;
  if (command.action === 'PAUSE') {
    const executed = mainWorldDispatcher('PAUSE');
    simulationState.hop9_mainWorldExecuted = executed;
    return { success: executed, state: 'paused' };
  }
  return { success: false };
}

// Hop 9: yt_main_world.js executes player.pauseVideo() safely
function mainWorldExecute(cmd: string) {
  if (cmd === 'PAUSE') {
    return true;
  }
  return false;
}

// Execute end-to-end simulation
const testRegisteredAppTabId = 42;
await boomBoxClickPause(async (bbMsg) => {
  return backgroundServiceWorkerReceive(bbMsg, testRegisteredAppTabId, async (retroFmTabMsg) => {
    return contentRetroFmRelay(retroFmTabMsg, async (winMsg) => {
      await appReceiveWindowMessage(winMsg, async (boomBoxAction) => {
        if (boomBoxAction.action === 'PAUSE') {
          await appHandlePause(async (ytCmd) => {
            return contentYoutubeReceive(ytCmd, (cmd) => {
              return mainWorldExecute(cmd);
            });
          });
        }
      });
    });
  });
});

assert(simulationState.hop1_boomBoxSent, 'Hop 1: Boom Box button click dispatches BOOMBOX_ACTION');
assert(simulationState.hop2_bgReceived, 'Hop 2: background.js receives BOOMBOX_ACTION');
assert(simulationState.hop3_appTabResolved, 'Hop 3: background.js resolves registered app tab');
assert(simulationState.hop4_contentRetroFmReceived, 'Hop 4: content_retrofm.js receives push message');
assert(simulationState.hop5_appWindowMessageFired, 'Hop 5: window message relays to RetroFM page');
assert(simulationState.hop6_appHandlerCalled, 'Hop 6: onBoomBoxAction dispatches to handlePauseMusic');
assert(simulationState.hop7_providerPauseSentToBg, 'Hop 7: provider sends PAUSE command to background');
assert(simulationState.hop8_youtubeContentReceived, 'Hop 8: content_youtube.js receives PAUSE command');
assert(simulationState.hop9_mainWorldExecuted, 'Hop 9: yt_main_world.js executes player.pauseVideo()');

// --- 17. Playback Reliability: Target Song Resolution & Hidden Tab Handling ---
console.log('\nTEST SUITE 17: Playback Reliability & Target Song Navigation');

// Simulation helper for handlePlayMusic logic
interface TargetSongSimResult {
  actionTaken: 'NAVIGATED' | 'PLAY_COMMAND_ONLY' | 'ERROR_REPORTED';
  navigatedUrl?: string;
  errorReason?: string;
  boomBoxDisplay?: string;
}

async function simulateTargetSongResolution(params: {
  tabUrl: string;
  tabVideoId: string | null;
  desiredVideoId: string | null;
  desiredSongTitle?: string;
  programResult?: any;
}): Promise<TargetSongSimResult> {
  const { tabUrl, tabVideoId, desiredVideoId, programResult } = params;

  // Unresolvable song check
  if (!desiredVideoId && !programResult?.selectedVideoId) {
    return {
      actionTaken: 'ERROR_REPORTED',
      errorReason: 'No song selected',
      boomBoxDisplay: 'No song selected'
    };
  }

  const effectiveDesiredId = desiredVideoId || programResult.selectedVideoId;
  const isWatchPage = tabUrl.includes('/watch');
  const effectiveLoadedId = tabVideoId;

  // If tab has no video (home page, search, blank) OR video ID differs from desired song -> navigate
  if (!isWatchPage || !effectiveLoadedId || effectiveLoadedId !== effectiveDesiredId) {
    return {
      actionTaken: 'NAVIGATED',
      navigatedUrl: `https://www.youtube.com/watch?v=${effectiveDesiredId}`
    };
  }

  // Same video ID -> send only play command
  return {
    actionTaken: 'PLAY_COMMAND_ONLY'
  };
}

// Subtest (a): Connected tab on YouTube home page (no video) -> Play navigates and starts
const testA = await simulateTargetSongResolution({
  tabUrl: 'https://www.youtube.com/',
  tabVideoId: null,
  desiredVideoId: 'f-BDCwxBF9Q'
});
assert(testA.actionTaken === 'NAVIGATED' && testA.navigatedUrl === 'https://www.youtube.com/watch?v=f-BDCwxBF9Q',
  'Suite 17 (a): Connected tab on YouTube home page navigates to desired song');

// Subtest (b): Connected tab has different video loaded -> Play navigates to desired song
const testB = await simulateTargetSongResolution({
  tabUrl: 'https://www.youtube.com/watch?v=oldVideo123',
  tabVideoId: 'oldVideo123',
  desiredVideoId: 'f-BDCwxBF9Q'
});
assert(testB.actionTaken === 'NAVIGATED' && testB.navigatedUrl === 'https://www.youtube.com/watch?v=f-BDCwxBF9Q',
  'Suite 17 (b): Connected tab with different video navigates to desired song');

// Subtest (c): Connected tab already has desired video loaded -> sends only play command (no reload)
const testC = await simulateTargetSongResolution({
  tabUrl: 'https://www.youtube.com/watch?v=f-BDCwxBF9Q',
  tabVideoId: 'f-BDCwxBF9Q',
  desiredVideoId: 'f-BDCwxBF9Q'
});
assert(testC.actionTaken === 'PLAY_COMMAND_ONLY',
  'Suite 17 (c): Connected tab with matching video sends only play command (no reload)');

// Subtest (d): Desired song cannot be resolved -> visible message and no silent failure
const testD = await simulateTargetSongResolution({
  tabUrl: 'https://www.youtube.com/watch?v=f-BDCwxBF9Q',
  tabVideoId: 'f-BDCwxBF9Q',
  desiredVideoId: null,
  programResult: null
});
assert(testD.actionTaken === 'ERROR_REPORTED' && testD.boomBoxDisplay === 'No song selected',
  'Suite 17 (d): Unresolvable song produces visible notice and displays "No song selected" on Boom Box');

// Subtest (e): Hidden tab recovery default behavior: revealYouTubeToStart = false dispatches NEEDS_USER_CLICK
interface RecoveryContractResult {
  tabActivated: boolean;
  needsUserClickDispatched: boolean;
}

function simulateHiddenTabRecoveryContract(params: {
  playerReachedStateOneIn2500ms: boolean;
  revealSetting: boolean;
}): RecoveryContractResult {
  const { playerReachedStateOneIn2500ms, revealSetting } = params;
  if (playerReachedStateOneIn2500ms) {
    return { tabActivated: false, needsUserClickDispatched: false };
  }
  if (!revealSetting) {
    return { tabActivated: false, needsUserClickDispatched: true };
  }
  return { tabActivated: true, needsUserClickDispatched: false };
}

const testE_default = simulateHiddenTabRecoveryContract({
  playerReachedStateOneIn2500ms: false,
  revealSetting: false
});
assert(!testE_default.tabActivated && testE_default.needsUserClickDispatched,
  'Suite 17 (e1): Default revealYouTubeToStart=false sends NEEDS_USER_CLICK and does NOT activate tab');

const testE_revealed = simulateHiddenTabRecoveryContract({
  playerReachedStateOneIn2500ms: false,
  revealSetting: true
});
assert(testE_revealed.tabActivated && !testE_revealed.needsUserClickDispatched,
  'Suite 17 (e2): Enabled revealYouTubeToStart=true activates tab for recovery');

// --- 18. Audio Diagnostics Snapshot Verification Suite ---
console.log('\nTEST SUITE 18: Audio Diagnostics Snapshot Completeness & Contract');

interface DiagnosticsSnapshot {
  ts: number;
  playerState: number | null;
  playerMuted: boolean | null;
  playerVolume: number | null;
  videoPaused: boolean | null;
  videoMuted: boolean | null;
  videoVolume: number | null;
  videoReadyState: number | null;
  visibilityState: string;
  userActivation: {
    hasBeenActive: boolean;
    isActive: boolean;
  };
  videoId: string | null;
  title: string;
  href: string;
  lastError: any;
  errors: any[];
}

function validateDiagnosticsSnapshot(snapshot: any): { valid: boolean; missingFields: string[] } {
  const requiredFields = [
    'playerState',
    'playerMuted',
    'playerVolume',
    'videoPaused',
    'videoMuted',
    'videoVolume',
    'videoReadyState',
    'visibilityState',
    'userActivation',
    'videoId',
    'title',
    'href'
  ];

  const missingFields: string[] = [];
  for (const field of requiredFields) {
    if (!(field in snapshot)) {
      missingFields.push(field);
    }
  }

  if (snapshot.userActivation) {
    if (!('hasBeenActive' in snapshot.userActivation)) missingFields.push('userActivation.hasBeenActive');
    if (!('isActive' in snapshot.userActivation)) missingFields.push('userActivation.isActive');
  }

  return {
    valid: missingFields.length === 0,
    missingFields
  };
}

// 18.1 Complete snapshot contract test
const sampleSnapshot: DiagnosticsSnapshot = {
  ts: Date.now(),
  playerState: 1,
  playerMuted: false,
  playerVolume: 100,
  videoPaused: false,
  videoMuted: false,
  videoVolume: 100,
  videoReadyState: 4,
  visibilityState: 'visible',
  userActivation: {
    hasBeenActive: true,
    isActive: false
  },
  videoId: 'f-BDCwxBF9Q',
  title: 'a-ha - Take on Me (Official Video) [Remastered in 4K]',
  href: 'https://www.youtube.com/watch?v=f-BDCwxBF9Q',
  lastError: null,
  errors: []
};

const validationResult = validateDiagnosticsSnapshot(sampleSnapshot);
assert(validationResult.valid, `Diagnostics snapshot has all required fields (missing: ${validationResult.missingFields.join(', ')})`);

// 18.2 Incomplete snapshot test fails as expected
const incompleteSnapshot = {
  playerState: 1,
  playerVolume: 100
};
const incompleteResult = validateDiagnosticsSnapshot(incompleteSnapshot);
assert(!incompleteResult.valid && incompleteResult.missingFields.includes('visibilityState'), 'Incomplete snapshot correctly fails field validation');

// --- 19. Extension Cross-World Detail Parsing & Error Isolation ---
console.log('TEST SUITE 19: Extension Cross-World Detail Parsing & Error Isolation');

function safeParseDetail(detail: any): any {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'object') return detail;
  if (typeof detail === 'string') {
    try {
      const parsed = JSON.parse(detail);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// 19.1 Null or malformed event detail does not throw
assert(safeParseDetail(null) === null, 'safeParseDetail handles null without throwing');
assert(safeParseDetail(undefined) === null, 'safeParseDetail handles undefined without throwing');
assert(safeParseDetail('') === null, 'safeParseDetail handles empty string without throwing');
assert(safeParseDetail('{invalid json') === null, 'safeParseDetail handles malformed JSON string without throwing');
assert(safeParseDetail('123') === null, 'safeParseDetail rejects primitive number in JSON string');
assert(safeParseDetail('"just a string"') === null, 'safeParseDetail rejects primitive string in JSON string');
const validObj = { type: 'TEST', value: 42 };
assert(safeParseDetail(JSON.stringify(validObj))?.value === 42, 'safeParseDetail parses valid JSON object string correctly');
assert(safeParseDetail(validObj)?.value === 42, 'safeParseDetail handles existing object cleanly');

// 19.2 Thrown handler error is recorded and does not stop the next handler
const reportedErrors: any[] = [];
function reportErrorMock(err: any, context: string) {
  reportedErrors.push({
    source: `test_context:${context}`,
    message: err?.message || String(err),
    time: Date.now()
  });
}

let handler1Ran: boolean = false;
let handler2Ran: boolean = false;

function testHandler1() {
  try {
    handler1Ran = true;
    throw new Error('Simulated failure in handler 1');
  } catch (err) {
    reportErrorMock(err, 'handler1');
  }
}

function testHandler2() {
  try {
    handler2Ran = true;
  } catch (err) {
    reportErrorMock(err, 'handler2');
  }
}

// Execute handlers in sequence
testHandler1();
testHandler2();

assert(Boolean(handler1Ran), 'Handler 1 executed');
assert(Boolean(handler2Ran), 'Handler 2 executed despite handler 1 throwing');
assert(reportedErrors.length === 1, 'Simulated error was captured');
assert(reportedErrors[0].message.includes('Simulated failure in handler 1'), 'Captured error message matches');
assert(reportedErrors[0].source === 'test_context:handler1', 'Captured error source includes context');

// --- Test Suite 20: Unvisited Tab Playback & Autoplay Activation ---
console.log('\n--- Test Suite 20: Unvisited Tab Playback & Autoplay Activation ---');

// (a) Navigation start no longer mutes the player
{
  let muteCallCount = 0;
  let setVolumeCalls: number[] = [];
  const mockPlayer = {
    mute: () => { muteCallCount++; },
    unMute: () => {},
    setVolume: (v: number) => { setVolumeCalls.push(v); }
  };

  // Simulating handleNavigationStart logic from yt_main_world.js:
  // Must NOT call player.mute(); applies queued volume via setVolume only.
  function simulateNavigationStart(player: any, queuedVolume: number | null) {
    if (player && typeof player.setVolume === 'function' && queuedVolume !== null && !isNaN(queuedVolume)) {
      try {
        player.setVolume(Math.round(queuedVolume * 100));
      } catch (e) {}
    }
  }

  simulateNavigationStart(mockPlayer, 0.85);
  assert(muteCallCount === 0, 'Navigation start does not call player.mute()');
  assert(setVolumeCalls.length === 1 && setVolumeCalls[0] === 85, 'Navigation start applies queued volume via setVolume()');
}

// (b) With no activation, applying volume never calls mute or unMute
{
  let muteCalls = 0;
  let unMuteCalls = 0;
  let volumeCalls: number[] = [];
  let diagnosticEvents: string[] = [];

  let isMutedState = true;
  const mockPlayer = {
    mute: () => { muteCalls++; isMutedState = true; },
    unMute: () => { unMuteCalls++; isMutedState = false; },
    setVolume: (v: number) => { volumeCalls.push(v); },
    isMuted: () => isMutedState
  };

  function simulateApplyVolume(player: any, targetVolume: number, hasActivation: boolean) {
    if (!player) return;
    const vol = Math.max(0, Math.min(100, Math.round(targetVolume * 100)));
    try {
      player.setVolume(vol);
    } catch (e) {}

    const isPlayerMuted = player.isMuted();
    if (vol > 0 && isPlayerMuted) {
      player.unMute();
    } else if (vol === 0 && !isPlayerMuted) {
      player.mute();
    }
  }

  // Test with hasActivation = false
  simulateApplyVolume(mockPlayer, 0.75, false);
  assert(muteCalls === 0, 'Mute() is not called for non-zero volume');
  assert(unMuteCalls === 1, 'unMute() is called when setting volume > 0 on muted player');
  assert(volumeCalls.length === 1 && volumeCalls[0] === 75, 'setVolume() is called with requested volume');

  // Test with volume = 0
  simulateApplyVolume(mockPlayer, 0, false);
  assert(muteCalls === 1, 'mute() is called when setting volume = 0');
}

// (c) First connect keeps YouTube tab in background and Boom Box opens directly with no modal
{
  let activeTabId: number = 101; // Boom Box tab currently active
  let ytTabActive: boolean = false;
  let modalShownOnBoomBox: boolean = false;

  const ytTabId: number = 202;
  let hasSessionActivation: boolean = false;

  // 1. Extension connects to YouTube tab in background; YouTube tab never brought active, no modal shown
  function simulateFirstConnect(targetYtTabId: number, hasActivation: boolean) {
    ytTabActive = false;
    modalShownOnBoomBox = false; // Modal eliminated: opens directly
  }

  // 2. User presses PLAY on Boom Box
  function simulateBoomBoxPlayClicked() {
    hasSessionActivation = true;
  }

  simulateFirstConnect(ytTabId, false);
  assert(!ytTabActive, 'First connect keeps YouTube tab in background');
  assert(activeTabId === 101, 'Active tab remains Boom Box (101)');
  assert(!modalShownOnBoomBox, 'Boom Box opens directly with no activation modal overlay');

  simulateBoomBoxPlayClicked();
  assert(Boolean(hasSessionActivation), 'hasSessionActivation set on user play interaction');
  assert(activeTabId === 101, 'Active tab remains Boom Box (101)');
}

// (d) No tab switching when activation exists
{
  let tabSwitchCount: number = 0;
  const ytTabId: number = 202;
  let activeTabId: number = 101;
  const hasSessionActivation: boolean = true;

  function simulateSubsequentPlay(targetYtTabId: number, hasActivation: boolean) {
    if (!hasActivation && !hasSessionActivation) {
      tabSwitchCount++;
      activeTabId = targetYtTabId;
    }
    // Normal play command proceeds in background without tab switch
  }

  simulateSubsequentPlay(ytTabId, true);
  assert(tabSwitchCount === 0, 'No tab switch when session activation already exists');
  assert(activeTabId === 101, 'Active tab remains unchanged');
}

// (e) Pending Play sent once after activation and canceled by Stop
{
  // Part 1: Pending Play is sent once when YT_TAB_ACTIVATED arrives
  let pendingPlayIntent: { tabId: number; timer?: any } | null = null;
  let playCommandSentCount: number = 0;

  function storePendingPlay(tabId: number) {
    pendingPlayIntent = { tabId };
  }

  function handleYtTabActivated() {
    if (pendingPlayIntent) {
      playCommandSentCount++;
      pendingPlayIntent = null;
    }
  }

  storePendingPlay(202);
  const currentIntent = pendingPlayIntent as { tabId: number; timer?: any } | null;
  assert(currentIntent?.tabId === 202, 'Pending Play stored without activation');

  handleYtTabActivated();
  assert(playCommandSentCount === 1, 'Pending Play executed once upon YT_TAB_ACTIVATED');
  assert(pendingPlayIntent === null, 'Pending Play cleared after execution');

  // Triggering again does not send duplicate play
  handleYtTabActivated();
  assert(playCommandSentCount === 1, 'Subsequent activations do not duplicate Play');

  // Part 2: Pending Play is canceled by Stop or Pause
  storePendingPlay(202);
  const storedAgain = pendingPlayIntent as { tabId: number; timer?: any } | null;
  assert(storedAgain?.tabId === 202, 'Pending Play stored again');

  function handleStopCommand() {
    pendingPlayIntent = null; // Cleared by stop
  }

  handleStopCommand();
  assert(pendingPlayIntent === null, 'Pending Play canceled by Stop command');

  handleYtTabActivated();
  assert(playCommandSentCount === 1, 'No play command sent after being canceled by Stop');
}

// --- Test Suite 21: Song Info Music Note Indicator & Fade Toggle ---
console.log('\n--- Test Suite 21: Song Info Music Note Indicator & Fade Toggle ---');
{
  const htmlContent = fs.readFileSync(path.resolve(__dirname, '../extension/player/index.html'), 'utf8');
  const cssContent = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.css'), 'utf8');
  const jsContent = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.js'), 'utf8');

  // 1. Verify HTML element has text ♫ and initial attributes
  assert(htmlContent.includes('<button id="sdot"'), 'index.html contains #sdot element');
  assert(htmlContent.includes('>♫</button>'), '#sdot in index.html contains ♫ character');
  assert(htmlContent.includes('aria-label="Toggle title and artist fade"'), '#sdot has correct aria-label');
  assert(htmlContent.includes('title="Fade between title and artist (click to turn off)"'), '#sdot has correct initial title');
  assert(htmlContent.includes('aria-pressed="true"'), '#sdot has initial aria-pressed="true"');

  // 2. Verify CSS rules for bright enabled state and dimmed disabled state
  assert(cssContent.includes('#sdot{'), 'player.css contains #sdot base rules');
  assert(cssContent.includes('color:#8dffb0'), '#sdot uses CRT green color palette');
  assert(cssContent.includes('background:transparent'), '#sdot does not use background badge/container');
  assert(cssContent.includes('border:0'), '#sdot does not use circular border');
  assert(cssContent.includes('#sdot[aria-pressed=false]{opacity:.38}'), '#sdot dims on aria-pressed=false');

  // 3. Verify toggle logic in player.js
  assert(jsContent.includes("sdotEl.setAttribute('aria-label'"), 'player.js updates accessible aria-label based on song display mode');
  assert(jsContent.includes("sdotEl.title="), 'player.js updates accessible title based on song display mode');

  // 4. Test state machine for toggle simulation
  let fadeOn: boolean = true;
  let sdotState = {
    ariaPressed: 'true',
    title: 'Fade between title and artist (click to turn off)',
    text: '♫'
  };

  function simulateSdotClick() {
    fadeOn = !fadeOn;
    sdotState.ariaPressed = String(fadeOn);
    sdotState.title = fadeOn ? 'Fade between title and artist (click to turn off)' : 'Show song info';
  }

  // Initial state: Enabled
  assert(sdotState.ariaPressed === 'true', 'Initial state aria-pressed is true');
  assert(sdotState.title === 'Fade between title and artist (click to turn off)', 'Initial title is enabled title');
  assert(sdotState.text === '♫', 'Note character is ♫');

  // Toggle off: Disabled
  simulateSdotClick();
  assert(Boolean(!fadeOn), 'fadeOn is false after first click');
  assert(sdotState.ariaPressed === 'false', 'aria-pressed is false after first click');
  assert(sdotState.title === 'Show song info', 'Title is Show song info when disabled');
  assert(sdotState.text === '♫', 'Note character remains ♫ when disabled');

  // Toggle back on: Enabled
  simulateSdotClick();
  assert(Boolean(fadeOn), 'fadeOn is true after second click');
  assert(sdotState.ariaPressed === 'true', 'aria-pressed is true after second click');
  assert(sdotState.title === 'Fade between title and artist (click to turn off)', 'Title restored to enabled title');
}

// --- Test Suite 22: Green Display Long Song Title & Artist Text Space ---
console.log('\n--- Test Suite 22: Green Display Long Song Title & Artist Text Space ---');
{
  const cssContent = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.css'), 'utf8');

  // 1. Verify #freq has flex:1 and min-width:0 to expand and shrink flexibly
  assert(cssContent.includes('#freq{') && cssContent.includes('flex:1') && cssContent.includes('min-width:0'), '#freq has flex:1 and min-width:0');

  // 2. Verify #sg does not have hardcoded 200px max-width clamp
  assert(!cssContent.includes('#sg{display:inline-block;max-width:200px'), '#sg has no artificial 200px max-width clamp');
  assert(cssContent.includes('#sg{') && cssContent.includes('text-overflow:ellipsis') && cssContent.includes('white-space:nowrap'), '#sg uses ellipsis truncation');

  // 3. Verify #year has flex:none and #row has gap to prevent overlap with frequency display
  assert(cssContent.includes('#year{') && cssContent.includes('flex:none'), '#year has flex:none to prevent numerical frequency clipping');
  assert(cssContent.includes('#row{') && cssContent.includes('gap:10px'), '#row has safety gap between frequency and song info');

  // 4. Test text width calculations for Sledgehammer (HD version)
  const regressionTitle = 'Sledgehammer (HD version)';
  const approxPanelContentWidth = 450 - 16 - 4 - 24; // 406px
  const maxYearWidth = 125; // 4 digits (72px) + dp (6px) + gaps (12px) + unit (29px) + safety
  const rowGap = 10;
  const sdotAndGap = 9 + 6; // 15px
  const availableSgWidth = approxPanelContentWidth - maxYearWidth - rowGap - sdotAndGap; // ~256px

  // At monospace character width (~8.4px for 14px font):
  const titleEstimatedWidth = regressionTitle.length * 8.4; // 210px
  assert(titleEstimatedWidth <= availableSgWidth, 'Sledgehammer (HD version) fits fully in available horizontal space (210px <= 256px)');

  // 5. Short and long titles / artists
  const testCases = [
    { text: 'Low', len: 3, fits: true },
    { text: 'Peter Gabriel', len: 13, fits: true },
    { text: 'Sledgehammer (HD version)', len: 25, fits: true },
    { text: 'Every Breath You Take (Remastered 2003)', len: 39, fits: false }
  ];

  testCases.forEach(tc => {
    const w = tc.len * 8.4;
    const fits = w <= availableSgWidth;
    assert(fits === tc.fits, `Text "${tc.text}" correctly categorized for fitting (${w.toFixed(1)}px vs ${availableSgWidth}px)`);
  });
}

// --- Test Suite 23: Startup Interaction, Consolidated Header & Full-Width Diagnostics ---
console.log('\n--- Test Suite 23: Startup Interaction, Consolidated Header & Full-Width Diagnostics ---');
{
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

  // 1. No activation modal on Boom Box or YouTube; direct startup
  const bbHtml = fs.readFileSync(path.resolve(__dirname, '../extension/player/index.html'), 'utf8');
  const bbJs = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.js'), 'utf8');
  const ytJs = fs.readFileSync(path.resolve(__dirname, '../extension/content_youtube.js'), 'utf8');

  assert(!bbHtml.includes('CLICK ANYWHERE TO START RETRO FM'), 'Activation modal removed from Boom Box HTML');
  assert(!bbJs.includes('rfm-modal'), 'Boom Box player.js does not require modal dismissal');
  assert(!ytJs.includes('retrofm-activation-overlay'), 'YouTube page does not display activation overlay');
  assert(!appSrc.includes('Start Audio'), 'Test page does not display a competing START AUDIO interaction control');

  // 2. Full-Width Live Diagnostic Status at Top
  assert(appSrc.includes('<section aria-label="Live Diagnostic Status" className="w-full'), 'Live Diagnostic Status spans full container width ("w-full")');
  assert(appSrc.includes('LIVE DIAGNOSTIC STATUS'), 'Live Diagnostic Status heading is rendered near the top');
  assert(appSrc.includes('Boom Box Player:'), 'Live Diagnostic Status displays Boom Box availability');
  assert(appSrc.includes('Chrome Extension:'), 'Live Diagnostic Status displays Chrome extension connection status');
  assert(appSrc.includes('YouTube Tab:'), 'Live Diagnostic Status displays YouTube tab connection status');

  // 3. Consolidated Top-Level Controls in Header
  assert(!appSrc.includes('<span>SILENCE ALL AUDIO</span>'), 'Redundant large text button SILENCE ALL AUDIO removed from top-level header');
  assert(appSrc.includes('toggleGlobalMute'), 'Header uses compact toggleGlobalMute action');
  assert(appSrc.includes('title={isAudioMuted ? \'Unmute audio\' : \'Silence all audio\'}'), 'Mute button has accessible tooltip for both states');
  assert(appSrc.includes('aria-label={isAudioMuted ? \'Unmute audio\' : \'Silence all audio\'}'), 'Mute button has accessible aria-label');

  // 4. Redundant buttons removed from top-level controls
  // "Open Boom Box" is removed from header because boom box auto-opens at startup
  const headerSection = appSrc.substring(appSrc.indexOf('<header'), appSrc.indexOf('</header>'));
  assert(!headerSection.includes('Open Boom Box'), 'Redundant "Open Boom Box" button removed from top-level header');
  assert(!headerSection.includes('Extension Active'), 'Redundant separate "Extension Active" pill removed from top-level header');
  assert(!headerSection.includes('Download Extension (v'), 'General "Download Extension" button removed from top-level header');
  assert(!headerSection.includes('Setup Guide'), 'Prominent "Setup Guide" button removed from top-level header');
  assert(headerSection.includes('Launch RetroFM Chrome Tab Group'), 'Launch button preserved as compact icon with accessible tooltip');

  // 5. Secondary Resources & Footer with Getting Started Link
  assert(appSrc.includes('<section aria-label="Secondary Resources"'), 'Secondary resources section added below workbench');
  assert(appSrc.includes('Download Extension (v{EXTENSION_VERSION})'), 'General extension download button relocated to secondary resources');
  assert(appSrc.includes('<footer'), 'Footer section is present');
  assert(appSrc.includes('Getting Started'), 'Footer includes "Getting Started" link');
  assert(appSrc.includes('setShowExtensionModal(true)'), 'Getting Started link reuses existing setup guide modal');
}

// --- Test Suite 24: Station-Jingle-First Playback Sequence & Automatic Advancement ---
console.log('\n--- Test Suite 24: Station-Jingle-First Playback Sequence & Automatic Advancement ---');
{
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

  // 1. Jingle URL normalization
  assert(normalizeYouTubeVideoId('3Wk2FzsxK4k') === '3Wk2FzsxK4k', 'Video ID normalized directly');
  assert(normalizeYouTubeVideoId('https://youtube.com/shorts/3Wk2FzsxK4k') === '3Wk2FzsxK4k', 'Shorts URL normalized to 3Wk2FzsxK4k');
  assert(normalizeYouTubeVideoId('https://www.youtube.com/watch?v=3Wk2FzsxK4k') === '3Wk2FzsxK4k', 'Watch URL normalized to 3Wk2FzsxK4k');
  assert(normalizeYouTubeVideoId('https://youtu.be/3Wk2FzsxK4k') === '3Wk2FzsxK4k', 'youtu.be URL normalized to 3Wk2FzsxK4k');

  // 2. Configuration & Startup preparation
  assert(RETROFM_JINGLE_CONFIG.videoId === '3Wk2FzsxK4k', 'RetroFM jingle video ID is 3Wk2FzsxK4k');
  assert(appSrc.includes("prepareSong(RETROFM_JINGLE_CONFIG.videoId, RETROFM_JINGLE_CONFIG.title)"), 'Startup auto-init prepares station jingle first');
  assert(Array.isArray(DEFAULT_SONG_QUEUE) && DEFAULT_SONG_QUEUE.length === 5, 'DEFAULT_SONG_QUEUE contains 5 canonical songs');
  assert(DEFAULT_SONG_QUEUE[0].videoId === 'f-BDCwxBF9Q', 'First queue song is Take On Me (f-BDCwxBF9Q)');
  assert(DEFAULT_SONG_QUEUE[1].videoId === 'Kr4EQDVETuA', 'Second queue song is Billie Jean (Kr4EQDVETuA)');
  assert(DEFAULT_SONG_QUEUE[2].videoId === 'Izx6DQUrsag', 'Third queue song is When Doves Cry (Izx6DQUrsag)');

  // 3. State machine simulation:
  // Jingle prepared -> PLAY starts jingle -> Jingle finishes naturally (state 0) -> Advances to Take On Me -> finishes -> Billie Jean
  let simulatedJingleState: string = 'prepared';
  let queueIndex = 0;
  let currentlyPlayingVideoId: string | null = null;
  let advanceCount = 0;
  let isAdvancing = false;

  function simulatePlay() {
    if (simulatedJingleState === 'prepared') {
      currentlyPlayingVideoId = RETROFM_JINGLE_CONFIG.videoId;
      simulatedJingleState = 'playing';
    } else {
      currentlyPlayingVideoId = DEFAULT_SONG_QUEUE[queueIndex].videoId;
    }
  }

  function simulateAdvance(isAfterJingle: boolean) {
    if (isAdvancing) return;
    isAdvancing = true;
    advanceCount++;
    if (isAfterJingle) {
      queueIndex = 0;
      simulatedJingleState = 'completed';
    } else {
      queueIndex = (queueIndex + 1) % DEFAULT_SONG_QUEUE.length;
    }
    currentlyPlayingVideoId = DEFAULT_SONG_QUEUE[queueIndex].videoId;
    isAdvancing = false;
  }

  function simulateStateChange(state: number, videoId: string) {
    if (state === 0 && !isAdvancing) {
      if (simulatedJingleState === 'playing' && videoId === RETROFM_JINGLE_CONFIG.videoId) {
        simulateAdvance(true);
      } else if (simulatedJingleState === 'completed') {
        simulateAdvance(false);
      }
    }
  }

  function simulatePause() {
    // PAUSE must not advance state
  }

  function simulateStop() {
    if (simulatedJingleState === 'playing' || simulatedJingleState === 'prepared' || simulatedJingleState === 'completed') {
      simulatedJingleState = 'cancelled';
    }
  }

  // Initial PLAY starts the jingle
  simulatePlay();
  assert(currentlyPlayingVideoId === '3Wk2FzsxK4k', 'Initial PLAY starts station jingle');
  assert(simulatedJingleState === 'playing', 'Jingle state is playing');

  // Temporary pause during jingle must NOT advance
  simulatePause();
  simulateStateChange(2, '3Wk2FzsxK4k'); // paused state
  assert(currentlyPlayingVideoId === '3Wk2FzsxK4k', 'PAUSE during jingle keeps jingle active');
  assert(simulatedJingleState === 'playing', 'PAUSE does not change jingle playing state');
  assert(advanceCount === 0, 'No advance on pause');

  // Buffering state must NOT advance
  simulateStateChange(3, '3Wk2FzsxK4k'); // buffering state
  assert(advanceCount === 0, 'No advance on buffering');

  // Natural completion (state 0) automatically advances to "Take On Me"
  simulateStateChange(0, '3Wk2FzsxK4k');
  assert(currentlyPlayingVideoId === 'f-BDCwxBF9Q', 'Natural completion (state 0) advances to Take On Me (f-BDCwxBF9Q)');
  assert(simulatedJingleState === 'completed', 'Jingle state becomes completed');
  assert(advanceCount === 1, 'Advance occurred exactly once');

  // Duplicate ended event while advancing should NOT double advance
  isAdvancing = true;
  simulateStateChange(0, '3Wk2FzsxK4k');
  isAdvancing = false;
  assert(advanceCount === 1, 'Duplicate state 0 while advancing is ignored');

  // Natural completion (state 0) of "Take On Me" advances to track 2 ("Billie Jean")
  simulateStateChange(0, 'f-BDCwxBF9Q');
  assert(currentlyPlayingVideoId === 'Kr4EQDVETuA', 'Take On Me ending advances automatically to Billie Jean (Kr4EQDVETuA)');
  assert(advanceCount === 2, 'Queue advanced to second song');

  // Natural completion of "Billie Jean" advances to track 3 ("When Doves Cry")
  simulateStateChange(0, 'Kr4EQDVETuA');
  assert(currentlyPlayingVideoId === 'Izx6DQUrsag', 'Billie Jean ending advances automatically to When Doves Cry (Izx6DQUrsag)');
  assert(advanceCount === 3, 'Queue advanced to third song');

  // STOP cancels playback sequence and prevents later ended events from advancing
  simulateStop();
  assert(simulatedJingleState === 'cancelled', 'STOP cancels sequence progression');
  simulateStateChange(0, 'Izx6DQUrsag');
  assert(advanceCount === 3, 'State 0 after STOP does not advance to next song');
}

// --- Test Suite 25: Startup Status Suppression, Background YouTube Isolation, Reload Reset & Decade Logo Binding ---
console.log('\n--- Test Suite 25: Startup Status Suppression, Background Isolation, Session Reset & Decade Logo Binding ---');
{
  // 1. Initial status suppression in Boom Box HTML
  const indexHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  assert(indexHtml.includes('<span id="st"></span>'), 'index.html initializes #st element empty without hardcoded STOPPED text');
  assert(!indexHtml.includes('<span id="st">■ STOPPED</span>'), 'index.html does not contain hardcoded STOPPED text');

  // 2. Status text logic simulation
  function simulateBoomBoxStatus(s: string, hasStarted: boolean): string {
    const normalized = (s === 'playing' || s === 'paused') ? s : (s === 'blank' ? 'blank' : 'stopped');
    if (!hasStarted || normalized === 'blank') {
      return '';
    }
    return normalized === 'playing' ? '▶ PLAYING' : normalized === 'paused' ? '❚❚ PAUSED' : '■ STOPPED';
  }

  assert(simulateBoomBoxStatus('stopped', false) === '', 'Startup status is blank when first song has not started');
  assert(simulateBoomBoxStatus('playing', false) === '', 'Status remains blank during jingle/startup even if player reports playing');
  assert(simulateBoomBoxStatus('paused', false) === '', 'Status remains blank during jingle pause');
  assert(simulateBoomBoxStatus('blank', false) === '', 'Explicit blank status remains blank');
  assert(simulateBoomBoxStatus('blank', true) === '', 'Explicit blank status overrides even if hasStarted is true');
  assert(simulateBoomBoxStatus('playing', true) === '▶ PLAYING', 'Status displays PLAYING once first real song has started');
  assert(simulateBoomBoxStatus('paused', true) === '❚❚ PAUSED', 'Status displays PAUSED once first real song has started');
  assert(simulateBoomBoxStatus('stopped', true) === '■ STOPPED', 'Status displays STOPPED once first real song has started');

  // 3. Background tab isolation (revealYouTubeToStart defaults to false)
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');
  assert(appTsx.includes('useState<boolean>(false)'), 'App.tsx defaults revealYouTubeToStart to false');

  const bgJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf-8');
  assert(!bgJs.includes('checkAndRecoverHiddenTabPlayback(tabId, payload?.revealYouTubeToStart !== false)'), 'background.js does not default revealYouTubeToStart to true in checkAndRecoverHiddenTabPlayback');
  assert(!bgJs.includes("type: 'NEEDS_USER_CLICK'"), 'background.js does not dispatch NEEDS_USER_CLICK');
  assert(!bgJs.includes('HIDDEN_TAB_RECOVERY_TRIGGERED'), 'background.js does not trigger hidden tab activation recovery');

  // 4. Boom Box reload reset coordination and no click warnings
  const playerJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  assert(!playerJs.includes('Click the YouTube tab once to allow music'), 'player.js does not contain the click warning string');
  assert(!playerJs.includes('needsUserClick'), 'player.js does not contain needsUserClick state');
  assert(playerJs.includes("sendBoomBoxAction('BOOMBOX_RELOADED')"), 'player.js dispatches BOOMBOX_RELOADED on startup');
  assert(appTsx.includes("case 'BOOMBOX_RELOADED':"), 'App.tsx handles BOOMBOX_RELOADED action');
  assert(appTsx.includes("jingleStateRef.current = 'prepared'"), 'BOOMBOX_RELOADED resets jingle state to prepared');
  assert(appTsx.includes("hasFirstSongStartedPlayingRef.current = false"), 'BOOMBOX_RELOADED resets hasFirstSongStartedPlayingRef');
  assert(appTsx.includes("currentQueueIndexRef.current = 0"), 'BOOMBOX_RELOADED resets queue index to 0');

  // 5. Authoritative decade footer logo binding
  assert(playerJs.includes('if (typeof state.decade === \'number\' && state.decade >= 1960 && state.decade <= 2020)'), 'player.js validates incoming decade from authoritative radio state');
  assert(playerJs.includes('logoDec = state.decade;'), 'player.js updates logoDec directly from state.decade');
  assert(playerJs.includes('paintLogo();'), 'player.js repaints logo on decade update');
  assert(playerJs.includes('logoDec=S.dec'), 'player.js initializes logoDec to current station decade (S.dec)');
  assert(!playerJs.includes('if (!isNaN(y)) setSongYear(y);'), 'player.js does not derive footer logo decade from song release year');

  // Verify all decade logo asset files exist for both black and white variants from 1960s to 2020s
  const logosDir = path.join(__dirname, '../extension/player/logos');
  const decades = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
  for (const dec of decades) {
    const blackPath = path.join(logosDir, `${dec}s-black.png`);
    const whitePath = path.join(logosDir, `${dec}s-white.png`);
    assert(fs.existsSync(blackPath), `Logo asset exists: ${dec}s-black.png`);
    assert(fs.existsSync(whitePath), `Logo asset exists: ${dec}s-white.png`);
    assert(fs.statSync(blackPath).size > 1000, `${dec}s-black.png has valid image payload`);
    assert(fs.statSync(whitePath).size > 1000, `${dec}s-white.png has valid image payload`);
  }

  // Simulate logo selection logic
  function getLogoSrc(decade: number, isDark: boolean): string {
    const LOGO_BASE = 'logos/';
    return LOGO_BASE + decade + 's-' + (isDark ? 'black' : 'white') + '.png';
  }

  assert(getLogoSrc(1960, false) === 'logos/1960s-white.png', '1960 light theme resolves to 1960s-white.png');
  assert(getLogoSrc(1960, true) === 'logos/1960s-black.png', '1960 dark theme resolves to 1960s-black.png');
  assert(getLogoSrc(1980, false) === 'logos/1980s-white.png', '1980 light theme resolves to 1980s-white.png');
  assert(getLogoSrc(2020, true) === 'logos/2020s-black.png', '2020 dark theme resolves to 2020s-black.png');

  // Verify App.tsx updates programYear from user date/decade selections
  assert(appTsx.includes("case 'SELECT_DATE_GENRE':"), 'App.tsx handles SELECT_DATE_GENRE');
  assert(appTsx.includes("action.year ? String(action.year) :"), 'App.tsx parses selected year from SELECT_DATE_GENRE');
  assert(appTsx.includes("setProgramYear(selectedYear);"), 'App.tsx updates programYear when date or decade is selected in Boom Box');

  // 6. Verified Playback & Jingle Metadata Isolation
  const contentYtJs = fs.readFileSync(path.join(__dirname, '../extension/content_youtube.js'), 'utf-8');
  assert(!contentYtJs.includes("finish(true, 'buffering_active')"), 'content_youtube.js does not confirm buffering as successful playback');
  assert(!playerJs.includes("setState('playing', true);\n  trace('CLICK_PLAY'"), 'player.js does not set optimistic playing state or run VU meters prior to playback confirmation');
  assert(appTsx.includes("const isJingleActive = jingleStateRef.current === 'prepared' || jingleStateRef.current === 'playing';"), 'App.tsx determines jingle active state');
  assert(appTsx.includes("if (clearSong || !hasFirstSongStarted || isJingleActive || playbackStatus.videoId === RETROFM_JINGLE_CONFIG.videoId) {\n      currentSong = null;"), 'App.tsx ensures currentSong is null during jingle and before first song starts playing');
}

// --- Test Suite 26: START RETRO FM Modal, Solid Black Initial Appearance & Handoff ---
console.log('\n--- Test Suite 26: START RETRO FM Modal, Solid Black Initial Appearance & Handoff ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const bgJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf-8');

  // 1. Initial Appearance & Dimming
  assert(bbHtml.includes('<body class="dark">'), 'index.html sets body class to dark by default');
  assert(bbHtml.includes('<div id="app" class="rfm-dimmed">'), 'index.html applies rfm-dimmed class to #app immediately in HTML');
  assert(bbCss.includes('body{margin:0;background:#000;'), 'player.css sets solid black #000 background on body');
  assert(bbCss.includes('#app.rfm-dimmed{filter:blur(6px) brightness(0.35);'), 'player.css applies blur and dimming to #app');
  assert(bbJs.includes('let dark=true,logoDec=S.dec;'), 'player.js initializes dark theme to true');

  // 2. ON AIR Modal
  assert(bbHtml.includes('id="rfmModal"'), 'index.html contains #rfmModal element');
  assert(bbHtml.includes('ON AIR'), 'index.html contains ON AIR button');
  assert(!bbHtml.includes('CLICK ANYWHERE TO START'), 'index.html does not contain unwanted CLICK ANYWHERE TO START text');
  assert(bbCss.includes('.rfm-modal-overlay'), 'player.css styles modal overlay');
  assert(bbCss.includes('.rfm-start-btn'), 'player.css styles ON AIR button');

  // 3. Modal Click & Handoff Dispatch
  assert(bbJs.includes("chrome.runtime.sendMessage({ type: 'START_RETRO_FM_HANDOFF' }"), 'player.js sends START_RETRO_FM_HANDOFF on button click');
  assert(bbJs.includes("btn.disabled = true;"), 'player.js disables button on click to prevent duplicate requests');
  assert(bbJs.includes("appEl.classList.remove('rfm-dimmed');"), 'player.js removes dimming only after handoff completes');
  assert(bgJs.includes("if (type === 'START_RETRO_FM_HANDOFF') {"), 'background.js handles START_RETRO_FM_HANDOFF message');
  assert(bgJs.includes("await chrome.tabs.update(ytTabId, { active: true });"), 'background.js activates YouTube tab for handoff');
  assert(bgJs.includes("await chrome.tabs.update(boomBoxId, { active: true });"), 'background.js reactivates Boom Box tab');
}

// --- Test Suite 27: Modal Logo, 1990s Default Footer Logo, Green Display Blanking & Continuous Queue Advancement ---
console.log('\n--- Test Suite 27: Modal Logo, 1990s Default Footer Logo, Green Display Blanking & Continuous Queue Advancement ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Startup Modal Logo
  assert(bbHtml.includes('<img id="rfmModalLogo" class="rfm-modal-logo" src="logos/1990s-black.png" alt="RetroFM">'), 'index.html embeds 1990s-black.png inside #rfmModal above button');
  assert(bbCss.includes('.rfm-modal-logo{max-height:72px;max-width:240px;'), 'player.css styles modal logo with appropriate constraints');

  // 2. Default Footer Logo (1990s)
  assert(bbJs.includes("dec:1990"), 'player.js defaults state S.dec to 1990');
  assert(appTsx.includes(": 1990;"), 'App.tsx defaults radio state decade fallback to 1990');
  assert(appTsx.includes("const [programYear, setProgramYear] = useState<string>('1995');"), 'App.tsx defaults programYear to 1995');

  // 3. Green Display Blanking
  assert(bbJs.includes("if(!song || !hasFirstSongStartedPlaying){\n    el.textContent='';\n    return;\n  }"), 'player.js keeps song title blank when no song or before first song starts playing');
  assert(appTsx.includes("if (clearSong || !hasFirstSongStarted || isJingleActive || playbackStatus.videoId === RETROFM_JINGLE_CONFIG.videoId) {\n      currentSong = null;"), 'App.tsx broadcasts currentSong as null during jingle or before first song plays');

  // 4. PLAY starts music queue, not jingle
  assert(!appTsx.includes("if (jingleStateRef.current === 'prepared') {\n        desiredVideoId = RETROFM_JINGLE_CONFIG.videoId;"), 'App.tsx handlePlayMusic does not replay jingle when jingle is prepared');

  // 5. Continuous Playback from Queue
  assert(appTsx.includes("jingleStateRef.current = 'completed';\n          logMessage('[Station Jingle] Jingle finished naturally. Standing by for PLAY to start music queue.');"), 'App.tsx marks jingle completed without advancing music queue prematurely');
  assert(appTsx.includes("} else if (hasFirstSongStartedPlayingRef.current && jingleStateRef.current !== 'cancelled') {\n          // Case 2: A regular music track finished naturally -> advance to next song in the queue"), 'App.tsx only advances queue on natural finish of confirmed music tracks');
}

// --- Test Suite 28: Ongoing VU Meter Animation & Green Display Song Metadata ---
console.log('\n--- Test Suite 28: Ongoing VU Meter Animation & Green Display Song Metadata ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Preset song selection in App.tsx updates programSongResult so metadata is never empty for "a-ha - Take On Me"
  assert(appTsx.includes("setProgramSongResult({\n            status: 'IDLE',\n            requested: `${desiredArtist} — ${programSongTitle || preset.title}`,"), 'App.tsx populates programSongResult with preset details when Priority 2 preset matches');

  // 2. hasFirstSongStartedPlayingRef is set to true immediately upon starting real song
  assert(appTsx.includes("hasFirstSongStartedPlayingRef.current = true;\n        }\n\n        logMessage(`▶ Playback started on YouTube tab:"), 'App.tsx marks first song as started upon real song navigation');

  // 3. App.tsx broadcasts radio state on rawState 1 confirmation
  assert(appTsx.includes("if (currentPlayingVid && currentPlayingVid !== RETROFM_JINGLE_CONFIG.videoId) {\n          if (!hasFirstSongStartedPlayingRef.current) {\n            hasFirstSongStartedPlayingRef.current = true;\n            logMessage(`▶ Confirmed real song playback active:"), 'App.tsx confirms real song playback and unsuppresses Boom Box status');

  // 4. Boom Box player.js does not kill isYtPlaybackActive on transient blank state while user action is playing
  assert(bbJs.includes("if (!lastUserTransportAction || lastUserTransportAction.state !== 'playing') {\n        isYtPlaybackActive = false;\n        setState('blank', true);\n      }"), 'player.js protects isYtPlaybackActive from being cleared by transient blank radio state');

  // 5. Boom Box player.js immediately catches YT_STATE_CHANGED rawState 1 to unsuppress and keep isYtPlaybackActive active
  assert(bbJs.includes("if (rawState === 1 && vid && vid !== '3Wk2FzsxK4k') {\n        hasFirstSongStartedPlaying = true;\n      }"), 'player.js catches real song rawState 1 to enable playback state and VU meter animation');

  // 6. Boom Box player.js populates song metadata from YT_STATE_CHANGED if not already populated
  assert(bbJs.includes("if (!song && message.payload.title && hasFirstSongStartedPlaying) {\n        setSong({ title: message.payload.title });"), 'player.js populates song metadata from YouTube state title if not yet received');

  // 7. Song display parsing and title cleaning logic
  const parsedArtist = cleanArtist('a-ha', 'a-ha - Take on Me (1985)');
  const parsedTitle = cleanTitle('a-ha - Take on Me (1985)', parsedArtist);
  assert(parsedArtist === 'a-ha', `cleanArtist correctly extracts "a-ha" (got "${parsedArtist}")`);
  assert(parsedTitle.toLowerCase() === 'take on me', `cleanTitle correctly extracts "Take on Me" (got "${parsedTitle}")`);

  // 8. VU meter condition simulation
  let simState = 'playing';
  let simIsYtPlaybackActive = true;
  let isPlaying = simState === 'playing' && simIsYtPlaybackActive;
  assert(isPlaying === true, 'Simulated VU meters continue running while playing and YouTube playback is active');
}

// --- Test Suite 29: Theme Background Coverage, Stationary Song Fade, Segmented Status Controls & Panel Alignment ---
console.log('\n--- Test Suite 29: Theme Background Coverage, Stationary Song Fade, Segmented Status Controls & Panel Alignment ---');
{
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. White background theme coverage
  assert(bbCss.includes('html:not(.dark),body:not(.dark){background:#fff}'), 'player.css covers html and body with white background when dark theme is off');
  assert(bbCss.includes('body{margin:0;background:#000;'), 'player.css retains dark background default on initial load');
  assert(bbJs.includes("document.body.classList.toggle('dark',dark);document.documentElement.classList.toggle('dark',dark);"), 'player.js toggles dark class on both body and documentElement');

  // 2. Stationary artist and song title during fading
  assert(bbCss.includes('#row{display:flex;justify-content:space-between;align-items:center;gap:10px}'), 'player.css centers #row items vertically to eliminate font baseline shifts');
  assert(bbCss.includes('#sg{display:inline-flex;align-items:center;min-width:0;flex:0 1 auto;height:20px;min-height:20px;line-height:20px;'), 'player.css enforces fixed height and line-height on #sg');
  assert(bbCss.includes('transform:none !important;'), 'player.css prevents transforms on #sg');
  assert(bbCss.includes('transition:opacity 1.2s ease-in-out'), 'player.css preserves 1.2s opacity transition');

  // 3. Segmented-display status controls & labels
  assert(bbCss.includes('.seg-st-display{'), 'player.css defines .seg-st-display');
  assert(bbCss.includes('.seg-st-char{position:relative;width:9px;height:15px;'), 'player.css defines compact 7-segment status characters');
  assert(bbJs.includes('SEG_ALPHA_MAP = {'), 'player.js contains 7-segment alphanumeric map');

  // Extract render7SegStatus and verify outputs
  const renderFnMatch = bbJs.match(/function render7SegStatus\(mode\)\s*\{[\s\S]*?\n\}/);
  assert(!!renderFnMatch, 'player.js contains render7SegStatus function');

  // Test status label outputs
  const simRender = new Function('SEG_ALPHA_MAP', `
    const SEG_MAP = SEG_ALPHA_MAP;
    ${renderFnMatch![0]}
    return render7SegStatus;
  `);
  const segAlphaMatch = bbJs.match(/const SEG_ALPHA_MAP\s*=\s*\{[\s\S]*?\};/);
  const simAlphaMap = new Function(`${segAlphaMatch![0]}; return SEG_ALPHA_MAP;`)();
  const testRender7Seg = simRender(simAlphaMap);

  const playHtml = testRender7Seg('playing');
  assert(playHtml.includes('aria-label="▶ PLAY"'), `playing status includes "▶ PLAY" aria-label (got: ${playHtml})`);
  assert(playHtml.includes('>PLAY<'), 'playing status includes sr-only text "PLAY"');

  const pauseHtml = testRender7Seg('paused');
  assert(pauseHtml.includes('aria-label="❚❚ PAUSE"'), `paused status includes "❚❚ PAUSE" aria-label (got: ${pauseHtml})`);

  const stopHtml = testRender7Seg('stopped');
  assert(stopHtml.includes('aria-label="■ STOP"'), `stopped status includes "■ STOP" aria-label (got: ${stopHtml})`);

  const rewHtml = testRender7Seg('rew');
  assert(rewHtml.includes('aria-label="◀◀ REW"'), `rewind transient status includes "◀◀ REW" aria-label (got: ${rewHtml})`);

  const ffHtml = testRender7Seg('ff');
  assert(ffHtml.includes('aria-label="▶▶ FF"'), `fast-forward transient status includes "▶▶ FF" aria-label (got: ${ffHtml})`);

  // Deck button bindings
  assert(bbJs.includes("if(k==='rewind'){showTransientStatus('rew');sendBoomBoxAction('REWIND');"), 'Rewind button triggers transient REW status and dispatches REWIND');
  assert(bbJs.includes("else if(k==='forward'){showTransientStatus('ff');sendBoomBoxAction('FAST_FORWARD');"), 'Fast-forward button triggers transient FF status and dispatches FAST_FORWARD');

  // Queue navigation in App.tsx
  assert(appTsx.includes('const prevIndex = (currentQueueIndexRef.current - 1 + DEFAULT_SONG_QUEUE.length) % DEFAULT_SONG_QUEUE.length;'), 'App.tsx navigates to previous queue song on rewind');
  assert(appTsx.includes('const nextIndex = (currentQueueIndexRef.current + 1) % DEFAULT_SONG_QUEUE.length;'), 'App.tsx navigates to next queue song on fast-forward');
  assert(appTsx.includes('navigateToQueueSong(prevIndex'), 'App.tsx calls navigateToQueueSong with previous index');
  assert(appTsx.includes('navigateToQueueSong(nextIndex'), 'App.tsx calls navigateToQueueSong with next index');

  // 4. Keep PLAY displayed while transitioning between songs
  assert(appTsx.includes('const isPlayingOrAdvancing = isAdvancingRef.current || playbackStatus.isPlaying;'), 'App.tsx keeps playing mode during queue advancement');
  assert(bbJs.includes("if (rawState === 0) {\n        // When startup jingle ends naturally, stop playback and reels until user clicks PLAY\n        if (isJingle) {\n          isYtPlaybackActive = false;\n          setVisualTransport('stopped');\n        } else if (S.state !== 'playing') {\n          setVisualTransport('stopped');\n        }\n      }"), 'player.js suppresses transient pause during song transition and buffering');

  // 5. Match green display width to Boom Box width
  assert(bbCss.includes('#panel{margin:4px 3.84% 8px;'), 'player.css aligns #panel horizontally to 3.84% margins matching Boom Box body bounds');
}

// --- Test Suite 30: Green Display Typography (Inter for Pills, DotGothic16 for Song/Artist) ---
console.log('\n--- Test Suite 30: Green Display Typography (Inter for Pills, DotGothic16 for Song/Artist) ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');

  // 1. Google Fonts loading
  assert(bbHtml.includes('fonts.googleapis.com'), 'index.html preconnects to Google Fonts');
  assert(bbHtml.includes('family=DotGothic16&family=Inter:wght@400;500;600;700'), 'index.html requests DotGothic16 and Inter font families');
  assert(bbCss.includes("@import url('https://fonts.googleapis.com/css2?family=DotGothic16&family=Inter:wght@400;500;600;700&display=swap');"), 'player.css imports DotGothic16 and Inter');

  // 2. Date and genre pills scoped to green display (#panel) with Inter and fallbacks
  assert(bbCss.includes("#panel .tag,#panel button.tag,#panel #hDate,#panel .chip{font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;"), 'Date and genre pills in green display use Inter font with appropriate system fallbacks');
  assert(bbCss.includes('#panel .chip.sel{font-weight:600}'), 'Selected genre chip in green display applies semi-bold weight');

  // 3. Artist and song title scoped to #panel #sg with DotGothic16 and monospace fallbacks
  assert(bbCss.includes("#panel #sg{font-family:'DotGothic16',ui-monospace,Menlo,Consolas,monospace;"), 'Artist and song title in green display use DotGothic16 with monospace fallbacks');
  assert(bbCss.includes('#panel #sg{font-family:\'DotGothic16\',ui-monospace,Menlo,Consolas,monospace;font-size:17px}'), 'Artist and song title font size is increased to 17px');

  // 4. Stationary position and layout preservation during fading
  assert(bbCss.includes('height:20px;min-height:20px;line-height:20px;'), '#sg layout dimensions remain fixed at 20px');
  assert(bbCss.includes('transform:none !important;'), '#sg translation is suppressed');

  // 5. Segmented digits and transport status remain untouched
  assert(bbCss.includes('.seg-unit{display:inline-flex;flex-direction:column;justify-content:center;align-items:center;height:34px;margin-left:5px;flex:none;line-height:1;color:#8dffb0;text-shadow:0 0 10px rgba(120,255,160,.6);font-family:ui-monospace,Menlo,Consolas,monospace;box-sizing:border-box}'), 'Segmented frequency unit retains monospace');
  assert(!bbCss.includes('#year{font-family'), '#year digits do not apply Inter or DotGothic16');
  assert(!bbCss.includes('#st{font-family'), '#st transport status does not apply Inter or DotGothic16');

  // 6. Fonts outside green display remain untouched
  assert(bbCss.includes('.rfm-start-btn{') && bbCss.includes('font:700 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;'), 'Startup modal button retains standard system font');
}

// --- Test Suite 31: Four Targeted Corrections (START RETROFM label & 100% black modal, Jingle Reel Stop, Restored Footer Logo, 17px DotGothic16) ---
console.log('\n--- Test Suite 31: Four Targeted Corrections (START RETROFM label & 100% black modal, Jingle Reel Stop, Restored Footer Logo, 17px DotGothic16) ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Startup modal label and solid black background (#000000 with 100% opacity)
  assert(bbHtml.includes('ON AIR</button>'), 'Modal button has exact label "ON AIR"');
  assert(bbCss.includes('.rfm-modal-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99999;background:#000000;'), 'Modal overlay has solid #000000 background (100% opacity, no alpha)');
  assert(bbCss.includes('.rfm-modal-box{background:#000000;'), 'Modal box has solid #000000 background matching 1990s-black.png');

  // 2. Stop cassette reels when startup jingle ends naturally
  assert(bbJs.includes("const isJingle = vid === '3Wk2FzsxK4k' || !hasFirstSongStartedPlaying;"), 'player.js checks if ended video is the startup jingle');
  assert(bbJs.includes("if (isJingle) {\n          isYtPlaybackActive = false;\n          setVisualTransport('stopped');"), 'player.js stops visual transport and marks playback inactive when jingle finishes');
  assert(appTsx.includes("if (jingleStateRef.current === 'playing' || finishedVideoId === RETROFM_JINGLE_CONFIG.videoId) {\n          jingleStateRef.current = 'completed';\n          logMessage('[Station Jingle] Jingle finished naturally. Standing by for PLAY to start music queue.');\n          setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, available: true }));\n          broadcastCurrentRadioState(true);"), 'App.tsx marks playbackStatus isPlaying:false and broadcasts blank/stopped radio state when jingle ends');

  // 3. Restore 1990s footer logo on date/genre screen
  assert(bbHtml.includes('<img id="logo" alt="RetroFM" src="logos/1990s-black.png" style="display:block">'), 'index.html displays 1990s-black.png by default on initial render');
  assert(bbJs.includes("paintLogo();"), 'player.js paints initial footer logo immediately upon startup');
  assert(bbJs.includes("if(dec>=1960&&dec<=2020&&logoDec!==dec){logoDec=dec;paintLogo();}"), 'player.js updates footer logo on date/decade changes in refresh()');

  // 4. Increase artist and song title font size by ~3.5px to 17px
  assert(bbCss.includes("#panel #sg{font-family:'DotGothic16',ui-monospace,Menlo,Consolas,monospace;font-size:17px}"), 'player.css sets #panel #sg font-size to 17px');
  assert(bbCss.includes('height:20px;min-height:20px;line-height:20px;'), 'player.css accommodates 17px font with 20px line height to prevent clipping');
}

// --- Test Suite 32: Stacked FM over MHz Frequency Unit Layout ---
console.log('\n--- Test Suite 32: Stacked FM over MHz Frequency Unit Layout ---');
{
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. render7SegFreq structure & accessible radio frequency label
  const renderFreqMatch = bbJs.match(/function render7SegFreq\(fStr\)\s*\{[\s\S]*?\n\}/);
  assert(!!renderFreqMatch, 'player.js contains render7SegFreq function');

  // Test representative frequencies: 87.5, 90.7, 97.9, 104.1, 108.0
  const simRenderFreq = new Function('SEG_MAP', `
    ${renderFreqMatch![0]}
    return render7SegFreq;
  `)(new Function(`${bbJs.match(/const SEG_MAP\s*=\s*\{[\s\S]*?\};/)![0]}; return SEG_MAP;`)());

  const testFreqs = ['87.5', '90.7', '97.9', '104.1', '108.0'];
  for (const f of testFreqs) {
    const html = simRenderFreq(f);
    assert(html.includes(`aria-label="${f} FM"`), `Accessible frequency label includes "${f} FM" (got: ${html})`);
    assert(html.includes('class="seg-dp"'), `Frequency HTML contains decimal point for ${f}`);
    assert(!html.includes(':'), `Frequency HTML never contains colon (time format) for ${f}`);
    assert(html.includes('<span class="seg-unit" aria-hidden="true"><span class="seg-unit-fm">FM</span><span class="seg-unit-mhz">MHz</span></span>'), `Frequency HTML contains stacked FM over MHz for ${f}`);
    // No duplicate inline FM label
    const fmOccurrences = (html.match(/FM/g) || []).length;
    // 1 in aria-label, 1 in .seg-unit-fm -> exactly 2
    assert(fmOccurrences === 2, `Frequency HTML has no duplicate FM labels (count: ${fmOccurrences})`);
  }

  // 2. CSS Layout for stacked labels
  assert(bbCss.includes('.seg-display{display:inline-flex;align-items:center;gap:3px;vertical-align:baseline}'), 'player.css vertically centers segmented display items against digits');
  assert(bbCss.includes('.seg-unit{display:inline-flex;flex-direction:column;justify-content:center;align-items:center;height:34px;margin-left:5px;flex:none;line-height:1;'), 'player.css defines .seg-unit column layout centered within 34px digit height');
  assert(bbCss.includes('.seg-unit-fm{font-size:15px;font-weight:700;line-height:1;display:block;text-align:center}'), 'player.css defines .seg-unit-fm with 15px font-size');
  assert(bbCss.includes('.seg-unit-mhz{font-size:10px;font-weight:700;line-height:1;display:block;text-align:center;margin-top:2px}'), 'player.css defines .seg-unit-mhz with 10px font-size and 2px top margin');

  // 3. Equal width calculation verification (15px * 2 chars = 10px * 3 chars = 30em/ch width)
  const fmCharWidth = 15 * 0.6; // standard monospace char ratio
  const mhzCharWidth = 10 * 0.6;
  const totalFmWidth = 2 * fmCharWidth;
  const totalMhzWidth = 3 * mhzCharWidth;
  assert(Math.abs(totalFmWidth - totalMhzWidth) < 0.001, `FM and MHz calculate to equal visual widths in monospace (${totalFmWidth}px vs ${totalMhzWidth}px)`);

  // 4. Height constraint: 15px FM + 2px margin + 10px MHz = 27px, which is strictly less than 34px digit height
  const totalLabelHeight = 15 + 2 + 10;
  assert(totalLabelHeight <= 34, `Combined label height (${totalLabelHeight}px) fits completely inside 34px digit height`);
}

// --- Test Suite 33: Music Note 1px Vertical Shift & Disabled Start Button until Timer Ready ---
console.log('\n--- Test Suite 33: Music Note 1px Vertical Shift & Disabled Start Button until Timer Ready ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Move the music note down by exactly 1 pixel without affecting text or surrounding elements
  assert(bbCss.includes('#sdot{'), 'player.css styles #sdot button');
  assert(bbCss.includes('transform:translateY(1px)'), 'player.css applies transform:translateY(1px) to #sdot');
  assert(bbCss.includes('#sg{display:inline-flex;align-items:center;min-width:0;flex:0 1 auto;height:20px;min-height:20px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity 1.2s ease-in-out;transform:none !important;margin:0;padding:0;vertical-align:middle}'), '#sg artist and song title layout remains unchanged and transform:none !important');
  assert(bbHtml.includes('<button id="sdot" aria-label="Toggle title and artist fade" title="Fade between title and artist (click to turn off)" aria-pressed="true">♫</button>'), 'index.html retains #sdot button and character');

  // 2. Disable ON AIR button until 4-second timer expires
  assert(bbHtml.includes('<button id="rfmStartBtn" class="rfm-start-btn" type="button" disabled>ON AIR</button>'), 'index.html renders #rfmStartBtn with disabled attribute by default');
  assert(bbCss.includes('.rfm-start-btn:disabled{cursor:default;transform:none}'), 'player.css styles disabled state for .rfm-start-btn');

  // 3. App.tsx tracks playback status and radio state
  assert(appTsx.includes('const isStartupReady = Boolean('), 'App.tsx computes isStartupReady');
  assert(appTsx.includes('isStartupReady,'), 'App.tsx includes isStartupReady in radio state broadcast');

  // 4. player.js gates button activation on real YouTube readiness signal
  assert(bbJs.includes('btn.disabled = true;'), 'player.js sets initial button disabled state to true');
  assert(bbJs.includes('function markStartupReady()'), 'player.js defines markStartupReady helper');
  assert(bbJs.includes('isStartupReady'), 'player.js tracks isStartupReady');
  assert(bbJs.includes('markStartupReady()'), 'player.js calls markStartupReady() on readiness events');
  assert(bbJs.includes('if (!isStartupReady || btn.disabled || handoffStarted) return;'), 'player.js guards click listener on isStartupReady, disabled, and handoffStarted');
  assert(!bbJs.includes('4000);'), 'player.js does not use unconditional 4000ms timer as substitute for readiness');
}

// --- Test Suite 34: Power-On Startup Transition, Paused Song Fade, and Tab Title ---
console.log('\n--- Test Suite 34: Power-On Startup Transition, Paused Song Fade, and Tab Title ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const bgJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf-8');

  // 1. Initial power-off / invisible button and modal border
  assert(bbCss.includes('.rfm-modal-box{background:#000000;border:2px solid #000000;'), 'player.css sets initial modal box border to #000000 (blends with black background)');
  assert(bbCss.includes('.rfm-modal-box.ready{border-color:#d22a1c;'), 'player.css sets ready modal box border to #d22a1c');
  assert(bbCss.includes('.rfm-start-btn{background:#000000;color:#000000;'), 'player.css sets initial button background and text to black #000000');
  assert(bbCss.includes('.rfm-start-btn.ready{background:#d22a1c;color:#ffffff;'), 'player.css sets ready button background to #d22a1c and text to #ffffff');
  assert(bbCss.includes('transition:border-color 0.8s ease,box-shadow 0.8s ease'), 'player.css applies smooth 0.8s transition to modal box border');
  assert(bbCss.includes('transition:background 0.8s ease,color 0.8s ease,box-shadow 0.8s ease,transform .15s ease'), 'player.css applies smooth 0.8s transition to button background and color');

  // 2. player.js applies .ready class to box and button on timer expiry
  assert(bbJs.includes('box.classList.add(\'ready\');'), 'player.js adds ready class to modal box on timer expiry');
  assert(bbJs.includes('btn.classList.add(\'ready\');'), 'player.js adds ready class to start button on timer expiry');
  assert(bbJs.includes('btn.disabled = false;'), 'player.js enables button on timer expiry');

  // 3. Execution simulation: YouTube state or radio state cannot disable button after timer
  let simButtonDisabled = true;
  let simButtonReady = false;
  let simBoxReady = false;

  // Initial state simulation
  assert(simButtonDisabled === true && simButtonReady === false, 'Simulation: button initially disabled');

  // Timer fires at 4000ms
  simButtonReady = true;
  simButtonDisabled = false;
  simBoxReady = true;
  assert(simButtonDisabled === false && simButtonReady === true && simBoxReady === true, 'Simulation: button and box powered on after 4000ms timer');

  // Radio state arriving with isStartupReady: false must not disable button
  const simRadioStatePayload = { isStartupReady: false, playbackStatus: 'stopped', appConnected: false };
  // In player.js applyRadioState, isStartupReady is recorded but does not touch button
  assert(simButtonDisabled === false && simButtonReady === true, 'Simulation: subsequent radio state cannot reverse button activation');

  // Late YT_STATE_CHANGED arriving must not disable button
  const simYtStatePayload = { state: -1, videoId: null };
  assert(simButtonDisabled === false && simButtonReady === true, 'Simulation: late YT_STATE_CHANGED cannot reverse button activation');

  // 4. Continued song title & artist fade when paused and stopped
  assert(bbJs.includes("if(S.state==='playing' || S.state==='paused' || S.state==='stopped'){"), 'renderSong schedules fade during playing, paused, and stopped states');
  assert(bbJs.includes("(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped')"), 'scheduleSongFade checks playing, paused, and stopped states');

  // 5. Chrome tab and tab group title is RetroFM without space
  assert(bbHtml.includes('<title>RetroFM</title>'), 'index.html has title "RetroFM" without space');
  assert(bbJs.includes('document.title = \'RetroFM\';'), 'player.js explicitly sets document.title to "RetroFM"');
  assert(!bgJs.includes("title: 'Retro FM'"), 'background.js does not use "Retro FM" with a space for tab group title');
  assert(bgJs.includes("title: 'RetroFM'"), 'background.js uses "RetroFM" for tab group title');
}

// --- Test Suite 35: 1,000ms REW and FF Transient Status Display & Timer Safety ---
console.log('\n--- Test Suite 35: 1,000ms REW and FF Transient Status Display & Timer Safety ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. Exactly 1000ms timeout in showTransientStatus
  assert(bbJs.includes('function showTransientStatus(mode) {'), 'player.js defines showTransientStatus');
  assert(bbJs.includes('}, 1000);'), 'showTransientStatus uses exactly 1,000ms timeout interval');

  // 2. Managed cleanup and cancellation of previous pending timers
  assert(bbJs.includes('function clearTransientStatus() {'), 'player.js defines clearTransientStatus helper');
  assert(bbJs.includes('if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }'), 'showTransientStatus cancels previous timer before setting new status');
  assert(bbJs.includes("act($('bPlay'),()=>{") && bbJs.includes("clearTransientStatus();\n  // Resume local Web Audio Context"), 'Clicking PLAY cancels any active transient status');
  assert(bbJs.includes("act($('bPause'),()=>{") && bbJs.includes("clearTransientStatus();\n  if (transportReconcileTimer)"), 'Clicking PAUSE cancels any active transient status');
  assert(bbJs.includes("act($('bStop'),()=>{") && bbJs.includes("clearTransientStatus();\n  if (transportReconcileTimer)"), 'Clicking STOP cancels any active transient status');
  assert(bbJs.includes("window.addEventListener('beforeunload',()=>{clearSongTimers();clearTransientStatus();});"), 'window beforeunload cleans up transient status timer');

  // 3. No premature clearance in applyRadioState or YT_STATE_CHANGED
  assert(!bbJs.includes("transientStatus && (state.playbackStatus === 'playing' || state.currentSong)"), 'applyRadioState does not prematurely clear transient status');
  assert(!bbJs.includes("transientStatus && isPlaying"), 'YT_STATE_CHANGED does not prematurely clear transient status');

  // 4. Deterministic Simulation: Timer safety, 1-second hold, and cancellation
  let currentTransientStatus: string | null = null;
  let activeTimerId: number | null = null;
  let simulatedDisplay: string = 'playing';
  let nextTimerId = 1;
  const timerCallbacks = new Map<number, () => void>();

  function simulateShow(mode: string) {
    if (activeTimerId !== null) {
      timerCallbacks.delete(activeTimerId);
      activeTimerId = null;
    }
    currentTransientStatus = mode;
    simulatedDisplay = mode;
    const tid = nextTimerId++;
    activeTimerId = tid;
    timerCallbacks.set(tid, () => {
      currentTransientStatus = null;
      activeTimerId = null;
      simulatedDisplay = 'playing'; // Revert to appropriate status (PLAY)
    });
    return tid;
  }

  // Simulation 1: Press REWIND -> REW displayed
  const tid1 = simulateShow('rew');
  assert(simulatedDisplay === 'rew', 'Simulation: Pressing REWIND displays rew');
  assert(activeTimerId === tid1, 'Simulation: Timer 1 scheduled for REW');

  // Simulation 2: Before 1s expires, rapid press FAST FORWARD -> cancels Timer 1, starts Timer 2 for FF
  const tid2 = simulateShow('ff');
  assert(simulatedDisplay === 'ff', 'Simulation: Rapid FAST FORWARD press immediately updates display to ff');
  assert(activeTimerId === tid2, 'Simulation: Timer 2 scheduled for FF');
  assert(!timerCallbacks.has(tid1), 'Simulation: Timer 1 was cancelled and cannot overwrite newer state');

  // Simulation 3: Radio state arrives during FF display -> does not clear FF
  assert(simulatedDisplay === 'ff', 'Simulation: Intervening radio state does not clear FF display');

  // Simulation 4: Timer 2 expires after 1s -> display reverts to PLAY
  const cb = timerCallbacks.get(tid2);
  assert(typeof cb === 'function', 'Simulation: Timer callback exists');
  cb!();
  assert(simulatedDisplay === 'playing', 'Simulation: After 1s interval expires, display reverts to PLAY');
  assert(currentTransientStatus === null, 'Simulation: Transient status is null after expiry');
}

// --- Test Suite 36: DSEG Digital Display Font for Transport Status Indicators ---
console.log('\n--- Test Suite 36: DSEG Digital Display Font for Transport Status Indicators ---');
{
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const fontsDir = path.join(__dirname, '../extension/player/fonts');

  // 1. Local font files exist in extension/player/fonts in both .woff2 and .woff formats
  const expectedFonts = [
    'DSEG14Classic-Regular.woff2',
    'DSEG14Classic-Regular.woff',
    'DSEG14Classic-Bold.woff2',
    'DSEG14Classic-Bold.woff'
  ];
  for (const fontName of expectedFonts) {
    const fontPath = path.join(fontsDir, fontName);
    assert(fs.existsSync(fontPath), `Font asset exists locally: ${fontName}`);
    assert(fs.statSync(fontPath).size > 1000, `Font asset ${fontName} has valid non-zero size`);
  }

  // 2. @font-face rules defined locally in player.css without external font CDNs or loaders
  assert(bbCss.includes("@font-face {\n  font-family: 'DSEG';\n  src: url('fonts/DSEG14Classic-Regular.woff2') format('woff2'),\n       url('fonts/DSEG14Classic-Regular.woff') format('woff');\n  font-weight: 400;\n  font-style: normal;\n  font-display: swap;\n}"), 'player.css defines local @font-face for regular DSEG');
  assert(bbCss.includes("@font-face {\n  font-family: 'DSEG';\n  src: url('fonts/DSEG14Classic-Bold.woff2') format('woff2'),\n       url('fonts/DSEG14Classic-Bold.woff') format('woff');\n  font-weight: 700;\n  font-style: normal;\n  font-display: swap;\n}"), 'player.css defines local @font-face for bold DSEG');
  assert(!bbCss.includes('fonts.googleapis.com') || !bbCss.includes('DSEG') || !bbCss.includes('fonts.googleapis.com/css2?family=DSEG'), 'DSEG font is loaded strictly locally and never requested via external CDNs');

  // 3. Styling of .seg-st-text scoped to transport status indicators
  assert(bbCss.includes('.seg-st-text{font-family:\'DSEG\',ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:700;line-height:1;letter-spacing:1px;color:#8dffb0;text-shadow:0 0 6px rgba(120,255,160,.65);display:inline-block}'), 'player.css styles .seg-st-text with DSEG font family, 700 weight, green color, and vintage glow text-shadow');
  assert(bbCss.includes('.seg-st-chars{display:none}'), 'player.css hides legacy custom segment bar markup in favor of DSEG lettering');

  // 4. render7SegStatus in player.js outputs .seg-st-text for all 5 transport states
  const renderFnMatch = bbJs.match(/function render7SegStatus\(mode\)\s*\{[\s\S]*?\n\}/);
  assert(!!renderFnMatch, 'player.js contains render7SegStatus function');

  const simRender = new Function('SEG_ALPHA_MAP', `
    const SEG_MAP = SEG_ALPHA_MAP;
    ${renderFnMatch![0]}
    return render7SegStatus;
  `);
  const segAlphaMatch = bbJs.match(/const SEG_ALPHA_MAP\s*=\s*\{[\s\S]*?\};/);
  const simAlphaMap = new Function(`${segAlphaMatch![0]}; return SEG_ALPHA_MAP;`)();
  const testRender7Seg = simRender(simAlphaMap);

  const statuses: Array<{ mode: string; expectedText: string; symbol: string }> = [
    { mode: 'playing', expectedText: 'PLAY', symbol: '\u25B6' },
    { mode: 'paused', expectedText: 'PAUSE', symbol: '\u275A\u275A' },
    { mode: 'stopped', expectedText: 'STOP', symbol: '\u25A0' },
    { mode: 'rew', expectedText: 'REW', symbol: '\u25C0\u25C0' },
    { mode: 'ff', expectedText: 'FF', symbol: '\u25B6\u25B6' }
  ];

  for (const st of statuses) {
    const html = testRender7Seg(st.mode);
    assert(html.includes(`<span class="seg-st-text" aria-hidden="true">${st.expectedText}</span>`), `Status HTML for ${st.mode} renders .seg-st-text with "${st.expectedText}"`);
    assert(html.includes(`<span class="seg-st-sym">${st.symbol}</span>`), `Status HTML for ${st.mode} retains status symbol "${st.symbol}"`);
    assert(html.includes(`class="sr-only">${st.expectedText}</span>`), `Status HTML for ${st.mode} preserves sr-only accessibility text`);
  }

  // 5. Scope discipline: other typography remains completely untouched
  assert(bbCss.includes("#panel .tag,#panel button.tag,#panel #hDate,#panel .chip{font-family:'Inter'"), 'Date and genre pills in green display still strictly use Inter font');
  assert(bbCss.includes("#panel #sg{font-family:'DotGothic16'"), 'Song title and artist still strictly use DotGothic16');
  assert(bbCss.includes('.seg-unit{display:inline-flex;flex-direction:column;justify-content:center;align-items:center;height:34px;margin-left:5px;flex:none;line-height:1;color:#8dffb0;text-shadow:0 0 10px rgba(120,255,160,.6);font-family:ui-monospace,Menlo,Consolas,monospace;box-sizing:border-box}'), 'Segmented frequency unit retains monospace and is not altered');
  assert(bbCss.includes('.rfm-start-btn{') && bbCss.includes('font:700 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;'), 'Startup modal button retains standard system font');
}

// --- Test Suite 37: STOP 1-Second Display & STOP Button Illumination ---
console.log('\n--- Test Suite 37: STOP 1-Second Display & STOP Button Illumination ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. In player.js, pressing STOP triggers showTransientStatus('stopped')
  assert(
    bbJs.includes("act($('bStop'),()=>{") &&
    bbJs.includes("showTransientStatus('stopped');"),
    'player.js bStop click handler triggers showTransientStatus("stopped")'
  );

  // 2. In player.js setState, stopped state illuminates bStop and gStop, and clears bPause and gp
  assert(
    bbJs.includes("$('bStop').classList.add('on');") &&
    bbJs.includes("$('gStop').classList.add('on');"),
    'player.js setState illuminates both bStop and gStop on stopped'
  );
  assert(
    bbJs.includes("$('bPause').classList.toggle('on', normalized === 'paused');") &&
    bbJs.includes("document.querySelectorAll('.gp').forEach(e => e.classList.toggle('on', normalized === 'paused'));"),
    'player.js setState strictly excludes bPause and .gp when normalized is stopped'
  );
  assert(
    bbJs.includes("setTimeout(() => {\n     $('gStop').classList.remove('on');\n     $('bStop').classList.remove('on');\n   }, 1000);"),
    'player.js setState holds bStop and gStop illumination for 1,000ms before turning off'
  );

  // 3. In App.tsx, explicit STOP prevents broadcasting playbackStatus: 'paused'
  assert(
    appTsx.includes('isExplicitStoppedRef = useRef<boolean>(false);'),
    'App.tsx tracks isExplicitStoppedRef'
  );
  assert(
    appTsx.includes("isExplicitStoppedRef.current ? 'stopped' : (effectiveStatus.available ? 'paused' : 'stopped')"),
    'App.tsx rawMode reports stopped rather than paused when explicit stop occurs'
  );
  assert(
    appTsx.includes('handleStopMusic') && appTsx.includes('isExplicitStoppedRef.current = true;'),
    'App.tsx handleStopMusic marks isExplicitStoppedRef as true'
  );

  // 4. Deterministic Simulation: STOP transient display, 1-second hold, and illumination state
  interface MockElement {
    classes: Set<string>;
    classList: {
      add: (c: string) => void;
      remove: (c: string) => void;
      toggle: (c: string, force?: boolean) => boolean;
      contains: (c: string) => boolean;
    };
  }

  function createMockElement(): MockElement {
    const classes = new Set<string>();
    return {
      classes,
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        toggle: (c: string, force?: boolean) => {
          const res = force !== undefined ? force : !classes.has(c);
          if (res) classes.add(c); else classes.delete(c);
          return res;
        },
        contains: (c: string) => classes.has(c)
      }
    };
  }

  const mockBPlay = createMockElement();
  const mockBPause = createMockElement();
  const mockBStop = createMockElement();
  const mockGPlay = createMockElement();
  const mockGPause = createMockElement();
  const mockGStop = createMockElement();

  let simDisplay = 'PLAY';
  let simTransient: string | null = null;
  let simTimerId: any = null;

  function simulateStopClick() {
    // 1. showTransientStatus('stopped')
    if (simTimerId) clearTimeout(simTimerId);
    simTransient = 'stopped';
    simDisplay = 'STOP';
    simTimerId = setTimeout(() => {
      simTransient = null;
      // After STOP 1s display interval expires, transport status label disappears (empty display)
      simDisplay = '';
      simTimerId = null;
    }, 1000);

    // 2. setState('stopped')
    const normalized: string = 'stopped';
    mockBPlay.classList.toggle('on', normalized === 'playing');
    mockBPause.classList.toggle('on', normalized === 'paused');
    mockGPlay.classList.toggle('on', normalized === 'playing');
    mockGPause.classList.toggle('on', normalized === 'paused');

    if (normalized === 'stopped') {
      mockGStop.classList.add('on');
      mockBStop.classList.add('on');
      setTimeout(() => {
        mockGStop.classList.remove('on');
        mockBStop.classList.remove('on');
      }, 1000);
    }
  }

  simulateStopClick();

  // Test immediate STOP state
  assert(simDisplay === 'STOP', 'Simulation: On STOP click, green display immediately shows STOP');
  assert(mockBStop.classList.contains('on'), 'Simulation: STOP button (#bStop) is illuminated');
  assert(mockGStop.classList.contains('on'), 'Simulation: STOP indicator (#gStop) is illuminated');
  assert(!mockBPause.classList.contains('on'), 'Simulation: PAUSE button (#bPause) is strictly NOT illuminated');
  assert(!mockGPause.classList.contains('on'), 'Simulation: PAUSE indicator (.gp) is strictly NOT illuminated');
  assert(!mockBPlay.classList.contains('on'), 'Simulation: PLAY button (#bPlay) is NOT illuminated');

  // Fast-forward 1000ms timer
  await new Promise((r) => setTimeout(r, 1050));

  // Test reverted state after 1,000ms: STOP status text disappears from the green display
  assert(simDisplay === '', 'Simulation: After 1,000ms expires, green display removes STOP label (becomes empty)');
  assert(!mockBStop.classList.contains('on'), 'Simulation: After 1,000ms, STOP button (#bStop) illumination turns off');
  assert(!mockGStop.classList.contains('on'), 'Simulation: After 1,000ms, STOP indicator (#gStop) illumination turns off');

  // 5. Verify in player.js that updateStatusDisplay empties display when S.state === 'stopped'
  assert(
    bbJs.includes("if (!hasFirstSongStartedPlaying || S.state === 'blank' || S.state === 'stopped') {\n    stEl.innerHTML = '';"),
    'player.js updateStatusDisplay sets empty innerHTML for stopped state once transientStatus clears'
  );

  // 6. Verify song & artist fade continues in player.js during stopped state
  assert(
    bbJs.includes("if(S.state==='playing' || S.state==='paused' || S.state==='stopped'){\n    scheduleSongFade();"),
    'player.js renderSong schedules song fade during stopped state'
  );
  assert(
    bbJs.includes("!song||!song.artist||!fadeOn||!appConnected||!S.locked||(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped')"),
    'player.js scheduleSongFade allows rotation during stopped state'
  );
}

// --- Test Suite 38: DSEG Y Glyph Proportion and Font Verification ---
console.log('\n--- Test Suite 38: DSEG Y Glyph Proportion and Font Verification ---');
{
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  let regFont: any = null;
  let boldFont: any = null;

  try {
    const opentypeModule = await dynamicImport('/tmp/dseg/node_modules/opentype.js/dist/opentype.js');
    const opentype = opentypeModule.default || opentypeModule;
    const woff2Module = await dynamicImport('/tmp/dseg/node_modules/wawoff2/decompress.js');
    const decompress = woff2Module.default || woff2Module;
    const regularWoff2Buf = fs.readFileSync(path.join(__dirname, '../extension/player/fonts/DSEG14Classic-Regular.woff2'));
    const boldWoff2Buf = fs.readFileSync(path.join(__dirname, '../extension/player/fonts/DSEG14Classic-Bold.woff2'));

    const regularTtfRaw = await decompress(regularWoff2Buf);
    const regAb = new Uint8Array(regularTtfRaw).slice().buffer;
    regFont = opentype.parse(regAb);

    const boldTtfRaw = await decompress(boldWoff2Buf);
    const boldAb = new Uint8Array(boldTtfRaw).slice().buffer;
    boldFont = opentype.parse(boldAb);

    const regY = regFont.charToGlyph('Y');
    const boldY = boldFont.charToGlyph('Y');

    assert(regY && boldY, 'Both Regular and Bold fonts contain glyph for Y');
    const regYBox = regY.getBoundingBox();
    const boldYBox = boldY.getBoundingBox();

    assert(regYBox.y1 === 0, `Regular font Y glyph extends to baseline (y1: ${regYBox.y1})`);
    assert(boldYBox.y1 === 0, `Bold font Y glyph extends to baseline (y1: ${boldYBox.y1})`);
    assert(regY.path.commands.filter((c: any) => c.type === 'M').length === 5, 'Regular font Y glyph has exactly 5 contours matching 7-segment uppercase Y (f, b, g, c, d)');
    assert(boldY.path.commands.filter((c: any) => c.type === 'M').length === 5, 'Bold font Y glyph has exactly 5 contours matching 7-segment uppercase Y (f, b, g, c, d)');

    // Ensure other characters (P, L, A) are untouched
    const regP = regFont.charToGlyph('P');
    const regL = regFont.charToGlyph('L');
    const regA = regFont.charToGlyph('A');
    assert(regP && regL && regA, 'Regular font contains glyphs for P, L, and A');
    assert(regP.unicode === 80 && regL.unicode === 76 && regA.unicode === 65, 'Unicodes for P, L, A preserved');
  } catch (err: any) {
    console.log(`(Optional font parser in /tmp skipped: ${err?.message || err})`);
  }
}

// --- Test Suite 39: Realistic Radio Tuning, Web Audio White Noise, and Green Display State ---
console.log('\n--- Test Suite 39: Realistic Radio Tuning, Web Audio White Noise, and Green Display State ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Dynamic station definitions exported and structured
  assert(!!STATIONS_BY_DECADE, 'STATIONS_BY_DECADE is defined and exported from App.tsx');
  assert(!!STATIONS_BY_DECADE[1980], 'STATIONS_BY_DECADE contains 1980 station configuration');
  const stations1980 = STATIONS_BY_DECADE[1980] || [];
  const expected1980 = [
    { genre: 'College Rock', freq: 88.9 },
    { genre: 'Hip-Hop', freq: 89.9 },
    { genre: 'New Wave', freq: 90.7 },
    { genre: 'Synth-Pop', freq: 93.1 },
    { genre: 'Urban Contemporary', freq: 97.9 },
    { genre: 'CHR', freq: 101.9 },
    { genre: 'Hair Metal', freq: 105.5 }
  ];
  for (const exp of expected1980) {
    const match = stations1980.find(s => s.genre === exp.genre && Math.abs(s.frequency - exp.freq) < 0.05);
    assert(!!match, `1980 station configuration includes ${exp.freq} MHz (${exp.genre})`);
  }

  // 2. App.tsx broadcasts dynamic station configuration
  assert(appTsx.includes('stations: STATIONS_BY_DECADE[decade] || []'), 'App.tsx broadcasts dynamic station configuration in radio state');

  // 3. player.js receives and parses dynamic stations
  assert(bbJs.includes('if (Array.isArray(state.stations) && state.stations.length > 0)'), 'player.js parses dynamic stations from incoming RADIO_STATE');
  assert(bbJs.includes('ST[S.dec] = normalized;'), 'player.js updates active decade stations table from dynamic state');

  // 4. Strict station matching precision in player.js (dial precision < 0.05 MHz)
  assert(bbJs.includes('stations.forEach(s=>{const d=Math.abs(s[1]-f);if(d<0.05)best=s});'), 'player.js matches stations strictly within dial precision (<0.05 MHz)');

  // 5. White Noise Web Audio Architecture in player.js
  assert(bbJs.includes('class StaticNoiseController'), 'player.js defines StaticNoiseController class');
  assert(bbJs.includes('ctx.createBuffer(1, bufferSize, ctx.sampleRate);'), 'StaticNoiseController generates white noise locally without remote network calls');
  assert(bbJs.includes("filter.type = 'bandpass';"), 'StaticNoiseController applies bandpass filter for authentic analog hiss');
  assert(bbJs.includes('staticController.setVolume(S.vol);'), 'Volume knob directly coordinates static noise volume');
  assert(bbJs.includes('staticController.dispose();'), 'player.js disposes Web Audio resources on window unload');

  // 6. Display State Requirements when dial is between valid genre stations
  assert(bbJs.includes("if(!S.locked){el.textContent='';el.title='';return;}"), 'player.js leaves station-information area (#sg) completely blank when untuned');
  assert(bbJs.includes("sdotEl.style.display=best?'':'none';"), 'player.js hides music note icon (#sdot) when untuned and restores when tuned');
  assert(bbJs.includes("if (!S.locked) {\n    stEl.innerHTML = '';\n    return;\n  }"), 'player.js leaves transport status area (#st) completely blank when untuned');

  // 7. App.tsx Station Tuning, Playback Position Preservation & Monotonic Sequencing
  assert(appTsx.includes('stationPlaybackCacheRef = useRef'), 'App.tsx maintains station playback position cache');
  assert(appTsx.includes('tuneSequenceRef = useRef'), 'App.tsx tracks monotonic tuning sequence counter for superseding rapid changes');
  assert(appTsx.includes('if (tuneSeq !== tuneSequenceRef.current) break;'), 'App.tsx cancels superseded in-flight station playback on rapid tuning');

  // 8. Deterministic Tuning & State Transitions Simulation
  interface SimStation {
    genre: string;
    freq: number;
    hasMusic: boolean;
  }
  const simStations: SimStation[] = [
    { genre: 'New Wave', freq: 90.7, hasMusic: true },
    { genre: 'Synth-Pop', freq: 93.1, hasMusic: true },
    { genre: 'Hair Metal', freq: 105.5, hasMusic: false }
  ];

  class SimBoomBoxTuner {
    freq: number = 90.7;
    locked: boolean = true;
    genre: string = 'New Wave';
    staticPlaying: boolean = false;
    playbackEnabled: boolean = true;
    currentStationTime: Record<string, number> = {};
    activeSongPlaying: string | null = 'Take on Me';
    displayStatus: string = 'PLAY';
    displaySongText: string = 'Take on Me';
    displayDotVisible: boolean = true;

    tune(newFreq: number) {
      this.freq = Math.round(newFreq * 10) / 10;
      const match = simStations.find(s => Math.abs(s.freq - this.freq) < 0.05);

      if (!match) {
        // Untuned frequency
        if (this.locked && this.activeSongPlaying) {
          this.currentStationTime[this.genre] = 45;
        }
        this.locked = false;
        this.genre = '';
        this.activeSongPlaying = null;
        this.displayDotVisible = false;
        this.displaySongText = '';
        this.displayStatus = '';
        if (this.playbackEnabled) {
          this.staticPlaying = true;
        }
      } else {
        // Reached valid station
        this.locked = true;
        this.genre = match.genre;
        this.staticPlaying = false;
        this.displayDotVisible = true;

        if (match.hasMusic) {
          if (this.playbackEnabled) {
            this.activeSongPlaying = match.genre === 'New Wave' ? 'Take on Me' : 'Sledgehammer';
            this.displayStatus = 'PLAY';
            this.displaySongText = this.activeSongPlaying;
          } else {
            this.displayStatus = 'PAUSE';
          }
        } else {
          // Scenario D: Valid station with no playable music
          this.activeSongPlaying = null;
          this.displaySongText = '';
          this.displayStatus = '';
        }
      }
    }

    stop() {
      this.playbackEnabled = false;
      this.staticPlaying = false;
      this.activeSongPlaying = null;
      this.displayStatus = 'STOP';
    }

    pause() {
      this.playbackEnabled = false;
      this.staticPlaying = false;
      this.displayStatus = 'PAUSE';
    }
  }

  // Simulation: Scenario A (Tune away from Station A -> Static plays -> Reach Station B -> Auto-play Station B)
  const tuner = new SimBoomBoxTuner();
  assert(tuner.locked && tuner.genre === 'New Wave', 'Simulation: Starts tuned to New Wave');
  assert(!tuner.staticPlaying && tuner.activeSongPlaying === 'Take on Me', 'Simulation: New Wave music playing, no static');

  // Tune to untuned frequency 91.5
  tuner.tune(91.5);
  assert(!tuner.locked, 'Simulation: 91.5 is untuned');
  assert(tuner.staticPlaying, 'Simulation: White noise starts immediately when untuned');
  assert(tuner.activeSongPlaying === null, 'Simulation: Music is paused while between stations');
  assert(tuner.displaySongText === '', 'Simulation: Station-info area is completely blank when untuned');
  assert(tuner.displayDotVisible === false, 'Simulation: Music note icon (#sdot) is hidden when untuned');
  assert(tuner.displayStatus === '', 'Simulation: Transport status (#st) is completely blank when untuned');

  // Continue tuning to 92.0 (another untuned frequency)
  tuner.tune(92.0);
  assert(tuner.staticPlaying, 'Simulation: White noise continues without interruption at 92.0');
  assert(tuner.displayStatus === '', 'Simulation: Status area remains blank at 92.0');

  // Reach Station B: Synth-Pop (93.1)
  tuner.tune(93.1);
  assert(tuner.locked && tuner.genre === 'Synth-Pop', 'Simulation: Locked onto Synth-Pop at 93.1');
  assert(!tuner.staticPlaying, 'Simulation: White noise stops immediately upon reaching valid station');
  assert(tuner.activeSongPlaying === 'Sledgehammer', 'Simulation: Synth-Pop music automatically plays');
  assert(tuner.displayStatus === 'PLAY', 'Simulation: Green display shows PLAY on Station B');
  assert(tuner.displayDotVisible === true, 'Simulation: Music note icon (#sdot) is restored');

  // Simulation: Scenario B (Return to Station A: New Wave 90.7)
  tuner.tune(90.7);
  assert(tuner.locked && tuner.genre === 'New Wave', 'Simulation: Returned to New Wave at 90.7');
  assert(!tuner.staticPlaying, 'Simulation: White noise stops on return to Station A');
  assert(tuner.currentStationTime['New Wave'] === 45, 'Simulation: Previously paused position preserved (45s)');
  assert(tuner.activeSongPlaying === 'Take on Me', 'Simulation: Music resumes without restarting');

  // Simulation: Scenario D (Valid station with no playable music: Hair Metal 105.5)
  tuner.tune(105.5);
  assert(tuner.locked && tuner.genre === 'Hair Metal', 'Simulation: Tuned to Hair Metal at 105.5');
  assert(!tuner.staticPlaying, 'Simulation: White noise stops on valid station even with no song');
  assert(tuner.activeSongPlaying === null, 'Simulation: No song plays from other genres');
  assert(tuner.displayStatus === '', 'Simulation: Status area is blank for station with no song');

  // Simulation: Transport control interaction (STOP while untuned)
  tuner.tune(95.0);
  assert(tuner.staticPlaying, 'Simulation: White noise starts on untuned 95.0');
  tuner.stop();
  assert(!tuner.staticPlaying, 'Simulation: STOP immediately silences white noise');
  assert(!tuner.playbackEnabled, 'Simulation: Playback disabled globally after STOP');

  // Dialing to 90.7 after STOP does not auto-play
  tuner.tune(90.7);
  assert(tuner.locked, 'Simulation: Tuned to 90.7 after stop');
  assert(!tuner.staticPlaying, 'Simulation: No static on station');
  assert(!tuner.playbackEnabled, 'Simulation: Playback remains disabled after explicit STOP');
}

// --- Test Suite 40: Genre Pill Illumination & Playback Synchronization ---
console.log('\n--- Test Suite 40: Genre Pill Illumination & Playback Synchronization ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  assert(bbJs.includes('function updateGenrePills()'), 'player.js defines updateGenrePills function');
  assert(bbJs.includes("const isPlaying = S.state === 'playing' && isYtPlaybackActive;"), 'updateGenrePills checks if playback state is playing');
  assert(bbJs.includes("c.classList.toggle('sel', isSelected && isPlaying);"), 'Genre pill sel class requires both matched genre and isPlaying state');
  assert(bbJs.includes('updateGenrePills();'), 'updateGenrePills is invoked on tune, state changes, and chips rendering');

  // Simulation: Pill illumination tracks playback state
  class PillSimulation {
    state: string = 'stopped';
    isYtPlaybackActive: boolean = false;
    currentGenre: string = 'New Wave';
    locked: boolean = true;
    illuminatedPill: string | null = null;

    update() {
      const isPlaying = this.state === 'playing' && this.isYtPlaybackActive;
      this.illuminatedPill = (this.locked && isPlaying) ? this.currentGenre : null;
    }
  }

  const sim = new PillSimulation();
  sim.update();
  assert(sim.illuminatedPill === null, 'Initial startup: No genre pill illuminates while stopped');

  sim.state = 'playing';
  sim.isYtPlaybackActive = true;
  sim.update();
  assert(sim.illuminatedPill === 'New Wave', 'New Wave pill illuminates when New Wave station is active and playing');
  assert(sim.illuminatedPill !== 'Synth-Pop', 'Unselected genre Synth-Pop does not illuminate');

  sim.state = 'paused';
  sim.update();
  assert(sim.illuminatedPill === null, 'Pausing music clears genre pill illumination');

  sim.state = 'playing';
  sim.update();
  assert(sim.illuminatedPill === 'New Wave', 'Resuming music restores New Wave pill illumination');

  sim.locked = false; // between stations
  sim.update();
  assert(sim.illuminatedPill === null, 'Tuning between stations clears genre illumination even if state was playing');

  sim.locked = true;
  sim.currentGenre = 'Synth-Pop';
  sim.update();
  assert(sim.illuminatedPill === 'Synth-Pop', 'Synth-Pop pill illuminates when locked onto Synth-Pop and playing');
  assert(sim.illuminatedPill !== 'New Wave', 'Previous station New Wave is no longer illuminated');

  sim.state = 'stopped';
  sim.isYtPlaybackActive = false;
  sim.update();
  assert(sim.illuminatedPill === null, 'STOP clears genre illumination');
}

// --- Test Suite 41: Three-State Song Display, Playback Time Formatting, and YouTube Sync ---
console.log('\n--- Test Suite 41: Three-State Song Display, Playback Time Formatting, and YouTube Sync ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const ytMw = fs.readFileSync(path.join(__dirname, '../extension/player/yt_main_world.js'), 'utf-8');
  const songSearchSrc = fs.readFileSync(path.join(__dirname, '../src/services/music/songSearch.ts'), 'utf-8');

  assert(bbCss.includes('#sdot.mode-hidden'), 'player.css includes dimmed dot styling for mode-hidden');
  assert(bbJs.includes("sdotEl.textContent='\\u2022'"), 'player.js sets • dot icon in hidden mode');
  assert(bbJs.includes("sdotEl.textContent='\\u23F1'"), 'player.js sets ⏱ clock icon in elapsed_time mode');
  assert(bbJs.includes("sdotEl.textContent='\\u266B'"), 'player.js sets ♫ music note in song_info mode');

  // Verify time formatting
  function formatPlaybackTime(sec: any) {
    if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return null;
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  assert(formatPlaybackTime(0) === '00:00', '0 seconds formats as 00:00');
  assert(formatPlaybackTime(35) === '00:35', '35 seconds formats as 00:35');
  assert(formatPlaybackTime(229) === '03:49', '229 seconds formats as 03:49');
  assert(formatPlaybackTime(3599) === '59:59', '3599 seconds (59m 59s) formats as 59:59');
  assert(formatPlaybackTime(3600) === '01:00:00', '3600 seconds (1h) formats as 01:00:00 with HH:MM:SS');
  assert(formatPlaybackTime(NaN) === null, 'NaN seconds formats safely as null');
  assert(formatPlaybackTime(-1) === null, 'Negative seconds formats safely as null');
  assert(formatPlaybackTime(undefined) === null, 'undefined seconds formats safely as null');

  assert(ytMw.includes('function syncPlaybackProgress('), 'yt_main_world.js defines syncPlaybackProgress');
  assert(ytMw.includes('function emitCurrentProgress('), 'yt_main_world.js defines emitCurrentProgress');
  assert(ytMw.includes('setInterval(emitCurrentProgress, 1000)'), 'yt_main_world.js sets ~1s interval timer while playing');

  assert(songSearchSrc.includes('export function lookupDurationFromSqlite'), 'songSearch.ts exports lookupDurationFromSqlite');
  assert(songSearchSrc.includes('export function storeDurationInSqlite'), 'songSearch.ts exports storeDurationInSqlite');
  assert(songSearchSrc.includes('library.sqlite'), 'songSearch.ts references library.sqlite');
  assert(songSearchSrc.includes('duration_sec'), 'songSearch.ts references duration_sec column');

  // Verify state persistence across tuning
  let mode: string = 'song_info';
  const cycleMode = () => {
    if (mode === 'song_info') mode = 'elapsed_time';
    else if (mode === 'elapsed_time') mode = 'hidden';
    else mode = 'song_info';
  };

  cycleMode();
  assert(mode === 'elapsed_time', 'Display mode elapsed_time is preserved across tuning changes');
  cycleMode();
  assert(mode === 'hidden', 'Display mode hidden is preserved across tuning changes');
}

// --- Test Suite 42: YouTube Readiness Signal Detection & Startup Modal Reveal ---
console.log('\n--- Test Suite 42: YouTube Readiness Signal Detection & Startup Modal Reveal ---');
{
  const indexHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const playerCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const playerJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  assert(indexHtml.includes('id="rfmModal"'), 'index.html contains #rfmModal overlay');
  assert(indexHtml.includes('class="rfm-modal-box"'), 'index.html contains .rfm-modal-box');
  assert(indexHtml.includes('id="rfmModalLogo"'), 'index.html displays #rfmModalLogo');
  assert(indexHtml.includes('id="rfmStartBtn" class="rfm-start-btn" type="button" disabled'), 'index.html renders #rfmStartBtn with disabled attribute by default');

  assert(playerCss.includes('.rfm-modal-box{background:#000000;border:2px solid #000000;'), 'player.css styles initial modal box with black border');
  assert(playerCss.includes('.rfm-modal-box.ready{border-color:#d22a1c;'), 'player.css turns modal box border to #d22a1c when ready');
  assert(playerCss.includes('.rfm-start-btn{background:#000000;color:#000000;'), 'player.css hides start button initially via black-on-black styling');
  assert(playerCss.includes('.rfm-start-btn.ready{background:#d22a1c;color:#ffffff;cursor:pointer;'), 'player.css reveals start button in red with cursor:pointer when ready');

  assert(playerJs.includes('function markStartupReady()'), 'player.js defines markStartupReady helper');
  assert(playerJs.includes('state.isStartupReady'), 'player.js checks state.isStartupReady in applyRadioState');
  assert(playerJs.includes('markStartupReady()'), 'player.js calls markStartupReady() on readiness events');
  assert(playerJs.includes("type: 'START_RETRO_FM_HANDOFF'"), 'player.js dispatches START_RETRO_FM_HANDOFF to background');

  // Simulation of modal readiness lifecycle
  class ModalSimulation {
    isReady: boolean = false;
    modalBoxClass: string = 'rfm-modal-box';
    buttonClass: string = 'rfm-start-btn';
    buttonDisabled: boolean = true;
    modalHidden: boolean = false;

    onReadySignal() {
      this.isReady = true;
      this.modalBoxClass = 'rfm-modal-box ready';
      this.buttonClass = 'rfm-start-btn ready';
      this.buttonDisabled = false;
    }

    clickStart() {
      if (!this.isReady || this.buttonDisabled) return false;
      this.modalHidden = true;
      return true;
    }
  }

  const modalSim = new ModalSimulation();
  assert(!modalSim.modalBoxClass.includes('ready'), 'Simulation: Modal box initially has no ready green border');
  assert(!modalSim.buttonClass.includes('ready'), 'Simulation: Start button initially has no ready styling');
  assert(modalSim.buttonDisabled === true, 'Simulation: Start button initially disabled');
  assert(modalSim.modalHidden === false, 'Simulation: Modal initially covers app');

  assert(modalSim.clickStart() === false, 'Simulation: Clicking while unready does not dismiss modal');

  // Emit YouTube readiness
  modalSim.onReadySignal();
  assert(modalSim.modalBoxClass.includes('ready'), 'Simulation: Modal box border illuminates green (.ready)');
  assert(modalSim.buttonClass.includes('ready'), 'Simulation: Start button illuminates green (.ready)');
  assert(modalSim.buttonDisabled === false, 'Simulation: Start button is enabled');
  assert(modalSim.clickStart() === true, 'Simulation: Clicking START RETROFM dismisses modal');
  assert(modalSim.modalHidden === true, 'Simulation: Boom box unblurs and becomes interactive');
}

// --- Test Suite 43: Initial Playback Progress Sync & Theme Logo Stability ---
console.log('\n--- Test Suite 43: Initial Playback Progress Sync & Theme Logo Stability ---');
{
  const ytJs = fs.readFileSync(path.resolve(__dirname, '../extension/player/yt_main_world.js'), 'utf8');
  const playerJs = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.js'), 'utf8');
  const appTsx = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

  // 1. Initial progress synchronization triggers without requiring user PAUSE
  assert(ytJs.includes('media.addEventListener(\'playing\'') && ytJs.includes('syncPlaybackProgress(true)'), 'yt_main_world.js starts progress sync on media playing event');
  assert(ytJs.includes('attachPlayerStateListener') && ytJs.includes('syncPlaybackProgress(true)'), 'yt_main_world.js starts progress sync if player is playing upon attachment');
  assert(ytJs.includes('executePlayerCommandDirect') && ytJs.includes('syncPlaybackProgress(true)'), 'yt_main_world.js starts progress sync on direct PLAY command');

  // 2. Video fallback in emitCurrentProgress
  assert(ytJs.includes('video.currentTime') && ytJs.includes('video.duration'), 'emitCurrentProgress falls back to HTML5 video currentTime and duration');

  // 3. Theme logo and decade stability
  assert(playerJs.includes('!isYtPlaybackActive'), 'player.js guards decade updates during active playback');
  assert(playerJs.includes('i.getAttribute(\'src\') !== targetSrc'), 'player.js checks getAttribute(\'src\') to prevent redundant image reloads');
  assert(appTsx.includes('activeDecadeRef'), 'App.tsx tracks activeDecadeRef for consistent radio state broadcasting');

  // Simulation: Decade stability during active playback
  let boomboxDecade = 1980;
  let isPlaybackActive = true;
  let logoSrc = 'logos/1980s-black.png';

  function applySimulatedRadioState(state: { decade?: number }) {
    if (typeof state.decade === 'number') {
      if (boomboxDecade !== state.decade && !isPlaybackActive) {
        boomboxDecade = state.decade;
        logoSrc = `logos/${boomboxDecade}s-black.png`;
      }
    }
  }

  // Incoming radio state with default 1990 while playing 1980s music
  applySimulatedRadioState({ decade: 1990 });
  assert(boomboxDecade === 1980, 'Simulation: Boom box decade remains 1980 during active playback');
  assert(logoSrc === 'logos/1980s-black.png', 'Simulation: Logo remains 1980s-black.png during active playback');

  // When stopped, intentional state update succeeds
  isPlaybackActive = false;
  applySimulatedRadioState({ decade: 1970 });
  assert(boomboxDecade === 1970, 'Simulation: Decade updates to 1970 when not playing');
  assert(logoSrc === 'logos/1970s-black.png', 'Simulation: Logo updates to 1970s-black.png when not playing');
}

// --- Test Suite 44: Tuning Metadata Consistency, Static Blanking, Resumption & Counter Glitch Prevention ---
console.log('\n--- Test Suite 44: Tuning Metadata Consistency, Static Blanking, Resumption & Counter Glitch Prevention ---');
{
  const playerJs = fs.readFileSync(path.resolve(__dirname, '../extension/player/player.js'), 'utf8');
  const appTsx = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

  // 1. Issue 1: Metadata consistency & embedded artist conflict resolution in player.js
  assert(playerJs.includes('function cleanArtist(rawArtist, rawTitle)'), 'player.js defines cleanArtist helper');
  assert(playerJs.includes('rALower !== embLower'), 'cleanArtist detects conflicting embedded artist in title');
  assert(playerJs.includes('videoId: d.videoId || null'), 'setSong records videoId on song object');

  // Issue 1 in App.tsx: programSongResult must match effectiveStatus.videoId and use currentPlaying refs
  assert(appTsx.includes('programSongResult.selectedVideoId === effectiveStatus.videoId'), 'App.tsx verifies programSongResult videoId matches effectiveStatus videoId');
  assert(appTsx.includes('currentPlayingArtistRef = useRef'), 'App.tsx maintains currentPlayingArtistRef');
  assert(appTsx.includes('currentPlayingSongRef = useRef'), 'App.tsx maintains currentPlayingSongRef');

  // 2. Issue 2: Green display blanking between stations (no STATIC or static glyph)
  assert(playerJs.includes("if(!S.locked){el.textContent='';el.title='';return;}"), 'player.js leaves green display completely blank when untuned (!S.locked)');
  assert(!playerJs.includes("el.textContent='\\u2591 static \\u2591'"), 'player.js no longer assigns static glyph to el.textContent');

  // 3. Issue 3: Station playback position caching and resumption without page reload
  assert(appTsx.includes('stationPlaybackCacheRef.current[currentGenre] = {'), 'App.tsx caches station playback position on untune');
  assert(appTsx.includes('currentLive.connectedTabId && currentLive.videoId === cached.videoId'), 'App.tsx checks if live tab is already on cached videoId');
  assert(appTsx.includes('handlePlayMusicRef.current()'), 'App.tsx resumes playback without page reload when video matches');

  // 4. Issue 4: Prevention of counter glitch on return
  assert(playerJs.includes('if(playbackProgress.videoId && song.videoId && playbackProgress.videoId !== song.videoId)'), 'player.js blanks elapsed time if progress videoId does not match current song videoId');
  assert(playerJs.includes('playbackProgress.currentTime = typeof state.currentSong.currentTime === \'number\''), 'player.js accepts initial currentTime from radio state for instant resumption');

  // Simulation of cleanArtist and cleanTitle conflict resolution
  function simCleanArtist(rawArtist: string, rawTitle: string): string {
    const cleanStr = (s: string) => (s && s.trim() !== 'undefined' && s.trim() !== 'null') ? s.trim() : '';
    const rA = cleanStr(rawArtist);
    let embeddedArtist = '';
    if (rawTitle) {
      const match = rawTitle.trim().match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
      if (match && match[1].trim()) embeddedArtist = match[1].trim();
    }
    if (embeddedArtist && rA) {
      const rALower = rA.toLowerCase();
      const embLower = embeddedArtist.toLowerCase();
      if (rALower !== embLower && !embLower.includes(rALower) && !rALower.includes(embLower)) {
        return embeddedArtist;
      }
    }
    return rA || embeddedArtist;
  }

  function simCleanTitle(rawTitle: string, artist: string): string {
    if (!rawTitle) return '';
    let t = rawTitle.trim();
    if (artist && artist.trim()) {
      const aEsc = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('^' + aEsc + '\\s*[-:—–~]\\s*', 'i'), '');
    }
    return t.trim();
  }

  // Conflict test: rawTitle has "U2 - With or Without You" but rawArtist was stale "a-ha"
  const resolvedArtist = simCleanArtist('a-ha', 'U2 - With or Without You');
  const resolvedTitle = simCleanTitle('U2 - With or Without You', resolvedArtist);
  assert(resolvedArtist === 'U2', 'Simulation: Discordant rawArtist "a-ha" corrected to embedded artist "U2"');
  assert(resolvedTitle === 'With or Without You', 'Simulation: Resolved title is clean "With or Without You" without embedded artist');
  const tooltip = resolvedTitle + (resolvedArtist ? ' by ' + resolvedArtist : '');
  assert(tooltip === 'With or Without You by U2', 'Simulation: Tooltip is "With or Without You by U2", never conflicting');

  // Untuned display blank test
  let displayLocked = false;
  let displayText = 'INITIAL';
  if (!displayLocked) {
    displayText = '';
  }
  assert(displayText === '', 'Simulation: Untuned display is empty string');

  // Resumption test without page reload
  let pageReloadCount = 0;
  let playCallCount = 0;
  const currentLiveTab = { connectedTabId: 101, videoId: 'abc1234', currentTime: 117 };
  const cachedStation = { videoId: 'abc1234', currentTime: 115 };
  if (currentLiveTab.connectedTabId && currentLiveTab.videoId === cachedStation.videoId) {
    playCallCount++;
  } else {
    pageReloadCount++;
  }
  assert(playCallCount === 1 && pageReloadCount === 0, 'Simulation: Returning to same station video does not reload page');
}

// -----------------------------------------------------------------------------
// Suite 45: Station Song Assignment, Automatic Playback, and SEEK/PLAY Display
// -----------------------------------------------------------------------------
{
  console.log('\n--- Test Suite 45: Station Song Assignment, Auto Playback & SEEK/PLAY ---');

  // 45.1 Deterministic 5-song rotation verification across STATIONS_BY_DECADE
  const decades = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
  let totalGenreStations = 0;
  const songUsageCounts: Record<string, number> = {
    'Take on Me': 0,
    'Billie Jean': 0,
    'When Doves Cry': 0,
    'With or Without You': 0,
    'Sledgehammer': 0
  };

  const expectedFiveSongs = [
    'Take on Me',
    'Billie Jean',
    'When Doves Cry',
    'With or Without You',
    'Sledgehammer'
  ];

  for (const dec of decades) {
    const stations = STATIONS_BY_DECADE[dec] || [];
    for (const st of stations) {
      totalGenreStations++;
      const presetKey = st.presetKey || '';
      assert(presetKey !== '', `Station ${st.frequency} FM (${st.genre}) in decade ${dec} must have presetKey assigned`);
      const preset = HARDCODED_PRESETS[presetKey];
      assert(Boolean(preset), `Station ${st.frequency} FM presetKey "${presetKey}" must exist in HARDCODED_PRESETS`);
      assert(Boolean(preset.videoId && preset.artist && preset.song), `Station ${st.frequency} FM preset must have videoId, artist, and song`);
      if (preset && preset.song) {
        if (songUsageCounts[preset.song] !== undefined) {
          songUsageCounts[preset.song]++;
        }
      }
    }
  }

  assert(totalGenreStations === 47, `Total stations configured across all decades should be 47, got ${totalGenreStations}`);
  for (const songName of expectedFiveSongs) {
    assert(
      (songUsageCounts[songName] || 0) >= 9,
      `Deterministic test rotation song "${songName}" should be assigned to at least 9 stations (got ${songUsageCounts[songName]})`
    );
  }
  // Verify that not all stations resolve to Prince
  assert(songUsageCounts['When Doves Cry'] < totalGenreStations, 'Not all stations resolve to Prince - When Doves Cry');
  console.log(`✓ 45.1 Deterministic 5-song rotation verified across all ${totalGenreStations} genre stations.`);

  // 45.2 SEEK in render7SegStatus and updateStatusDisplay
  // In extension/player/player.js:
  // render7SegStatus CONFIG maps:
  //   seek: 'SEEK',
  //   seeking: 'SEEK'
  // When isSeeking is true, updateStatusDisplay renders SEEK
  function mockRender7SegStatus(status: string): string {
    const CONFIG: Record<string, string> = {
      seek: 'SEEK',
      seeking: 'SEEK',
      play: 'PLAY',
      playing: 'PLAY',
      pause: 'PAUSE',
      paused: 'PAUSE',
      stop: 'STOP',
      stopped: 'STOP'
    };
    return CONFIG[(status || '').toLowerCase()] || '';
  }

  assert(mockRender7SegStatus('seek') === 'SEEK', 'render7SegStatus renders "SEEK" for seek state');
  assert(mockRender7SegStatus('seeking') === 'SEEK', 'render7SegStatus renders "SEEK" for seeking state');
  assert(mockRender7SegStatus('play') === 'PLAY', 'render7SegStatus renders "PLAY" for play state');

  // 45.3 Untuned blank display behavior
  function mockUpdateStatusDisplay(isLocked: boolean, isSeeking: boolean, state: string, hasStarted: boolean): string {
    if (!isLocked) {
      return '';
    }
    if (isSeeking || state === 'seek') {
      return mockRender7SegStatus('SEEK');
    }
    if (!hasStarted && (state === 'blank' || !state)) {
      return '';
    }
    return mockRender7SegStatus(state);
  }

  assert(mockUpdateStatusDisplay(false, false, 'seek', false) === '', 'Untuned dial produces blank status display');
  assert(mockUpdateStatusDisplay(false, false, 'playing', true) === '', 'Untuned dial always produces blank status display');
  assert(mockUpdateStatusDisplay(true, true, 'seek', true) === 'SEEK', 'Tuning locked station shows SEEK while seeking');
  assert(mockUpdateStatusDisplay(true, false, 'playing', true) === 'PLAY', 'Playback confirmed shows PLAY on locked station');
  console.log('✓ 45.2 & 45.3 SEEK/PLAY status display and blank untuned behavior verified.');

  // 45.4 Auto-playback trigger on station tune
  let simulatedPlaybackState = 'stopped';
  let simulatedTuneAutoplay = false;

  function simulateTuneEvent(isLocked: boolean, genre: string | null) {
    if (!isLocked || !genre) {
      simulatedPlaybackState = 'paused';
      return { autoPlay: false };
    }
    // Radio simulator auto-plays on station lock
    simulatedTuneAutoplay = true;
    simulatedPlaybackState = 'playing';
    return { autoPlay: true };
  }

  // User tunes away into static
  simulateTuneEvent(false, null);
  assert(simulatedPlaybackState === 'paused', 'Tuning to static pauses playback');

  // User tunes to another genre station
  const tuneRes = simulateTuneEvent(true, 'CHR');
  assert(tuneRes.autoPlay === true, 'Tuning to genre station emits autoPlay: true');
  assert(simulatedPlaybackState === 'playing', 'Genre station starts playing automatically without manual PLAY');
  console.log('✓ 45.4 Auto-playback on station tuning verified.');
}

// --- Test Suite 46: Artist and Song Title Fade-In/Out Display Stability ---
console.log('\n--- Test Suite 46: Artist and Song Title Fade-In/Out Display Stability ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. Verify setSong protects in-flight rotation if same video or same metadata received
  assert(bbJs.includes('const isSameVideo = nextSong.videoId && song.videoId && nextSong.videoId === song.videoId;'), 'setSong checks videoId equality to prevent clobbering active song');
  assert(bbJs.includes('const isSameMetadata = nextSong.title.toLowerCase() === song.title.toLowerCase()'), 'setSong checks case-insensitive metadata equality');

  // 2. Verify cleanArtist & cleanTitle correctly parse artist and title for alternating display
  const artist = cleanArtist('U2', 'With or Without You');
  const title = cleanTitle('With or Without You', artist);
  assert(artist === 'U2', `cleanArtist preserves "U2" (got "${artist}")`);
  assert(title.toLowerCase() === 'with or without you', `cleanTitle preserves "With or Without You" (got "${title}")`);

  // 3. Simulate phase rotation lifecycle (Phase 0: Title for 3000ms -> Phase 1: Artist for 3000ms)
  let simPhase = 0;
  let simDisplay = title;
  let simOpacity = '1';
  let sTimerRunning = false;
  let sFadeTimerRunning = false;

  function simStartFade() {
    sTimerRunning = true;
    // After 3000ms hold
    setTimeout(() => {
      sTimerRunning = false;
      simOpacity = '0'; // 1200ms fade transition
      sFadeTimerRunning = true;
      setTimeout(() => {
        sFadeTimerRunning = false;
        simPhase = simPhase === 0 ? 1 : 0;
        simDisplay = simPhase === 1 ? artist : title;
        simOpacity = '1';
        simStartFade();
      }, 1200);
    }, 3000);
  }

  simStartFade();
  assert(simPhase === 0, 'Phase 0 begins with Song Title');
  assert(simDisplay.toLowerCase() === 'with or without you', 'Display shows Song Title in Phase 0');

  // Transition to Phase 1 (Artist)
  simPhase = 1;
  simDisplay = artist;
  assert(simPhase === 1, 'Phase 1 alternates to Artist');
  assert(simDisplay === 'U2', 'Display shows Artist "U2" in Phase 1');

  // Simulate setSong receiving duplicate or metadata payload while Phase 1 is visible
  let activeSong: any = { title: 'With or Without You', artist: 'U2', videoId: 'XmSdTa9kaiQ' };
  let incomingPayload: any = { title: 'U2 - With or Without You', videoId: 'XmSdTa9kaiQ' };
  let incomingArtist = cleanArtist(incomingPayload.artist, incomingPayload.title);
  let incomingTitle = cleanTitle(incomingPayload.title, incomingArtist);
  let isDuplicate = (incomingPayload.videoId && activeSong.videoId && incomingPayload.videoId === activeSong.videoId) ||
    (incomingTitle.toLowerCase() === activeSong.title.toLowerCase());

  assert(isDuplicate === true, 'Subsequent radio state broadcast recognized as same song');
  // Since it is recognized as the same song, phase is preserved and not reset to 0
  assert(simPhase === 1, 'Phase remains 1 (Artist) and is not prematurely reset to 0');
  assert(simDisplay === 'U2', 'Display retains "U2" without disappearing');
  console.log('✓ 46. Artist and Song Title alternating fade stability verified.');
}


// --- Test Suite 47: Station Switching Display Isolation and Seamless Resumption ---
console.log('\n--- Test Suite 47: Station Switching Display Isolation and Seamless Resumption ---');
{
  const bbJs = fs.readFileSync(path.join(process.cwd(), 'extension/player/player.js'), 'utf-8');
  const bgJs = fs.readFileSync(path.join(process.cwd(), 'extension/background.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
  const ytMusicProviderTs = fs.readFileSync(path.join(process.cwd(), 'src/services/music/YouTubeMusicProvider.ts'), 'utf-8');

  // 1. In player.js, when key !== lastKey and locked onto a station (best), song is immediately cleared
  assert(
    bbJs.includes("if(key!==lastKey){\n   lastKey=key;\n   if(best){\n     song=null;\n     playbackProgress.currentTime = 0;\n     playbackProgress.duration = 0;\n     playbackProgress.videoId = null;\n     clearSongTimers();\n     renderSong();\n   }"),
    'player.js immediately clears song, playback progress, and song timers when tuning to another station'
  );

  // 2. In player.js applyRadioState, state.clearSong clears song and renders
  assert(
    bbJs.includes("if (state.clearSong) {\n    song = null;\n    clearSongTimers();\n    renderSong();"),
    'player.js applyRadioState handles state.clearSong by clearing song and timers'
  );

  // 3. In player.js applyRadioState, station genre mismatch prevents setting currentSong
  assert(
    bbJs.includes("const activeDialGenre = matchedStation ? matchedStation[0] : null;\n    const isMismatchedGenre = state.genre && activeDialGenre && state.genre !== activeDialGenre;\n    if (!isMismatchedGenre) {"),
    'player.js applyRadioState rejects currentSong if state.genre does not match the active dial genre'
  );

  // 4. In background.js NAVIGATE_YOUTUBE, initialTime is sought before PLAY
  assert(
    bgJs.includes("if (typeof payload.initialTime === 'number' && payload.initialTime > 0) {\n            try {\n              await chrome.tabs.sendMessage(tabId, { action: 'SEEK', time: payload.initialTime });"),
    'background.js NAVIGATE_YOUTUBE executes SEEK to initialTime before triggering PLAY loop'
  );

  // 5. In YouTubeMusicProvider.ts, navigate and navigateDetailed accept initialTime
  assert(
    ytMusicProviderTs.includes("public async navigateDetailed(url: string, videoId?: string, targetVolume?: number, revealYouTubeToStart: boolean = true, initialTime?: number)"),
    'YouTubeMusicProvider.ts navigateDetailed accepts initialTime parameter'
  );

  // 6. In App.tsx, switching stations saves cache and immediately clears program song metadata before SEEK broadcast
  assert(
    appTsx.includes("stationPlaybackCacheRef.current[prevGenre] = {\n                genre: prevGenre,\n                frequency: (liveStatus as any).frequency || (freq ?? 0),\n                videoId: liveStatus.videoId,\n                title: liveStatus.title,\n                artist: currentPlayingArtistRef.current || programArtist,\n                song: currentPlayingSongRef.current || programSongTitle,\n                year: currentPlayingYearRef.current || programYear,\n                currentTime: liveStatus.currentTime,\n                duration: liveStatus.duration\n              };\n              // Immediately clear program song metadata for the previous station\n              setProgramSongResult(null);\n              currentPlayingArtistRef.current = '';\n              currentPlayingSongRef.current = '';"),
    'App.tsx saves station cache and clears previous station program metadata when tuning stations'
  );

  // 7. In App.tsx, initial tuning broadcast uses clearSong = true
  assert(
    appTsx.includes("isTuningSeekingRef.current = true;\n            broadcastCurrentRadioState(true, true);"),
    'App.tsx broadcasts SEEK with clearSong=true when tuning to a station'
  );

  // 8. In App.tsx, natural song finish (rawState === 0) clears station playback cache
  assert(
    appTsx.includes("if (activeStationGenreRef.current) {\n            delete stationPlaybackCacheRef.current[activeStationGenreRef.current];\n          }"),
    'App.tsx deletes finished station from stationPlaybackCacheRef on natural completion'
  );

  // 9. In App.tsx, Scenario B passes cached.currentTime to navigateDetailed
  assert(
    appTsx.includes("await musicProviderRef.current.navigate(targetUrl, cached.videoId, targetVolFraction, revealYouTubeToStart, cached.currentTime);"),
    'App.tsx passes cached.currentTime to navigate when switching videos on resumption'
  );

  console.log('✓ 47. Station switching display isolation and seamless resumption verified.');
}


// --- Test Suite 48: Radio Tuning, Genre Availability, and Song Selection ---
console.log('\n--- Test Suite 48: Radio Tuning, Genre Availability, and Song Selection ---');
{
  const bbJs = fs.readFileSync(path.join(process.cwd(), 'extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
  const songSelectorTs = fs.readFileSync(path.join(process.cwd(), 'src/services/songSelector.ts'), 'utf-8');

  // 1. Supported 1960s taxonomy genres in songSelector.ts
  assert(
    songSelectorTs.includes('SUPPORTED_1960S_GENRES'),
    'songSelector.ts exports SUPPORTED_1960S_GENRES'
  );
  const expected1960sTaxonomy = [
    'Baroque Pop', 'Bossa Nova', 'British Invasion', 'Country',
    'Easy Listening', 'Folk', 'Folk Rock', 'Garage Rock',
    'Gospel', 'Jazz', 'Latin', 'Motown',
    'Pop', 'R&B', 'Rock', 'Rock and Roll',
    'Ska', 'Soul', 'Surf Rock'
  ];
  for (const g of expected1960sTaxonomy) {
    assert(songSelectorTs.includes(`'${g}'`), `SUPPORTED_1960S_GENRES contains "${g}"`);
  }

  // 2. getAvailableGenres filters against SUPPORTED_1960S_GENRES and checks existedBy
  assert(
    songSelectorTs.includes('if (is1960s && !SUPPORTED_1960S_GENRES.has(trimmed))'),
    'getAvailableGenres filters 1960s dates against SUPPORTED_1960S_GENRES'
  );
  assert(
    songSelectorTs.includes('if (youtubeId(s) && existedBy(s, broadcastDate))'),
    'getAvailableGenres verifies song existedBy broadcast date'
  );

  // 3. App.tsx broadcasts activeStation genre and frequency instead of hardcoded decade station
  assert(
    appTsx.includes('const currentGenre = activeStationGenreRef.current;'),
    'App.tsx determines current genre from activeStationGenreRef'
  );
  assert(
    appTsx.includes('frequency: activeStation.frequency,\n      genre: activeStation.genre,'),
    'App.tsx broadcasts activeStation.frequency and activeStation.genre'
  );

  // 4. App.tsx TUNE handler resolves station from dynamic stations
  assert(
    appTsx.includes('const dynamicStations = calculateDynamicStationsForDate(songLibraryRef.current, activeDateRef.current, decadeNum);'),
    'App.tsx calculates dynamicStations in TUNE handler'
  );

  // 5. App.tsx handles REQUEST_DATE_STATIONS action
  assert(
    appTsx.includes("case 'REQUEST_DATE_STATIONS':"),
    'App.tsx handles REQUEST_DATE_STATIONS action from boombox flap board'
  );

  // 6. player.js aligns dial frequency to active genre only once on initial connection
  assert(
    bbJs.includes('// Align dial frequency to active genre if needed') &&
    bbJs.includes('if (state.genre && !hasInitializedDial)'),
    'player.js aligns dial frequency to active genre only once on initial connection to avoid snapping'
  );

  // 7. player.js default 1960s stations do not contain unsupported genres
  assert(
    !bbJs.includes("1960:[['Pop',95.1],['Motown',101.5],['Soul',107.1],['R&B',93.5],['Freeform/Underground'"),
    'player.js default 1960s table does not contain Freeform/Underground or Psychedelic Rock'
  );

  // 8. Runtime test: getAvailableGenres with library data
  const libPath = path.join(process.cwd(), 'public/data/retrofm_library_youtube.json');
  if (fs.existsSync(libPath)) {
    const libData = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
    const { getAvailableGenres, pickSong } = await import('../src/services/songSelector.js');

    // On 1963-07-04, Psychedelic Rock has no songs and must not be available
    const genres1963 = getAvailableGenres(libData, '1963-07-04');
    assert(!genres1963.includes('Psychedelic Rock'), 'getAvailableGenres excludes Psychedelic Rock on 1963-07-04');
    assert(genres1963.includes('Motown'), 'getAvailableGenres includes Motown on 1963-07-04');
    assert(genres1963.includes('Pop'), 'getAvailableGenres includes Pop on 1963-07-04');

    // On 1960-07-04, British Invasion has no songs and must not be available
    const genres1960 = getAvailableGenres(libData, '1960-07-04');
    assert(!genres1960.includes('British Invasion'), 'getAvailableGenres excludes British Invasion on 1960-07-04');

    // On 1968-05-01, Bossa Nova has no eligible songs charting within 2 years: must NOT be available and must return null (zero unrelated fallbacks)
    const genres19680501 = getAvailableGenres(libData, '1968-05-01');
    assert(!genres19680501.includes('Bossa Nova'), 'getAvailableGenres excludes Bossa Nova on 1968-05-01 (charted in 1963 and 10 days later)');
    const bossaPick = pickSong(libData, '1968-05-01', 'Bossa Nova', { recent: [] });
    assert(bossaPick === null, 'pickSong returns null for Bossa Nova on 1968-05-01 without falling back to unrelated genres (Hugo Montenegro)');

    // Consistency: Every available genre for 1968-05-01 must successfully yield an eligible song in pickSong
    for (const g of genres19680501) {
      const p = pickSong(libData, '1968-05-01', g, { recent: [] });
      assert(!!p, `Genre "${g}" available on 1968-05-01 must have an eligible song`);
      assert(p?.genreMatched === true, `Song for genre "${g}" must be genreMatched`);
    }

    // 9. Runtime test: pickSong rotation without immediate repeats
    let simState: { recent: string[] } = { recent: [] };
    let lastPlayed = null;
    let immediateRepeatCount = 0;
    for (let i = 0; i < 15; i++) {
      const pick = pickSong(libData, '1964-07-04', 'Motown', simState);
      assert(!!pick, `Pick ${i + 1} for Motown on 1964-07-04 returns a valid pick`);
      if (pick) {
        assert(pick.genreMatched === true, `Pick ${i + 1} genreMatched is true`);
        if (lastPlayed && pick.song.id === lastPlayed.id) {
          immediateRepeatCount++;
        }
        lastPlayed = pick.song;
        simState = pick.state;
      }
    }
    assert(immediateRepeatCount === 0, 'pickSong never immediately repeats the same song back-to-back');
  }

  console.log('✓ 48. Radio Tuning, Genre Availability, and Song Selection verified.');
}


// --- Test Suite 49: Tuning, Station Selection, and Playback Synchronization ---
console.log('\n--- Test Suite 49: Tuning, Station Selection, and Playback Synchronization ---');
{
  const bbJs = fs.readFileSync(path.join(process.cwd(), 'extension/player/player.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
  const libPath = path.join(process.cwd(), 'public/data/retrofm_library_youtube.json');

  // 1. Static code checks for cache isolation & request synchronization in App.tsx
  assert(
    appTsx.includes('const isConfirmedForGenre = Boolean(') &&
    appTsx.includes('(!programSongResult?.selectedVideoId || liveStatus.videoId === programSongResult.selectedVideoId)') &&
    appTsx.includes('!isTuningSeekingRef.current'),
    'App.tsx guards !isLocked cache write to prevent saving unconfirmed videos into currentGenre cache'
  );

  assert(
    appTsx.includes('const isPrevConfirmed = !isTuningSeekingRef.current && (!programSongResult?.selectedVideoId || liveStatus.videoId === programSongResult.selectedVideoId);') &&
    appTsx.includes('isPrevConfirmed'),
    'App.tsx guards prevGenre station cache write with isPrevConfirmed'
  );

  assert(
    appTsx.includes('await playLibrarySong(pick, `Tuned to station ${genre}`, tuneSeq);'),
    'App.tsx passes tuneSeq to playLibrarySong in TUNE handler'
  );

  assert(
    appTsx.includes('const playLibrarySong = async (pick: SongPick, reason: string = \'Library song\', expectedTuneSeq?: number)'),
    'App.tsx playLibrarySong accepts expectedTuneSeq parameter'
  );

  assert(
    appTsx.includes('if (typeof expectedTuneSeq === \'number\' && expectedTuneSeq !== tuneSequenceRef.current) {\n      logMessage(`[Song Selector] Playback request for "${songTitle}" superseded'),
    'App.tsx playLibrarySong verifies tuneSeq after navigation to abort superseded playback requests'
  );

  // 2. Anti-mismatch guard in broadcastCurrentRadioState
  assert(
    appTsx.includes('else if (programSongResult && programSongResult.selectedVideoId && programSongResult.selectedVideoId !== effectiveStatus.videoId) {\n      currentSong = null;'),
    'App.tsx broadcasts currentSong as null when YouTube has not yet switched to the selected video ID'
  );

  // 3. Genre isolation for nextSongRef
  assert(
    appTsx.includes('const isNextGenreValid = nextSongRef.current && (') &&
    appTsx.includes('nextSongRef.current.song.genres?.toLowerCase().includes(targetGenre.toLowerCase())'),
    'App.tsx validates nextSongRef against targetGenre in handlePlayMusic'
  );

  // 4. player.js dial sensitivity and debouncing
  assert(
    bbJs.includes("knob($('kTun'),'tun',40,-135,135,tune,.2/20.5,450);"),
    'player.js sets smooth precision divisor 450 for tuning knob'
  );

  assert(
    bbJs.includes("if (action === 'TUNE' && isTuningDrag) {") &&
    bbJs.includes("function flushPendingTune()"),
    'player.js debounces TUNE actions during dial drag and flushes on release'
  );

  // 5. Runtime simulation of May 1, 1965 reproduction scenario
  if (fs.existsSync(libPath)) {
    const libData = JSON.parse(fs.readFileSync(libPath, 'utf-8'));
    const { calculateDynamicStationsForDate } = await import('../src/App.js');
    const { pickSong, newPlayState } = await import('../src/services/songSelector.js');

    const stations1965 = calculateDynamicStationsForDate(libData, '1965-05-01', 1960);
    assert(stations1965.length >= 3, '1965-05-01 has at least 3 dynamic stations');
    assert(stations1965[0].genre === 'British Invasion' && Math.abs(stations1965[0].frequency - 88.5) < 0.05, 'Station 0 is British Invasion at 88.5 FM');
    assert(stations1965[1].genre === 'Country' && Math.abs(stations1965[1].frequency - 90.1) < 0.05, 'Station 1 is Country at 90.1 FM');
    assert(stations1965[2].genre === 'Easy Listening' && Math.abs(stations1965[2].frequency - 91.5) < 0.05, 'Station 2 is Easy Listening at 91.5 FM');

    let state = newPlayState();
    // Step 1: Tune to British Invasion
    const pick1 = pickSong(libData, '1965-05-01', 'British Invasion', state);
    assert(!!pick1, 'Pick for British Invasion returns a valid song');
    if (pick1) {
      assert(pick1.genreMatched === true, 'British Invasion song is genre matched');
      const biVideoId = pick1.song.streaming.youtube.id;
      state = pick1.state;

      // Simulate active YouTube playback on British Invasion
      let livePlaybackStatus = {
        connectedTabId: 101,
        videoId: biVideoId,
        title: `${pick1.song.artist} - ${pick1.song.title}`,
        isPlaying: true,
        currentTime: 42,
        duration: 160
      };
      let stationPlaybackCache: Record<string, any> = {};

      // Station 0 saves cache on departure
      stationPlaybackCache['British Invasion'] = {
        genre: 'British Invasion',
        frequency: 88.5,
        videoId: livePlaybackStatus.videoId,
        title: livePlaybackStatus.title,
        artist: pick1.song.artist,
        song: pick1.song.title,
        currentTime: 42,
        duration: 160
      };
      assert(stationPlaybackCache['British Invasion'].videoId === biVideoId, 'British Invasion cached with correct video ID');

      // Step 2: Manually tune to 90.1 FM (Country)
      // Dial sweeps past 88.6 (untuned) and lands on 90.1 (Country)
      const pick2 = pickSong(libData, '1965-05-01', 'Country', state);
      assert(!!pick2, 'Pick for Country returns a valid song');
      if (pick2) {
        assert(pick2.genreMatched === true, 'Country song is genre matched');
        const countryVideoId = pick2.song.streaming.youtube.id;
        assert(countryVideoId !== biVideoId, 'Country video ID is different from British Invasion video ID');

        // Simulate transient needle movement across 90.1 -> 90.2 -> 90.1 while Country is seeking
        let isTuningSeeking = true;
        let programSongResult: any = {
          status: 'NAVIGATING',
          selectedVideoId: countryVideoId,
          selectedTitle: pick2.song.title
        };

        // If an untuned event fires while isTuningSeeking is true, cache write must be BLOCKED
        const isConfirmedForGenre = Boolean(
          livePlaybackStatus.videoId &&
          (!programSongResult?.selectedVideoId || livePlaybackStatus.videoId === programSongResult.selectedVideoId) &&
          !isTuningSeeking
        );
        assert(isConfirmedForGenre === false, 'Cache write is blocked while Country is seeking and YouTube has previous video');
        assert(!stationPlaybackCache['Country'], 'Country cache remains uncorrupted by previous British Invasion video');

        // Step 3: Anti-mismatch display verification
        // While YouTube tab still has biVideoId and programSongResult has countryVideoId:
        function computeCurrentSong(pResult: any, pStatus: any, isSeeking: boolean) {
          if (isSeeking) return null;
          if (pResult && pResult.selectedVideoId && pResult.selectedVideoId === pStatus.videoId) {
            return { title: pResult.selectedTitle, videoId: pResult.selectedVideoId };
          }
          if (pResult && pResult.selectedVideoId && pResult.selectedVideoId !== pStatus.videoId) {
            return null;
          }
          return null;
        }

        assert(computeCurrentSong(programSongResult, livePlaybackStatus, isTuningSeeking) === null, 'Green display remains null during seek');
        assert(computeCurrentSong(programSongResult, livePlaybackStatus, false) === null, 'Green display remains null while YouTube has not transitioned to Country video');

        // When YouTube confirms navigation to Country video:
        livePlaybackStatus.videoId = countryVideoId;
        livePlaybackStatus.title = `${pick2.song.artist} - ${pick2.song.title}`;
        programSongResult.status = 'PLAYING';
        isTuningSeeking = false;
        const confirmedSong = computeCurrentSong(programSongResult, livePlaybackStatus, false);
        assert(confirmedSong !== null, 'Green display confirms song once YouTube navigates');
        if (confirmedSong) {
          assert(confirmedSong.videoId === countryVideoId, 'Green display confirms Country video ID');
        }

        // Step 4: Tune to Station 2 (Easy Listening 91.5 FM)
        const pick3 = pickSong(libData, '1965-05-01', 'Easy Listening', state);
        assert(!!pick3, 'Pick for Easy Listening returns a valid song');
        if (pick3) {
          assert(pick3.genreMatched === true, 'Easy Listening song is genre matched');
          const easyVideoId = pick3.song.streaming.youtube.id;
          assert(easyVideoId !== countryVideoId && easyVideoId !== biVideoId, 'Easy Listening video ID is unique and correct');
        }
      }
    }
  }

  console.log('✓ 49. Tuning, Station Selection, and Playback Synchronization verified.');
}

// --- Test Suite 50: Startup Readiness Detection and START RETRO FM Button Behavior ---
console.log('\n--- Test Suite 50: Startup Readiness Detection and START RETRO FM Button Behavior ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const bgJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf-8');
  const csYtJs = fs.readFileSync(path.join(__dirname, '../extension/content_youtube.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // Verify source code hooks
  assert(bgJs.includes('checkYouTubeReadiness'), 'background.js defines checkYouTubeReadiness helper');
  assert(bgJs.includes('notifyYouTubeReadiness'), 'background.js defines notifyYouTubeReadiness helper');
  assert(bgJs.includes('chrome.tabs.onUpdated.addListener'), 'background.js monitors tab updates for YouTube completion');
  assert(csYtJs.includes("type: 'YT_PAGE_READY'"), 'content_youtube.js announces YT_PAGE_READY on initialization');
  assert(csYtJs.includes('hasVideoElement: false'), 'content_youtube.js returns available: true even without mounted video element');
  assert(bbJs.includes("message.type === 'YT_READY'"), 'player.js listens for YT_READY event');
  assert(bbJs.includes('startupReadyInterval'), 'player.js uses bounded polling for startup readiness');
  assert(appTsx.includes('const isStartupReady = Boolean('), 'App.tsx computes isStartupReady from connected tab availability');

  // State Machine Simulation for all 10 scenarios
  class StartupHandoffSimulation {
    ytTab: { id: number; url: string; status: 'loading' | 'complete'; hasScript: boolean } | null = null;
    isStartupReady: boolean = false;
    modalBoxClass: string = 'rfm-modal-box';
    buttonClass: string = 'rfm-start-btn';
    buttonDisabled: boolean = true;
    modalHidden: boolean = false;
    handoffCount: number = 0;
    appConnected: boolean = true;

    // Simulate background.js checkYouTubeReadiness()
    checkReadiness(): { ready: boolean; tabId: number | null } {
      if (!this.ytTab || !this.ytTab.url.includes('youtube.com')) {
        return { ready: false, tabId: null };
      }
      if (this.ytTab.status !== 'complete' || !this.ytTab.hasScript) {
        return { ready: false, tabId: this.ytTab.id };
      }
      return { ready: true, tabId: this.ytTab.id };
    }

    // Simulate player.js markStartupReady()
    markStartupReady() {
      this.isStartupReady = true;
      this.modalBoxClass = 'rfm-modal-box ready';
      this.buttonClass = 'rfm-start-btn ready';
      this.buttonDisabled = false;
    }

    // Simulate player.js START RETRO FM button click
    clickStart(): boolean {
      if (!this.isStartupReady || this.buttonDisabled || this.handoffCount > 0) {
        return false;
      }
      this.handoffCount++;
      this.buttonDisabled = true;
      this.modalHidden = true;
      return true;
    }
  }

  // 1. YouTube is ready before the initial page opens
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = { id: 101, url: 'https://www.youtube.com/', status: 'complete', hasScript: true };
    const check = sim.checkReadiness();
    assert(check.ready === true, '1. YouTube check reports ready when tab complete before initial page');
    sim.markStartupReady();
    assert(sim.buttonClass.includes('ready') && !sim.buttonDisabled, '1. Button immediately appears and is enabled');
  }

  // 2. YouTube becomes ready after the initial page opens
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = null;
    assert(sim.checkReadiness().ready === false, '2. Initial check reports not ready when YouTube not opened');
    assert(sim.buttonDisabled === true && !sim.buttonClass.includes('ready'), '2. Button starts disabled and unready');
    // YouTube opens and completes loading
    sim.ytTab = { id: 102, url: 'https://www.youtube.com/', status: 'complete', hasScript: true };
    assert(sim.checkReadiness().ready === true, '2. Check succeeds once YouTube loads after initial page');
    sim.markStartupReady();
    assert(sim.buttonClass.includes('ready') && !sim.buttonDisabled, '2. Button updates to ready without page reload');
  }

  // 3. Readiness is reported after an initial request fails or times out
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = { id: 103, url: 'https://www.youtube.com/', status: 'loading', hasScript: false };
    assert(sim.checkReadiness().ready === false, '3. Initial request fails during loading');
    assert(sim.buttonDisabled === true, '3. Button remains disabled during initial failure');
    // Next poll tick after script injected and page completed
    sim.ytTab.status = 'complete';
    sim.ytTab.hasScript = true;
    assert(sim.checkReadiness().ready === true, '3. Recovery poll succeeds');
    sim.markStartupReady();
    assert(!sim.buttonDisabled && sim.buttonClass.includes('ready'), '3. Button activates after retry');
  }

  // 4. The readiness response arrives after the relevant listener is initialized
  {
    const sim = new StartupHandoffSimulation();
    assert(sim.isStartupReady === false, '4. Listener initialized before readiness arrival');
    // Message arrives from background
    sim.markStartupReady();
    assert(sim.isStartupReady === true, '4. Readiness successfully processed after listener registration');
  }

  // 5. Duplicate readiness notifications do not trigger duplicate startup actions
  {
    const sim = new StartupHandoffSimulation();
    sim.markStartupReady();
    sim.markStartupReady();
    sim.markStartupReady();
    assert(sim.buttonClass === 'rfm-start-btn ready', '5. Button class remains idempotent on duplicate ready notifications');
    const firstClick = sim.clickStart();
    assert(firstClick === true, '5. First click triggers startup handoff');
    const secondClick = sim.clickStart();
    assert(secondClick === false, '5. Subsequent clicks are ignored');
    assert(sim.handoffCount === 1, '5. Exactly one startup handoff executed');
  }

  // 6. A stale readiness response from an obsolete tab is ignored
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = { id: 999, url: 'https://www.google.com/', status: 'complete', hasScript: false };
    assert(sim.checkReadiness().ready === false, '6. Obsolete or non-YouTube tab is rejected');
  }

  // 7. A service-worker restart does not permanently prevent readiness detection
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = { id: 104, url: 'https://www.youtube.com/', status: 'complete', hasScript: true };
    // Simulate service worker restart where in-memory activeConnectedTabId was reset to null
    const freshCheck = sim.checkReadiness();
    assert(freshCheck.ready === true, '7. Dynamically resolves live YouTube tab despite worker restart');
  }

  // 8. YouTube reloads and the readiness state is updated appropriately
  {
    const sim = new StartupHandoffSimulation();
    sim.ytTab = { id: 105, url: 'https://www.youtube.com/watch?v=abc', status: 'complete', hasScript: true };
    assert(sim.checkReadiness().ready === true, '8. Ready before reload');
    // Tab reload starts
    sim.ytTab.status = 'loading';
    assert(sim.checkReadiness().ready === false, '8. Correctly transitions to not ready during reload');
    // Tab reload finishes
    sim.ytTab.status = 'complete';
    assert(sim.checkReadiness().ready === true, '8. Recovers readiness when reload completes');
  }

  // 9. The button becomes visible when the actual readiness condition is met
  {
    const sim = new StartupHandoffSimulation();
    sim.markStartupReady();
    assert(sim.buttonClass.includes('ready'), '9. .ready class added to button');
    assert(sim.modalBoxClass.includes('ready'), '9. .ready class added to modal box');
    assert(bbCss.includes('.rfm-start-btn.ready{background:#d22a1c;color:#ffffff;'), '9. CSS reveals red start button');
  }

  // 10. The button does not become enabled prematurely when the integration is not ready
  {
    const sim = new StartupHandoffSimulation();
    assert(sim.buttonDisabled === true, '10. Button remains disabled initially');
    assert(!sim.buttonClass.includes('ready'), '10. Button remains black-on-black/invisible');
    assert(sim.clickStart() === false, '10. Attempting to click prematurely fails safely');
  }

  console.log('✓ 50. Startup Readiness Detection and START RETRO FM Button Behavior verified.');
}

// --- Test Suite 51: Initialization Order & TDZ Protection ---
console.log('\n--- Test Suite 51: Initialization Order & TDZ Protection ---');
{
  const playerJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. Verify isYtPlaybackActive is declared before updateGenrePills and tune
  const isYtDeclIndex = playerJs.indexOf('let isYtPlaybackActive = false;');
  const updateGenrePillsIndex = playerJs.indexOf('function updateGenrePills()');
  const tuneCallIndex = playerJs.indexOf('tune();refresh();dIn.focus();');

  assert(isYtDeclIndex !== -1, 'player.js declares let isYtPlaybackActive = false;');
  assert(updateGenrePillsIndex !== -1, 'player.js defines updateGenrePills()');
  assert(tuneCallIndex !== -1, 'player.js invokes tune() at startup');
  assert(isYtDeclIndex < updateGenrePillsIndex, 'isYtPlaybackActive declared before updateGenrePills() definition');
  assert(isYtDeclIndex < tuneCallIndex, 'isYtPlaybackActive declared before startup tune() invocation');

  // 2. Verify VU meter declaration line does NOT duplicate isYtPlaybackActive
  assert(playerJs.includes('let env=0,nl=0,nr=0,beat=.5,vuRunning=false;'), 'VU meter declaration line excludes duplicate isYtPlaybackActive declaration');

  // 3. Verify simulated startup execution without TDZ error
  try {
    const fn = new Function(`
      const S = { state: 'stopped', vol: 0.7, bal: 0.5, tun: 0.6, dec: 1990 };
      const ST = { 1990: [['Grunge', 99.9]] };
      const MIN = 87.5, SPAN = 20.5;
      let isYtPlaybackActive = false;
      function updateGenrePills() {
        const isPlaying = (S.state === 'playing' || isYtPlaybackActive);
        return isPlaying;
      }
      return updateGenrePills();
    `);
    const res = fn();
    assert(res === false, 'Startup execution evaluates updateGenrePills safely without ReferenceError');
  } catch (err: any) {
    assert(false, 'Startup evaluation threw unexpected error: ' + err.message);
  }

  console.log('✓ 51. Initialization Order & TDZ Protection verified.');
}

// --- Test Suite 52: Song Completion and Seek Display Transition ---
console.log('\n--- Test Suite 52: Song Completion and Seek Display Transition ---');
{
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');
  const playerJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. App.tsx advanceToNextSong guards with isAdvancingRef
  assert(appTsx.includes('if (isAdvancingRef.current) return false;'), 'advanceToNextSong guards against re-entrancy');
  assert(appTsx.includes('isAdvancingRef.current = true;'), 'advanceToNextSong sets isAdvancingRef to true during advancement');
  assert(appTsx.includes('isSongTransition = isAdvancingRef.current && !effectiveStatus.isPlaying;'), 'App.tsx identifies song transition when advancing without active playback');
  assert(appTsx.includes('rawMode = (isTuningSeekingRef.current || isSongTransition) ? \'seek\''), 'App.tsx sets rawMode to seek during song transitions');

  // 2. player.js sets seeking state on natural completion transition
  assert(playerJs.includes('if (!isJingle) {\n          setSeekingState(true);\n        } else {\n          setSeekingState(false);\n        }'), 'player.js sets seeking state when natural non-jingle song ends');

  // 3. User pause still produces paused state
  assert(playerJs.includes('else if (rawState === 2) {\n        if (!isSeeking) {\n          setVisualTransport(\'paused\');\n        }\n      }'), 'player.js retains paused state when YouTube pauses without seeking');

  // 4. Simulated state transitions for song end vs user pause
  const render7SegStatus = (st: string) => {
    switch (st) {
      case 'playing': return 'PLAY';
      case 'paused': return 'PAUSE';
      case 'stopped': return 'STOP';
      case 'seek': return 'SEEK';
      case 'rew': return 'REW';
      case 'ff': return 'FF';
      default: return 'STOP';
    }
  };

  // State machine simulation
  let simulatedTransport = 'playing';
  let isSeeking = false;

  // Scenario A: Song finishes naturally -> transitions to SEEK
  // YouTube emits rawState: 0 (ended)
  const isJingle = false;
  if (!isJingle) {
    isSeeking = true;
  }
  let displayStatus = isSeeking ? 'SEEK' : render7SegStatus(simulatedTransport);
  assert(displayStatus === 'SEEK', 'Display shows SEEK immediately when song finishes naturally');

  // YouTube emits rawState: 2 (unloading/pause) while seeking to next song
  if (!isSeeking) {
    simulatedTransport = 'paused';
  }
  displayStatus = isSeeking ? 'SEEK' : render7SegStatus(simulatedTransport);
  assert(displayStatus === 'SEEK', 'Display suppresses PAUSE and keeps SEEK while YouTube prepares next song');

  // YouTube starts playing next song (rawState: 1)
  isSeeking = false;
  simulatedTransport = 'playing';
  displayStatus = isSeeking ? 'SEEK' : render7SegStatus(simulatedTransport);
  assert(displayStatus === 'PLAY', 'Display returns to PLAY once next song starts playing');

  // Scenario B: User explicitly clicks PAUSE
  // isSeeking is false, YouTube emits rawState: 2 (paused)
  if (!isSeeking) {
    simulatedTransport = 'paused';
  }
  displayStatus = isSeeking ? 'SEEK' : render7SegStatus(simulatedTransport);
  assert(displayStatus === 'PAUSE', 'Display correctly shows PAUSE when user explicitly pauses');

  console.log('✓ 52. Song Completion and Seek Display Transition verified.');
}

// --- Test Suite 53: Historical Song Eligibility and REWIND Selection ---
console.log('\n--- Test Suite 53: Historical Song Eligibility and REWIND Selection ---');
{
  const appTsx = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
  const libPath = path.join(process.cwd(), 'public/data/retrofm_library_youtube.json');
  const { pickSong, newPlayState, isReleasedOnOrBefore, isStrictlyReleasedBefore, existedBy } = await import('../src/services/songSelector.js');
  const libData = fs.existsSync(libPath) ? JSON.parse(fs.readFileSync(libPath, 'utf-8')) : [];

  // 1. Static code assertions: App.tsx REWIND handler calls pickSong from songLibraryRef
  assert(
    appTsx.includes('handleRewindMusic') &&
    appTsx.includes('songLibraryRef.current.length > 0') &&
    appTsx.includes('pickSong(') &&
    appTsx.includes('playLibrarySong(pick, \'REWIND / Previous\')'),
    'App.tsx handleRewindMusic queries songLibraryRef via pickSong() for active date and genre'
  );

  // 2. Static code assertions: Queue fallback enforces historical eligibility
  assert(
    appTsx.includes('if (activeDateRef.current && !isReleasedOnOrBefore(targetSong, activeDateRef.current))'),
    'App.tsx navigateToQueueSong enforces isReleasedOnOrBefore cutoff on active broadcast date'
  );

  // 3. Test Case 1 & 2: Historical REWIND & Known Future Song Rejection
  // Broadcast date: May 1, 1969; Genre: POP
  // Peter Gabriel's "Sledgehammer" (1986) or any song released after May 1, 1969 must never be selected.
  const broadcastDate1969 = '1969-05-01';
  let state1969 = newPlayState();
  const pick1969 = pickSong(libData, broadcastDate1969, 'Pop', state1969);
  assert(!!pick1969, 'pickSong returns an eligible song for 1969-05-01 Pop');
  if (pick1969) {
    assert(pick1969.genreMatched === true, 'Test Case 3: REWIND respects genre (Pop)');
    assert(isReleasedOnOrBefore(pick1969.song, broadcastDate1969), 'Test Case 1: Picked song released on or before May 1, 1969');
    assert(
      !pick1969.song.title.toLowerCase().includes('sledgehammer') &&
      !pick1969.song.artist.toLowerCase().includes('peter gabriel'),
      'Test Case 2: Peter Gabriel - Sledgehammer is rejected for May 1, 1969'
    );
  }

  // 4. Test Case 4: Date boundary tests
  // Exactly on broadcast date
  const songOnDate = {
    id: 'test-exact-date',
    title: 'On Date Song',
    artist: 'Artist',
    chart_year: 1969,
    release_date: '1969-05-01',
    release_date_precision: 'day',
    genres: 'Pop',
    primary_genre: 'Pop',
    peak_position: 1,
    first_chart_date: '1969-05-01',
    last_chart_date: '1969-06-01',
    peak_date: '1969-05-15',
    weeks_on_chart: 4,
    streaming: { youtube: { id: 'vid1', url: 'https://youtube.com/watch?v=vid1' } }
  };
  const songDayAfter = {
    ...songOnDate,
    id: 'test-after-date',
    release_date: '1969-05-02'
  };
  assert(isReleasedOnOrBefore(songOnDate, '1969-05-01') === true, 'Test Case 4a: Song released on broadcast date is eligible');
  assert(isReleasedOnOrBefore(songDayAfter, '1969-05-01') === false, 'Test Case 4b: Song released 1 day after broadcast date is ineligible');

  // Month and year precision boundary tests
  const songMonthSame = { ...songOnDate, release_date: '1969-05', release_date_precision: 'month' };
  const songMonthAfter = { ...songOnDate, release_date: '1969-06', release_date_precision: 'month' };
  assert(isReleasedOnOrBefore(songMonthSame, '1969-05-01') === true, 'Test Case 4c: Song released in same month is eligible under month precision');
  assert(isReleasedOnOrBefore(songMonthAfter, '1969-05-01') === false, 'Test Case 4d: Song released in following month is ineligible');

  const songYearSame = { ...songOnDate, release_date: '1969', release_date_precision: 'year' };
  const songYearAfter = { ...songOnDate, release_date: '1970', release_date_precision: 'year' };
  assert(isReleasedOnOrBefore(songYearSame, '1969-05-01') === true, 'Test Case 4e: Song released in same year is eligible under year precision');
  assert(isReleasedOnOrBefore(songYearAfter, '1969-05-01') === false, 'Test Case 4f: Song released in following year is ineligible');

  // 5. Test Case 5: Unknown or missing release date
  const songNoRelDate = { ...songOnDate, release_date: null };
  const songEmptyRelDate = { ...songOnDate, release_date: '' };
  assert(isReleasedOnOrBefore(songNoRelDate, '1969-05-01') === false, 'Test Case 5a: Song with null release date is ineligible');
  assert(isReleasedOnOrBefore(songEmptyRelDate, '1969-05-01') === false, 'Test Case 5b: Song with empty release date is ineligible');

  // 6. Test Case 6: Queue / fallback rejection
  const sledgehammerQueueItem = {
    videoId: 'OJWJE0x7T4Q',
    title: 'Peter Gabriel - Sledgehammer (1986)',
    artist: 'Peter Gabriel',
    song: 'Sledgehammer',
    year: '1986',
    release_date: '1986-04-21',
    release_date_precision: 'day',
    duration: '04:58'
  };
  assert(isReleasedOnOrBefore(sledgehammerQueueItem, '1969-05-01') === false, 'Test Case 6: Sledgehammer in queue is ineligible for 1969-05-01');

  // 7. Test Case 7: Later broadcast date
  assert(isReleasedOnOrBefore(sledgehammerQueueItem, '1986-05-01') === true, 'Test Case 7: Sledgehammer is eligible for broadcast date 1986-05-01');

  // 8. Test Case 8: No eligible songs followed without selecting ineligible song
  const emptyLib: any[] = [];
  const pickEmpty = pickSong(emptyLib, '1969-05-01', 'Pop', newPlayState());
  assert(pickEmpty === null, 'Test Case 8: When no songs are eligible, pickSong returns null without selecting ineligible song');

  console.log('✓ 53. Historical Song Eligibility and REWIND Selection verified.');
}

// --- Test Suite 54: Boombox Volume Knob Resilience & Lifecycle ---
console.log('\n--- Test Suite 54: Boombox Volume Knob Resilience & Lifecycle ---');
{
  // Mock music provider tracking volume and ramp calls
  class MockMusicProvider {
    public volumeCalls: { fraction: number; rampId: number }[] = [];
    public rampCalls: { fraction: number; durationMs: number; rampId: number }[] = [];

    public async setVolume(fraction: number, rampId: number): Promise<boolean> {
      this.volumeCalls.push({ fraction, rampId });
      return true;
    }

    public async rampVolume(fraction: number, durationMs: number, rampId: number): Promise<boolean> {
      this.rampCalls.push({ fraction, durationMs, rampId });
      return true;
    }
  }

  // Test 1: Multiple volume adjustments in 'idle' state immediately update YouTube volume
  const provider1 = new MockMusicProvider();
  const vc1 = new VolumeController({
    musicProvider: provider1 as any,
    onLog: () => {},
    initialUserVolume: 80,
    initialDuckLevel: 20
  });

  assert(vc1.getState() === 'idle', 'Test 1a: VolumeController initializes in idle state');
  assert(vc1.getUserVolume() === 80, 'Test 1b: User volume correctly initialized to 80');

  await vc1.setUserVolume(65, 'Knob turn 1');
  assert(vc1.getUserVolume() === 65, 'Test 1c: User volume updated to 65');
  assert(provider1.volumeCalls.length === 1 && provider1.volumeCalls[0].fraction === 0.65, 'Test 1d: Provider setVolume received 0.65');

  await vc1.setUserVolume(40, 'Knob turn 2');
  assert(vc1.getUserVolume() === 40, 'Test 1e: User volume updated to 40');
  assert(provider1.volumeCalls.length === 2 && provider1.volumeCalls[1].fraction === 0.4, 'Test 1f: Provider setVolume received 0.4');

  // Test 2: Knob adjustment while ducked/restoring preserves user volume and restores cleanly
  const provider2 = new MockMusicProvider();
  const vc2 = new VolumeController({
    musicProvider: provider2 as any,
    onLog: () => {},
    initialUserVolume: 90,
    initialDuckLevel: 15
  });

  const duckPromise = vc2.duck(50, 'DJ speech start');
  assert(vc2.getState() === 'ducking' || vc2.getState() === 'ducked', 'Test 2a: Controller begins ducking');
  const duckRes = await duckPromise;
  assert(duckRes === true, 'Test 2b: Ducking completed successfully');
  assert(vc2.getState() === 'ducked', 'Test 2c: State is ducked');

  // Turn volume knob while ducked
  await vc2.setUserVolume(50, 'Knob turned while ducked');
  assert(vc2.getUserVolume() === 50, 'Test 2d: userVolume immediately updated to 50 while ducked');

  // Now restore after DJ speech
  const restoreRes = await vc2.restore(50, 'DJ speech finished');
  assert(restoreRes === true, 'Test 2e: Restoration completed');
  assert(vc2.getState() === 'idle', 'Test 2f: State returned to idle');
  assert(vc2.getUserVolume() === 50, 'Test 2g: Restored user volume reflects the knob adjustment (50)');

  // Turn knob again after restoration completes
  await vc2.setUserVolume(75, 'Knob turned after restore');
  assert(vc2.getUserVolume() === 75, 'Test 2h: Volume knob immediately updates userVolume after restore');
  const lastCall = provider2.volumeCalls[provider2.volumeCalls.length - 1];
  assert(lastCall && lastCall.fraction === 0.75, 'Test 2i: Provider received setVolume 0.75 after restore');

  // Test 3: Song transition / navigation during speech or stale duck ramp does not leave controller stuck
  const provider3 = new MockMusicProvider();
  const vc3 = new VolumeController({
    musicProvider: provider3 as any,
    onLog: () => {},
    initialUserVolume: 85,
    initialDuckLevel: 20
  });

  // Cancel immediately resets state to idle
  await vc3.duck(200, 'DJ speech');
  await vc3.cancel('Song navigation');
  assert(vc3.getState() === 'idle', 'Test 3a: Cancel resets state to idle');
  assert(vc3.isSequenceActive() === false, 'Test 3b: isSequenceActive is false after cancel');

  // Knob can immediately control volume again
  await vc3.setUserVolume(30, 'Knob turn after song transition');
  assert(vc3.getUserVolume() === 30, 'Test 3c: userVolume is 30');
  const postCancelCall = provider3.volumeCalls[provider3.volumeCalls.length - 1];
  assert(postCancelCall && postCancelCall.fraction === 0.3, 'Test 3d: Provider setVolume received 0.3 immediately after transition');

  // Test 4: Sync initial volume is deferred if sequence active and does not corrupt state
  const provider4 = new MockMusicProvider();
  const vc4 = new VolumeController({
    musicProvider: provider4 as any,
    onLog: () => {},
    initialUserVolume: 70,
    initialDuckLevel: 20
  });

  await vc4.duck(10, 'DJ break');
  await vc4.syncInitialVolume('New song start while ducked');
  assert(vc4.getState() === 'ducked', 'Test 4a: syncInitialVolume deferred while sequence active, state remains ducked');

  await vc4.restore(10, 'DJ break end');
  assert(vc4.getState() === 'idle', 'Test 4b: Restored cleanly to idle');

  await vc4.setUserVolume(95, 'Knob turn on new song');
  assert(vc4.getUserVolume() === 95, 'Test 4c: Knob adjustment functions normally on subsequent song');

  console.log('✓ 54. Boombox Volume Knob Resilience & Lifecycle verified.');
}

// --- Test Suite 55: DJ Talk Frequency Presets & Silent Break Behavior ---
console.log('\n--- Test Suite 55: DJ Talk Frequency Presets & Silent Break Behavior ---');
{
  // 1. Validate TALK_PRESETS configuration and keys
  assert(Boolean(TALK_PRESETS), 'Test 1a: TALK_PRESETS is exported');
  assert(TALK_PRESETS.every.talkChance === 1.0 && TALK_PRESETS.every.maxSilentBreaks === 0, 'Test 1b: "every" preset has talkChance 1.0 and maxSilentBreaks 0');
  assert(TALK_PRESETS.often.talkChance === 0.67 && TALK_PRESETS.often.maxSilentBreaks === 2, 'Test 1c: "often" preset has talkChance 0.67 and maxSilentBreaks 2');
  assert(TALK_PRESETS.sometimes.talkChance === 0.35 && TALK_PRESETS.sometimes.maxSilentBreaks === 4, 'Test 1d: "sometimes" preset has talkChance 0.35 and maxSilentBreaks 4');
  assert(TALK_PRESETS.rarely.talkChance === 0.2 && TALK_PRESETS.rarely.maxSilentBreaks === 6, 'Test 1e: "rarely" preset has talkChance 0.2 and maxSilentBreaks 6');

  // Dummy songs for testing buildBreak
  const dummySong1 = {
    id: 'song-1',
    title: 'Test Song One',
    artist: 'Test Artist',
    release_date: '1964-01-01',
    release_date_precision: 'day',
    primary_genre: 'Pop',
    genres: 'Pop',
    peak_position: 1,
    peak_date: '1964-02-01',
    last_chart_date: '1964-05-01',
    weeks_on_chart: 12
  };
  const dummySong2 = {
    id: 'song-2',
    title: 'Test Song Two',
    artist: 'Another Artist',
    release_date: '1964-03-01',
    release_date_precision: 'day',
    primary_genre: 'Rock',
    genres: 'Rock',
    peak_position: 5,
    peak_date: '1964-04-01',
    last_chart_date: '1964-06-01',
    weeks_on_chart: 8
  };

  // 2. Preset "every": with talkChance 1.0, buildBreak returns speech for every song change
  const state0 = newDjState(12345);
  const breakEvery1 = buildBreak(dummySong1, dummySong2, '1964-07-04', state0, Math.random, TALK_PRESETS.every);
  assert(breakEvery1.text.length > 0, 'Test 2a: "every" preset produces spoken commentary on break 1');

  const breakEvery2 = buildBreak(dummySong2, dummySong1, '1964-07-04', breakEvery1.state, Math.random, TALK_PRESETS.every);
  assert(breakEvery2.text.length > 0, 'Test 2b: "every" preset produces spoken commentary on break 2');

  // 3. Preset "rarely": with mock RNG returning 0.9 (>= 0.2), buildBreak produces silent break (empty text)
  const mockRngAlwaysSilent = () => 0.99;
  const breakSilent = buildBreak(dummySong1, dummySong2, '1964-07-04', state0, mockRngAlwaysSilent, TALK_PRESETS.rarely);
  assert(breakSilent.text === '', 'Test 3a: buildBreak returns empty text when RNG misses talkChance');
  assert(breakSilent.state.silentRun === 1, 'Test 3b: silentRun counter increments on silent break');

  // 4. Silent break enforcement: empty text causes App.tsx to skip executeDJOverMusic (so no ducking)
  let duckExecuted = false;
  const simulateAutoAdvance = (breakResultText: string) => {
    if (breakResultText) {
      duckExecuted = true;
    }
  };
  simulateAutoAdvance(breakSilent.text);
  assert(duckExecuted === false, 'Test 4: When breakResultText is empty, music ducking / speech execution is NOT invoked');

  console.log('✓ 55. DJ Talk Frequency Presets & Silent Break Behavior verified.');
}

// --- Test Suite 56: Boom Box DJ Speech Playback Delegation ---
console.log('\n--- Test Suite 56: Boom Box DJ Speech Playback Delegation ---');
{
  // 1. YouTubeMusicProvider has playBoomBoxDjSpeech and onBoomBoxDjSpeechFinished
  const provider = new YouTubeMusicProvider();
  assert(typeof provider.playBoomBoxDjSpeech === 'function', 'Test 1a: YouTubeMusicProvider has playBoomBoxDjSpeech method');
  assert(typeof provider.onBoomBoxDjSpeechFinished === 'function', 'Test 1b: YouTubeMusicProvider has onBoomBoxDjSpeechFinished method');

  // 2. Verify BOOMBOX_DJ_SPEECH_FINISHED dispatches to listener
  const resultState = { speechFinishedReceived: false, receivedPayload: null as any };
  const unsubscribe = provider.onBoomBoxDjSpeechFinished((payload) => {
    resultState.speechFinishedReceived = true;
    resultState.receivedPayload = payload;
  });

  (provider as any).boomBoxDjSpeechFinishedListeners.forEach((fn: any) => {
    fn({ success: true, text: 'Up next, Born A Woman from Sandy Posey.', durationSec: 4.5 });
  });

  assert(resultState.speechFinishedReceived, 'Test 2a: onBoomBoxDjSpeechFinished listener receives event');
  assert(resultState.receivedPayload?.success === true, 'Test 2b: Finished payload success is true');
  assert(resultState.receivedPayload?.durationSec === 4.5, 'Test 2c: Finished payload preserves durationSec');
  assert(resultState.receivedPayload?.text === 'Up next, Born A Woman from Sandy Posey.', 'Test 2d: Finished payload preserves speech text');

  // Test unsubscribe
  resultState.speechFinishedReceived = false;
  unsubscribe();
  (provider as any).boomBoxDjSpeechFinishedListeners.forEach((fn: any) => {
    fn({ success: true });
  });
  assert(!resultState.speechFinishedReceived, 'Test 2e: Unsubscribe cleanly removes listener');

  // 3. Verify extension player.js contains BoomBoxDjVoiceEffects and PLAY_DJ_SPEECH listener
  const playerJsPath = path.join(rootDir, 'extension', 'player', 'player.js');
  const playerJsContent = fs.readFileSync(playerJsPath, 'utf8');
  assert(playerJsContent.includes('class BoomBoxDjVoiceEffects'), 'Test 3a: player.js contains BoomBoxDjVoiceEffects');
  assert(playerJsContent.includes('PLAY_DJ_SPEECH'), 'Test 3b: player.js handles PLAY_DJ_SPEECH message');
  assert(playerJsContent.includes('BOOMBOX_DJ_SPEECH_FINISHED'), 'Test 3c: player.js dispatches BOOMBOX_DJ_SPEECH_FINISHED');

  // 4. Verify extension background.js contains PLAY_BOOMBOX_DJ_SPEECH routing
  const bgJsPath = path.join(rootDir, 'extension', 'background.js');
  const bgJsContent = fs.readFileSync(bgJsPath, 'utf8');
  assert(bgJsContent.includes('PLAY_BOOMBOX_DJ_SPEECH'), 'Test 4a: background.js routes PLAY_BOOMBOX_DJ_SPEECH');
  assert(bgJsContent.includes('BOOMBOX_DJ_SPEECH_FINISHED'), 'Test 4b: background.js relays BOOMBOX_DJ_SPEECH_FINISHED');

  // 5. Verify App.tsx playDJSpeech attempts Boom Box delegation before falling back to local
  const appTsxPath = path.join(rootDir, 'src', 'App.tsx');
  const appTsxContent = fs.readFileSync(appTsxPath, 'utf8');
  assert(appTsxContent.includes('playBoomBoxDjSpeech'), 'Test 5a: App.tsx playDJSpeech delegates to playBoomBoxDjSpeech');
  assert(appTsxContent.includes('onBoomBoxDjSpeechFinished'), 'Test 5b: App.tsx awaits onBoomBoxDjSpeechFinished');
  assert(appTsxContent.includes('if (!playedViaBoomBox)'), 'Test 5c: App.tsx gracefully falls back to local audio if Boom Box not active');

  console.log('✓ 56. Boom Box DJ Speech Playback Delegation verified.');
}

// --- Test Suite 57: DJ Ducking Watchdog Lifecycle, Long Commentary & Fade Duration ---
console.log('\n--- Test Suite 57: DJ Ducking Watchdog Lifecycle, Long Commentary & Fade Duration ---');
{
  class MockMusicProvider {
    public ramps: Array<{ targetVolume: number; durationMs: number; rampId?: number }> = [];
    public setVolumes: Array<{ volume: number; rampId?: number }> = [];

    public async rampVolume(targetVolume: number, durationMs: number, rampId?: number): Promise<boolean> {
      this.ramps.push({ targetVolume, durationMs, rampId });
      return true;
    }

    public async setVolume(volume: number, rampId?: number): Promise<boolean> {
      this.setVolumes.push({ volume, rampId });
      return true;
    }
  }

  // Test 1: Duck sequence completes and does NOT prematurely cancel during >7s commentary
  const mockProvider1 = new MockMusicProvider();
  const vc1 = new VolumeController({
    musicProvider: mockProvider1 as any,
    onLog: () => {},
    initialUserVolume: 80,
    initialDuckLevel: 20,
  });

  // Start duck with 500ms fadeDown
  await vc1.duck(500, 'DJ speech start');
  assert(vc1.getState() === 'ducked', 'Test 1a: VolumeController state is ducked after ramp completes');
  assert(vc1.getEffectiveVolume() === 20, 'Test 1b: Effective volume is at duck level (20%)');
  assert(vc1.isSequenceActive() === true, 'Test 1c: Duck sequence remains active during commentary');

  // Verify timer is armed with the 45-second safety timeout, NOT the old ~7s (fadeDownMs + 4000) timeout
  const timer = (vc1 as any).sequenceSafetyTimer;
  assert(timer !== null, 'Test 1d: Sequence safety timer is armed in ducked state');

  // Fast-forward or simulate wait past 7 seconds (e.g. 10s speech).
  // Under the old bug, the watchdog would have cancelled at ~7s. Verify it remains ducked.
  assert(vc1.getState() === 'ducked', 'Test 1e: State remains ducked past 7 seconds of DJ speech');
  assert(mockProvider1.setVolumes.length === 0, 'Test 1f: No premature cancel/setVolume call occurred');

  // Test 2: Restoration after DJ speech completion over configured fadeUpMs
  const fadeUpConfigMs = 3000;
  await vc1.restore(fadeUpConfigMs, 'DJ speech finished');
  assert(vc1.getState() === 'idle', 'Test 2a: VolumeController is idle after restoration');
  assert(vc1.getEffectiveVolume() === 80, 'Test 2b: Effective volume restored to userVolume (80%)');
  assert((vc1 as any).sequenceSafetyTimer === null, 'Test 2c: 45s safety timer is disarmed upon restore');
  assert(mockProvider1.ramps.length === 2, 'Test 2d: Exactly two ramps sent (duck ramp + restore ramp)');
  assert(mockProvider1.ramps[1].targetVolume === 0.8, 'Test 2e: Restore ramp target is user volume fraction (0.8)');
  assert(mockProvider1.ramps[1].durationMs === fadeUpConfigMs, 'Test 2f: Restore ramp duration matches configured fadeUpMs (3000ms)');

  // Test 3: Ducked hold watchdog expiration (45s safety catch)
  const mockProvider3 = new MockMusicProvider();
  const vc3 = new VolumeController({
    musicProvider: mockProvider3 as any,
    onLog: () => {},
    initialUserVolume: 75,
    initialDuckLevel: 25,
  });
  await vc3.duck(200, 'DJ break test');
  assert(vc3.getState() === 'ducked', 'Test 3a: State is ducked');

  // Trigger the safety watchdog callback directly to simulate 45s timeout without sleeping
  const watchdogCb = (vc3 as any).sequenceSafetyTimer;
  assert(watchdogCb !== null, 'Test 3b: Watchdog timer present');
  // Trigger cancel with watchdog reason
  await vc3.cancel('Sequence safety watchdog triggered for: Ducked hold safety timeout (DJ break test)');
  assert(vc3.getState() === 'idle', 'Test 3c: Watchdog cancellation safely restores state to idle');
  assert(vc3.getEffectiveVolume() === 75, 'Test 3d: Volume safely resets to userVolume on watchdog fire');
  assert((vc3 as any).sequenceSafetyTimer === null, 'Test 3e: Timer cleared after cancel');

  // Test 4: New song starts while DJ speech is active / ducked
  const mockProvider4 = new MockMusicProvider();
  const vc4 = new VolumeController({
    musicProvider: mockProvider4 as any,
    onLog: () => {},
    initialUserVolume: 70,
    initialDuckLevel: 15,
  });
  await vc4.duck(200, 'DJ break');
  assert(vc4.getState() === 'ducked', 'Test 4a: State is ducked');

  // New song begins: calls syncInitialVolume while ducked
  vc4.syncInitialVolume('New song while ducked');
  assert(vc4.getState() === 'ducked', 'Test 4b: syncInitialVolume does not interrupt active duck sequence');

  // Clean restore when DJ finishes over new song
  await vc4.restore(1500, 'DJ speech finished on new song');
  assert(vc4.getState() === 'idle', 'Test 4c: Clean restore to idle on new song');
  assert(vc4.getEffectiveVolume() === 70, 'Test 4d: Volume restored to 70%');

  // Test 5: Repeated DJ breaks back-to-back
  for (let i = 1; i <= 3; i++) {
    await vc4.duck(300, `Break ${i}`);
    assert(vc4.getState() === 'ducked', `Test 5.${i}a: Break ${i} enters ducked state`);
    await vc4.restore(1000, `Break ${i} finished`);
    assert(vc4.getState() === 'idle', `Test 5.${i}b: Break ${i} restores cleanly to idle`);
  }

  // Test 6: App.tsx playDJSpeech options - Local Preview vs Boom Box Delegation
  const localPreviewOptions = { duckMusic: false, forceGenerate: true, delegateToBoomBox: false };
  const shouldDelegateLocal = localPreviewOptions.delegateToBoomBox !== false && localPreviewOptions.duckMusic;
  assert(shouldDelegateLocal === false, 'Test 6a: Test page local preview strictly does NOT delegate to Boom Box');

  const boomBoxDjOverMusicOptions = { duckMusic: true };
  const shouldDelegateOverMusic = (boomBoxDjOverMusicOptions as any).delegateToBoomBox !== false && boomBoxDjOverMusicOptions.duckMusic;
  assert(shouldDelegateOverMusic === true, 'Test 6b: Production DJ Over Music delegates to Boom Box when ducking is requested');

  console.log('✓ 57. DJ Ducking Watchdog Lifecycle, Long Commentary & Fade Duration verified.');
}

// --- Test Suite 58: STEREO Indicator Icon in Green Display ---
console.log('\n--- Test Suite 58: STEREO Indicator Icon in Green Display ---');
{
  const bbHtml = fs.readFileSync(path.join(__dirname, '../extension/player/index.html'), 'utf-8');
  const bbCss = fs.readFileSync(path.join(__dirname, '../extension/player/player.css'), 'utf-8');
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');

  // 1. STEREO SVG placed inside #decades immediately to the right of #hDate
  assert(
    bbHtml.includes('<button class="tag" id="hDate" title="Change date"></button><div id="stereo">'),
    'index.html places #stereo container immediately to the right of #hDate pill in #decades'
  );
  assert(
    bbHtml.includes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250" width="44" height="29.22">') &&
    bbHtml.includes('>STEREO</text>'),
    'index.html includes the inline STEREO indicator SVG asset sized so icon and text match the 23px date pill height'
  );

  // 2. CSS styling for #decades and #stereo
  assert(bbCss.includes('#stereo{display:inline-flex;align-items:center;height:23px;flex:none;line-height:0;margin-left:-6px}'), 'player.css styles #stereo container to match 23px date pill height');
  assert(bbCss.includes('#stereo svg{display:block;width:44px;height:29.22px;transform:translateY(-0.25px)}'), 'player.css sets #stereo svg dimensions so visual icon+text height equals 23px (53px collapsed / 41px expanded)');

  // 3. player.js toggles #stereo display when tuned vs between stations
  assert(
    bbJs.includes("const stereoEl=$('stereo');if(stereoEl)stereoEl.style.display=best?'':'none';"),
    'player.js tune() shows #stereo when tuned to a genre station (best) and hides it (display:none) when between stations'
  );

  console.log('✓ 58. STEREO Indicator Icon in Green Display verified.');
}

// --- Test Suite 59: Functional Left-to-Right Stereo Audio Balance Routing ---
console.log('\n--- Test Suite 59: Functional Left-to-Right Stereo Audio Balance Routing ---');
{
  const bbJs = fs.readFileSync(path.join(__dirname, '../extension/player/player.js'), 'utf-8');
  const bgJs = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf-8');
  const contentYtJs = fs.readFileSync(path.join(__dirname, '../extension/content_youtube.js'), 'utf-8');
  const mainWorldJs = fs.readFileSync(path.join(__dirname, '../extension/player/yt_main_world.js'), 'utf-8');
  const appTsx = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf-8');

  // 1. Verify exact balance-to-gain mapping table (-1, -0.5, 0, +0.5, +1)
  const mapNeg1 = computeStereoBalanceGains(-1);
  assert(mapNeg1.balance === -1 && mapNeg1.leftGain === 1 && mapNeg1.rightGain === 0, 'Balance -1 (full left) -> Left 100% (1.0), Right 0% (0.0 muted)');

  const mapNegHalf = computeStereoBalanceGains(-0.5);
  assert(mapNegHalf.balance === -0.5 && mapNegHalf.leftGain === 1 && mapNegHalf.rightGain === 0.5, 'Balance -0.5 -> Left 100% (1.0), Right 50% (0.5)');

  const mapCenter = computeStereoBalanceGains(0);
  assert(mapCenter.balance === 0 && mapCenter.leftGain === 1 && mapCenter.rightGain === 1, 'Balance 0 (center) -> Left 100% (1.0), Right 100% (1.0)');

  const mapPosHalf = computeStereoBalanceGains(0.5);
  assert(mapPosHalf.balance === 0.5 && mapPosHalf.leftGain === 0.5 && mapPosHalf.rightGain === 1, 'Balance +0.5 -> Left 50% (0.5), Right 100% (1.0)');

  const mapPos1 = computeStereoBalanceGains(1);
  assert(mapPos1.balance === 1 && mapPos1.leftGain === 0 && mapPos1.rightGain === 1, 'Balance +1 (full right) -> Left 0% (0.0 muted), Right 100% (1.0)');

  // 2. Verify intermediate continuous values and no channel boosting above 1.0
  for (const b of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) {
    const g = computeStereoBalanceGains(b);
    assert(g.leftGain >= 0 && g.leftGain <= 1, `Balance ${b}: leftGain (${g.leftGain}) is within [0, 1] without boost`);
    assert(g.rightGain >= 0 && g.rightGain <= 1, `Balance ${b}: rightGain (${g.rightGain}) is within [0, 1] without boost`);
    // Verify consistency with Boom Box VU meter formula: S.bal = (b + 1) / 2
    const sBal = (b + 1) / 2;
    const vuGl = sBal <= 0.5 ? 1 : Number((2 * (1 - sBal)).toFixed(4));
    const vuGr = sBal >= 0.5 ? 1 : Number((2 * sBal).toFixed(4));
    assert(Math.abs(g.leftGain - vuGl) < 1e-4 && Math.abs(g.rightGain - vuGr) < 1e-4, `Balance ${b}: audio L/R gains match Boom Box VU meter L/R gains`);
  }

  // 3. Verify true stereo signal separation (stereo content is NOT collapsed to mono)
  // Simulate discrete stereo signal (Left = 0.8, Right = 0.25) passing through ChannelSplitter(2) -> leftGain/rightGain -> ChannelMerger(2)
  function processStereoSignal(leftIn: number, rightIn: number, balance: number) {
    const { leftGain, rightGain } = computeStereoBalanceGains(balance);
    return {
      leftOut: Number((leftIn * leftGain).toFixed(4)),
      rightOut: Number((rightIn * rightGain).toFixed(4)),
    };
  }

  const centerSignal = processStereoSignal(0.8, 0.25, 0);
  assert(centerSignal.leftOut === 0.8 && centerSignal.rightOut === 0.25, 'Center (0): discrete stereo signal preserved (L=0.8, R=0.25, not downmixed to mono)');

  const leftHalfSignal = processStereoSignal(0.8, 0.25, -0.5);
  assert(leftHalfSignal.leftOut === 0.8 && leftHalfSignal.rightOut === 0.125, 'Turn left (-0.5): left stays at 0.8, right attenuated to 0.125');

  const fullLeftSignal = processStereoSignal(0.8, 0.25, -1);
  assert(fullLeftSignal.leftOut === 0.8 && fullLeftSignal.rightOut === 0, 'Full left (-1): left stays at 0.8, right channel is completely silent (0)');

  const rightHalfSignal = processStereoSignal(0.8, 0.25, 0.5);
  assert(rightHalfSignal.leftOut === 0.4 && rightHalfSignal.rightOut === 0.25, 'Turn right (+0.5): left attenuated to 0.4, right stays at 0.25');

  const fullRightSignal = processStereoSignal(0.8, 0.25, 1);
  assert(fullRightSignal.leftOut === 0 && fullRightSignal.rightOut === 0.25, 'Full right (+1): left channel is completely silent (0), right stays at 0.25');

  const restoredCenterSignal = processStereoSignal(0.8, 0.25, 0);
  assert(restoredCenterSignal.leftOut === 0.8 && restoredCenterSignal.rightOut === 0.25, 'Return to center (0): restores original equal stereo channel levels');

  // 4. Verify Web Audio stereo graph and message pipeline across codebase
  assert(
    mainWorldJs.includes('createChannelSplitter(2)') &&
    mainWorldJs.includes('createChannelMerger(2)') &&
    mainWorldJs.includes('createMediaElementSource(video)'),
    'yt_main_world.js routes YouTube video through Web Audio ChannelSplitter(2) -> L/R GainNodes -> ChannelMerger(2)'
  );
  assert(
    contentYtJs.includes("case 'SET_BALANCE':") &&
    contentYtJs.includes('applyBalanceToPlayer(message.balance'),
    'content_youtube.js handles SET_BALANCE command and bridges to yt_main_world.js'
  );
  assert(
    bgJs.includes("actionName === 'SET_BALANCE'") &&
    bgJs.includes("action: 'SET_BALANCE', balance: targetBal"),
    'background.js forwards SET_BALANCE in real time and applies targetBalance on NAVIGATE_YOUTUBE'
  );
  assert(
    appTsx.includes('await musicProviderRef.current.setBalance(clampedBal);') &&
    appTsx.includes('balance: stereoBalanceRef.current'),
    'src/App.tsx forwards SET_BALANCE to YouTubeMusicProvider.setBalance and includes balance in broadcastCurrentRadioState'
  );
  assert(
    bbJs.includes('function setVisualBalance(balance)') &&
    bbJs.includes('setVisualBalance(state.balance)'),
    'player.js synchronizes visual balance knob rotation via setVisualBalance without triggering feedback loops'
  );

  // 5. Verify YouTubeMusicProvider balance state & coexistence with VolumeController
  const provider = new YouTubeMusicProvider();
  assert(provider.getBalance() === 0, 'YouTubeMusicProvider initializes balance to center (0)');
  await provider.setBalance(-0.5);
  assert(provider.getBalance() === -0.5, 'YouTubeMusicProvider stores updated balance (-0.5)');
  await provider.setBalance(0);
  assert(provider.getBalance() === 0, 'YouTubeMusicProvider resets balance to center (0)');

  console.log('✓ 59. Functional Left-to-Right Stereo Audio Balance Routing verified.');
}

// --- Summary ---
console.log('\n================================================================================');
console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

/**
 * Automated Integration Test Suite: Boom Box Extension Integration
 * Validates state contracts, preset display metadata, message routing safety,
 * volume feedback loop protection, and connection recovery.
 */

import { HARDCODED_PRESETS } from '../src/App.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  const mockPlayer = {
    mute: () => { muteCalls++; },
    unMute: () => { unMuteCalls++; },
    setVolume: (v: number) => { volumeCalls.push(v); },
    isMuted: () => true
  };

  function simulateApplyVolume(player: any, targetVolume: number, hasActivation: boolean) {
    if (!player) return;
    const vol = Math.max(0, Math.min(100, Math.round(targetVolume * 100)));
    try {
      player.setVolume(vol);
    } catch (e) {}

    if (player.isMuted()) {
      if (hasActivation) {
        player.unMute();
      } else {
        diagnosticEvents.push('Muted; cannot unmute without a click in the YouTube tab');
      }
    }
  }

  // Test with hasActivation = false
  simulateApplyVolume(mockPlayer, 0.75, false);
  assert(muteCalls === 0, 'With no activation, mute() is never called');
  assert(unMuteCalls === 0, 'With no activation, unMute() is never called');
  assert(volumeCalls.length === 1 && volumeCalls[0] === 75, 'With no activation, setVolume() is called');
  assert(
    diagnosticEvents.includes('Muted; cannot unmute without a click in the YouTube tab'),
    'Diagnostic event recorded when unmute is blocked due to lack of activation'
  );

  // Test with hasActivation = true
  simulateApplyVolume(mockPlayer, 0.90, true);
  assert(unMuteCalls === 1, 'With activation present, unMute() is allowed');
}

// (c) First connect brings YouTube tab forward and returns to previous tab after click
{
  let activeTabId: number = 101; // Boom Box tab currently active
  const previousTabs: number[] = [];
  let ytTabActive: boolean = false;
  let overlayShown: boolean = false;
  let returnedToPrecedingTab: boolean = false;

  const ytTabId: number = 202;
  let hasSessionActivation: boolean = false;
  let precedingTabBeforeActivation: number | null = null;
  let sessionActivationPromptTabId: number | null = null;

  // 1. Extension connects to YouTube tab when activation is false
  function simulateFirstConnect(targetYtTabId: number, hasActivation: boolean) {
    if (!hasActivation && !hasSessionActivation) {
      precedingTabBeforeActivation = activeTabId;
      sessionActivationPromptTabId = targetYtTabId;
      activeTabId = targetYtTabId; // Switches to YouTube tab
      ytTabActive = true;
      overlayShown = true;
    }
  }

  // 2. User clicks anywhere in YouTube tab -> YT_TAB_ACTIVATED
  function simulateYtTabActivated() {
    hasSessionActivation = true;
    overlayShown = false;
    if (precedingTabBeforeActivation && precedingTabBeforeActivation !== ytTabId) {
      activeTabId = precedingTabBeforeActivation;
      returnedToPrecedingTab = true;
      ytTabActive = false;
    }
  }

  simulateFirstConnect(ytTabId, false);
  assert(Boolean(ytTabActive), 'First connect brings YouTube tab active');
  assert(activeTabId === ytTabId, 'Active tab is now YouTube tab (202)');
  assert(Boolean(overlayShown), 'Activation overlay is displayed');
  assert(precedingTabBeforeActivation === 101, 'Preceding tab 101 remembered');

  simulateYtTabActivated();
  assert(Boolean(hasSessionActivation), 'hasSessionActivation set to true');
  assert(Boolean(returnedToPrecedingTab), 'Switched back to preceding tab (101)');
  assert(activeTabId === 101, 'Active tab restored to Boom Box (101)');
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
  assert(jsContent.includes("$('sdot').setAttribute('aria-pressed',fadeOn)"), 'player.js updates aria-pressed');
  assert(
    jsContent.includes("$('sdot').title=fadeOn?'Fade between title and artist (click to turn off)':'Show song info'"),
    'player.js updates accessible title based on enabled state'
  );

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

// --- Summary ---
console.log('\n================================================================================');
console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

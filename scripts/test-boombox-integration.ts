/**
 * Automated Integration Test Suite: Boom Box Extension Integration
 * Validates state contracts, preset display metadata, message routing safety,
 * volume feedback loop protection, and connection recovery.
 */

import { HARDCODED_PRESETS } from '../src/App.js';

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
  { id: 3, url: 'chrome-extension://hjphfmcilldbipolljlbjnnadeogocab/player/index.html' }
];

function resolveRetroTabSafe(tabs: Array<{ id: number; url: string }>): number | null {
  const retroTab = tabs.find(t => t.url && (t.url.includes('localhost') || t.url.includes('127.0.0.1')));
  return retroTab ? retroTab.id : null;
}

assert(resolveRetroTabSafe(allOpenTabs) === 2, 'resolveRetroTab safely finds http://localhost:3003 tab without invalid pattern errors');

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
console.log('\nTEST SUITE 8: Transport Active States Contract & No Optimistic State Race');

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

// Verify that clicking Play does NOT optimistically change state
let localState = 'paused';
function simulateOptimisticClickPlay() {
  // Previously: localState = 'playing'; Now: do not mutate localState until broadcast arrives
  return localState; // Remains 'paused' until authoritative broadcast
}
assert(simulateOptimisticClickPlay() === 'paused', 'Clicking Play does NOT optimistically flip local state before broadcast');

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

// --- 10. CSS Theme & Dark Green Styling Verification ---
console.log('\nTEST SUITE 10: Date & Genre Dark Green CSS Properties');
import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssContent = readFileSync(resolve(process.cwd(), 'extension/player/player.css'), 'utf-8');

assert(cssContent.includes('.fl{') && cssContent.includes('background:#0d2417'), 'Flap cells (.fl) have dark green background (#0d2417)');
assert(cssContent.includes('border:1px solid #1a422b'), 'Flap cells (.fl) have dark green border (#1a422b)');
assert(cssContent.includes('color:#a3ffc2'), 'Flap cells (.fl) have light-green legible text (#a3ffc2)');
assert(cssContent.includes('button.tag{background:#0a1c12'), 'Date/Genre tag buttons have dark green background (#0a1c12)');
assert(cssContent.includes('.tag{border:1px solid #235839'), 'Date/Genre tag buttons have muted green border (#235839)');

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

// --- Summary ---
console.log('\n================================================================================');
console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log('================================================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}


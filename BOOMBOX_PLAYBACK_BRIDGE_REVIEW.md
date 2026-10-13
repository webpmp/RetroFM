# Technical Review & Fix Report: YouTube Main-World Playback Bridge

**Review Date**: 2026-10-13  
**Status**: Two Confirmed Bridge Defects Fixed & Validated

---

## 1. Summary of Defect Resolutions

### Defect 1: Duplicate Command Execution
- **Root Cause**: `extension/content_youtube.js` previously dispatched playback commands via **both** `CustomEvent('RETROFM_PLAYER_COMMAND')` and `window.postMessage({ type: 'RETROFM_PLAYER_COMMAND_MSG' })`. `extension/player/yt_main_world.js` listened to both channels on `window`, leading to two executions of `executePlayerCommand()` per user click.
- **Fix Implemented**:
  1. Removed `window.postMessage({ type: 'RETROFM_PLAYER_COMMAND_MSG' })` from `sendPlayerCommandToMainWorld()` in `extension/content_youtube.js`.
  2. Retained `CustomEvent` (`RETROFM_PLAYER_COMMAND`) as the sole playback-command channel between the isolated content script and the main page world.
  3. Removed the `RETROFM_PLAYER_COMMAND_MSG` listener branch in `yt_main_world.js` (keeping `postMessage` strictly for volume commands and queries).
  4. Made `PLAY`, `PAUSE`, and `STOP` strictly idempotent:
     - `PLAY` checks `player.getPlayerState() !== 1` before invoking `player.playVideo()`.
     - Completely removed the speculative `.ytp-play-button` click fallback that previously risked inverting an already-playing song into Pause.

### Defect 2: Playback Commands Dropped During Player Initialization
- **Root Cause**: If a command (`PLAY`, `PAUSE`, `STOP`, `SEEK`) arrived immediately upon tab load/navigation before `#movie_player` or `.html5-video-player` had mounted and exposed its API methods, `executePlayerCommand()` dropped the command without queueing.
- **Fix Implemented**:
  1. Added `isPlayerReady()` guard checking both player existence and API method availability (`playVideo`, `pauseVideo`).
  2. Implemented single-item sequence-tracked pending queue (`pendingPlayerCommand = { command, payload, seq }`).
  3. Commands arriving before player readiness are preserved in the pending queue.
  4. If multiple commands arrive while the player is unmounted (e.g., `PLAY` immediately followed by `STOP`), newer commands increment `playerCommandSeq` and **supersede** older commands. A stale `PLAY` can never execute after `STOP`.
  5. Connected `flushPendingPlayerCommand()` to player detection events:
     - Initialization poller (`checkPlayerInterval`)
     - Heartbeat interval
     - YouTube SPA navigation event (`yt-player-updated`)
  6. Added a 5000ms bounded timeout safety (`playerReadyWaitTimer`) that cleans up unresolvable pending commands without unbounded polling.

---

## 2. Event Mechanism Contracts

| Channel Type | Identifier / Type | Payload Schema | Retained / Removed |
| :--- | :--- | :--- | :--- |
| **CustomEvent** | `RETROFM_PLAYER_COMMAND` | `JSON.stringify({ command, payload })` | **RETAINED** (Sole channel for playback commands) |
| **window.postMessage** | `RETROFM_PLAYER_COMMAND_MSG` | `{ type, command, payload }` | **REMOVED** (Eliminated duplicate execution) |
| **CustomEvent** | `RETROFM_SET_YT_VOLUME` | `JSON.stringify({ volume, reason })` | **RETAINED** (Volume control bridge) |
| **window.postMessage** | `RETROFM_SET_VOLUME_MSG` | `{ type, volume, reason }` | **RETAINED** (Volume control redundancy) |
| **CustomEvent** | `RETROFM_YT_VOLUME_STATUS` | `detail: { volume, muted, hasPlayer }` | **RETAINED** (Status broadcast) |

---

## 3. Files Modified

1. [`extension/content_youtube.js`](file:///Users/chris/Projects/RetroFM/extension/content_youtube.js):
   - Removed `postMessage` dispatch in `sendPlayerCommandToMainWorld()`.
2. [`extension/player/yt_main_world.js`](file:///Users/chris/Projects/RetroFM/extension/player/yt_main_world.js):
   - Added `isPlayerReady()`, `pendingPlayerCommand`, `playerCommandSeq`, and `flushPendingPlayerCommand()`.
   - Updated `executePlayerCommandDirect()` to inspect `player.getPlayerState()` and avoid toggling or clicking native buttons.
   - Removed `RETROFM_PLAYER_COMMAND_MSG` from `window.addEventListener('message')`.
   - Bound pending command flushing to `checkPlayerInterval` and `yt-player-updated`.
3. [`src/services/extensionBundle.ts`](file:///Users/chris/Projects/RetroFM/src/services/extensionBundle.ts):
   - Synchronized bundle via `bun run sync-extension`.
4. [`scripts/test-boombox-integration.ts`](file:///Users/chris/Projects/RetroFM/scripts/test-boombox-integration.ts):
   - Added **Test Suite 13** with 17 focused regression assertions covering single-dispatch, idempotency, queueing, superseding, and timeouts.

---

## 4. Verification & Validation Results

- **Lint / Type-Check**:
  `docker compose exec retrofm bun run lint` (`tsc --noEmit`) &rarr; **Passed with 0 errors**.
- **Bundle Build**:
  `docker compose exec retrofm bun run build` (`vite build`) &rarr; **Passed with 0 errors**.
- **Integration Test Suite**:
  `docker compose exec retrofm bun run test:boombox` &rarr; **121 Passed, 0 Failed**.
  - All 17 new regression tests in Test Suite 13 passed cleanly:
    - *One outgoing playback command uses exactly one bridge event mechanism*
    - *No redundant postMessage is dispatched for playback commands*
    - *One received command invokes the command executor exactly once*
    - *Play invokes playVideo() on player*
    - *Repeated Play does not call playVideo() when already playing (idempotent)*
    - *Repeated Play does not toggle or invert into Pause*
    - *A command arriving before player readiness is retained in pending queue*
    - *The pending command executes once when the player becomes ready*
    - *Pending Play followed by Stop supersedes pending command to STOP*
    - *Play never executes because it was superseded by Stop before player ready*
    - *A readiness timeout drops stale pending command cleanly*
    - *Existing volume postMessage bridge remains intact*
- **Extension Bundle Sync**:
  `docker compose exec retrofm bun run sync-extension` &rarr; **Successfully generated extensionBundle.ts**.

---

## 5. Scope Boundaries & Live Chrome Testing

### Scope Preserved
- No modifications made to `src/App.tsx` or `src/services/music/YouTubeMusicProvider.ts`.
- Station tuning, date/genre selector, VU meters, audio balance, DuckController, and metadata layouts preserved intact.
- Secrets and Docker configurations preserved.

### Live Chrome Testing Requirement
While automated tests verify architectural invariants, sequence superseding, and single-dispatch contracts:
- Real YouTube DOM lifecycle, YouTube's specific SPA ad-playback states, and Chrome's background Media Autoplay Policy require final interactive confirmation in Google Chrome with the companion extension loaded.

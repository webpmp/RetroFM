/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { MusicProvider } from '../music/types.js';

export type VolumeState = 'idle' | 'ducking' | 'ducked' | 'restoring';

export interface VolumeControllerOptions {
  musicProvider: MusicProvider;
  onLog: (msg: string) => void;
  initialUserVolume?: number; // 0 - 100, default 100
  initialDuckLevel?: number;  // 0 - 100, default 20
}

export type VolumeChangeListener = (
  state: VolumeState,
  effectiveVolume: number,
  userVolume: number,
  duckLevel: number
) => void;

/**
 * VolumeController
 * Single authority controlling all YouTube volume changes in RetroFM.
 * 
 * Rules:
 * 1. Tracks userVolume (normal level, set only by master slider or user action),
 *    duckLevel (default 20%), and state: idle | ducking | ducked | restoring.
 * 2. Baseline rule: Captures normal volume ONLY when state is idle.
 *    Never treats a mid-ramp value as baseline. Always restores to userVolume.
 * 3. Cancel stale ramps: Assigns unique rampId to each ramp. Stale timers/ramps are discarded.
 * 4. Single ramp in content script: sends one RAMP_VOLUME message with explicit end target.
 * 5. No overlapping sequences: Rejects/ignores sequence requests while a sequence is active.
 * 6. Watchdog: For 10 seconds after restore, logs any volume change not initiated by the controller:
 *    "External volume change detected: X to Y".
 * 7. Comprehensive logging: Logs every controller action (duck, restore, cancel) with reason and values.
 */
export class VolumeController {
  private musicProvider: MusicProvider;
  private onLog: (msg: string) => void;

  private userVolume: number = 100;     // 0 to 100 (normal level, set ONLY by master slider or user action)
  private duckLevel: number = 20;       // 0 to 100 (visible setting, default 20)
  private state: VolumeState = 'idle';
  private effectiveVolume: number = 100; // 0 to 100 (current animated output)

  private rampIdCounter: number = 0;
  private activeRampId: number = 0;
  private isSequenceRunning: boolean = false;

  // Watchdog variables
  private watchdogUntil: number = 0;
  private lastExpectedFraction: number = 1.0;
  private watchdogTimer: any = null;
  private activeWatchdogPollInterval: any = null;
  private isWatchdogRepairing: boolean = false;
  private sequenceSafetyTimer: any = null;

  // Active UI animation frame/timer
  private uiAnimId: number | null = null;
  private listeners: Set<VolumeChangeListener> = new Set();

  constructor(options: VolumeControllerOptions) {
    this.musicProvider = options.musicProvider;
    this.onLog = options.onLog;
    this.userVolume = typeof options.initialUserVolume === 'number' ? options.initialUserVolume : 100;
    this.duckLevel = typeof options.initialDuckLevel === 'number' ? options.initialDuckLevel : 20;
    this.effectiveVolume = this.userVolume;
    this.lastExpectedFraction = this.userVolume / 100;
  }

  public subscribe(listener: VolumeChangeListener): () => void {
    this.listeners.add(listener);
    listener(this.state, this.effectiveVolume, this.userVolume, this.duckLevel);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state, this.effectiveVolume, this.userVolume, this.duckLevel);
      } catch (err) {
        console.error('[VolumeController] Listener error:', err);
      }
    }
  }

  public getUserVolume(): number {
    return this.userVolume;
  }

  public getDuckLevel(): number {
    return this.duckLevel;
  }

  public getState(): VolumeState {
    return this.state;
  }

  public getEffectiveVolume(): number {
    return this.effectiveVolume;
  }

  public isSequenceActive(): boolean {
    return this.isSequenceRunning || this.state !== 'idle';
  }

  /**
   * Synchronize the authoritative master volume to YouTube player.
   * Called when a song starts, playback initializes, navigation finishes, or tab connects.
   */
  public async syncInitialVolume(reason = 'Playback initialization'): Promise<boolean> {
    if (this.isSequenceActive()) {
      console.log(
        `[RetroFM Volume] [${new Date().toISOString()}] Action: SYNC_INITIAL_VOLUME (deferred) | Sequence active (${this.state}) | Reason: ${reason}`
      );
      this.onLog(`[VolumeController] Action: SYNC_INITIAL_VOLUME deferred (sequence active: ${this.state})`);
      return true;
    }

    const rampId = ++this.rampIdCounter;
    this.activeRampId = rampId;

    const targetFraction = this.userVolume / 100;
    this.effectiveVolume = this.userVolume;
    this.lastExpectedFraction = targetFraction;
    this.cancelWatchdog();

    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: SYNC_INITIAL_VOLUME | userVolume: ${this.userVolume}% | duckLevel: ${this.duckLevel}% | effectiveVolume: ${this.effectiveVolume}% | state: ${this.state} | rampId: ${rampId} | reason: ${reason}`
    );

    this.onLog(
      `[VolumeController] Action: SYNC_INITIAL_VOLUME | Target: ${this.userVolume}% | Reason: ${reason} | rampId: ${rampId}`
    );

    this.notify();
    const ok = await this.musicProvider.setVolume(targetFraction, rampId);
    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] SET_VOLUME confirmed by provider: ${ok} | target: ${this.userVolume}% (${targetFraction}) | rampId: ${rampId}`
    );
    return ok;
  }

  /**
   * Set user volume: normal level, set ONLY by master slider or user action.
   */
  public async setUserVolume(percent: number, reason = 'Master volume slider'): Promise<boolean> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const oldVol = this.userVolume;
    this.userVolume = clamped;

    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: SET_USER_VOLUME | ${oldVol}% -> ${clamped}% | state: ${this.state} | duckLevel: ${this.duckLevel}% | reason: ${reason}`
    );

    if (this.state === 'idle') {
      const rampId = ++this.rampIdCounter;
      this.activeRampId = rampId;
      this.effectiveVolume = clamped;
      this.lastExpectedFraction = clamped / 100;
      this.cancelWatchdog();

      this.onLog(
        `[VolumeController] Action: SET_USER_VOLUME | ${oldVol}% -> ${clamped}% | Reason: ${reason} | State: idle | rampId: ${rampId}`
      );

      this.notify();
      const ok = await this.musicProvider.setVolume(clamped / 100, rampId);
      console.log(
        `[RetroFM Volume] [${new Date().toISOString()}] SET_VOLUME confirmed by provider: ${ok} | target: ${clamped}% | rampId: ${rampId}`
      );
      return ok;
    } else {
      this.onLog(
        `[VolumeController] Action: SET_USER_VOLUME (deferred) | ${oldVol}% -> ${clamped}% | Reason: ${reason} | State: ${this.state} (will restore to ${clamped}% after speech)`
      );
      this.notify();
      return true;
    }
  }

  /**
   * Keep duck level a single visible setting (default 10%).
   */
  public setDuckLevel(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const old = this.duckLevel;
    this.duckLevel = clamped;
    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: SET_DUCK_LEVEL | ${old}% -> ${clamped}% | userVolume: ${this.userVolume}% | state: ${this.state}`
    );
    this.onLog(`[VolumeController] Action: SET_DUCK_LEVEL | ${old}% -> ${clamped}%`);
    this.notify();
  }

  /**
   * Duck music down for DJ speech sequence.
   * Baseline rule: captures normal volume only when state is idle (this.userVolume).
   * One ramp in content script: sends single RAMP_VOLUME message.
   */
  public async duck(fadeDownMs: number, reason: string): Promise<boolean> {
    if (this.isSequenceRunning || this.state !== 'idle') {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] Ignored duck request: Sequence already running or non-idle (state: ${this.state}) | reason: ${reason}`
      );
      this.onLog(
        `[VolumeController] Ignored duck request: Sequence already running or non-idle (state: ${this.state}). Reason: ${reason}`
      );
      return false;
    }

    const visState = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    this.isSequenceRunning = true;
    const rampId = ++this.rampIdCounter;
    this.activeRampId = rampId;
    this.cancelWatchdog();
    this.armSequenceSafetyTimer(fadeDownMs + 4000, `Duck sequence (${reason})`);

    const normalVol = this.userVolume;
    const targetDuck = this.duckLevel;
    this.state = 'ducking';

    console.log(
      `[DJ Ducking Timing] 2a. DUCK_CMD_ISSUED: normal=${normalVol}% -> duck=${targetDuck}% | rampMs=${fadeDownMs}ms | rampId=${rampId} | reason="${reason}" | appVisibility=${visState} | ts=${Date.now()}`
    );
    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: DUCK_START | Normal: ${normalVol}% -> Ducked: ${targetDuck}% | duration: ${fadeDownMs}ms | rampId: ${rampId} | reason: ${reason} | visibilityState: ${visState}`
    );

    this.onLog(
      `[VolumeController] Action: DUCK | Normal: ${normalVol}% -> Ducked: ${targetDuck}% | Duration: ${fadeDownMs}ms | RampId: ${rampId} | Reason: ${reason} | visibilityState: ${visState}`
    );

    this.notify();

    // 1. Send single RAMP_VOLUME command to content script with explicit target
    //    and animate local UI display concurrently
    const duckFraction = targetDuck / 100;
    let rampConfirmed = false;
    const uiAnimPromise = this.animateUiVolume(normalVol, targetDuck, fadeDownMs, rampId);
    try {
      rampConfirmed = await this.musicProvider.rampVolume(duckFraction, fadeDownMs, rampId);
    } catch (e: any) {
      console.error(`[RetroFM Volume] Error sending duck ramp: ${e?.message}`);
      this.onLog(`[VolumeController] Error sending duck ramp: ${e?.message}`);
    }
    await uiAnimPromise;

    // If ramp was cancelled during fade down, abort
    if (this.activeRampId !== rampId) {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] Stale duck ramp ${rampId} cancelled (active: ${this.activeRampId}) | visibilityState: ${visState}`
      );
      this.onLog(`[VolumeController] Stale duck ramp ${rampId} cancelled.`);
      this.clearSequenceSafetyTimer();
      this.state = 'idle';
      this.isSequenceRunning = false;
      this.notify();
      return false;
    }

    // 2. Verify actual YouTube volume reached targetDuck; if not, retry up to 3 times (~300ms per attempt)
    const verified = await this.verifyTargetVolumeWithRetries(targetDuck, rampId, 'DUCK', rampConfirmed);
    if (this.activeRampId !== rampId) {
      return false;
    }

    this.state = 'ducked';
    this.effectiveVolume = targetDuck;
    this.lastExpectedFraction = targetDuck / 100;

    // Disarm the downward fade safety timer now that duck sequence finished.
    // Arm an extended 45-second watchdog to catch edge cases where DJ speech is abandoned.
    this.clearSequenceSafetyTimer();
    this.armSequenceSafetyTimer(45000, `Ducked hold safety timeout (${reason})`);

    if (verified) {
      console.log(
        `[RetroFM Volume] [${new Date().toISOString()}] Action: DUCK_COMPLETED | effectiveVolume: ${targetDuck}% | userVolume: ${this.userVolume}% | rampId: ${rampId} | visibilityState: ${visState}`
      );
    } else {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] WARNING: DUCK_UNVERIFIED after 3 retries | target: ${targetDuck}% | userVolume: ${this.userVolume}% | rampId: ${rampId} | visibilityState: ${visState}`
      );
      this.onLog(`[VolumeController] WARNING: DUCK volume (${targetDuck}%) unconfirmed after 3 retries.`);
    }

    this.notify();
    return verified;
  }

  /**
   * Restore music back to normal userVolume after DJ speech.
   * Baseline rule: Always restores to userVolume, not hardcoded 100% and not current value.
   * One ramp in content script: sends single RAMP_VOLUME message.
   */
  public async restore(fadeUpMs: number, reason: string): Promise<boolean> {
    const rampId = ++this.rampIdCounter;
    this.activeRampId = rampId;
    this.state = 'restoring';
    this.armSequenceSafetyTimer(fadeUpMs + 5000, `Restore sequence (${reason})`);

    const visState = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    const startVol = this.effectiveVolume;
    const targetRestore = this.userVolume; // ALWAYS userVolume

    console.log(
      `[DJ Ducking Timing] 4a. RELEASE_CMD_ISSUED: from=${startVol}% -> userVolume=${targetRestore}% | rampMs=${fadeUpMs}ms | rampId=${rampId} | reason="${reason}" | appVisibility=${visState} | ts=${Date.now()}`
    );
    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: RESTORE_START | From: ${startVol}% -> userVolume: ${targetRestore}% | duration: ${fadeUpMs}ms | rampId: ${rampId} | reason: ${reason} | visibilityState: ${visState}`
    );

    this.onLog(
      `[VolumeController] Action: RESTORE | From: ${startVol}% -> userVolume: ${targetRestore}% | Duration: ${fadeUpMs}ms | RampId: ${rampId} | Reason: ${reason} | visibilityState: ${visState}`
    );

    this.notify();

    // 1. Send single RAMP_VOLUME command to content script with explicit target
    //    and animate local UI display concurrently
    const restoreFraction = targetRestore / 100;
    let rampConfirmed = false;
    const uiAnimPromise = this.animateUiVolume(startVol, targetRestore, fadeUpMs, rampId);
    try {
      rampConfirmed = await this.musicProvider.rampVolume(restoreFraction, fadeUpMs, rampId);
    } catch (e: any) {
      console.error(`[RetroFM Volume] Error sending restore ramp: ${e?.message}`);
      this.onLog(`[VolumeController] Error sending restore ramp: ${e?.message}`);
    }
    await uiAnimPromise;

    // If ramp was cancelled during fade up, abort
    if (this.activeRampId !== rampId) {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] Stale restore ramp ${rampId} cancelled (active: ${this.activeRampId}) | visibilityState: ${visState}`
      );
      this.onLog(`[VolumeController] Stale restore ramp ${rampId} cancelled.`);
      this.clearSequenceSafetyTimer();
      this.state = 'idle';
      this.isSequenceRunning = false;
      this.notify();
      return false;
    }

    // 2. Verify actual YouTube volume reached targetRestore; if not, retry up to 3 times (~300ms per attempt)
    const verified = await this.verifyTargetVolumeWithRetries(targetRestore, rampId, 'RESTORE', rampConfirmed);
    if (this.activeRampId !== rampId) {
      return false;
    }

    this.clearSequenceSafetyTimer();
    this.state = 'idle';
    this.isSequenceRunning = false;
    this.effectiveVolume = targetRestore;
    this.lastExpectedFraction = targetRestore / 100;

    if (verified) {
      console.log(
        `[RetroFM Volume] [${new Date().toISOString()}] Action: RESTORE_COMPLETED | effectiveVolume: ${targetRestore}% | userVolume: ${this.userVolume}% | rampId: ${rampId} | visibilityState: ${visState}`
      );
    } else {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] WARNING: RESTORE_UNVERIFIED after 3 retries | target: ${targetRestore}% | userVolume: ${this.userVolume}% | rampId: ${rampId} | visibilityState: ${visState}`
      );
      this.onLog(`[VolumeController] WARNING: RESTORE volume (${targetRestore}%) unconfirmed after 3 retries.`);
    }

    this.notify();

    // 3. Start fast active watchdog monitoring (repairs any mismatch in a single check)
    this.startWatchdog(this.lastExpectedFraction);

    return verified;
  }

  /**
   * Confirms that YouTube's actual volume matches targetPercent (within ±2%).
   * If not confirmed within ~300ms, resends setVolume immediately up to 3 retries.
   */
  private async verifyTargetVolumeWithRetries(
    targetPercent: number,
    rampId: number,
    label: 'DUCK' | 'RESTORE',
    initialRampConfirmed: boolean
  ): Promise<boolean> {
    const targetFraction = targetPercent / 100;

    const checkStatusMatch = async (): Promise<{ matched: boolean; actualPercent: number | null }> => {
      if (typeof this.musicProvider.getStatus !== 'function') {
        return { matched: initialRampConfirmed, actualPercent: initialRampConfirmed ? targetPercent : null };
      }
      try {
        const s = await this.musicProvider.getStatus();
        if (s && s.available && typeof s.volume === 'number' && !isNaN(s.volume)) {
          const actualPercent = Math.round(s.volume * 100);
          return { matched: Math.abs(actualPercent - targetPercent) <= 2, actualPercent };
        }
      } catch {
        // Ignore transient status error and rely on setVolume ack
      }
      return { matched: initialRampConfirmed, actualPercent: initialRampConfirmed ? targetPercent : null };
    };

    if (initialRampConfirmed) {
      const statusCheck = await checkStatusMatch();
      if (statusCheck.matched) {
        return true;
      }
    }

    // Wait up to ~300ms for any in-flight ramp or status update before first retry
    if (!initialRampConfirmed) {
      await new Promise((r) => setTimeout(r, 300));
      if (this.activeRampId !== rampId) return false;
      const postWaitCheck = await checkStatusMatch();
      if (postWaitCheck.matched && postWaitCheck.actualPercent !== null) {
        return true;
      }
    }

    // Retry up to 3 times immediately
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.activeRampId !== rampId) return false;
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] ${label} verification retry ${attempt}/3: resending setVolume(${targetPercent}%) | rampId=${rampId}`
      );
      this.onLog(`[VolumeController] ${label} retry ${attempt}/3 -> ${targetPercent}%`);
      let setOk = false;
      try {
        setOk = await this.musicProvider.setVolume(targetFraction, rampId);
      } catch (err: any) {
        console.warn(`[RetroFM Volume] ${label} retry ${attempt}/3 setVolume error: ${err?.message}`);
      }

      if (this.activeRampId !== rampId) return false;
      const verifyAfterSet = await checkStatusMatch();
      if (verifyAfterSet.matched && (setOk || verifyAfterSet.actualPercent !== null)) {
        console.log(
          `[RetroFM Volume] [${new Date().toISOString()}] ${label} verified on retry ${attempt}/3: target=${targetPercent}%, actual=${verifyAfterSet.actualPercent ?? targetPercent}% | rampId=${rampId}`
        );
        return true;
      }

      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const finalCheck = await checkStatusMatch();
    console.warn(
      `[RetroFM Volume] [${new Date().toISOString()}] WARNING: ${label} volume verification failed after 3 retries (expected ${targetPercent}%, actual ${finalCheck.actualPercent ?? 'unknown'}%) | rampId=${rampId}`
    );
    return false;
  }

  /**
   * Cancel active duck/restore and restore immediately to userVolume.
   */
  public async cancel(reason: string): Promise<void> {
    const rampId = ++this.rampIdCounter;
    this.activeRampId = rampId;

    this.clearSequenceSafetyTimer();
    this.cancelActiveAnimation();

    this.isSequenceRunning = false;
    this.state = 'idle';
    this.effectiveVolume = this.userVolume;
    this.lastExpectedFraction = this.userVolume / 100;

    const visState = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    console.log(
      `[DJ Ducking Timing] 4a. RELEASE_CMD_ISSUED (immediate cancel): restoring to userVolume=${this.userVolume}% | rampId=${rampId} | reason="${reason}" | appVisibility=${visState} | ts=${Date.now()}`
    );
    console.log(
      `[RetroFM Volume] [${new Date().toISOString()}] Action: CANCEL | Restoring to userVolume: ${this.userVolume}% | rampId: ${rampId} | reason: ${reason}`
    );

    this.onLog(
      `[VolumeController] Action: CANCEL | Restoring to userVolume: ${this.userVolume}% | RampId: ${rampId} | Reason: ${reason}`
    );

    this.notify();

    try {
      await this.musicProvider.setVolume(this.userVolume / 100, rampId);
    } catch (e: any) {
      console.error(`[RetroFM Volume] Error cancelling volume: ${e?.message}`);
      this.onLog(`[VolumeController] Error cancelling volume: ${e?.message}`);
    }

    this.startWatchdog(this.lastExpectedFraction);
  }

  /**
   * Process volume reported by YouTube tab polling (e.g. from getStatus()).
   * Baseline rule: NEVER treats a mid-ramp value as baseline.
   * Watchdog rule: Detects any mismatch and immediately repairs it to userVolume in one check.
   */
  public handlePolledVolume(volumeFraction: number): void {
    if (typeof volumeFraction !== 'number' || isNaN(volumeFraction)) return;

    // 1. While ducking, ducked, or restoring, do NOT overwrite userVolume or effectiveVolume!
    if (this.state !== 'idle') {
      return;
    }

    const polledPercent = Math.round(volumeFraction * 100);
    const expectedPercent = this.userVolume;
    const expectedFraction = expectedPercent / 100;

    // 2. Watchdog active (within 10 seconds of restore): immediately repair any mismatch in one check
    if (Date.now() < this.watchdogUntil) {
      if (Math.abs(polledPercent - expectedPercent) >= 3) {
        console.warn(
          `[RetroFM Volume] [${new Date().toISOString()}] External volume change detected (watchdog): expected ${expectedPercent}%, actual ${polledPercent}% | fraction: ${volumeFraction} — repairing to ${expectedPercent}% in one check`
        );
        this.onLog(`External volume change detected: ${expectedPercent}% to ${polledPercent}% (repairing to ${expectedPercent}%)`);
        this.repairVolumeMismatch(expectedFraction, expectedPercent, polledPercent);
      } else {
        this.lastExpectedFraction = expectedFraction;
      }
      return;
    }

    // 3. Normal idle: if YouTube player volume drifted from RetroFM authoritative master volume, repair in one check
    if (Math.abs(polledPercent - expectedPercent) >= 3) {
      console.warn(
        `[RetroFM Volume] [${new Date().toISOString()}] Idle volume mismatch detected: expected ${expectedPercent}%, actual ${polledPercent}% — repairing to ${expectedPercent}% in one check`
      );
      this.onLog(`Volume mismatch detected: expected ${expectedPercent}%, actual ${polledPercent}% (repairing to ${expectedPercent}%)`);
      this.repairVolumeMismatch(expectedFraction, expectedPercent, polledPercent);
      return;
    }

    this.lastExpectedFraction = expectedFraction;
  }

  private repairVolumeMismatch(targetFraction: number, targetPercent: number, actualPercent: number): void {
    this.lastExpectedFraction = targetFraction;
    if (this.isWatchdogRepairing || this.state !== 'idle') return;
    this.isWatchdogRepairing = true;
    const repairRampId = ++this.rampIdCounter;
    this.activeRampId = repairRampId;

    this.musicProvider
      .setVolume(targetFraction, repairRampId)
      .then((ok) => {
        console.log(
          `[RetroFM Volume] [${new Date().toISOString()}] Watchdog repair completed (ok=${ok}): corrected ${actualPercent}% -> ${targetPercent}% | rampId=${repairRampId}`
        );
      })
      .catch((err) => {
        console.warn(`[RetroFM Volume] Watchdog repair error:`, err);
      })
      .finally(() => {
        this.isWatchdogRepairing = false;
      });
  }

  private startWatchdog(expectedFraction: number): void {
    this.cancelWatchdog();
    this.lastExpectedFraction = expectedFraction;
    this.watchdogUntil = Date.now() + 10000; // 10 seconds watchdog

    // Active fast watchdog check every 500ms so mismatches are detected and repaired within <= 500ms
    if (typeof this.musicProvider.getStatus === 'function') {
      this.activeWatchdogPollInterval = setInterval(async () => {
        if (Date.now() >= this.watchdogUntil || this.state !== 'idle') {
          if (this.activeWatchdogPollInterval) {
            clearInterval(this.activeWatchdogPollInterval);
            this.activeWatchdogPollInterval = null;
          }
          return;
        }
        try {
          const s = await this.musicProvider.getStatus();
          if (s && s.available && typeof s.volume === 'number' && !isNaN(s.volume)) {
            this.handlePolledVolume(s.volume);
          }
        } catch {
          // ignore transient status poll error
        }
      }, 500);
      this.activeWatchdogPollInterval?.unref?.();
    }

    this.watchdogTimer = setTimeout(() => {
      if (this.activeWatchdogPollInterval) {
        clearInterval(this.activeWatchdogPollInterval);
        this.activeWatchdogPollInterval = null;
      }
      this.watchdogUntil = 0;
      this.watchdogTimer = null;
    }, 10000);
    this.watchdogTimer?.unref?.();
  }

  private clearSequenceSafetyTimer(): void {
    if (this.sequenceSafetyTimer) {
      clearTimeout(this.sequenceSafetyTimer);
      this.sequenceSafetyTimer = null;
    }
  }

  private armSequenceSafetyTimer(durationMs: number, reason: string): void {
    this.clearSequenceSafetyTimer();
    const timeoutMs = Math.max(3000, durationMs + 2500);
    this.sequenceSafetyTimer = setTimeout(() => {
      if (this.state !== 'idle') {
        console.warn(
          `[RetroFM Volume] [${new Date().toISOString()}] Sequence safety watchdog triggered! Force resetting state from ${this.state} to idle (reason: ${reason}).`
        );
        this.cancel(`Sequence safety watchdog triggered for: ${reason}`);
      }
    }, timeoutMs);
    this.sequenceSafetyTimer?.unref?.();
  }

  private cancelWatchdog(): void {
    if (this.activeWatchdogPollInterval) {
      clearInterval(this.activeWatchdogPollInterval);
      this.activeWatchdogPollInterval = null;
    }
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogUntil = 0;
  }

  private cancelActiveAnimation(): void {
    if (this.uiAnimId !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this.uiAnimId);
      } else {
        clearTimeout(this.uiAnimId);
      }
      this.uiAnimId = null;
    }
  }

  /**
   * Smoothly animates effectiveVolume for UI feedback only (no network/postMessage calls).
   * Completely immune to tab visibility throttling: if tab is hidden, completes immediately or via clock timer.
   */
  private animateUiVolume(from: number, to: number, durationMs: number, rampId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.cancelActiveAnimation();

      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (durationMs <= 0 || isHidden) {
        this.effectiveVolume = to;
        this.notify();
        return resolve();
      }

      const schedule = (cb: () => void) => {
        if (typeof requestAnimationFrame !== 'undefined' && document.visibilityState !== 'hidden') {
          return requestAnimationFrame(cb);
        }
        return setTimeout(cb, 16) as any;
      };

      const startTime = performance.now();
      const step = () => {
        // Cancel animation if stale ramp
        if (this.activeRampId !== rampId) {
          console.warn(
            `[RetroFM Volume] UI animation cancelled for stale rampId ${rampId} (active: ${this.activeRampId})`
          );
          return resolve();
        }

        // If tab was switched to background mid-animation, immediately finish cleanly
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          this.effectiveVolume = to;
          this.notify();
          this.uiAnimId = null;
          return resolve();
        }

        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        const eased = 0.5 * (1 - Math.cos(Math.PI * progress));
        this.effectiveVolume = Math.round(from + (to - from) * eased);
        this.notify();

        if (progress < 1) {
          this.uiAnimId = schedule(step);
        } else {
          this.effectiveVolume = to;
          this.notify();
          this.uiAnimId = null;
          resolve();
        }
      };

      this.uiAnimId = schedule(step);
    });
  }
}

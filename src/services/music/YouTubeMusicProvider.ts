import { MusicPlaybackStatus, MusicProvider, SongProgramRequest, SongProgramResult, TabInfo } from './types.js';

export const FIXED_EXTENSION_ID = 'hjphfmcilldbipolljlbjnnadeogocab';

export function computeStereoBalanceGains(balance: number): { balance: number; leftGain: number; rightGain: number } {
  const b = typeof balance === 'number' && !isNaN(balance)
    ? Number(Math.max(-1, Math.min(1, balance)).toFixed(4))
    : 0;
  const leftGain = b <= 0 ? 1 : Number(Math.max(0, 1 - b).toFixed(4));
  const rightGain = b >= 0 ? 1 : Number(Math.max(0, 1 + b).toFixed(4));
  return { balance: b, leftGain, rightGain };
}

export class YouTubeMusicProvider implements MusicProvider {
  public readonly name = 'YouTubeMusicProvider';
  private connectedTabId: number | null = null;
  private currentBalance = 0;
  private isExtensionDetected = false;
  private reportedExtensionVersion: string | null = null;
  private messageCounter = 0;
  private boomBoxActionListeners: Set<(action: any) => void> = new Set();
  private stateRequestListeners: Set<() => void> = new Set();
  private ytStateChangedListeners: Set<(payload: any) => void> = new Set();
  private revealListeners: Set<() => void> = new Set();
  private needsUserClickListeners: Set<() => void> = new Set();
  private ytTabActivatedListeners: Set<() => void> = new Set();
  private boomBoxDjSpeechFinishedListeners: Set<(payload: any) => void> = new Set();

  // Cached YouTube player diagnostics from extension messages
  public latestYtState: {
    state: number | null;
    currentTime: number;
    duration: number;
    videoId: string | null;
    title: string;
    ytVisibility: string;
  } = {
    state: null,
    currentTime: 0,
    duration: 0,
    videoId: null,
    title: '',
    ytVisibility: 'unknown'
  };

  // Deduplication cache for incoming extension messages (dedupes by unique message ID, action+timestamp, or rampId+event)
  private static processedMessageIds: Map<string, number> = new Map();
  private static readonly DEDUPE_TTL_MS = 2000;

  public static isDuplicateMessage(msgKey: string): boolean {
    const now = Date.now();
    // Prune stale entries
    for (const [key, ts] of YouTubeMusicProvider.processedMessageIds.entries()) {
      if (now - ts > YouTubeMusicProvider.DEDUPE_TTL_MS) {
        YouTubeMusicProvider.processedMessageIds.delete(key);
      }
    }
    if (YouTubeMusicProvider.processedMessageIds.has(msgKey)) {
      return true;
    }
    YouTubeMusicProvider.processedMessageIds.set(msgKey, now);
    return false;
  }

  public getActiveListenerCounts(): {
    boomBoxAction: number;
    stateRequest: number;
    ytStateChanged: number;
    reveal: number;
    needsUserClick: number;
    ytTabActivated: number;
    boomBoxDjSpeechFinished: number;
    total: number;
  } {
    const counts = {
      boomBoxAction: this.boomBoxActionListeners.size,
      stateRequest: this.stateRequestListeners.size,
      ytStateChanged: this.ytStateChangedListeners.size,
      reveal: this.revealListeners.size,
      needsUserClick: this.needsUserClickListeners.size,
      ytTabActivated: this.ytTabActivatedListeners.size,
      boomBoxDjSpeechFinished: this.boomBoxDjSpeechFinishedListeners.size,
      total:
        this.boomBoxActionListeners.size +
        this.stateRequestListeners.size +
        this.ytStateChangedListeners.size +
        this.revealListeners.size +
        this.needsUserClickListeners.size +
        this.ytTabActivatedListeners.size +
        this.boomBoxDjSpeechFinishedListeners.size
    };
    return counts;
  }

  constructor() {
    if (typeof window !== 'undefined') {
      // Post app hello on load
      window.postMessage({ type: 'RETROFM_APP_HELLO' }, '*');

      window.addEventListener('message', (event) => {
        if (event.data && event.data.source === 'RETRO_FM_EXTENSION') {
          this.isExtensionDetected = true;
          if (event.data.type === 'EXTENSION_READY') {
            // Post app hello each time extension is detected / announces ready
            window.postMessage({ type: 'RETROFM_APP_HELLO' }, '*');
          }
          if (event.data.version) {
            this.reportedExtensionVersion = event.data.version;
          }
          if (event.data.type === 'BOOMBOX_ACTION' && event.data.payload) {
            const p = event.data.payload;
            const actionId = p.msgId || `${p.action}_${p.date || ''}_${p.genre || ''}_${p.decade || ''}_${p.volume || ''}_${p.balance || ''}_${p.t_boombox_click || p.t_boombox_perf || ''}`;
            const dedupeKey = `BOOMBOX_ACTION_${actionId}`;
            if (YouTubeMusicProvider.isDuplicateMessage(dedupeKey)) {
              return; // Silently drop identical duplicate action
            }

            const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
            const actionSource = p.source || (p.action === 'PAUSE' || p.action === 'END_OF_SONG_TRIGGER' ? 'unknown' : undefined);
            const sourceStr = actionSource ? ` source=${actionSource}` : '';
            console.log(`[Transport Timing] [RetroFM App] BOOMBOX_ACTION received in app tab: ${p.action}${sourceStr} (visibility=${vis})`);
            for (const listener of this.boomBoxActionListeners) {
              try { listener(p); } catch (e) {}
            }
          }
          if (event.data.type === 'GET_RADIO_STATE_REQUEST') {
            const reqKey = `GET_RADIO_STATE_REQUEST_${event.data.reqId || Math.floor(Date.now() / 250)}`;
            if (YouTubeMusicProvider.isDuplicateMessage(reqKey)) {
              return;
            }
            for (const listener of this.stateRequestListeners) {
              try { listener(); } catch (e) {}
            }
          }
          if (event.data.type === 'YT_STATE_CHANGED' && event.data.payload) {
            const p = event.data.payload;
            if (typeof p.state === 'number') this.latestYtState.state = p.state;
            if (typeof p.currentTime === 'number') this.latestYtState.currentTime = p.currentTime;
            if (typeof p.duration === 'number' && p.duration > 0) this.latestYtState.duration = p.duration;
            if (p.videoId) this.latestYtState.videoId = p.videoId;
            if (p.title) this.latestYtState.title = p.title;
            if (p.ytVisibility) this.latestYtState.ytVisibility = p.ytVisibility;

            const stateKey = `YT_STATE_CHANGED_${p.state}_${p.videoId || ''}_${p.currentTime || ''}_${p.duration || ''}`;
            if (YouTubeMusicProvider.isDuplicateMessage(stateKey)) {
              return;
            }
            for (const listener of this.ytStateChangedListeners) {
              try { listener(p); } catch (e) {}
            }
          }
          if (event.data.type === 'YT_PAGE_READY' && event.data.payload) {
            for (const listener of this.ytStateChangedListeners) {
              try { listener({ state: -1, available: true, ...event.data.payload }); } catch (e) {}
            }
          }
          if (event.data.type === 'YOUTUBE_REVEALED_TO_START') {
            for (const listener of this.revealListeners) {
              try { listener(); } catch (e) {}
            }
          }
          if (event.data.type === 'NEEDS_USER_CLICK') {
            for (const listener of this.needsUserClickListeners) {
              try { listener(); } catch (e) {}
            }
          }
          if (event.data.type === 'YT_TAB_ACTIVATED') {
            const tabActKey = `YT_TAB_ACTIVATED_${Math.floor(Date.now() / 500)}`;
            if (YouTubeMusicProvider.isDuplicateMessage(tabActKey)) {
              return;
            }
            for (const listener of this.ytTabActivatedListeners) {
              try { listener(); } catch (e) {}
            }
          }
          if (event.data.type === 'BOOMBOX_DJ_SPEECH_FINISHED') {
            const p = event.data.payload;
            const speechKey = `BOOMBOX_DJ_SPEECH_FINISHED_${p?.endedTs || ''}_${p?.durationSec || ''}_${p?.eventType || ''}`;
            if (YouTubeMusicProvider.isDuplicateMessage(speechKey)) {
              return;
            }
            for (const listener of this.boomBoxDjSpeechFinishedListeners) {
              try { listener(p); } catch (e) {}
            }
          }
          if (event.data.type === 'YT_VOLUME_RAMP_REACHED' && event.data.payload) {
            const p = event.data.payload;
            const rampKey = `YT_VOLUME_RAMP_REACHED_${p.event}_${p.rampId || ''}_${p.targetPercent || ''}_${p.ts || ''}`;
            if (YouTubeMusicProvider.isDuplicateMessage(rampKey)) {
              return; // Drop duplicate ramp completion log
            }
            const appVis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
            const label = p.event === 'YT_VOLUME_REACHED_DUCK' ? '2b. YT_VOLUME_REACHED_DUCK' : '4b. YT_VOLUME_REACHED_NORMAL';
            console.log(
              `[DJ Ducking Timing] ${label}: target=${p.targetPercent}% | actualPlayerVol=${p.actualPlayerVol}% | rampElapsed=${p.rampElapsedMs}ms (target=${p.targetDurationMs}ms) | rampId=${p.rampId} | appVisibility=${appVis} | ytVisibility=${p.ytVisibility || 'unknown'} | ts=${p.ts || Date.now()}`
            );
          }
        }
      });
      // Send initial ping to check if extension is already active
      this.pingExtension().catch(() => {});
    }
  }

  private async sendExtensionMessage(type: string, payload?: any, timeoutMs = 6000): Promise<any> {
    if (typeof window === 'undefined') {
      throw new Error('Window environment not available');
    }

    // Attempt 1: Direct Native Chrome Extension Messaging via externally_connectable
    if (typeof (window as any).chrome !== 'undefined' && (window as any).chrome?.runtime?.sendMessage) {
      try {
        const directResult = await new Promise((resolveDirect, rejectDirect) => {
          try {
            (window as any).chrome.runtime.sendMessage(
              FIXED_EXTENSION_ID,
              { type, payload },
              (response: any) => {
                let lastErr = null;
                try {
                  lastErr = (window as any).chrome.runtime?.lastError;
                } catch (e) {
                  lastErr = e;
                }
                if (lastErr) {
                  rejectDirect(lastErr);
                } else if (response && response.success) {
                  resolveDirect(response.data !== undefined ? response.data : response);
                } else if (response && response.error) {
                  rejectDirect(new Error(response.error));
                } else {
                  rejectDirect(new Error('No response from direct messaging'));
                }
              }
            );
          } catch (callErr) {
            rejectDirect(callErr);
          }
        });

        this.isExtensionDetected = true;
        return directResult;
      } catch (err) {
        // Fall back to postMessage bridge below
      }
    }

    // Attempt 2: Message Bridge via content_retrofm.js
    return new Promise((resolve, reject) => {
      const id = 'rfm_' + (++this.messageCounter) + '_' + Date.now();
      let timer: any = null;

      const handler = (event: MessageEvent) => {
        const isFromValidSource = event.source === window || event.source === window.parent || event.source === null;
        if (
          isFromValidSource &&
          event.data &&
          event.data.source === 'RETRO_FM_EXTENSION' &&
          (event.data.id === id || (!event.data.id && event.data.type === type + '_RESPONSE'))
        ) {
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          this.isExtensionDetected = true;
          if (event.data.version) {
            this.reportedExtensionVersion = event.data.version;
          }
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.data !== undefined ? event.data.data : event.data);
          }
        }
      };

      window.addEventListener('message', handler);

      const msg = {
        source: 'RETRO_FM_PAGE',
        id,
        type,
        payload,
      };

      window.postMessage(msg, '*');
      if (window.parent && window.parent !== window) {
        try {
          window.parent.postMessage(msg, '*');
        } catch (e) {
          // ignore
        }
      }

      timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error(`Extension request '${type}' timed out after ${timeoutMs}ms. Please ensure the extension is loaded with 'all_frames: true'.`));
      }, timeoutMs);
    });
  }

  public getReportedVersion(): string | null {
    return this.reportedExtensionVersion;
  }

  public async pingExtension(): Promise<{ active: boolean; version?: string }> {
    try {
      const res = await this.sendExtensionMessage('PING', {}, 1000);
      this.isExtensionDetected = true;
      const ver = res?.version || this.reportedExtensionVersion || undefined;
      if (ver) {
        this.reportedExtensionVersion = ver;
      }
      return { active: true, version: ver };
    } catch {
      return { active: false };
    }
  }

  public async isAvailable(): Promise<boolean> {
    const res = await this.pingExtension();
    return res.active;
  }

  public async listTabs(): Promise<TabInfo[]> {
    const res = await this.sendExtensionMessage('LIST_YOUTUBE_TABS');
    return res?.tabs || [];
  }

  /**
   * Launch Retro FM: Opens YouTube next to the Retro FM tab, registers it as connected,
   * creates/reuses a Chrome tab group titled "Retro FM" (orange), and returns the connection result.
   */
  public async launchRetroFmGroup(): Promise<{
    success: boolean;
    connectedTabId?: number;
    groupId?: number;
    createdNewTab?: boolean;
    status?: MusicPlaybackStatus;
    error?: string;
  }> {
    try {
      const res = await this.sendExtensionMessage('LAUNCH_RETRO_FM', {}, 8000);
      if (res?.connectedTabId) {
        this.connectedTabId = res.connectedTabId;
        const status = res.status || (await this.getStatus());
        return {
          success: true,
          connectedTabId: res.connectedTabId,
          groupId: res.groupId,
          createdNewTab: res.createdNewTab,
          status,
        };
      }
      return { success: false, error: res?.error || 'Failed to initialize RetroFM tab group' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public onBoomBoxAction(callback: (action: any) => void): () => void {
    this.boomBoxActionListeners.add(callback);
    return () => {
      this.boomBoxActionListeners.delete(callback);
    };
  }

  public onRadioStateRequest(callback: () => void): () => void {
    this.stateRequestListeners.add(callback);
    return () => {
      this.stateRequestListeners.delete(callback);
    };
  }

  public onYouTubeStateChanged(callback: (payload: any) => void): () => void {
    this.ytStateChangedListeners.add(callback);
    return () => {
      this.ytStateChangedListeners.delete(callback);
    };
  }

  public onRevealYouTubeToStart(callback: () => void): () => void {
    this.revealListeners.add(callback);
    return () => {
      this.revealListeners.delete(callback);
    };
  }

  public onNeedsUserClick(callback: () => void): () => void {
    this.needsUserClickListeners.add(callback);
    return () => {
      this.needsUserClickListeners.delete(callback);
    };
  }

  public onYtTabActivated(callback: () => void): () => void {
    this.ytTabActivatedListeners.add(callback);
    return () => {
      this.ytTabActivatedListeners.delete(callback);
    };
  }

  public onBoomBoxDjSpeechFinished(callback: (payload: any) => void): () => void {
    this.boomBoxDjSpeechFinishedListeners.add(callback);
    return () => {
      this.boomBoxDjSpeechFinishedListeners.delete(callback);
    };
  }

  public async playBoomBoxDjSpeech(payload: {
    audioSrc?: string | null;
    durationSec?: number;
    text?: string;
    isBrowser?: boolean;
    effectsSettings?: any;
  }): Promise<{ success: boolean; started?: boolean; error?: string; reason?: string }> {
    try {
      const res = await this.sendExtensionMessage('PLAY_BOOMBOX_DJ_SPEECH', payload, 4000);
      return res || { success: false };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async stopBoomBoxDjSpeech(reason = 'stopped'): Promise<boolean> {
    try {
      await this.sendExtensionMessage('STOP_BOOMBOX_DJ_SPEECH', { reason }, 1500);
      return true;
    } catch {
      return false;
    }
  }

  public async openBoomBox(): Promise<{ success: boolean; tabId?: number; reused?: boolean; error?: string }> {
    try {
      const res: any = await this.sendExtensionMessage('OPEN_BOOMBOX', {}, 4000);
      const isSuccess = Boolean(res?.success || res?.tabId || res?.reused !== undefined);
      return { success: isSuccess, tabId: res?.tabId, reused: res?.reused };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to open Boom Box' };
    }
  }

  public async notifySessionActivated(): Promise<void> {
    try {
      await this.sendExtensionMessage('YT_TAB_ACTIVATED', {}, 2000);
    } catch (e) {
      // ignore
    }
  }

  public registerAppHello(): void {
    if (typeof window !== 'undefined') {
      window.postMessage({ type: 'RETROFM_APP_HELLO' }, '*');
    }
  }

  public recordTrace(event: string, data?: Record<string, any>): void {
    try {
      this.sendExtensionMessage('RECORD_TRACE', {
        ts: Date.now(),
        source: 'app',
        event,
        data: data || {}
      }, 2000).catch(() => {});
    } catch (e) {}
  }

  public async getTransportTrace(): Promise<string> {
    try {
      const res = await this.sendExtensionMessage('GET_TRANSPORT_TRACE', {}, 4000);
      const list = Array.isArray(res?.traceLog) ? res.traceLog : (Array.isArray(res?.data?.traceLog) ? res.data.traceLog : []);
      if (!list || list.length === 0) {
        return 'No transport trace entries recorded yet.';
      }
      return list
        .map((entry: any) => {
          const iso = new Date(entry.ts || Date.now()).toISOString();
          const src = (entry.source || 'unknown').padEnd(14, ' ');
          const evt = entry.event || 'UNKNOWN';
          const details = entry.data && Object.keys(entry.data).length > 0 ? ' ' + JSON.stringify(entry.data) : '';
          return `${iso} [${src}] ${evt}${details}`;
        })
        .join('\n');
    } catch (err: any) {
      return `Failed to fetch transport trace: ${err?.message || 'timeout/disconnected'}`;
    }
  }

  public async getAudioDiagnostics(): Promise<{ snapshot: any; events: any[] } | null> {
    try {
      const res = await this.sendExtensionMessage('GET_AUDIO_DIAGNOSTICS', {}, 3000);
      const data = res?.data || res;
      return {
        snapshot: data?.snapshot || null,
        events: Array.isArray(data?.events) ? data.events : []
      };
    } catch {
      return null;
    }
  }

  public async broadcastRadioState(state: any): Promise<boolean> {
    try {
      const res = await this.sendExtensionMessage('BROADCAST_RADIO_STATE', state, 2000);
      return !!res?.success;
    } catch {
      return false;
    }
  }

  public async connect(
    tabId?: number,
    options?: { askForOneTimeClick?: boolean }
  ): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    try {
      const res = await this.sendExtensionMessage('CONNECT_YOUTUBE_TAB', {
        tabId,
        askForOneTimeClick: options?.askForOneTimeClick
      });
      if (res?.tabId) {
        this.connectedTabId = res.tabId;
        this.setBalance(this.currentBalance).catch(() => {});
        const status = res.status || (await this.getStatus());
        return { success: true, status };
      }
      return { success: false, error: 'No YouTube tab found' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async disconnect(): Promise<void> {
    this.connectedTabId = null;
  }

  public getConnectedTabId(): number | null {
    return this.connectedTabId;
  }

  public async getStatus(): Promise<MusicPlaybackStatus> {
    if (!this.connectedTabId) {
      return {
        available: false,
        title: 'Not connected',
        url: '',
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        connectedTabId: null,
      };
    }

    try {
      const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
        tabId: this.connectedTabId,
        command: { action: 'GET_STATUS' },
      });
      return {
        available: !!res?.available,
        title: res?.title || 'Unknown Title',
        url: res?.url || '',
        isPlaying: !!res?.isPlaying,
        currentTime: res?.currentTime || 0,
        duration: res?.duration || 0,
        volume: typeof res?.volume === 'number' ? res.volume : 1,
        balance: typeof res?.balance === 'number' ? res.balance : this.currentBalance,
        leftGain: typeof res?.leftGain === 'number' ? res.leftGain : computeStereoBalanceGains(this.currentBalance).leftGain,
        rightGain: typeof res?.rightGain === 'number' ? res.rightGain : computeStereoBalanceGains(this.currentBalance).rightGain,
        muted: !!res?.muted,
        connectedTabId: this.connectedTabId,
      };
    } catch (err) {
      return {
        available: false,
        title: 'Connection error',
        url: '',
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        connectedTabId: this.connectedTabId,
      };
    }
  }

  private async ensureConnected(): Promise<number | null> {
    if (this.connectedTabId) return this.connectedTabId;
    try {
      const tabs = await this.listTabs();
      if (tabs && tabs.length > 0) {
        const res = await this.connect(tabs[0].id);
        if (res.success && res.status) {
          return this.connectedTabId;
        }
      }
    } catch {}
    return null;
  }

  public async play(revealYouTubeToStart: boolean = true): Promise<boolean> {
    const res = await this.playDetailed(revealYouTubeToStart);
    return res.success;
  }

  public async playDetailed(revealYouTubeToStart: boolean = true, t_boombox_play_click?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
        tabId,
        command: {
          action: 'PLAY',
          t_boombox_play_click: t_boombox_play_click || null
        },
        revealYouTubeToStart,
      });
      const isPlaying = !!(res?.success && (res?.status?.isPlaying || res?.state === 'playing' || res?.state === 'already_playing' || res?.state === 'buffering_active'));
      return {
        success: isPlaying,
        status: res?.status,
        error: res?.error
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async pause(): Promise<boolean> {
    const res = await this.pauseDetailed('app_pause');
    return res.success;
  }

  public async pauseDetailed(source: string = 'app_pause'): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const vis = typeof document !== 'undefined' ? document.visibilityState : 'unknown';
    console.log(`[Transport Timing] [RetroFM App] pauseDetailed invoked (source=${source}, visibility=${vis})`);
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
        tabId,
        command: { action: 'PAUSE', source },
      });
      return {
        success: !!res?.success,
        status: res?.status,
        error: res?.error
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async stop(): Promise<boolean> {
    const res = await this.stopDetailed();
    return res.success;
  }

  public async stopDetailed(): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
        tabId,
        command: { action: 'STOP' },
      });
      return {
        success: !!res?.success,
        status: res?.status,
        error: res?.error
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async seek(seconds: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'SEEK', time: seconds },
    });
    return !!res?.success;
  }

  public async setVolume(volume: number, rampId?: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'SET_VOLUME', volume, rampId },
    });
    if (res && typeof res.confirmed === 'boolean') {
      return res.confirmed;
    }
    return !!res?.success;
  }

  public getBalance(): number {
    return this.currentBalance;
  }

  public async setBalance(balance: number): Promise<boolean> {
    const { balance: clamped } = computeStereoBalanceGains(balance);
    this.currentBalance = clamped;
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'SET_BALANCE', balance: clamped },
    });
    return !!res?.success;
  }

  public async rampVolume(targetVolume: number, durationMs: number, rampId?: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const timeoutMs = Math.max(6000, (durationMs || 500) + 3000);
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'RAMP_VOLUME', targetVolume, durationMs, rampId },
    }, timeoutMs);
    if (res && typeof res.confirmed === 'boolean') {
      return res.confirmed;
    }
    return !!res?.success;
  }

  public async prepare(url: string, videoId?: string, targetVolume?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      this.recordTrace('PREPARE_YOUTUBE_DISPATCH', { tabId, url, videoId, targetVolume, targetBalance: this.currentBalance });
      const res = await this.sendExtensionMessage('NAVIGATE_YOUTUBE', {
        tabId,
        url,
        videoId,
        targetVolume,
        targetBalance: this.currentBalance,
        prepareOnly: true,
        revealYouTubeToStart: false,
      });
      return {
        success: !!res?.success,
        status: res?.data?.status || res?.status,
        error: res?.error
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async navigate(url: string, videoId?: string, targetVolume?: number, revealYouTubeToStart: boolean = true, initialTime?: number): Promise<boolean> {
    const res = await this.navigateDetailed(url, videoId, targetVolume, revealYouTubeToStart, initialTime);
    return res.success;
  }

  public async navigateDetailed(url: string, videoId?: string, targetVolume?: number, revealYouTubeToStart: boolean = true, initialTime?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      const res = await this.sendExtensionMessage('NAVIGATE_YOUTUBE', {
        tabId,
        url,
        videoId,
        targetVolume,
        targetBalance: this.currentBalance,
        revealYouTubeToStart,
        initialTime,
      });
      return {
        success: !!res?.success,
        status: res?.data?.status || res?.status,
        error: res?.error
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async programSong(request: SongProgramRequest): Promise<SongProgramResult> {
    const cleanArtist = (request.artist || '').trim();
    const cleanSong = (request.song || '').trim();
    const cleanYear = (request.year || '').trim();
    const requestedStr = `${cleanArtist} — ${cleanSong}${cleanYear ? ` (${cleanYear})` : ''}`;

    if (!cleanArtist || !cleanSong) {
      return {
        success: false,
        requested: requestedStr,
        status: 'Unable to reliably select requested song',
        error: 'Artist and song title are required.',
      };
    }

    try {
      const response = await fetch('/api/music/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artist: cleanArtist, song: cleanSong, year: cleanYear }),
      });

      const data = await response.json();
      if (data.status === 'not_found' || !data.success || !data.selected) {
        return {
          success: false,
          requested: requestedStr,
          status: 'not_found',
          error: data.error || `No trustworthy recording found for ${cleanArtist} - ${cleanSong}. Nothing was played.`,
        };
      }

      const navSuccess = await this.navigate(data.selected.url, data.selected.videoId);
      if (!navSuccess) {
        return {
          success: false,
          requested: requestedStr,
          selected: data.selected,
          status: 'Unable to navigate YouTube tab',
          error: 'Failed to instruct YouTube tab to navigate to the selected video.',
        };
      }

      // Wait briefly for player initialization then command play
      await new Promise((r) => setTimeout(r, 1200));
      await this.play();

      return {
        success: true,
        requested: requestedStr,
        selected: data.selected,
        status: 'Playing',
      };
    } catch (err: any) {
      return {
        success: false,
        requested: requestedStr,
        status: 'Unable to reliably select requested song',
        error: err.message || 'Error occurred while programming song.',
      };
    }
  }
}

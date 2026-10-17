import { MusicPlaybackStatus, MusicProvider, SongProgramRequest, SongProgramResult, TabInfo } from './types.js';

export const FIXED_EXTENSION_ID = 'hjphfmcilldbipolljlbjnnadeogocab';

export class YouTubeMusicProvider implements MusicProvider {
  public readonly name = 'YouTubeMusicProvider';
  private connectedTabId: number | null = null;
  private isExtensionDetected = false;
  private reportedExtensionVersion: string | null = null;
  private messageCounter = 0;
  private boomBoxActionListeners: Set<(action: any) => void> = new Set();
  private stateRequestListeners: Set<() => void> = new Set();
  private ytStateChangedListeners: Set<(payload: any) => void> = new Set();
  private revealListeners: Set<() => void> = new Set();
  private needsUserClickListeners: Set<() => void> = new Set();
  private ytTabActivatedListeners: Set<() => void> = new Set();

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
            for (const listener of this.boomBoxActionListeners) {
              try { listener(event.data.payload); } catch (e) {}
            }
          }
          if (event.data.type === 'GET_RADIO_STATE_REQUEST') {
            for (const listener of this.stateRequestListeners) {
              try { listener(); } catch (e) {}
            }
          }
          if (event.data.type === 'YT_STATE_CHANGED' && event.data.payload) {
            for (const listener of this.ytStateChangedListeners) {
              try { listener(event.data.payload); } catch (e) {}
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
            for (const listener of this.ytTabActivatedListeners) {
              try { listener(); } catch (e) {}
            }
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
    const res = await this.pauseDetailed();
    return res.success;
  }

  public async pauseDetailed(): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
        tabId,
        command: { action: 'PAUSE' },
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
    return !!res?.success;
  }

  public async rampVolume(targetVolume: number, durationMs: number, rampId?: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'RAMP_VOLUME', targetVolume, durationMs, rampId },
    });
    return !!res?.success;
  }

  public async prepare(url: string, videoId?: string, targetVolume?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    const tabId = await this.ensureConnected();
    if (!tabId) return { success: false, error: 'No YouTube tab connected' };
    try {
      this.recordTrace('PREPARE_YOUTUBE_DISPATCH', { tabId, url, videoId, targetVolume });
      const res = await this.sendExtensionMessage('NAVIGATE_YOUTUBE', {
        tabId,
        url,
        videoId,
        targetVolume,
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

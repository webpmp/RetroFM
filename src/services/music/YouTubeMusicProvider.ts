import { MusicPlaybackStatus, MusicProvider, SongProgramRequest, SongProgramResult, TabInfo } from './types.js';

export const FIXED_EXTENSION_ID = 'hjphfmcilldbipolljlbjnnadeogocab';

export class YouTubeMusicProvider implements MusicProvider {
  public readonly name = 'YouTubeMusicProvider';
  private connectedTabId: number | null = null;
  private isExtensionDetected = false;
  private messageCounter = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('message', (event) => {
        if (event.data && event.data.source === 'RETRO_FM_EXTENSION') {
          this.isExtensionDetected = true;
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
    if ((window as any).chrome?.runtime?.sendMessage) {
      try {
        const directResult = await new Promise((resolveDirect, rejectDirect) => {
          (window as any).chrome.runtime.sendMessage(
            FIXED_EXTENSION_ID,
            { type, payload },
            (response: any) => {
              const lastErr = (window as any).chrome.runtime?.lastError;
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
        reject(new Error(`Extension request '${type}' timed out after ${timeoutMs}ms. Please ensure the extension (v1.0.3) is loaded with 'all_frames: true'.`));
      }, timeoutMs);
    });
  }

  public async pingExtension(): Promise<boolean> {
    try {
      await this.sendExtensionMessage('PING', {}, 1000);
      this.isExtensionDetected = true;
      return true;
    } catch {
      return false;
    }
  }

  public async isAvailable(): Promise<boolean> {
    return this.pingExtension();
  }

  public async listTabs(): Promise<TabInfo[]> {
    const res = await this.sendExtensionMessage('LIST_YOUTUBE_TABS');
    return res?.tabs || [];
  }

  public async connect(tabId?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
    try {
      const res = await this.sendExtensionMessage('CONNECT_YOUTUBE_TAB', { tabId });
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

  public async play(): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'PLAY' },
    });
    return !!res?.success;
  }

  public async pause(): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'PAUSE' },
    });
    return !!res?.success;
  }

  public async stop(): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'STOP' },
    });
    return !!res?.success;
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

  public async setVolume(volume: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'SET_VOLUME', volume },
    });
    return !!res?.success;
  }

  public async rampVolume(targetVolume: number, durationMs: number): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
      tabId,
      command: { action: 'RAMP_VOLUME', targetVolume, durationMs },
    });
    return !!res?.success;
  }

  public async navigate(url: string, videoId?: string): Promise<boolean> {
    const tabId = await this.ensureConnected();
    if (!tabId) return false;
    const res = await this.sendExtensionMessage('NAVIGATE_YOUTUBE', {
      tabId,
      url,
      videoId,
    });
    return !!res?.success;
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
      if (!data.success || !data.selected) {
        return {
          success: false,
          requested: requestedStr,
          status: 'Unable to reliably select requested song',
          error: data.error || 'No suitable YouTube recording could be identified.',
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

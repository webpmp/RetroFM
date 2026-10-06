export interface MusicPlaybackStatus {
  available: boolean;
  title: string;
  url: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number; // 0.0 to 1.0
  muted: boolean;
  connectedTabId?: number | null;
}

export interface SongTimingStructure {
  introStart: number;
  vocalStart: number;
  vocalEnd: number;
  outroStart: number;
  end: number;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface SongProgramRequest {
  artist: string;
  song: string;
  year?: string;
}

export interface SongSelectionInfo {
  title: string;
  videoId: string;
  channel: string;
  url: string;
  duration?: string;
  confidenceScore?: number;
  reason?: string;
}

export interface SongProgramResult {
  success: boolean;
  requested: string;
  selected?: SongSelectionInfo;
  status: string; // "Playing" or "Unable to reliably select requested song"
  error?: string;
}

export interface MusicProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  listTabs?(): Promise<TabInfo[]>;
  connect(tabId?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }>;
  disconnect(): Promise<void>;
  getStatus(): Promise<MusicPlaybackStatus>;
  play(): Promise<boolean>;
  pause(): Promise<boolean>;
  stop(): Promise<boolean>;
  seek(seconds: number): Promise<boolean>;
  setVolume(volume: number): Promise<boolean>;
  rampVolume(targetVolume: number, durationMs: number): Promise<boolean>;
  navigate(url: string, videoId?: string): Promise<boolean>;
  programSong(request: SongProgramRequest): Promise<SongProgramResult>;
}

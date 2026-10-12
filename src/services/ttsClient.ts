export interface TTSRequest {
  text: string;
  engine?: 'GEMINI' | 'KOKORO' | 'BROWSER';
  voice?: string;
  style?: string;
  model?: string;
}

export interface TTSResponse {
  success: boolean;
  audioBase64?: string;
  mimeType?: string;
  modelUsed?: string;
  durationSeconds?: number;
  error?: string;
  quotaExceeded?: boolean;
}

export interface KokoroVoice {
  id: string;
  name: string;
  description?: string;
}

export interface KokoroServiceStatus {
  isAvailable: boolean;
  voices: KokoroVoice[];
  defaultVoice: string;
}

export async function generateTTS(request: TTSRequest): Promise<TTSResponse> {
  try {
    const res = await fetch('/api/tts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    const data = await res.json();
    return data;
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Network error communicating with speech API',
    };
  }
}

export async function fetchKokoroStatus(): Promise<KokoroServiceStatus> {
  try {
    const res = await fetch('/api/tts/kokoro/status');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch {
    return {
      isAvailable: false,
      voices: [
        { id: 'am_michael', name: 'Michael (American Male - DJ/Host)' },
        { id: 'bm_george', name: 'George (British Male - BBC Host)' },
        { id: 'af_bella', name: 'Bella (American Female)' },
        { id: 'af_sarah', name: 'Sarah (American Female)' },
        { id: 'bf_emma', name: 'Emma (British Female)' },
        { id: 'bf_isabella', name: 'Isabella (British Female)' },
      ],
      defaultVoice: 'am_michael',
    };
  }
}

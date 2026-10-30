export interface TTSRequest {
  text: string;
  engine?: 'GEMINI' | 'KOKORO' | 'BROWSER';
  voice?: string;
  style?: string;
  model?: string;
  speed?: number;
  breakId?: string;
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
  const provider = request.engine || 'GEMINI';
  const voice = request.voice || 'default';
  const speed = request.speed !== undefined ? request.speed : 1.0;
  const chars = (request.text || '').length;

  console.log(`[TTS] provider=${provider} voice=${voice} speed=${speed} chars=${chars} start text="${(request.text || '').substring(0, 30).replace(/\n/g, ' ')}..."`);
  try {
    const res = await fetch('/api/tts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[TTS] provider=${provider} voice=${voice} chars=${chars} error status=${res.status} statusText="${res.statusText}" err="${errText}"`);
      return {
        success: false,
        error: `HTTP ${res.status}: ${errText || res.statusText}`,
      };
    }

    const data = await res.json();
    if (data.success) {
      console.log(`[TTS] provider=${provider} voice=${voice} chars=${chars} finish status=${res.status} duration=${data.durationSeconds || 'N/A'}s audioChars=${data.audioBase64?.length || 0}`);
    } else {
      console.error(`[TTS] provider=${provider} voice=${voice} chars=${chars} error status=${res.status} err="${data.error || 'Unknown error'}"`);
    }
    return data;
  } catch (err: any) {
    console.error(`[TTS] provider=${provider} voice=${voice} chars=${chars} error status=0 err="${err?.message || 'Network error'}"`);
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

import { TTSGenerateRequest, TTSGenerateResult, TTSProvider } from './types.js';

export interface KokoroVoiceInfo {
  id: string;
  name: string;
  description?: string;
}

export const FALLBACK_KOKORO_VOICES: KokoroVoiceInfo[] = [
  { id: 'am_michael', name: 'Michael (American Male - DJ/Host)', description: 'Default energetic American male' },
  { id: 'bm_george', name: 'George (British Male - BBC Host)', description: 'Authoritative British male' },
  { id: 'af_bella', name: 'Bella (American Female)', description: 'Clear upbeat American female' },
  { id: 'af_sarah', name: 'Sarah (American Female)', description: 'Warm conversational American female' },
  { id: 'bf_emma', name: 'Emma (British Female)', description: 'Polished British female' },
  { id: 'bf_isabella', name: 'Isabella (British Female)', description: 'Expressive British female' },
];

export class KokoroTTSProvider implements TTSProvider {
  public readonly name = 'KokoroTTSProvider';
  private baseUrl: string;

  constructor(customBaseUrl?: string) {
    this.baseUrl = customBaseUrl || process.env.KOKORO_BASE_URL || 'http://127.0.0.1:8880';
  }

  /**
   * Determine candidate URLs to try, handling host.docker.internal when running in Docker
   */
  private getCandidateUrls(): string[] {
    const urls = [this.baseUrl];
    if (this.baseUrl.includes('127.0.0.1') || this.baseUrl.includes('localhost')) {
      const dockerHost = this.baseUrl
        .replace('127.0.0.1', 'host.docker.internal')
        .replace('localhost', 'host.docker.internal');
      if (!urls.includes(dockerHost)) {
        urls.push(dockerHost);
      }
    } else if (this.baseUrl.includes('host.docker.internal')) {
      const localHost = this.baseUrl.replace('host.docker.internal', '127.0.0.1');
      if (!urls.includes(localHost)) {
        urls.push(localHost);
      }
    }
    return urls;
  }

  /**
   * Check health and retrieve supported voices from the running Kokoro service
   */
  async getServiceInfo(): Promise<{ isAvailable: boolean; voices: KokoroVoiceInfo[]; defaultVoice: string }> {
    const candidateUrls = this.getCandidateUrls();

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);

        const res = await fetch(`${url}/health`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const data = await res.json() as any;
          this.baseUrl = url; // remember the responsive URL
          const voiceIds: string[] = Array.isArray(data.supported_voices) ? data.supported_voices : [];
          const voices: KokoroVoiceInfo[] = voiceIds.length > 0
            ? voiceIds.map((id) => {
                const fallback = FALLBACK_KOKORO_VOICES.find(v => v.id === id);
                return fallback || { id, name: id };
              })
            : FALLBACK_KOKORO_VOICES;

          return {
            isAvailable: true,
            voices,
            defaultVoice: data.default_voice || 'am_michael',
          };
        }
      } catch {
        // try next candidate
      }
    }

    return {
      isAvailable: false,
      voices: FALLBACK_KOKORO_VOICES,
      defaultVoice: 'am_michael',
    };
  }

  /**
   * Synthesize text into audio using Kokoro
   */
  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const { text, voice } = request;
    if (!text || !text.trim()) {
      throw new Error('Script text cannot be empty for Kokoro TTS.');
    }

    const candidateUrls = this.getCandidateUrls();
    const voiceToUse = voice || 'am_michael';
    let lastError: Error | null = null;

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout for synthesis

        const res = await fetch(`${url}/tts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text.trim(),
            voice: voiceToUse,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          throw new Error(`Kokoro service responded with HTTP ${res.status}: ${errorText || res.statusText}`);
        }

        const durationHeader = res.headers.get('x-audio-duration');
        let durationSeconds: number | undefined;
        if (durationHeader) {
          const parsed = parseFloat(durationHeader);
          if (!isNaN(parsed) && parsed > 0) {
            durationSeconds = Math.round(parsed * 10) / 10;
          }
        }

        const arrayBuffer = await res.arrayBuffer();
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Kokoro returned empty audio buffer');
        }

        const buffer = Buffer.from(arrayBuffer);
        const audioBase64 = buffer.toString('base64');

        // Estimate duration if header was not provided (24kHz 16-bit mono PCM = ~48000 bytes/sec)
        if (!durationSeconds) {
          // Standard WAV header is 44 bytes
          const audioBytes = Math.max(0, buffer.byteLength - 44);
          durationSeconds = Math.round((audioBytes / 48000) * 10) / 10;
        }

        this.baseUrl = url; // remember the responsive URL
        return {
          audioBase64,
          mimeType: 'audio/wav',
          modelUsed: 'Kokoro-82M-bf16',
          durationSeconds: durationSeconds || 3,
        };
      } catch (err: any) {
        lastError = err;
      }
    }

    throw new Error(
      `Kokoro TTS generation failed: ${lastError?.message || 'Could not connect to Kokoro service at ' + this.baseUrl}`
    );
  }
}

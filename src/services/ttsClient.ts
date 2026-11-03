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

/**
 * Trims trailing silence from a base64-encoded PCM WAV audio buffer so that
 * HTMLAudioElement 'ended' fires immediately when spoken DJ speech stops.
 * Preserves a natural ~80ms tail so word endings are never clipped.
 */
export function trimWavTrailingSilenceBase64(
  audioBase64: string,
  rawDurationSec?: number
): { audioBase64: string; durationSeconds: number; trimmedMs: number } {
  const fallbackDur = typeof rawDurationSec === 'number' && rawDurationSec > 0 ? rawDurationSec : 4;
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
  }

  try {
    let bytes: Uint8Array;
    if (typeof Buffer !== 'undefined') {
      bytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
    } else if (typeof atob === 'function') {
      const bin = atob(audioBase64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    } else {
      return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
    }

    if (bytes.byteLength < 44) {
      return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Check 'RIFF' (0x52494646) and 'WAVE' (0x57415645)
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
      return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
    }

    let sampleRate = 24000;
    let numChannels = 1;
    let bitsPerSample = 16;
    let audioFormat = 1; // 1 = PCM, 3 = IEEE float
    let dataChunkOffset = -1;
    let dataChunkSize = 0;

    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === 0x666d7420) {
        // 'fmt '
        if (offset + 24 <= bytes.byteLength) {
          audioFormat = view.getUint16(offset + 8, true);
          numChannels = view.getUint16(offset + 10, true) || 1;
          sampleRate = view.getUint32(offset + 12, true) || 24000;
          bitsPerSample = view.getUint16(offset + 22, true) || 16;
        }
      } else if (chunkId === 0x64617461) {
        // 'data'
        dataChunkOffset = offset;
        dataChunkSize = Math.min(chunkSize, bytes.byteLength - (offset + 8));
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (dataChunkOffset < 0 || dataChunkSize <= 0) {
      return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
    }

    const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
    const blockAlign = Math.max(1, numChannels * bytesPerSample);
    const totalFrames = Math.floor(dataChunkSize / blockAlign);
    if (totalFrames <= 0 || sampleRate <= 0) {
      return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
    }

    const actualRawDurationSec = totalFrames / sampleRate;
    const pcmStart = dataChunkOffset + 8;

    // Scan backwards from the end to find the last frame exceeding silence threshold (~ -38 dB)
    let lastActiveFrame = totalFrames - 1;
    const silenceThreshold16 = 400; // out of 32768 (~1.2% amplitude)
    const silenceThresholdFloat = 0.012;

    if (audioFormat === 1 && bitsPerSample === 16) {
      for (let f = totalFrames - 1; f >= 0; f--) {
        const framePos = pcmStart + f * blockAlign;
        let active = false;
        for (let c = 0; c < numChannels; c++) {
          const sample = view.getInt16(framePos + c * 2, true);
          if (Math.abs(sample) > silenceThreshold16) {
            active = true;
            break;
          }
        }
        if (active) {
          lastActiveFrame = f;
          break;
        }
      }
    } else if (audioFormat === 3 && bitsPerSample === 32) {
      for (let f = totalFrames - 1; f >= 0; f--) {
        const framePos = pcmStart + f * blockAlign;
        let active = false;
        for (let c = 0; c < numChannels; c++) {
          const sample = view.getFloat32(framePos + c * 4, true);
          if (Math.abs(sample) > silenceThresholdFloat) {
            active = true;
            break;
          }
        }
        if (active) {
          lastActiveFrame = f;
          break;
        }
      }
    } else {
      return {
        audioBase64,
        durationSeconds: Number(actualRawDurationSec.toFixed(2)),
        trimmedMs: 0,
      };
    }

    // Keep an 80ms natural tail after the last voiced sample so speech never sounds clipped
    const tailPadFrames = Math.round(sampleRate * 0.08);
    const targetFrames = Math.min(totalFrames, lastActiveFrame + 1 + tailPadFrames);
    const silentFrames = totalFrames - targetFrames;
    const trimmedMs = Math.round((silentFrames / sampleRate) * 1000);

    // Only rewrite buffer if trailing silence > 100ms
    if (trimmedMs <= 100 || targetFrames <= 0) {
      return {
        audioBase64,
        durationSeconds: Number(actualRawDurationSec.toFixed(2)),
        trimmedMs: 0,
      };
    }

    const newDataByteLength = targetFrames * blockAlign;
    const newTotalByteLength = pcmStart + newDataByteLength;
    const trimmedBytes = bytes.slice(0, newTotalByteLength);
    const trimmedView = new DataView(trimmedBytes.buffer, trimmedBytes.byteOffset, trimmedBytes.byteLength);

    // Update RIFF chunk size (file size - 8) and data chunk size
    trimmedView.setUint32(4, newTotalByteLength - 8, true);
    trimmedView.setUint32(dataChunkOffset + 4, newDataByteLength, true);

    let newBase64: string;
    if (typeof Buffer !== 'undefined') {
      newBase64 = Buffer.from(trimmedBytes).toString('base64');
    } else {
      let binary = '';
      const chunkStep = 0x8000;
      for (let i = 0; i < trimmedBytes.length; i += chunkStep) {
        binary += String.fromCharCode.apply(null, Array.from(trimmedBytes.subarray(i, i + chunkStep)));
      }
      newBase64 = btoa(binary);
    }

    const trimmedDurationSec = Number((targetFrames / sampleRate).toFixed(2));
    console.log(
      `[DJ Ducking Timing] Trimmed ${trimmedMs}ms of trailing silence from TTS WAV (raw=${actualRawDurationSec.toFixed(2)}s -> trimmed=${trimmedDurationSec.toFixed(2)}s)`
    );

    return {
      audioBase64: newBase64,
      durationSeconds: trimmedDurationSec,
      trimmedMs,
    };
  } catch (e) {
    return { audioBase64, durationSeconds: fallbackDur, trimmedMs: 0 };
  }
}

export async function generateTTS(request: TTSRequest): Promise<TTSResponse> {
  const provider = request.engine || 'GEMINI';
  const voice = request.voice || 'default';
  const speed = request.speed !== undefined ? request.speed : 1.0;
  const chars = (request.text || '').length;

  console.log(`[DJ] TTS: provider=${provider} voice=${voice} speed=${speed} chars=${chars} start text="${(request.text || '').substring(0, 30).replace(/\n/g, ' ')}..."`);
  try {
    const res = await fetch('/api/tts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[DJ] TTS Error: provider=${provider} voice=${voice} chars=${chars} error status=${res.status} statusText="${res.statusText}" err="${errText}"`);
      return {
        success: false,
        error: `HTTP ${res.status}: ${errText || res.statusText}`,
      };
    }

    const data = await res.json();
    if (data.success && data.audioBase64) {
      const trimRes = trimWavTrailingSilenceBase64(data.audioBase64, data.durationSeconds);
      data.audioBase64 = trimRes.audioBase64;
      data.durationSeconds = trimRes.durationSeconds;
      console.log(`[DJ] TTS: provider=${provider} voice=${voice} chars=${chars} finish status=${res.status} duration=${data.durationSeconds || 'N/A'}s (trimmed=${trimRes.trimmedMs}ms) audioChars=${data.audioBase64?.length || 0}`);
    } else if (data.success) {
      console.log(`[DJ] TTS: provider=${provider} voice=${voice} chars=${chars} finish status=${res.status} duration=${data.durationSeconds || 'N/A'}s audioChars=${data.audioBase64?.length || 0}`);
    } else {
      console.error(`[DJ] TTS Error: provider=${provider} voice=${voice} chars=${chars} error status=${res.status} err="${data.error || 'Unknown error'}"`);
    }
    return data;
  } catch (err: any) {
    console.error(`[DJ] TTS Error: provider=${provider} voice=${voice} chars=${chars} error status=0 err="${err?.message || 'Network error'}"`);
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

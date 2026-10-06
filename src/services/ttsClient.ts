export interface TTSRequest {
  text: string;
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

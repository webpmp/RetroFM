export interface TTSGenerateRequest {
  text: string;
  engine?: 'GEMINI' | 'KOKORO' | 'BROWSER';
  voice?: string; // 'Puck' | 'Charon' | etc. for Gemini, or 'am_michael' | 'bm_george' etc. for Kokoro
  style?: string; // Voice acting / radio delivery prompt
  model?: string;
  speed?: number; // Speech synthesis speed factor (e.g. 0.50 to 2.00)
}

export interface TTSGenerateResult {
  audioBase64: string;
  mimeType: string;
  modelUsed: string;
  durationSeconds?: number;
}

export interface TTSProvider {
  readonly name: string;
  generate(request: TTSGenerateRequest): Promise<TTSGenerateResult>;
}

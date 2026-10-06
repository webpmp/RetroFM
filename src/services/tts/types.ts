export interface TTSGenerateRequest {
  text: string;
  voice?: string; // 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr'
  style?: string; // Voice acting / radio delivery prompt
  model?: string;
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

import { GoogleGenAI } from '@google/genai';
import { TTSGenerateRequest, TTSGenerateResult, TTSProvider } from './types.js';

export class GeminiTTSProvider implements TTSProvider {
  public readonly name = 'GeminiTTSProvider';
  private ai: GoogleGenAI;
  private primaryModel: string;
  private fallbackModel: string;

  constructor(
    apiKey?: string,
    primaryModel = 'gemini-2.5-flash-preview-tts',
    fallbackModel = 'gemini-3.8-flash-lite-tts'
  ) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      console.warn('[GeminiTTSProvider] Warning: GEMINI_API_KEY is not defined in environment.');
    }
    this.ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
  }

  async generate(request: TTSGenerateRequest): Promise<TTSGenerateResult> {
    const voiceName = request.voice || 'Puck'; // Energetic male radio-style voice
    const styleInstruction = request.style || (
      'Confident, conversational 1980s radio DJ. Fast but natural pacing. ' +
      'Warm broadcast voice. Slightly energetic. Not announcer-like.'
    );

    // List of models to try in order of latency and availability
    const candidateModels = [
      request.model || this.primaryModel,
      'gemini-2.5-flash-preview-tts',
      'gemini-3.8-flash-lite-tts',
      'gemini-3.8-flash-tts',
    ];

    // Deduplicate while preserving order
    const uniqueModels = Array.from(new Set(candidateModels));

    let lastError: any = null;

    for (const model of uniqueModels) {
      try {
        console.log(`[GeminiTTSProvider] Attempting TTS with model: ${model}, voice: ${voiceName}`);
        return await this.callModel(model, request.text, voiceName, styleInstruction);
      } catch (err: any) {
        lastError = err;
        console.warn(`[GeminiTTSProvider] Model ${model} failed:`, err?.message || err);
      }
    }

    throw new Error(
      `Gemini TTS generation failed across all models (${uniqueModels.join(', ')}). ` +
      `Last error: ${lastError?.message || 'Unknown upstream error'}`
    );
  }

  private async callModel(
    model: string,
    text: string,
    voiceName: string,
    styleInstruction: string
  ): Promise<TTSGenerateResult> {
    // Note: gemini-2.5-flash-preview-tts does not support speechMetadata (returns HTTP 400).
    // gemini-3.8-flash models support speechMetadata.
    const isV38 = model.includes('3.8');

    const contents = isV38
      ? [
          {
            role: 'user',
            parts: [
              {
                text,
                speechMetadata: {
                  style: styleInstruction,
                },
              },
            ],
          },
        ]
      : [
          {
            role: 'user',
            parts: [
              {
                text,
              },
            ],
          },
        ];

    const response = await this.ai.models.generateContent({
      model,
      contents,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const candidate = response.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData?.data);

    if (!audioPart || !audioPart.inlineData?.data) {
      throw new Error(`Model ${model} did not return audio data in candidate parts.`);
    }

    const audioBase64 = audioPart.inlineData.data;
    const mimeType = audioPart.inlineData.mimeType || 'audio/wav';

    // 24kHz, 16-bit mono = 48,000 bytes/sec
    const rawByteLength = Buffer.from(audioBase64, 'base64').length;
    const durationSeconds = Number((rawByteLength / 48000).toFixed(2));

    return {
      audioBase64,
      mimeType,
      modelUsed: model,
      durationSeconds,
    };
  }
}

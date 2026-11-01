/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Factory function for ScriptWriterProvider.
 * Shared between browser and server without pulling in server-only services or caches.
 */

import { ScriptWriterProvider } from './types.js';
import { GeminiScriptWriterProvider } from './GeminiScriptWriterProvider.js';
import { LMStudioScriptWriterProvider } from './LMStudioScriptWriterProvider.js';
import { getEnv } from '../envUtil.js';

let _defaultGeminiWriter: GeminiScriptWriterProvider | null = null;
export function getDefaultGeminiWriter(): GeminiScriptWriterProvider {
  if (!_defaultGeminiWriter) {
    const defaultModel = getEnv('GEMINI_TEXT_MODEL', 'gemini-3.8-flash');
    const fallbackModel = getEnv('GEMINI_TEXT_MODEL_FALLBACK') || undefined;
    const apiKey = getEnv('GEMINI_API_KEY') || undefined;
    _defaultGeminiWriter = new GeminiScriptWriterProvider(
      apiKey,
      defaultModel,
      fallbackModel
    );
  }
  return _defaultGeminiWriter;
}

export function getScriptWriterProvider(options?: {
  provider?: 'gemini' | 'lmstudio';
  endpoint?: string;
  model?: string;
}): ScriptWriterProvider {
  if (options?.provider === 'lmstudio') {
    return new LMStudioScriptWriterProvider({
      endpoint: options.endpoint,
      model: options.model,
    });
  }
  return getDefaultGeminiWriter();
}

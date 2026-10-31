/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Safe environment variable accessor for browser and server.
 */

export function getEnv(key: string, defaultValue = ''): string {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const val = process.env[key];
      return (val !== undefined && val.trim() !== '') ? val.trim() : defaultValue;
    }
  } catch {}
  return defaultValue;
}

/**
 * Derives the effective application URL from APP_URL and the running port.
 * When APP_URL is unset, blank, or its port doesn't match the actual running port,
 * it derives the URL from the active port (e.g. http://localhost:3000).
 */
export function getEffectiveAppUrl(port?: number | string): string {
  const rawPort = typeof port !== 'undefined' ? port : (typeof process !== 'undefined' ? process.env?.PORT : undefined);
  const parsedPort = rawPort ? Number(String(rawPort).trim()) : NaN;
  const activePort = (!isNaN(parsedPort) && parsedPort > 0) ? parsedPort : 3000;
  const configuredUrl = (typeof process !== 'undefined' ? process.env?.APP_URL?.trim() : '') || '';

  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      const configuredPort = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
      if (configuredPort === activePort) {
        return configuredUrl.replace(/\/+$/, '');
      }
    } catch {
      // Invalid URL in APP_URL, fallback to derived localhost URL
    }
  }

  return `http://localhost:${activePort}`;
}

export interface EnvCheckResult {
  missingRequired: { key: string; whatBreaks: string }[];
  missingOptional: { key: string; whatBreaks: string }[];
}

/**
 * Checks for required and optional environment variables, returning any that are missing.
 */
export function checkEnvironmentKeys(): EnvCheckResult {
  const result: EnvCheckResult = {
    missingRequired: [],
    missingOptional: [],
  };

  const geminiKey = typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY?.trim() : '';
  if (!geminiKey) {
    result.missingRequired.push({
      key: 'GEMINI_API_KEY',
      whatBreaks: 'DJ voice commentary generation, Gemini TTS audio synthesis, and AI news break script writing will be unavailable.',
    });
  }

  const youtubeKey = typeof process !== 'undefined' ? process.env?.YOUTUBE_API_KEY?.trim() : '';
  if (!youtubeKey) {
    result.missingRequired.push({
      key: 'YOUTUBE_API_KEY',
      whatBreaks: 'Live YouTube video search, video ID resolution, and duration lookups will fail.',
    });
  }

  const nytKey = typeof process !== 'undefined' ? process.env?.NYT_API_KEY?.trim() : '';
  if (!nytKey) {
    result.missingOptional.push({
      key: 'NYT_API_KEY',
      whatBreaks: 'Historical news facts from the New York Times Archive will be skipped; DJ breaks will omit news trivia.',
    });
  }

  return result;
}

/**
 * Prints a formatted startup message in the terminal naming any missing required keys
 * and what won't work without them, instead of failing silently.
 */
export function logStartupEnvironmentStatus(): void {
  const { missingRequired, missingOptional } = checkEnvironmentKeys();

  if (missingRequired.length > 0) {
    console.warn('\n================================================================================');
    console.warn('⚠️  WARNING: Missing Required Environment Variables');
    console.warn('================================================================================');
    for (const item of missingRequired) {
      console.warn(`  • [${item.key}]: MISSING`);
      console.warn(`    What won't work: ${item.whatBreaks}`);
    }
    console.warn('\n  Configure these keys in your .env file (see .env.example for details).');
    console.warn('================================================================================\n');
  }

  if (missingOptional.length > 0) {
    console.log('[RetroFM Environment] Optional keys notice:');
    for (const item of missingOptional) {
      console.log(`  • [${item.key}]: Unset (${item.whatBreaks})`);
    }
  }
}

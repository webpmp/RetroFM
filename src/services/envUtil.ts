/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Safe environment variable accessor for browser and server.
 */

export function getEnv(key: string, defaultValue = ''): string {
  try {
    if (typeof process !== 'undefined' && process.env) {
      return process.env[key] || defaultValue;
    }
  } catch {}
  return defaultValue;
}

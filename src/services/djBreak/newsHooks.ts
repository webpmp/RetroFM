/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Code-added opener hooks and lead-ins for segment breaks.
 * The model never writes these; code prepends them AFTER the Step 2 claim audit,
 * so the audit only ever checks the model's own sentences.
 */

/**
 * 7a: Builds a single lead-in string in code matching story age and placement:
 * - 0 days + Front page: "On the front page of today's Times,"
 * - 0 days + Other:      "In today's Times,"
 * - 1 day:               "In yesterday's Times,"
 * - 2-3 days:            "A couple of days ago, The Times reported,"
 * - 4-7 days:            "Last week, The Times reported,"
 */
export function buildNewsLeadIn(
  category: 'major_news' | 'music_news' | string,
  isFrontPage: boolean | undefined,
  diffDays: number
): string {
  if (diffDays <= 0) {
    return isFrontPage
      ? "On the front page of today's Times,"
      : "In today's Times,";
  }
  if (diffDays === 1) {
    return "In yesterday's Times,";
  }
  if (diffDays <= 3) {
    return "A couple of days ago, The Times reported,";
  }
  return "Last week, The Times reported,";
}

/** Prepends a hook to a body, lowercasing a common sentence-initial word after a comma hook. */
export function prependHook(hook: string, body: string): string {
  const b = (body || '').trim();
  if (!hook) return b;
  if (!b) return '';
  if (hook.endsWith(',')) {
    const firstWord = b.split(/\s+/)[0];
    const lowerable = ['The', 'A', 'An', 'This', 'That', 'These', 'Those', 'There', 'It', 'On', 'In', 'At'];
    const rest = lowerable.includes(firstWord) ? firstWord.toLowerCase() + b.slice(firstWord.length) : b;
    return `${hook} ${rest}`;
  }
  return `${hook} ${b}`;
}

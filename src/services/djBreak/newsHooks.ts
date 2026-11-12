/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Code-added opener hooks and lead-ins for segment breaks.
 * The model never writes these; code prepends them AFTER the Step 2 claim audit,
 * so the audit only ever checks the model's own sentences.
 */

/**
 * 8a: Builds a single lead-in string in code matching story age and placement:
 * - 0 days + Front page: "On the front page of today's Times,"
 * - 0 days + Other:      "In today's Times,"
 * - 1 day:               "In yesterday's Times,"
 * - 2-3 days:            "A couple of days ago in The Times,"
 * - 4-7 days:            "Last week in The Times,"
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
    return "A couple of days ago in The Times,";
  }
  return "Last week in The Times,";
}

/**
 * Strips from model draft any publication or time lead-in phrase before validation and lead-in attachment.
 */
export function stripModelPublicationPhrases(text: string): string {
  if (!text) return '';
  let cleaned = text.trim();

  // Pattern matching lead-in phrases at the beginning of the text or sentence
  const LEAD_IN_PATTERNS = [
    /^(?:on\s+the\s+front\s+pages?\s+of\s+(?:the\s+times|today['’]s\s+times|yesterday['’]s\s+times)[,:\s]*)/i,
    /^(?:from\s+the\s+front\s+pages?\s+of\s+(?:the\s+times|today['’]s\s+times|yesterday['’]s\s+times)[,:\s]*)/i,
    /^(?:on\s+the\s+front\s+page[,:\s]*)/i,
    /^(?:from\s+the\s+front\s+page[,:\s]*)/i,
    /^(?:from\s+today['’]s\s+times[,:\s]*)/i,
    /^(?:from\s+yesterday['’]s\s+times[,:\s]*)/i,
    /^(?:in\s+today['’]s\s+times[,:\s]*)/i,
    /^(?:in\s+yesterday['’]s\s+times[,:\s]*)/i,
    /^(?:in\s+today['’]s\s+paper[,:\s]*)/i,
    /^(?:in\s+yesterday['’]s\s+paper[,:\s]*)/i,
    /^(?:in\s+the\s+headlines[,:\s]*)/i,
    /^(?:in\s+the\s+news[,:\s]*)/i,
    /^(?:today['’]s\s+headlines?[,:\s]*)/i,
    /^(?:today['’]s\s+news[,:\s]*)/i,
    /^(?:in\s+today['’]s\s+top\s+story[,:\s]*)/i,
    /^(?:a\s+couple\s+of\s+days\s+ago(?:\s+in\s+the\s+times|\s*,\s*the\s+times\s+reported)?[,:\s]*)/i,
    /^(?:last\s+week(?:\s+in\s+the\s+times|\s*,\s*the\s+times\s+reported)?[,:\s]*)/i,
    /^(?:earlier\s+this\s+week(?:\s+in\s+the\s+times|\s*,\s*the\s+times\s+reported)?[,:\s]*)/i,
    /^(?:according\s+to\s+(?:the\s+times|today['’]s\s+times)[,:\s]*)/i,
    /^(?:the\s+times\s+reports?(?:\s+this\s+week)?[,:\s]*)/i,
    /^(?:it\s+is\s+reported\s+that[,:\s]*)/i,
    /^(?:reported\s+that[,:\s]*)/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of LEAD_IN_PATTERNS) {
      if (pat.test(cleaned)) {
        cleaned = cleaned.replace(pat, '').trim();
        changed = true;
      }
    }
  }

  // Also strip inline awkward occurrences like "in today's Times," or "according to today's Times" or "in today's paper"
  cleaned = cleaned.replace(/,\s*(?:in\s+today['’]s\s+(?:times|paper)|in\s+yesterday['’]s\s+(?:times|paper)|according\s+to\s+today['’]s\s+(?:times|paper)|according\s+to\s+the\s+times)\b/gi, '');
  cleaned = cleaned.replace(/\s+\b(?:in\s+today['’]s\s+(?:times|paper)|in\s+yesterday['’]s\s+(?:times|paper))\b(?=[.,;])/gi, '');
  cleaned = cleaned.replace(/\b(?:in\s+today['’]s\s+(?:times|paper)|in\s+yesterday['’]s\s+(?:times|paper)|according\s+to\s+today['’]s\s+(?:times|paper)|according\s+to\s+the\s+times)[,:\s]+/gi, '');

  // Strip awkward "over a couple of days ago" -> "a couple of days ago" or remove "over"
  cleaned = cleaned.replace(/\bover\s+(a\s+couple\s+of\s+days\s+ago)\b/gi, '$1');

  // Capitalize the first letter if needed
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned.replace(/\s{2,}/g, ' ').trim();
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

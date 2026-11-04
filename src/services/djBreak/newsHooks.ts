/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Code-added opener hooks for segment breaks.
 * The model never writes these; code prepends them AFTER the Step 2 claim audit,
 * so the audit only ever checks the model's own sentences.
 */

/** Front-page style hooks: only used when the NYT article actually ran on page 1 / section A. */
const FRONT_PAGE_HOOKS = ['From the front pages of The Times,', 'On the front page of The Times,'];
/** Neutral news hooks: no claim about page placement and no relative-time words. */
const NEUTRAL_NEWS_HOOKS = ['In the news,', 'In the headlines,'];
/** Music news hooks: no relative-time words. */
const MUSIC_NEWS_HOOKS = ['In music news,', 'Across the music world,'];

export function chooseNewsHook(topic: string, isFrontPage: boolean | undefined, seed: number): string {
  if (topic === 'major_news') {
    const list = isFrontPage ? FRONT_PAGE_HOOKS : NEUTRAL_NEWS_HOOKS;
    return list[seed % list.length];
  }
  if (topic === 'music_news') {
    return MUSIC_NEWS_HOOKS[seed % MUSIC_NEWS_HOOKS.length];
  }
  return '';
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

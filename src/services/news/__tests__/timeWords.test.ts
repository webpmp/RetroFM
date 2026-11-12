// @ts-ignore
import { describe, it, expect } from 'bun:test';
import { resolveRelativeTimeWords } from '../almanacService.js';

describe('resolveRelativeTimeWords (Round 6 Item 5)', () => {
  it('fixes the 1970-05-05 Kent State script ("this afternoon" -> "yesterday afternoon" when pub_date === broadcastDate)', () => {
    const raw =
      'Four students at Kent State University, two of them women, were shot to death this afternoon by a volley of National Guard gunfire.';
    const res = resolveRelativeTimeWords(raw, '1970-05-05', '1970-05-05');
    expect(res.text).toBe(
      'Four students at Kent State University, two of them women, were shot to death yesterday afternoon by a volley of National Guard gunfire.'
    );
    expect(res.converted).toBe(true);
  });

  it('normalizes "today", "tonight", "this morning", "this evening", and "last night" to yesterday equivalents when pub_date === broadcastDate', () => {
    const raw =
      'Officials said today that the agreement reached late last night and signed this morning would take effect tonight or later this evening.';
    const res = resolveRelativeTimeWords(raw, '1988-07-04', '1988-07-04');
    expect(res.text).toContain('yesterday');
    expect(res.text).toContain('last night');
    expect(res.text).toContain('yesterday morning');
    expect(res.text).toContain('yesterday evening');
    expect(res.text).not.toMatch(/\b(?:today|tonight|this morning|this afternoon|this evening)\b/i);
  });

  it('normalizes time words to the filing weekday name when pub_date < broadcastDate', () => {
    // 1976-07-04 is Sunday; filing day is Saturday (1976-07-03)
    const raw =
      'Israeli airborne commandos staged a daring night-time raid on Entebbe airport in Uganda last night, and officials spoke this afternoon.';
    const res = resolveRelativeTimeWords(raw, '1976-07-04', '1976-07-05');
    expect(res.text).toContain('Saturday night');
    expect(res.text).toContain('Saturday afternoon');
    expect(res.text).not.toMatch(/\b(?:today|tonight|this morning|this afternoon|this evening|last night)\b/i);
  });
});

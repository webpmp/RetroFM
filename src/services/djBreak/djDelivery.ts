/**
 * RetroFM DJ delivery: shapes the PUNCTUATION of a spoken line so the voice sounds livelier or more relaxed.
 * It never changes, adds or removes a word, and it leaves song titles and artist names exactly as they are.
 *
 *   const spokenText = shapeDelivery(text, { excitement: 60, pauses: 40, protect: [artist, title] });
 *
 * Two sliders drive it (0 to 100):
 *  - excitement: how often a sentence's period becomes an exclamation point ("!" lifts the voice at the end).
 *  - pauses: how often a comma before "and/but/so/because" becomes a dash (a longer breath) and how often a sentence
 *    ends with an ellipsis (a trailing, thoughtful pause).
 * Text-to-speech engines read punctuation as intonation and pause cues, so this works with Kokoro and most others.
 */
export interface DeliveryOptions { excitement: number; pauses: number; protect?: string[] }

type Rng = () => number;
const clamp = (n: number) => Math.max(0, Math.min(100, n)) / 100;

export function shapeDelivery(text: string, opts: DeliveryOptions, rng: Rng = Math.random): string {
  const ex = clamp(opts.excitement), pa = clamp(opts.pauses);
  if (!text || (ex === 0 && pa === 0)) return text;

  // Hide names and titles so none of their punctuation is touched.
  const hidden: string[] = [];
  let work = text;
  for (const p of [...(opts.protect ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    let idx = work.indexOf(p);
    while (idx !== -1) {
      hidden.push(p);
      const token = `\u0001${hidden.length - 1}\u0001`;
      work = work.slice(0, idx) + token + work.slice(idx + p.length);
      idx = work.indexOf(p, idx + token.length);
    }
  }

  const sentences = work.split(/(?<=[.!?])\s+/);
  const shaped = sentences.map((s, i) => {
    let t = s;
    if (pa > 0) t = t.replace(/, (and|but|so|because) /g, (m, w) => (rng() < pa * 0.8 ? ` \u2014 ${w} ` : m));
    const last = i === sentences.length - 1;
    if (/\.$/.test(t) && !/\.\.\.$/.test(t)) {
      if (ex > 0 && rng() < ex * 0.7) t = t.replace(/\.$/, "!");
      else if (pa > 0 && !last && rng() < pa * 0.25) t = t.replace(/\.$/, "...");
    }
    return t;
  });
  return shaped.join(" ").replace(/\u0001(\d+)\u0001/g, (_m, n) => hidden[Number(n)]);
}

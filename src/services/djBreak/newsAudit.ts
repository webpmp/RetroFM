/**
 * RetroFM news-line audit: code checks for a DJ sentence written about a news headline.
 *
 * The AI writer gets only the headline and abstract; this module then checks, in plain code, that the sentence adds
 * nothing: no new numbers, names or places, no hindsight, no greeting, no time-of-day talk. A sentence that fails
 * is rejected (retry once, then drop it). It works with any writer: Gemini, a local model, or anything else.
 *
 *   const packet = { date: "1967-12-20", headline: "...", abstract: "..." };
 *   if (isSensitive(packet)) skip it;
 *   const result = auditNewsLine(line, packet);   // { ok, reasons }
 */

export interface NewsPacket { date: string; headline: string; abstract?: string; section?: string }
export interface AuditResult { ok: boolean; reasons: string[] }

const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  million: 1e6, billion: 1e9, dozen: 12 };

/** Numbers claimed in a text: digits (commas ignored) and spelled-out numbers. */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  for (const w of text.toLowerCase().replace(/-/g, " ").match(/[a-z]+/g) ?? []) if (w in ONES && w !== "one") out.add(ONES[w]);
  return out;
}

const STOP_CAPS = new Set(["i", "a", "an", "the", "it", "its", "this", "that", "here", "there", "now", "so", "and", "but", "or",
  "in", "on", "at", "for", "with", "as", "to", "of", "by", "from", "we", "you", "they", "he", "she", "what", "why", "how",
  "who", "when", "where", "well", "no", "yes", "today", "tonight", "meanwhile", "still", "just", "some", "more", "all"]);
const ALLOWED_CAPS = new Set(["retrofm", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "times", "new", "york"]);

const GREETING = /\b(good (morning|afternoon|evening|night)|tonight|this (morning|evening|afternoon)|listeners|hey there|welcome back|stay tuned|breaking news|you won'?t believe)\b/i;
const HINDSIGHT = /\b(later|eventually|would go on|years? later|in hindsight|turned out|went on to|remembered as|we now know|historians?|history books)\b/i;

const words = (s: string) => s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];

export function auditNewsLine(line: string, packet: NewsPacket): AuditResult {
  const reasons: string[] = [];
  const text = (line ?? "").trim();
  const source = `${packet.headline} ${packet.abstract ?? ""}`;
  const srcLower = source.toLowerCase();
  const n = text.split(/\s+/).filter(Boolean).length;
  if (!text) return { ok: false, reasons: ["empty"] };
  if (n < 6 || n > 45) reasons.push(`length ${n} words (want 6 to 45)`);
  if ((text.match(/[.!?](\s|$)/g) ?? []).length > 3) reasons.push("more than three sentences");
  if (GREETING.test(text)) reasons.push("greeting, time-of-day or hype phrase");

  const hind = text.match(HINDSIGHT);
  if (hind && !srcLower.includes(hind[0].toLowerCase())) reasons.push(`hindsight: "${hind[0]}"`);

  const year = Number(packet.date.slice(0, 4));
  const allowedNumbers = new Set([...numbersIn(source), year]);
  const extra = [...numbersIn(text)].filter((x) => !allowedNumbers.has(x));
  if (extra.length) reasons.push(`numbers not in the headline: ${extra.join(", ")}`);

  // Names and places: any capitalised word not at the start of a sentence must come from the headline/abstract.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const invented = new Set<string>();
  for (const s of sentences) {
    words(s).forEach((w, i) => {
      if (i === 0) return;
      if (w[0] !== w[0].toUpperCase() || w[0] === w[0].toLowerCase()) return;
      const base = w.replace(/['’]s$/i, "").toLowerCase();
      if (STOP_CAPS.has(base) || ALLOWED_CAPS.has(base)) return;
      if (!srcLower.includes(base)) invented.add(w);
    });
  }
  if (invented.size) reasons.push(`names not in the headline: ${[...invented].join(", ")}`);

  const quoted = text.match(/["\u201c]([^"\u201d]+)["\u201d]/g) ?? [];
  if (quoted.some((q) => !srcLower.includes(q.slice(1, -1).toLowerCase()))) reasons.push("quotes text that is not in the headline");
  return { ok: reasons.length === 0, reasons };
}

const SENSITIVE = /\b(kill(s|ed|ing)?|dead|death|dies|died|dying|murder(s|ed)?|slain|shot|shooting|assassinat\w*|massacre|crash(es|ed)?|disaster|victims?|bomb(s|ing|ed)?|rape[sd]?|suicide|funeral|tragedy|casualt\w*|hostages?|execut\w*|epidemic|famine|riot(s|ing)?|killing)\b/i;

/** True for headlines an upbeat music DJ should not make light of. Skip these by default. */
export function isSensitive(packet: NewsPacket): boolean {
  return SENSITIVE.test(`${packet.headline} ${packet.abstract ?? ""}`);
}

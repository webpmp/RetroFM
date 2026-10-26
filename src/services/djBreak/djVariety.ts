/**
 * RetroFM DJ variety: decides WHAT kind of break to do between two songs, so the DJ never gets predictable.
 *
 * Break types: song observation (chart facts, release timing, the DJ's own opinion), station ID with a wish for the
 * listener's time of day, a calendar moment (holidays, seasons), the upcoming song's place on this week's chart, news
 * (from your NYT pipeline), a jingle, or a plain announcement. Nothing here uses AI. Every line ends by announcing the
 * next song from the data, so the DJ can never name the wrong song.
 *
 *   let state = newVarietyState();
 *   const r = buildVarietyBreak({ prev, next, date: "1979-05-01", now: new Date(), decade: "1970s", genre: "Disco",
 *                                 frequency: "89.7", topOfWeek, jingles, news, length: "mixed" }, state);
 *   state = r.state;
 *   if (r.kind === "jingle") playJingle(r.jingle!) else if (r.text) speak(r.text);   // "silent" has no text
 */
import { announceNext, artistTitle, buildBreak, TALK_PRESETS, newDjState, type DjState, type Song, type TalkLength,
  type TalkOptions } from "./djBreakObservations.js";

export interface Jingle { id: string; decade: string; genre: string | null; youtube_id: string; title?: string; duration_sec?: number }
export interface NewsItem { text: string }                       // a finished, already-audited DJ sentence or two
export interface TopEntry { rank: number; title: string; artist: string }

export interface BreakContext {
  prev: Song | null;
  next: Song | null;
  date: string;                    // the selected date, YYYY-MM-DD
  now: Date;                       // the listener's computer clock (used only for the time-of-day wish)
  decade: string;                  // e.g. "1970s"
  genre: string | null;            // the tuned station's genre (used to pick a jingle)
  frequency?: string | null;       // e.g. "89.7"
  stationName?: string;            // default "RetroFM"
  topOfWeek?: TopEntry[] | null;   // the top 10 on the chart in effect on `date`, best first
  jingles?: Jingle[];
  news?: NewsItem | null;
  economy?: { text: string } | null;   // a cost-of-living sentence from costOfLiving.ts (prices, wages, jobs, rates)
  length?: TalkLength;             // how much the DJ says about a song; default "short"
}

export type BreakKind = "observation" | "frequency" | "calendar" | "chart_now" | "news" | "economy" | "jingle" | "plain" | "silent";

export interface VarietyState {
  dj: DjState;
  silentRun: number;
  sinceType: Partial<Record<BreakKind, number>>;   // breaks since each type was last used
  recent: BreakKind[];
  usedJingles: string[];
  breaks: number;
}
export const newVarietyState = (seed?: number): VarietyState =>
  ({ dj: newDjState(seed), silentRun: 0, sinceType: {}, recent: [], usedJingles: [], breaks: 0 });

export interface BreakResult {
  kind: BreakKind;
  text: string;                    // what to speak ("" for silent and jingle)
  jingle?: Jingle;                 // set when kind is "jingle"
  afterText?: string;              // for jingles: an optional "Up next..." to speak after it, if you want one
  detail?: string;                 // e.g. the observation kinds
  /** How to time the speech. "land": it ENDS 0.5 to 2 s after the next song starts (the announcement lands as the song
   *  begins), so back-time it by its measured length. "follow": it STARTS 1 to 2 s before the song that is ending
   *  finishes and runs into the next song's intro. */
  timing?: "land" | "follow";
  maxSeconds?: number;             // the most speech time this break should take
  state: VarietyState;
}

type Rng = () => number;
const pick = <T,>(items: T[], rng: Rng): T => items[Math.floor(rng() * items.length)];

// ---------- spoken numbers and frequencies ----------
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)], o = n % 10;
  return o ? `${t}-${ONES[o]}` : t;
}

/** "91.7" -> "ninety-one point seven"; "103.5" -> "one oh three point five". */
export function spokenFrequency(f: string): string {
  const [whole, dec] = f.trim().split(".");
  const n = Number(whole);
  const w = n >= 100 ? (n === 100 ? "one hundred" : `one oh ${ONES[n - 100]}`) : numberWords(n);
  return dec && dec !== "0" ? `${w} point ${dec.split("").map((d) => ONES[Number(d)]).join(" ")}` : w;
}

/** The listener's part of the day, from their computer clock. */
export function daypart(d: Date): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
}

// ---------- the types of break ----------
const station = (c: BreakContext) => c.stationName ?? "RetroFM";

/** 1979 -> "nineteen seventy-nine", 2003 -> "two thousand three", 2015 -> "twenty fifteen". */
export function spokenYear(y: number): string {
  if (y >= 2010) return `twenty ${numberWords(y - 2000)}`.replace(/^twenty twenty$/, "twenty twenty");
  if (y >= 2000) return y === 2000 ? "two thousand" : `two thousand ${numberWords(y - 2000)}`;
  const hi = Math.floor(y / 100), lo = y % 100;
  return `${numberWords(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${numberWords(lo)}` : numberWords(lo)}`;
}

function stationLine(c: BreakContext, rng: Rng): string {
  const s = station(c), f = c.frequency ? `${spokenFrequency(c.frequency)} FM` : "";
  const y = spokenYear(Number(c.date.slice(0, 4)));
  const id = f
    ? pick([`You're listening to ${s}, ${f}`, `This is ${s}, ${f}`, `${s}, ${f}`], rng)
    : pick([`You're listening to ${s}`, `This is ${s}`], rng);
  // A slogan that names the year anchors the listener in the era, the way a real station's "the hits of 1979" would.
  const slogan = rng() < 0.75
    ? `, ${pick([`the sound of ${y}`, `playing the hits of ${y}`, `your home for the hits of ${y}`], rng)}`
    : "";
  const wish = rng() < 0.2 ? ` I hope you're having a good ${daypart(c.now)}.` : "";
  return `${id}${slogan}.${wish}`;
}

function thanksgiving(y: number): number {          // 4th Thursday of November
  const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return 1 + ((4 - first + 7) % 7) + 21;
}

/** A holiday or season line for the date, or null. Never mentions the day of the week or the year. */
export function calendarLine(date: string, rng: Rng): string | null {
  const [y, m, d] = date.split("-").map(Number);
  const fixed: Record<string, string[]> = {
    "1-1": ["Happy New Year!", "It's New Year's Day."],
    "2-14": ["Happy Valentine's Day.", "It's Valentine's Day, so dedicate a song to someone special."],
    "3-17": ["Happy St. Patrick's Day."],
    "4-1": ["It's April Fools' Day, so watch your back."],
    "7-4": ["Happy Fourth of July!", "It's the Fourth of July."],
    "10-31": ["Happy Halloween!", "It's Halloween night, so watch out for goblins."],
    "12-24": ["It's Christmas Eve."], "12-25": ["Merry Christmas!"], "12-31": ["It's New Year's Eve."],
    "3-20": ["It's the first day of spring."], "3-21": ["It's the first day of spring."],
    "6-21": ["It's the first day of summer."], "9-22": ["It's the first day of fall."], "9-23": ["It's the first day of fall."],
    "12-21": ["It's the first day of winter."],
  };
  const key = `${m}-${d}`;
  if (fixed[key]) return pick(fixed[key], rng);
  if (m === 12 && d < 24) return `Only ${numberWords(25 - d)} more shopping day${25 - d === 1 ? "" : "s"} until Christmas.`;
  if (m === 11 && d === thanksgiving(y)) return "Happy Thanksgiving!";
  if (m === 11 && Math.abs(d - thanksgiving(y)) <= 3) return d < thanksgiving(y) ? "Thanksgiving is just around the corner." : "Hope you had a good Thanksgiving.";
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Only about the upcoming song: where it sits on this week's chart. Null if it is not in the chart's top entries. */
function chartNowLine(c: BreakContext, rng: Rng): string | null {
  if (!c.next || !c.topOfWeek?.length) return null;
  const hit = c.topOfWeek.find((t) => norm(t.title) === norm(c.next!.title));
  if (!hit) return null;
  const lead = hit.rank === 1
    ? pick(["This next one is the number one song in the country this week.", "This next song is number one in the country right now."], rng)
    : hit.rank <= 3
      ? `This next one is number ${numberWords(hit.rank)} in the country this week.`
      : `This next one is in the top ten this week, at number ${numberWords(hit.rank)}.`;
  return `${lead} ${announceNext(c.next, rng)}`;
}

const NEWS_LEADS = ["I was just flipping through the paper.", "Did you see this one in the paper?",
  "Here's something I read in today's paper.", "I just saw this in the newspaper.", "Here's what's in the news."];

function pickJingle(c: BreakContext, s: VarietyState, rng: Rng): Jingle | null {
  const all = (c.jingles ?? []).filter((j) => j.decade === c.decade);
  const match = all.filter((j) => j.genre && c.genre && j.genre.toLowerCase() === c.genre.toLowerCase());
  const pool = match.length ? match : all.filter((j) => !j.genre);
  if (!pool.length) return null;
  const unused = pool.filter((j) => !s.usedJingles.includes(j.id));
  return pick(unused.length ? unused : pool, rng);
}

// ---------- choosing ----------
const recentWith = (r: BreakKind[], k: BreakKind): BreakKind[] => [...r, k].slice(-3);
const WEIGHT: Record<string, number> = { observation: 38, frequency: 10, calendar: 6, chart_now: 10, news: 20, economy: 14, jingle: 8, plain: 4 };
const COOLDOWN: Record<string, number> = { observation: 0, frequency: 6, calendar: 8, chart_now: 6, news: 3, economy: 5, jingle: 8, plain: 0 };

export function buildVarietyBreak(c: BreakContext, state: VarietyState, rng: Rng = Math.random,
                                  talk: TalkOptions = TALK_PRESETS.every): BreakResult {
  const first = state.breaks === 0;
  const s: VarietyState = { ...state, breaks: state.breaks + 1,
    sinceType: Object.fromEntries(Object.entries(state.sinceType).map(([k, v]) => [k, (v ?? 0) + 1])) };

  // Quiet song changes (never the first one, never too many in a row).
  if (!first && s.silentRun < talk.maxSilentBreaks && rng() >= talk.talkChance) {
    return { kind: "silent", text: "", state: { ...s, silentRun: s.silentRun + 1 } };
  }
  s.silentRun = 0;

  const done = (kind: BreakKind, text: string, extra: Partial<BreakResult> = {}): BreakResult => ({
    kind, text, timing: "land", maxSeconds: 22, ...extra,
    state: { ...s, sinceType: { ...s.sinceType, [kind]: 0 }, recent: recentWith(s.recent, kind), ...(extra.state ?? {}) },
  });
  const next = c.next;
  if (!next) return done("plain", "");

  const options: { kind: BreakKind; make: () => BreakResult | null }[] = [];
  const cooled = (k: BreakKind) => (s.sinceType[k] ?? 99) >= COOLDOWN[k] && s.recent[s.recent.length - 1] !== k;
  const add = (kind: BreakKind, make: () => BreakResult | null) => { if (cooled(kind)) options.push({ kind, make }); };

  add("observation", () => {
    const r = buildBreak(c.prev, next, c.date, s.dj, rng, TALK_PRESETS.every, c.length ?? "short");
    return r.text ? done("observation", r.text, { detail: r.kind ?? "announcement",
      timing: r.slot === "after" ? "follow" : "land", maxSeconds: r.slot === "after" ? 12 : 22, state: { ...s, dj: r.state,
      sinceType: { ...s.sinceType, observation: 0 }, recent: recentWith(s.recent, "observation") } }) : null;
  });
  add("frequency", () => done("frequency", `${stationLine(c, rng)} ${announceNext(next, rng)}`));
  add("calendar", () => { const l = calendarLine(c.date, rng); return l ? done("calendar", `${l} ${announceNext(next, rng)}`) : null; });
  add("chart_now", () => { const l = chartNowLine(c, rng); return l ? done("chart_now", l) : null; });
  add("news", () => (c.news?.text ? done("news", `${pick(NEWS_LEADS, rng)} ${c.news.text} ${announceNext(next, rng)}`) : null));
  add("economy", () => (c.economy?.text ? done("economy", `${c.economy.text} ${announceNext(next, rng)}`) : null));
  if (!first) add("jingle", () => {
    const j = pickJingle(c, s, rng);
    return j ? done("jingle", "", { jingle: j, afterText: announceNext(next, rng),
      state: { ...s, usedJingles: [...s.usedJingles, j.id], sinceType: { ...s.sinceType, jingle: 0 }, recent: recentWith(s.recent, "jingle") } }) : null;
  });
  options.push({ kind: "plain", make: () => done("plain", announceNext(next, rng)) });

  // The first break of a session is a welcome: the station ID.
  const pool = first ? options.filter((o) => o.kind === "frequency") : options;
  let remaining = pool.length ? [...pool] : [...options];
  while (remaining.length) {
    const total = remaining.reduce((sum, o) => sum + WEIGHT[o.kind], 0);
    let r = rng() * total, idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) { r -= WEIGHT[remaining[i].kind]; if (r <= 0) { idx = i; break; } }
    const made = remaining[idx].make();
    if (made) return made;
    remaining = remaining.filter((_, i) => i !== idx);   // nothing valid for that type: try another
  }
  return done("plain", announceNext(next, rng));
}

// Re-exported for convenience.
export { artistTitle };

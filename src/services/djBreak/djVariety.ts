/**
 * RetroFM DJ variety: decides WHAT kind of break to do between two songs, so the DJ never gets predictable.
 *
 * Break types: song observation, time and date check, station ID with frequency, calendar moment, listener
 * request, this week's number one, news (from your NYT pipeline), jingle, plain announcement. Nothing here uses AI.
 * Every line ends by announcing the next song from the data, so the DJ can never name the wrong song.
 *
 *   let state = newVarietyState();
 *   const r = buildVarietyBreak({ prev, next, date: "1967-12-20", now: new Date(), decade: "1960s",
 *                                 genre: "Country", frequency: "91.7", topOfWeek, jingles, news }, state);
 *   state = r.state;
 *   if (r.kind === "jingle") playJingle(r.jingle!) else if (r.text) speak(r.text);   // "silent" has no text
 */
import { announceNext, artistTitle, buildBreak, spoken, TALK_PRESETS, type DjState, type Song, type TalkOptions,
  newDjState } from "./djBreakObservations.js";

export interface Jingle { id: string; decade: string; genre: string | null; youtube_id: string; title?: string; duration_sec?: number }
export interface NewsItem { text: string }                       // a finished, already-audited DJ sentence or two
export interface TopEntry { rank: number; title: string; artist: string }

export interface BreakContext {
  prev: Song | null;
  next: Song | null;
  date: string;                    // the selected date, YYYY-MM-DD
  now: Date;                       // the listener's computer clock
  decade: string;                  // e.g. "1960s"
  genre: string | null;            // the tuned station's genre
  frequency?: string | null;       // e.g. "91.7"
  stationName?: string;            // default "RetroFM"
  topOfWeek?: TopEntry[] | null;   // the chart in effect on `date`, best first
  jingles?: Jingle[];
  news?: NewsItem | null;
}

export type BreakKind = "observation" | "time" | "frequency" | "calendar" | "request" | "number_one" | "news" |
  "jingle" | "plain" | "silent";

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
  detail?: string;                 // e.g. the observation kind
  state: VarietyState;
}

type Rng = () => number;
const pick = <T,>(items: T[], rng: Rng): T => items[Math.floor(rng() * items.length)];

// ---------- spoken numbers, times and frequencies ----------
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

/** 8:40 -> "eight forty", 8:05 -> "eight oh five", 12:00 -> "twelve o'clock". */
export function spokenTime(d: Date): string {
  const h = d.getHours() % 12 || 12, m = d.getMinutes();
  if (m === 0) return `${numberWords(h)} o'clock`;
  return `${numberWords(h)} ${m < 10 ? "oh " + numberWords(m) : numberWords(m)}`;
}
const daypart = (d: Date) => { const h = d.getHours(); return h >= 5 && h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night"; };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh",
  "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
  "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
  "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];
const parts = (date: string) => { const [y, m, d] = date.split("-").map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };

// ---------- the types of break ----------
const station = (c: BreakContext) => c.stationName ?? "RetroFM";
const freqPhrase = (c: BreakContext) => (c.frequency ? `${spokenFrequency(c.frequency)} FM` : "");

function timeLine(c: BreakContext, rng: Rng): string {
  const p = parts(c.date), t = spokenTime(c.now), part = daypart(c.now), wd = WEEKDAYS[p.dow];
  const day = `${MONTHS[p.m - 1]} ${ORD[p.d]}, ${p.y}`;
  const f = c.frequency ? `, ${freqPhrase(c)}` : "";
  return pick([
    `It's ${t} on a ${wd} ${part}, ${day}, and you're listening to ${station(c)}${f}.`,
    `${wd} ${part}, ${day}. It's ${t} here on ${station(c)}${f}.`,
    `The time is ${t}. You're tuned to ${station(c)}${f}, and it's ${wd}, ${day}.`,
  ], rng);
}

function frequencyLine(c: BreakContext, rng: Rng): string {
  const s = station(c), f = freqPhrase(c);
  const options = f
    ? [`You're listening to ${s} on ${f}.`, `${s}, ${f}.`, `This is ${s}, ${f}, right where you want to be.`,
       ...(c.genre ? [`You're tuned to ${s}, ${f}, your ${c.genre} station.`] : [])]
    : [`You're listening to ${s}.`, `This is ${s}.`];
  return pick(options, rng);
}

function thanksgiving(y: number): number {          // 4th Thursday of November
  const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return 1 + ((4 - first + 7) % 7) + 21;
}

/** A holiday or day-of-week line for the date, or null. */
export function calendarLine(date: string, rng: Rng): string | null {
  const { y, m, d, dow } = parts(date);
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
  const weekday: Record<number, string[]> = {
    1: ["It's Monday, so here's something to get you going."], 5: ["It's Friday, and the weekend is almost here.", "Thank goodness it's Friday."],
    6: ["It's Saturday, so make it a good one."], 0: ["It's Sunday, so take it easy."],
  };
  return weekday[dow] ? pick(weekday[dow], rng) : null;
}

const NAMES: Record<string, string[]> = {
  "1960s": ["Linda", "Susan", "Debbie", "Barbara", "Carol", "Sandra", "Donna", "Nancy", "Judy", "Patty"],
  "1970s": ["Lisa", "Karen", "Kim", "Michelle", "Cindy", "Tammy", "Pam", "Laura", "Denise", "Sheila"],
  "1980s": ["Jennifer", "Amy", "Melissa", "Jessica", "Heather", "Kelly", "Stephanie", "Tracy", "Christy", "Tina"],
  "1990s": ["Ashley", "Jessica", "Amanda", "Brittany", "Sarah", "Megan", "Tiffany", "Crystal", "Jasmine", "Kayla"],
  "2000s": ["Emily", "Madison", "Hannah", "Alexis", "Taylor", "Kayla", "Brianna", "Samantha", "Jordan", "Haley"],
  "2010s": ["Emma", "Olivia", "Ava", "Sophia", "Isabella", "Mia", "Abigail", "Harper", "Chloe", "Zoe"],
  "2020s": ["Emma", "Olivia", "Ava", "Luna", "Mia", "Harper", "Ella", "Aria", "Chloe", "Zoe"],
};
const MALE = ["Mike", "Dave", "Steve", "Tom", "Jim", "Rick", "Chris", "Danny", "Kevin", "Matt"];
const CITIES = ["Dayton, Ohio", "Tulsa", "Omaha", "Baton Rouge", "Albany", "Spokane", "Fresno", "Wichita", "Knoxville",
  "Cleveland", "Duluth", "Reno", "Louisville", "Tucson", "Scranton", "Boise", "Macon", "Providence"];

function requestLine(c: BreakContext, rng: Rng): string {
  const { artist, title } = artistTitle(c.next!);
  const pool = rng() < 0.8 ? (NAMES[c.decade] ?? NAMES["1980s"]) : MALE;
  const name = pick(pool, rng), city = pick(CITIES, rng);
  return pick([
    `This next one was requested by ${name} in ${city}. Here's ${artist} with ${title}.`,
    `${name} from ${city} called in for this one: ${artist}, with ${title}.`,
    `Here's a request from ${name} in ${city}. It's ${title} by ${artist}.`,
    `This one goes out to ${name} in ${city}, who asked for it. ${artist}, with ${title}.`,
  ], rng);
}

function numberOneLine(c: BreakContext, rng: Rng): string | null {
  const top = c.topOfWeek?.[0];
  if (!top || !c.next) return null;
  const { artist, title } = artistTitle(c.next);
  if (top.title === c.next.title) return `Here it is, this week's number one song in the country: ${artist}, with ${title}.`;
  const tArtist = spoken(top.artist), tTitle = spoken(top.title);
  return pick([
    `The number one song in the country this week is ${tTitle} by ${tArtist}. ${announceNext(c.next, rng)}`,
    `At the very top of the charts this week: ${tArtist} with ${tTitle}. ${announceNext(c.next, rng)}`,
  ], rng);
}

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

const WEIGHT: Record<string, number> = { observation: 25, time: 15, frequency: 12, calendar: 8, request: 12,
  number_one: 10, news: 20, jingle: 8, plain: 5 };
const COOLDOWN: Record<string, number> = { observation: 0, time: 6, frequency: 5, calendar: 8, request: 5,
  number_one: 6, news: 3, jingle: 8, plain: 0 };

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
    kind, text, ...extra,
    state: { ...s, sinceType: { ...s.sinceType, [kind]: 0 }, recent: recentWith(s.recent, kind) },
  });
  const next = c.next;
  if (!next) return done("plain", "");

  // What is possible right now?
  const options: { kind: BreakKind; make: () => BreakResult | null }[] = [];
  const cooled = (k: BreakKind) => (s.sinceType[k] ?? 99) >= COOLDOWN[k] && s.recent[s.recent.length - 1] !== k;
  const add = (kind: BreakKind, make: () => BreakResult | null) => { if (cooled(kind)) options.push({ kind, make }); };

  add("observation", () => {
    const r = buildBreak(c.prev, next, c.date, s.dj, rng, TALK_PRESETS.every);
    return r.text ? done("observation", r.text, { detail: r.kind ?? "announcement", state: { ...s, dj: r.state,
      sinceType: { ...s.sinceType, observation: 0 }, recent: recentWith(s.recent, "observation") } }) : null;
  });
  add("time", () => done("time", `${timeLine(c, rng)} ${announceNext(next, rng)}`));
  add("frequency", () => done("frequency", `${frequencyLine(c, rng)} ${announceNext(next, rng)}`));
  add("calendar", () => { const l = calendarLine(c.date, rng); return l ? done("calendar", `${l} ${announceNext(next, rng)}`) : null; });
  add("request", () => done("request", requestLine(c, rng)));
  add("number_one", () => { const l = numberOneLine(c, rng); return l ? done("number_one", l) : null; });
  add("news", () => (c.news?.text ? done("news", `${c.news.text} ${announceNext(next, rng)}`) : null));
  if (!first) add("jingle", () => {
    const j = pickJingle(c, s, rng);
    return j ? done("jingle", "", { jingle: j, afterText: announceNext(next, rng),
      state: { ...s, usedJingles: [...s.usedJingles, j.id], sinceType: { ...s.sinceType, jingle: 0 }, recent: recentWith(s.recent, "jingle") } }) : null;
  });
  options.push({ kind: "plain", make: () => done("plain", announceNext(next, rng)) });

  // The first break of a session is a welcome: the station ID or the time check.
  const pool = first ? options.filter((o) => o.kind === "frequency" || o.kind === "time") : options;
  const candidates = pool.length ? pool : options;
  let remaining = [...candidates];
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

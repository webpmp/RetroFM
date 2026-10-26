/**
 * RetroFM DJ break builder.
 *
 * Builds what the DJ says between two songs, with no AI and no stored comments. Everything is derived from fields
 * already in retrofm_library_youtube.json, and every observation is date-checked, so the DJ never says something
 * that had not happened yet on the selected date. Times are spoken relative to the selected date ("last year",
 * "back in April"), so the DJ sounds like he is broadcasting on that day.
 *
 * Works with any play order: it only looks at the song that just ended (prev), the song about to start (next),
 * the selected date, and a little state it hands back to you.
 *
 *   let state = newDjState();
 *   const { text, state: s2 } = buildBreak(prevSong, nextSong, "1979-05-01", state);
 *   state = s2;            // keep it for the next break
 *   speak(text);
 */

export interface Song {
  id: string;
  title: string;
  artist: string;
  release_date: string | null;
  release_date_precision: string | null;
  primary_genre: string | null;
  genres: string | null;
  peak_position: number | null;
  peak_date: string | null;
  last_chart_date: string | null;
  weeks_on_chart: number | null;
}

export interface DjState {
  seed: number;          // random per listening session; decides which songs get "before" or "after" comments
  recentKinds: string[]; // last few observation kinds, to avoid repeats
  silentRun?: number;    // breaks in a row where the DJ stayed quiet
}

export const newDjState = (seed: number = Math.floor(Math.random() * 1e9)): DjState =>
  ({ seed, recentKinds: [], silentRun: 0 });

/** How often the DJ talks. talkChance = chance of speaking at a given song change; the DJ never stays quiet for
 *  more than maxSilentBreaks song changes in a row. The very first break of a session always speaks. */
export interface TalkOptions { talkChance: number; maxSilentBreaks: number }
export const TALK_PRESETS: Record<"every" | "often" | "sometimes" | "rarely", TalkOptions> = {
  every:     { talkChance: 1.0,  maxSilentBreaks: 0 },  // every song change
  often:     { talkChance: 0.67, maxSilentBreaks: 2 },  // roughly 2 of every 3 song changes
  sometimes: { talkChance: 0.35, maxSilentBreaks: 4 },  // roughly every 3rd song change
  rarely:    { talkChance: 0.2,  maxSilentBreaks: 6 },  // roughly every 5th song change
};

/** How much the DJ says about a song: one sentence, sometimes two or three, or usually two or three. */
export type TalkLength = "short" | "mixed" | "long";

type Rng = () => number;
const pick = <T,>(items: T[], rng: Rng): T => items[Math.floor(rng() * items.length)];

/**
 * Each song gets a fixed mode for the session: "before" (comment as it is introduced) or "after" (comment once it
 * has played). It depends only on the song and the session seed, not on play order, so it works with random play,
 * and a song can never be commented on both before and after.
 */
export function songMode(songId: string, seed: number): "before" | "after" {
  let h = seed | 0;
  for (let i = 0; i < songId.length; i++) h = (Math.imul(h, 31) + songId.charCodeAt(i)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h & 1) === 0 ? "before" : "after";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

/** Names the way a DJ would say them: no quote marks, "&" read as "and", "Featuring" in lower case. */
export function spoken(name: string): string {
  return name.replace(/["\u201c\u201d]/g, "").replace(/\s+Featuring\s+/gi, " featuring ").replace(/&/g, "and").trim();
}

const numberWord = (n: number): string => {
  const w = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  return n <= 20 ? w[n] : String(n);
};

/** Pad a partial date (YYYY or YYYY-MM) to YYYY-MM-DD, at the start of the period. */
const start = (d: string): string => (d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);

/**
 * How long before `date` something happened, as a DJ would say it on that day: "this month", "last month",
 * "back in November", "in April of last year", "last year", "two years ago". `dateStr` may be YYYY, YYYY-MM or
 * YYYY-MM-DD. Returns null if it is not before `date`.
 */
export function relativeWhen(dateStr: string, date: string): string | null {
  const [ey, em, ed] = dateStr.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  const years = y - ey;
  if (years < 0 || (years === 0 && em && em > m)) return null;
  if (em && ed) {   // a full date: a week or two back reads as "this week" or "a couple of weeks ago"
    const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86_400_000);
    if (days < 0) return null;
    if (days <= 7) return "just this week";
    if (days <= 21) return "a couple of weeks ago";
  }
  if (em) {
    const months = years * 12 + (m - em);
    if (ed) {  // a full date: use the real number of days for anything recent
      const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ey, em - 1, ed)) / 86_400_000);
      if (days < 0) return null;
      if (days <= 7) return "just this week";
      if (days <= 21) return "a couple of weeks ago";
    }
    if (months === 0) return "this month";
    if (months === 1) return "last month";
    if (months < 12 && years === 0) return `back in ${MONTHS[em - 1]}`;
    if (months < 12) return `back in ${MONTHS[em - 1]}`;
    if (years === 1) return `in ${MONTHS[em - 1]} of last year`;
    return years === 2 ? "a couple of years ago" : `${numberWord(Math.floor(months / 12))} years ago`;
  }
  if (years === 0) return "earlier this year";
  if (years === 1) return "last year";
  return years === 2 ? "a couple of years ago" : `${numberWord(years)} years ago`;
}

export interface Observation { kind: string; text: string; follow: string }

/** What the DJ can honestly say a song has going for it, by genre. Generic enough to be true of nearly every record in it. */
function opinionNouns(s: Song): string[] {
  const g = `${s.primary_genre ?? ""} ${s.genres ?? ""}`.toLowerCase();
  const sets: [RegExp, string[]][] = [
    [/disco|dance|house|techno|edm|eurodance|freestyle|electro|club|trance|jersey|phonk|amapiano/, ["that beat", "that dance floor groove", "the energy", "that bass line"]],
    [/funk|motown|soul|r&b|philadelphia/, ["that groove", "that rhythm", "the feeling in it", "that voice"]],
    [/hip-hop|rap|trap|drill|crunk|boom bap|g-funk/, ["that beat", "the flow", "that hook", "the attitude"]],
    [/country|bluegrass|folk|singer-songwriter|americana|indie folk/, ["the storytelling", "that voice", "the way it's written", "that melody"]],
    [/hard rock|metal|punk|grunge|garage|surf|rock|arena|glam|emo|post-hardcore|metalcore|nu metal|psychedelic/, ["that guitar", "the energy", "that big chorus", "the attitude"]],
    [/reggae|ska|dub|reggaeton|latin|bossa|afrobeats|brazilian/, ["that rhythm", "that groove", "that laid-back feel", "the way it moves"]],
    [/soft rock|adult contemporary|easy listening|baroque|ballad|jazz|blues/, ["that melody", "the mood", "that voice", "the feeling in it"]],
  ];
  for (const [re, nouns] of sets) if (re.test(g)) return nouns;
  return ["that melody", "that chorus", "that hook", "the whole feel of it"];
}

const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

/**
 * Every observation that is already true on `date`. `slot` picks the wording. In a "before" break the observations
 * come first and the announcement last ("This next one hit number one back in June. Here's X with Y."), so they talk
 * about "this next one". In an "after" break the announcement comes first ("That was X with Y.") and the observations
 * look back at it ("That one hit number one..."). `text` is the sentence as a first sentence; `follow` is the same
 * sentence starting with "It", for use as a second or third sentence.
 */
export function observations(s: Song, date: string, rng: Rng = Math.random,
                             slot: "before" | "after" = "before"): Observation[] {
  const out: Observation[] = [];
  const before = slot === "before";
  const First = before ? "This next one" : "That one";
  // Build a sentence once from a randomly chosen template, in both its first-sentence and follow-up forms.
  const mk = (kind: string, templates: ((subj: string) => string)[]) => {
    const t = pick(templates, rng);
    out.push({ kind, text: t(First), follow: t("It") });
  };

  // Chart facts are only used once the event they describe has happened.
  if (s.peak_position && s.peak_date && date >= s.peak_date) {
    const when = relativeWhen(s.peak_date, date);
    const n = s.peak_position === 1 ? "one" : numberWord(s.peak_position);
    const at = when ? ` ${when}` : "";
    mk("peak", s.peak_position === 1
      ? [(x) => `${x} went all the way to number one${at}.`, (x) => `${x} hit number one on the Billboard Hot 100${at}.`]
      : [(x) => `${x} climbed to number ${n}${at}.`, (x) => `${x} reached number ${n} on the Billboard Hot 100${at}.`]);
  }
  if (s.weeks_on_chart && s.weeks_on_chart >= 12 && s.last_chart_date && date >= s.last_chart_date) {
    mk("long_run", [(x) => `${x} spent ${s.weeks_on_chart} weeks on the chart.`,
                    (x) => `${x} stayed on the Hot 100 for ${s.weeks_on_chart} weeks.`]);
  }

  // Release: said the way a DJ on that day would say it ("last year"), never as a bare year.
  if (s.release_date && start(s.release_date) <= date) {
    const when = relativeWhen(s.release_date, date);
    if (when) {
      const fresh = when === "this month" || when === "just this week" || when === "last month";
      const w = when === "just this week" ? "this week" : when;
      mk("release", fresh
        ? [(x) => `${x} just came out ${w}.`, (x) => `${x} is brand new, out ${w}.`]
        : [(x) => `${x} came out ${when}.`, (x) => `${x} was released ${when}.`]);
    }
  }

  // The DJ's own take: first person, warm, and about things true of nearly any record in the genre.
  const nouns = opinionNouns(s), d = pick(nouns, rng), D = cap(d);
  const op = pick(before
    ? [`I've been looking forward to this next one. I love ${d}.`, `This next one is one of my favorites. ${D} gets me every time.`,
       `Oh, I love this next one. ${D} is just irresistible.`, `You're going to like this next one. ${D} is great.`]
    : [`I never get tired of that one. ${D} gets me every time.`, `I love that song. ${D} is just irresistible.`,
       `That one's a favorite of mine, especially ${d}.`, `Can't help it, I love ${d} on that one.`], rng);
  out.push({ kind: "opinion", text: op, follow: op });
  return out;
}

const AFTER = ["That was {artist} with {title}.", "{artist}, with {title}.", "You've been listening to {title} by {artist}."];
const BEFORE = ["Up next, {title} from {artist}.", "Here's {artist} with {title}.", "This is {title}, by {artist}.",
  "Coming up, {artist} with {title}."];

const fill = (tpl: string, s: Song) => tpl.replace("{artist}", spoken(s.artist)).replace("{title}", spoken(s.title));

/** The announcement of a song about to play, with a random wording ("Up next, X from Y."). */
export function announceNext(song: Song, rng: Rng = Math.random): string {
  return fill(pick(BEFORE, rng), song);
}

/** Artist and title as a DJ would say them. */
export const artistTitle = (s: Song) => ({ artist: spoken(s.artist), title: spoken(s.title) });

const ORDER = ["release", "peak", "long_run", "opinion"];
/** Most words an observation may add: a "before" break lands on the song's start (more room); an "after" break runs
 *  into the next song's intro (less room). */
export const MAX_WORDS = { before: 55, after: 30 };
const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * What the DJ says between `prev` (just ended, or null at the start) and `next` (about to play).
 * One song only: `prev` if its mode is "after", `next` if its mode is "before". If neither fits, the DJ just announces
 * the next song (or the one that ended). `length` controls whether he says one sentence about the song or several.
 * `slot` tells the app how to time it: "before" lines END just as the next song starts; "after" lines START as the
 * song that just played ends.
 */
export function buildBreak(prev: Song | null, next: Song | null, date: string, state: DjState,
                           rng: Rng = Math.random, talk: TalkOptions = TALK_PRESETS.every,
                           length: TalkLength = "short"):
  { text: string; state: DjState; slot: "before" | "after"; kind: string | null } {
  // Stay quiet at some song changes (never the first one, and never too many in a row).
  const silentRun = state.silentRun ?? 0;
  if (prev && silentRun < talk.maxSilentBreaks && rng() >= talk.talkChance) {
    return { text: "", state: { ...state, silentRun: silentRun + 1 }, slot: next ? "before" : "after", kind: null };
  }

  const eligible: ("after" | "before")[] = [];
  if (prev && songMode(prev.id, state.seed) === "after") eligible.push("after");
  if (next && songMode(next.id, state.seed) === "before") eligible.push("before");

  let slot: "before" | "after" = next ? "before" : "after";   // plain announcement if nothing is eligible
  let used: Observation[] = [];
  const order = [...eligible].sort(() => rng() - 0.5);
  for (const candidate of order) {
    const song = candidate === "after" ? prev! : next!;
    const all = observations(song, date, rng, candidate);
    if (!all.length) continue;
    const fresh = all.filter((o) => !state.recentKinds.includes(o.kind));
    const main = pick(fresh.length ? fresh : all, rng);
    used = [main];
    // Longer breaks: add one or two more things about the same song, the DJ's own take last.
    const chance = length === "long" ? 0.85 : length === "mixed" ? 0.4 : 0;
    if (rng() < chance) {
      const more = all.filter((o) => o.kind !== main.kind && o.kind !== "opinion").sort(() => rng() - 0.5);
      const extra = more.slice(0, rng() < (length === "long" ? 0.4 : 0.15) ? 2 : 1);
      used = [...used, ...extra];
      const opinion = all.find((o) => o.kind === "opinion");
      if (opinion && !used.some((o) => o.kind === "opinion") && rng() < 0.75) used.push(opinion);
    }
    used.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    // Fit the room available (the announcement counts too): drop the last sentences until it is short enough,
    // always keeping at least one.
    const room = MAX_WORDS[candidate] - wordCount(fill(pick(candidate === "after" ? AFTER : BEFORE, rng), song));
    while (used.length > 1 && used.reduce((n, o, i) => n + wordCount(i === 0 ? o.text : o.follow), 0) > room) used.pop();
    slot = candidate;
    break;
  }
  const song = slot === "after" ? prev! : next!;
  if (!song) return { text: "", state, slot, kind: null };
  const announce = fill(pick(slot === "after" ? AFTER : BEFORE, rng), song);
  const body = used.map((o, i) => (i === 0 ? o.text : o.follow)).join(" ");
  // before: observations first, then the announcement lands as the song starts. after: announcement, then observations.
  const text = !used.length ? announce : slot === "before" ? `${body} ${announce}` : `${announce} ${body}`;
  return {
    text,
    state: { ...state, silentRun: 0, recentKinds: [...state.recentKinds, ...used.map((o) => o.kind)].slice(-4) },
    slot,
    kind: used.length ? used.map((o) => o.kind).join("+") : null,
  };
}

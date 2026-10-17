/**
 * RetroFM DJ break builder.
 *
 * Builds the short thing the DJ says between two songs, with no AI and no stored comments.
 * Everything is derived from fields already in retrofm_library_youtube.json, and every observation is
 * date-checked, so the DJ never says something that had not happened yet on the selected date.
 *
 * Works with any play order: it only looks at the song that just ended (prev), the song about to start
 * (next), the selected date, and a little state it hands back to you.
 *
 *   let state = newDjState();
 *   const { text, state: s2 } = buildBreak(prevSong, nextSong, "1964-07-04", state);
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
}

export const newDjState = (seed: number = Math.floor(Math.random() * 1e9)): DjState => ({ seed, recentKinds: [] });

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

type Rng = () => number;
const pick = <T,>(items: T[], rng: Rng): T => items[Math.floor(rng() * items.length)];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];

/** Names the way a DJ would say them: no quote marks, "&" read as "and", "Featuring" in lower case. */
export function spoken(name: string): string {
  return name.replace(/["\u201c\u201d]/g, "").replace(/\s+Featuring\s+/gi, " featuring ").replace(/&/g, "and").trim();
}

/** Pad a partial date (YYYY or YYYY-MM) to YYYY-MM-DD, at the start of the period. */
const start = (d: string): string => (d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);

function numberWord(n: number): string {
  const w = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  return n <= 20 ? w[n] : String(n);
}

interface Observation { kind: string; text: string }

/** Every observation that is already true on `date`. Empty if none apply. */
export function observations(s: Song, date: string, rng: Rng = Math.random): Observation[] {
  const out: Observation[] = [];

  // Chart facts are only used once the event they describe has happened.
  if (s.peak_position && s.peak_date && date >= s.peak_date) {
    out.push({
      kind: "peak",
      text: s.peak_position === 1
        ? pick(["It went all the way to number one on the Billboard Hot 100.",
                "That one hit number one on the Billboard Hot 100."], rng)
        : pick([`It climbed to number ${numberWord(s.peak_position)} on the Billboard Hot 100.`,
                `That one reached number ${numberWord(s.peak_position)} on the Billboard Hot 100.`], rng),
    });
  }
  if (s.weeks_on_chart && s.weeks_on_chart >= 12 && s.last_chart_date && date >= s.last_chart_date) {
    out.push({
      kind: "long_run",
      text: pick([`It spent ${s.weeks_on_chart} weeks on the Billboard Hot 100.`,
                  `That record stayed on the Hot 100 for ${s.weeks_on_chart} weeks.`], rng),
    });
  }

  // Release facts: true once the song is out. Songs are only chosen if released by the selected date,
  // but check anyway.
  if (s.release_date && start(s.release_date) <= date) {
    const [y, m] = s.release_date.split("-");
    const when = s.release_date_precision && s.release_date_precision !== "year" && m
      ? `${MONTHS[Number(m) - 1]} ${y}` : y;
    out.push({
      kind: "release",
      text: pick([`It came out in ${when}.`, `That one dates from ${when}.`], rng),
    });
  }

  // The style of the record, from the library's own genre tag.
  if (s.primary_genre) {
    out.push({
      kind: "genre",
      text: pick([`A good one for ${s.primary_genre} fans.`, `Pure ${s.primary_genre}.`,
                  `Some ${s.primary_genre} for you.`], rng),
    });
  }
  return out;
}

const AFTER = ["That was {artist} with {title}.", "{artist}, with {title}.", "You've been listening to {title} by {artist}."];
const BEFORE = ["Up next, {title} from {artist}.", "Here's {artist} with {title}.", "This is {title}, by {artist}.",
  "Coming up, {artist} with {title}."];

const fill = (tpl: string, s: Song) => tpl.replace("{artist}", spoken(s.artist)).replace("{title}", spoken(s.title));

/**
 * What the DJ says between `prev` (just ended, or null at the start) and `next` (about to play).
 * One observation at most, about a song whose mode fits this break: `prev` if its mode is "after", `next` if its
 * mode is "before". If neither fits, the DJ just announces the next song (or the one that ended).
 */
export function buildBreak(prev: Song | null, next: Song | null, date: string, state: DjState,
                           rng: Rng = Math.random): { text: string; state: DjState; slot: "before" | "after"; kind: string | null } {
  const eligible: ("after" | "before")[] = [];
  if (prev && songMode(prev.id, state.seed) === "after") eligible.push("after");
  if (next && songMode(next.id, state.seed) === "before") eligible.push("before");

  let slot: "before" | "after" = next ? "before" : "after";   // plain announcement if nothing is eligible
  let obs: Observation | null = null;
  const order = [...eligible].sort(() => rng() - 0.5);
  for (const candidate of order) {
    const song = candidate === "after" ? prev! : next!;
    const all = observations(song, date, rng);
    if (!all.length) continue;
    const fresh = all.filter((o) => !state.recentKinds.includes(o.kind));
    obs = pick(fresh.length ? fresh : all, rng);
    slot = candidate;
    break;
  }
  const song = slot === "after" ? prev! : next!;
  if (!song) return { text: "", state, slot, kind: null };
  const announce = fill(pick(slot === "after" ? AFTER : BEFORE, rng), song);
  return {
    text: obs ? `${announce} ${obs.text}` : announce,
    state: { ...state, recentKinds: obs ? [...state.recentKinds, obs.kind].slice(-3) : state.recentKinds },
    slot,
    kind: obs ? obs.kind : null,
  };
}

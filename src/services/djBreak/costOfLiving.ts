/**
 * RetroFM cost of living: builds one honest sentence about everyday life on the selected date, from the statistics
 * downloaded by fetch_prices.py (prices, wages, unemployment, mortgage rates, inflation). No AI: every number comes
 * from the data, and only data that existed before the selected date is used.
 *
 *   const prices = await (await fetch("/data/prices.json")).json();
 *   const line = economyLine(prices, "1979-05-01");     // { kind: "gasoline", text: "Regular gas is running ..." } or null
 *   // pass { text: line.text } as `economy` in the break context for buildVarietyBreak
 *
 * Which data is allowed on a date: a monthly average price describes a month that has to be over (last month or
 * earlier); government statistics such as unemployment and inflation are published weeks later, so those use data from
 * two months back; weekly mortgage rates use the latest week before the date.
 */

export interface PriceSeries { fred_id?: string; title?: string; units?: string; frequency?: string; start: string; end: string; obs: [string, number][] }
export interface PricesFile { fetched?: string; series: Record<string, PriceSeries> }
export interface EconomyLine { kind: string; text: string }

type Rng = () => number;
const pick = <T,>(items: T[], rng: Rng): T => items[Math.floor(rng() * items.length)];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ---------- speaking numbers ----------
const W = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const T = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export const words = (n: number): string => n < 20 ? W[n] : n < 100 ? (n % 10 ? `${T[Math.floor(n / 10)]}-${W[n % 10]}` : T[n / 10]) : String(n);

/** 0.86 -> "eighty-six cents", 1.19 -> "one dollar and nineteen cents", 2.9 -> "two dollars and ninety cents". */
export function spokenMoney(v: number): string {
  const cents = Math.round(v * 100);
  if (cents < 100) return `${words(cents)} cents`;
  const d = Math.floor(cents / 100), c = cents % 100;
  const dollars = `${words(d)} ${d === 1 ? "dollar" : "dollars"}`;
  return c ? `${dollars} and ${words(c)} ${c === 1 ? "cent" : "cents"}` : dollars;
}

/** 7.04 -> "seven", 2.5 -> "two point five", 0.3 -> "point three". Whole numbers when the value is large, unless oneDecimal. */
export function spokenPercent(v: number, oneDecimal = false): string {
  const r = !oneDecimal && Math.abs(v) >= 3 ? Math.round(v) : Math.round(v * 10) / 10;
  if (Number.isInteger(r)) return words(r);
  const [i, f] = r.toFixed(1).split(".");
  return `${i === "0" ? "" : words(Number(i)) + " "}point ${words(Number(f))}`.trim();
}

/** A mortgage rate to the nearest quarter, the way people said it: 10.37 -> "ten and a quarter". */
export function spokenRate(v: number): string {
  const q = Math.round(v * 4) / 4, i = Math.floor(q), f = q - i;
  const frac = f === 0.25 ? " and a quarter" : f === 0.5 ? " and a half" : f === 0.75 ? " and three quarters" : "";
  return `${words(i)}${frac}`;
}

// ---------- looking up data ----------
const ym = (d: string) => d.slice(0, 7);
const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split("-").map(Number); const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const addDays = (d: string, n: number): string => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Monthly series: the observation for exactly `month`, or null. */
const monthValue = (s: PriceSeries | undefined, month: string): number | null => {
  const hit = s?.obs.find(([d]) => ym(d) === month);
  return hit ? hit[1] : null;
};

/** Latest observation on or before `cutoff` that is no older than `maxAgeDays`. */
const latest = (s: PriceSeries | undefined, cutoff: string, maxAgeDays: number): [string, number] | null => {
  if (!s) return null;
  let best: [string, number] | null = null;
  for (const o of s.obs) { if (o[0] > cutoff) break; best = o; }
  return best && best[0] >= addDays(cutoff, -maxAgeDays) ? best : null;
};

const compare = (now: number, ago: number | null, fmt: (v: number) => string, rng: Rng): string => {
  if (ago === null || ago <= 0) return "";
  const pct = (now - ago) / ago;
  if (Math.abs(pct) < 0.03) return pick([", about the same as a year ago", ", pretty much where it was a year ago"], rng);
  return pct > 0 ? `, up from ${fmt(ago)} a year ago` : `, down from ${fmt(ago)} a year ago`;
};

/** All lines that the data supports for `date`, one per statistic. */
export function economyLines(p: PricesFile, date: string, rng: Rng = Math.random): EconomyLine[] {
  const out: EconomyLine[] = [];
  const S = p.series ?? {};
  const month = ym(date);
  const lastMonth = addMonths(month, -1);       // a monthly price average is only known once the month is over
  const published = addMonths(month, -2);       // statistics such as CPI and unemployment arrive weeks after the month

  const price = (label: string, text: (v: string) => string, fmt = spokenMoney) => {
    const v = monthValue(S[label], lastMonth);
    if (v === null) return;
    const ago = monthValue(S[label], addMonths(lastMonth, -12));
    out.push({ kind: label, text: text(`${fmt(v)}${compare(v, ago, fmt, rng)}`) });
  };
  price("gasoline", (x) => `Regular gas is running about ${x.replace(/^([^,]*)/, "$1 a gallon")}.`);
  price("eggs", (x) => `A dozen eggs will run you about ${x}.`);
  price("milk", (x) => `A gallon of milk is going for about ${x}.`);
  price("bread", (x) => `A pound of white bread is about ${x}.`);
  price("coffee", (x) => `Coffee is running about ${x} a pound.`);
  price("beef", (x) => `Ground beef is about ${x} a pound.`);
  price("earnings", (x) => `The average worker in private industry makes about ${x} an hour.`);

  const mw = latest(S.minwage, date, 800);
  if (mw) {
    const recent = mw[0] >= addDays(date, -90);
    out.push({ kind: "minwage", text: recent
      ? `The federal minimum wage just went up to ${spokenMoney(mw[1])} an hour.`
      : `The federal minimum wage is ${spokenMoney(mw[1])} an hour.` });
  }
  const cpiNow = monthValue(S.cpi, published), cpiAgo = monthValue(S.cpi, addMonths(published, -12));
  if (cpiNow !== null && cpiAgo !== null) {
    const pct = (cpiNow / cpiAgo - 1) * 100;
    out.push({ kind: "cpi", text: pct < 0.5 && pct > -0.5
      ? "Prices have barely moved over the past year."
      : pct > 0 ? `Prices are up about ${spokenPercent(pct)} percent over the past year.`
                : `Prices are down about ${spokenPercent(-pct)} percent from a year ago.` });
  }
  const un = monthValue(S.unemployment, published);
  if (un !== null) out.push({ kind: "unemployment", text: `Unemployment was ${spokenPercent(un, true)} percent in ${MONTHS[Number(published.slice(5)) - 1]}.` });
  const mg = latest(S.mortgage, addDays(date, -1), 21);
  if (mg) out.push({ kind: "mortgage", text: `A thirty-year mortgage will cost you about ${spokenRate(mg[1])} percent.` });
  return out;
}

/** One line at random, preferring a statistic that was not used recently. Null if the data supports nothing. */
export function economyLine(p: PricesFile, date: string, rng: Rng = Math.random, recentKinds: string[] = []): EconomyLine | null {
  const all = economyLines(p, date, rng);
  if (!all.length) return null;
  const fresh = all.filter((l) => !recentKinds.includes(l.kind));
  return pick(fresh.length ? fresh : all, rng);
}

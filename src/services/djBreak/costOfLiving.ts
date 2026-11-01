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

/**
 * All lines that the data supports for `date`, one per statistic.
 * Rules:
 * - Only emit a candidate when the change from a year earlier is >= 10%, OR
 *   a defined milestone is crossed:
 *     - Gasoline crosses a round dollar amount (e.g. integer floor change between last month and prior months or year ago)
 *     - Federal minimum wage increase went into effect within 90 days
 *     - 30-year fixed mortgage rate is > 15% or < 5%
 * - Never emit a flat or unchanged price (e.g. < 10% change with no milestone).
 */
export function economyLines(p: PricesFile, date: string, _rng: Rng = Math.random): EconomyLine[] {
  const out: EconomyLine[] = [];
  const S = p.series ?? {};
  const month = ym(date);
  const lastMonth = addMonths(month, -1);       // a monthly price average is only known once the month is over
  const published = addMonths(month, -2);       // statistics such as CPI and unemployment arrive weeks after the month

  // Standard prices: gasoline, eggs, milk, bread, coffee, beef, earnings
  const price = (
    label: string,
    buildVariants: (nowStr: string, agoStr: string, pct: number) => string[],
    fmt = spokenMoney,
    extraMilestoneCheck?: (now: number, ago: number | null) => boolean
  ) => {
    const v = monthValue(S[label], lastMonth);
    if (v === null || v <= 0) return;
    const ago = monthValue(S[label], addMonths(lastMonth, -12));
    if (ago === null || ago <= 0) return;

    const pct = (v - ago) / ago;
    const has10PctChange = Math.abs(pct) >= 0.10;
    const hasMilestone = extraMilestoneCheck ? extraMilestoneCheck(v, ago) : false;

    // Reject flat or unchanged prices: must have >= 10% change or milestone
    if (!has10PctChange && !hasMilestone) {
      return;
    }

    const variants = buildVariants(fmt(v), fmt(ago), pct);
    const text = pick(variants, _rng);
    out.push({ kind: label, text });
  };

  // 1. Gasoline: >= 10% change or crossed round dollar threshold (4-6 variants)
  price(
    "gasoline",
    (nowStr, agoStr, pct) =>
      pct > 0
        ? [
            `Regular gas is running about ${nowStr} a gallon, up from ${agoStr} a year ago.`,
            `At the pumps this month, regular gas is going for about ${nowStr} a gallon, up from ${agoStr} last year.`,
            `Filling up the tank will cost you around ${nowStr} a gallon for regular, compared to ${agoStr} a year ago.`,
            `Gasoline prices are averaging about ${nowStr} a gallon for regular, up from ${agoStr} this time last year.`,
            `Regular unleaded is running around ${nowStr} a gallon, up from ${agoStr} a year ago.`,
          ]
        : [
            `Regular gas is running about ${nowStr} a gallon, down from ${agoStr} a year ago.`,
            `At the pumps, regular gas is down to about ${nowStr} a gallon, from ${agoStr} last year.`,
            `Filling up is running around ${nowStr} a gallon for regular, down from ${agoStr} a year ago.`,
            `Gasoline prices are down to about ${nowStr} a gallon, compared to ${agoStr} last year.`,
            `Regular gas is running about ${nowStr} a gallon, down from ${agoStr} this time last year.`,
          ],
    spokenMoney,
    (now, ago) => {
      // Check if crossed round dollar integer milestone from 1 year ago or previous month
      if (ago !== null && Math.floor(now) !== Math.floor(ago)) return true;
      const prevMonthVal = monthValue(S.gasoline, addMonths(lastMonth, -1));
      if (prevMonthVal !== null && Math.floor(now) !== Math.floor(prevMonthVal)) return true;
      return false;
    }
  );

  // 2. Eggs: >= 10% change (4-6 variants)
  price("eggs", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `A dozen eggs will run you about ${nowStr}, up from ${agoStr} a year ago.`,
          `At the grocery store, a dozen eggs is going for about ${nowStr}, up from ${agoStr} last year.`,
          `Checking the grocery receipt, a dozen eggs costs around ${nowStr}, up from ${agoStr} a year ago.`,
          `A carton of eggs is running about ${nowStr}, compared to ${agoStr} this time last year.`,
          `A dozen eggs is going for about ${nowStr} this month, up from ${agoStr} a year ago.`,
        ]
      : [
          `A dozen eggs will run you about ${nowStr}, down from ${agoStr} a year ago.`,
          `At the grocery store, a dozen eggs is down to about ${nowStr}, from ${agoStr} last year.`,
          `Eggs are running about ${nowStr} a dozen, down from ${agoStr} a year ago.`,
          `A carton of eggs is down to around ${nowStr}, compared to ${agoStr} this time last year.`,
          `A dozen eggs is going for about ${nowStr} this month, down from ${agoStr} a year ago.`,
        ]
  );

  // 3. Milk: >= 10% change (4-6 variants)
  price("milk", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `A gallon of milk is going for about ${nowStr}, up from ${agoStr} a year ago.`,
          `At the store, a gallon of whole milk runs around ${nowStr}, up from ${agoStr} last year.`,
          `Milk is costing about ${nowStr} a gallon, compared to ${agoStr} a year ago.`,
          `Picking up a gallon of milk will run you around ${nowStr}, up from ${agoStr} this time last year.`,
          `A gallon of milk is priced around ${nowStr}, up from ${agoStr} a year ago.`,
        ]
      : [
          `A gallon of milk is going for about ${nowStr}, down from ${agoStr} a year ago.`,
          `At the store, milk is down to around ${nowStr} a gallon, from ${agoStr} last year.`,
          `Milk is running about ${nowStr} a gallon, down from ${agoStr} a year ago.`,
          `Picking up a gallon of milk is costing around ${nowStr}, down from ${agoStr} this time last year.`,
          `A gallon of milk is priced around ${nowStr}, down from ${agoStr} a year ago.`,
        ]
  );

  // 4. Bread: >= 10% change (4-6 variants)
  price("bread", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `A pound of white bread is about ${nowStr}, up from ${agoStr} a year ago.`,
          `A loaf of white bread runs around ${nowStr}, up from ${agoStr} last year.`,
          `Bread is going for about ${nowStr} a pound, compared to ${agoStr} a year ago.`,
          `Picking up a loaf of bread will cost you about ${nowStr}, up from ${agoStr} this time last year.`,
          `A pound loaf of white bread is priced around ${nowStr}, up from ${agoStr} a year ago.`,
        ]
      : [
          `A pound of white bread is about ${nowStr}, down from ${agoStr} a year ago.`,
          `A loaf of white bread is down to around ${nowStr}, from ${agoStr} last year.`,
          `Bread is going for about ${nowStr} a pound, down from ${agoStr} a year ago.`,
          `Picking up a loaf of bread costs about ${nowStr}, down from ${agoStr} this time last year.`,
          `A pound loaf of white bread is priced around ${nowStr}, down from ${agoStr} a year ago.`,
        ]
  );

  // 5. Coffee: >= 10% change (4-6 variants)
  price("coffee", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `Coffee is running about ${nowStr} a pound, up from ${agoStr} a year ago.`,
          `A pound of coffee is going for around ${nowStr}, up from ${agoStr} last year.`,
          `Buying a can of coffee will cost you about ${nowStr} a pound, up from ${agoStr} a year ago.`,
          `Coffee prices are averaging around ${nowStr} a pound, compared to ${agoStr} this time last year.`,
          `A pound of coffee is running about ${nowStr}, up from ${agoStr} a year ago.`,
        ]
      : [
          `Coffee is running about ${nowStr} a pound, down from ${agoStr} a year ago.`,
          `A pound of coffee is down to around ${nowStr}, from ${agoStr} last year.`,
          `Buying coffee will cost you about ${nowStr} a pound, down from ${agoStr} a year ago.`,
          `Coffee prices are averaging around ${nowStr} a pound, down from ${agoStr} this time last year.`,
          `A pound of coffee is running about ${nowStr}, down from ${agoStr} a year ago.`,
        ]
  );

  // 6. Ground Beef: >= 10% change (4-6 variants)
  price("beef", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `Ground beef is about ${nowStr} a pound, up from ${agoStr} a year ago.`,
          `At the butcher counter, ground beef is running around ${nowStr} a pound, up from ${agoStr} last year.`,
          `Ground beef is costing about ${nowStr} a pound, compared to ${agoStr} a year ago.`,
          `A pound of ground beef is priced around ${nowStr}, up from ${agoStr} this time last year.`,
          `Ground beef is going for about ${nowStr} a pound, up from ${agoStr} a year ago.`,
        ]
      : [
          `Ground beef is about ${nowStr} a pound, down from ${agoStr} a year ago.`,
          `At the butcher counter, ground beef is down to around ${nowStr} a pound, from ${agoStr} last year.`,
          `Ground beef is costing about ${nowStr} a pound, down from ${agoStr} a year ago.`,
          `A pound of ground beef is priced around ${nowStr}, down from ${agoStr} this time last year.`,
          `Ground beef is going for about ${nowStr} a pound, down from ${agoStr} a year ago.`,
        ]
  );

  // 7. Average Hourly Earnings: >= 10% change (4-6 variants)
  price("earnings", (nowStr, agoStr, pct) =>
    pct > 0
      ? [
          `The average worker in private industry makes about ${nowStr} an hour, up from ${agoStr} a year ago.`,
          `Average hourly earnings in private industry stand at about ${nowStr}, up from ${agoStr} last year.`,
          `Paychecks show the average private sector worker earning about ${nowStr} an hour, up from ${agoStr} a year ago.`,
          `Across private industry, workers are making around ${nowStr} an hour, compared to ${agoStr} this time last year.`,
          `Average hourly pay in private industry is around ${nowStr}, up from ${agoStr} a year ago.`,
        ]
      : [
          `The average worker in private industry makes about ${nowStr} an hour, down from ${agoStr} a year ago.`,
          `Average hourly earnings in private industry stand at about ${nowStr}, down from ${agoStr} last year.`,
          `Across private industry, workers are making around ${nowStr} an hour, down from ${agoStr} this time last year.`,
          `Average hourly pay in private industry is around ${nowStr}, down from ${agoStr} a year ago.`,
        ]
  );

  // 8. Federal Minimum Wage: milestone only (change within past 90 days) (4-6 variants)
  const mw = latest(S.minwage, date, 800);
  if (mw) {
    const recent = mw[0] >= addDays(date, -90);
    if (recent) {
      const prior = S.minwage?.obs.filter(([d]) => d < mw[0]).slice(-1)[0];
      if (!prior || prior[1] !== mw[1]) {
        const mwStr = spokenMoney(mw[1]);
        const variants = [
          `The federal minimum wage just went up to ${mwStr} an hour.`,
          `The new federal minimum wage is now in effect at ${mwStr} an hour.`,
          `Starting recently, the federal minimum wage stands at ${mwStr} an hour.`,
          `Federal minimum wage rates have stepped up to ${mwStr} an hour.`,
        ];
        out.push({ kind: "minwage", text: pick(variants, _rng) });
      }
    }
  }

  // 9. CPI inflation: >= 10% change milestone (4-6 variants)
  const cpiNow = monthValue(S.cpi, published), cpiAgo = monthValue(S.cpi, addMonths(published, -12));
  if (cpiNow !== null && cpiAgo !== null && cpiAgo > 0) {
    const pct = ((cpiNow - cpiAgo) / cpiAgo) * 100;
    if (Math.abs(pct) >= 10) {
      const pctStr = spokenPercent(Math.abs(pct));
      const variants = pct > 0
        ? [
            `Prices are up about ${pctStr} percent over the past year.`,
            `Consumer prices have risen about ${pctStr} percent compared to a year ago.`,
            `The cost of living is up roughly ${pctStr} percent from this time last year.`,
            `Overall consumer prices are running about ${pctStr} percent higher than a year ago.`,
          ]
        : [
            `Prices are down about ${pctStr} percent from a year ago.`,
            `Consumer prices have fallen about ${pctStr} percent compared to last year.`,
            `The cost of living is down roughly ${pctStr} percent from this time last year.`,
            `Overall consumer prices are running about ${pctStr} percent lower than a year ago.`,
          ];
      out.push({ kind: "cpi", text: pick(variants, _rng) });
    }
  }

  // 10. 30-year Mortgage Rate: milestone if > 15% or < 5% (4-6 variants)
  const mg = latest(S.mortgage, addDays(date, -1), 21);
  if (mg) {
    const rate = mg[1];
    if (rate > 15 || rate < 5) {
      const rStr = spokenRate(rate);
      const variants = [
        `A thirty-year mortgage will cost you about ${rStr} percent.`,
        `Home loan rates for a thirty-year fixed mortgage are running around ${rStr} percent.`,
        `If you are shopping for a home, thirty-year fixed mortgage rates stand at about ${rStr} percent.`,
        `Fixed rates on a thirty-year home mortgage are hovering near ${rStr} percent.`,
      ];
      out.push({ kind: "mortgage", text: pick(variants, _rng) });
    }
  }

  // 11. Unemployment: >= 10% change milestone from a year ago (4-6 variants)
  const unNow = monthValue(S.unemployment, published);
  const unAgo = monthValue(S.unemployment, addMonths(published, -12));
  if (unNow !== null && unAgo !== null && unAgo > 0) {
    const pct = (unNow - unAgo) / unAgo;
    if (Math.abs(pct) >= 0.10) {
      const unStr = spokenPercent(unNow, true);
      const mName = MONTHS[Number(published.slice(5)) - 1];
      const variants = [
        `Unemployment was ${unStr} percent in ${mName}.`,
        `The national unemployment rate stood at ${unStr} percent for ${mName}.`,
        `Government figures put national unemployment at ${unStr} percent in ${mName}.`,
        `Jobless figures for ${mName} came in at ${unStr} percent nationwide.`,
      ];
      out.push({ kind: "unemployment", text: pick(variants, _rng) });
    }
  }

  return out;
}

/** One line at random, preferring a statistic that was not used recently. Null if the data supports nothing. */
export function economyLine(p: PricesFile, date: string, rng: Rng = Math.random, recentKinds: string[] = []): EconomyLine | null {
  const all = economyLines(p, date, rng);
  if (!all.length) return null;
  const fresh = all.filter((l) => !recentKinds.includes(l.kind));
  return pick(fresh.length ? fresh : all, rng);
}

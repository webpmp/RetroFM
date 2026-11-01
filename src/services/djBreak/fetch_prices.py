# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx"]
# ///
"""Download everyday-life statistics (prices, wages, jobs, rates) from FRED for the DJ's cost-of-living lines.

  export FRED_API_KEY="your-free-key"
  uv run fetch_prices.py --out /Users/chris/Projects/RetroFM/public/data/prices.json

FRED (the St. Louis Fed's data site) republishes U.S. government data such as the Bureau of Labor Statistics' average
prices. A free key takes a minute: create an account at fred.stlouisfed.org, then My Account > API Keys.
The script prints, for each series, the dates it covers, so we know which years each statistic can be used for.
Nothing here is written by an AI: every number comes straight from the source.
"""
import argparse
import json
import logging
import os
import sys
from datetime import date

import httpx

logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx would otherwise print URLs that contain the API key

BASE = "https://api.stlouisfed.org/fred"
# label -> FRED series id. These are the series I expect to exist; the coverage table shows which really do.
SERIES = {
    "gasoline": "APU000074714",     # average price, unleaded regular gasoline, per gallon (monthly)
    "eggs": "APU0000708111",        # eggs, grade A large, per dozen (monthly)
    "milk": "APU0000709112",        # whole milk, per gallon (monthly)
    "bread": "APU0000702111",       # white bread, per pound (monthly)
    "coffee": "APU0000717311",      # ground coffee, per pound (monthly)
    "beef": "APU0000703112",        # ground beef, per pound (monthly)
    "minwage": "FEDMINNFRWG",       # federal minimum hourly wage
    "cpi": "CPIAUCSL",              # consumer price index, all items (monthly index; used to compute inflation)
    "unemployment": "UNRATE",       # unemployment rate, percent (monthly)
    "mortgage": "MORTGAGE30US",     # 30-year fixed mortgage rate, percent (weekly)
    "earnings": "AHETPI",           # average hourly earnings, private-industry production and nonsupervisory workers
}


def get(client: httpx.Client, path: str, key: str, **params) -> dict:
    r = client.get(f"{BASE}/{path}", params={"api_key": key, "file_type": "json", **params}, timeout=60)
    if r.status_code != 200:
        try:
            msg = r.json().get("error_message", "")
        except ValueError:
            msg = r.text[:120]
        raise RuntimeError(f"HTTP {r.status_code}: {msg}")
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/retrofm/prices.json"))
    args = ap.parse_args()
    key = os.environ.get("FRED_API_KEY")
    if not key:
        sys.exit("FRED_API_KEY is not set. Get a free key at fred.stlouisfed.org (My Account > API Keys), then:\n"
                 '  export FRED_API_KEY="your-key"')

    out: dict = {"fetched": date.today().isoformat(), "series": {}}
    rows = []
    with httpx.Client() as client:
        for label, sid in SERIES.items():
            try:
                info = get(client, "series", key, series_id=sid)["seriess"][0]
                obs = get(client, "series/observations", key, series_id=sid)["observations"]
                points = [[o["date"], float(o["value"])] for o in obs if o["value"] not in (".", "")]
                if not points:
                    raise RuntimeError("no data points")
                out["series"][label] = {"fred_id": sid, "title": info.get("title", ""), "units": info.get("units", ""),
                                        "frequency": info.get("frequency_short", ""), "start": points[0][0],
                                        "end": points[-1][0], "obs": points}
                rows.append((label, sid, points[0][0], points[-1][0], len(points), info.get("units", "")[:38], "ok"))
            except (RuntimeError, httpx.HTTPError, KeyError, IndexError, ValueError) as e:
                rows.append((label, sid, "-", "-", 0, "", f"FAILED: {e}"))
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"{'label':13} {'FRED id':14} {'first':11} {'last':11} {'points':>6}  units / status")
    for r in rows:
        print(f"{r[0]:13} {r[1]:14} {r[2]:11} {r[3]:11} {r[4]:>6}  {r[5] or r[6]}" + (f"  [{r[6]}]" if r[5] and r[6] != "ok" else ""))
    ok = sum(1 for r in rows if r[6] == "ok")
    print(f"\nSaved {ok} of {len(rows)} series to {args.out} ({os.path.getsize(args.out) / 1e3:.0f} KB).")


if __name__ == "__main__":
    main()

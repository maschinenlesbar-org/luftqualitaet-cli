---
name: luftqualitaet-annual-report
description: >
  Rank German monitoring stations by a pollutant's annual balance or its
  limit-value exceedances for a year, using the luftqualitaet-cli. Trigger when
  the user asks "which cities had the worst NO₂ in 2023?", "where did PM₁₀ exceed
  the limit last year?", "rank stations by ozone exceedances", "annual air-quality
  balance for Germany", or wants a yearly / nationwide / regional comparison. Joins
  the per-station annual rows to station names and locations and ranks them, instead
  of returning anonymous numeric rows.
version: 1.0.0
userInvocable: true
---

# Luftqualität Annual Balances & Exceedances

Answer the yearly, comparative questions — *where was a pollutant worst, and where
did it break the limit value* — by ranking the `annual-balances` /
`transgressions` rows and joining them to real station names and places.

## Tooling

This skill drives the `luftqualitaet` command. **Before anything else, validate it is available** — run `command -v luftqualitaet` (or `luftqualitaet --version`). If it is not on your PATH, STOP and inform the user that the `luftqualitaet` CLI (`@maschinenlesbar.org/luftqualitaet-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Always `--compact`. `--year` must be **≥ 2016** (the API has nothing earlier; the
CLI rejects lower years locally, exit `1`).

## Step 1 — Resolve the component id

Both commands need a numeric **component id**. Map names to ids with
`luftqualitaet components --lang en` — the common ones:
`1=PM₁₀, 3=O₃ (ozone), 4=SO₂, 5=NO₂, 9=PM₂.₅`. NO₂ (`5`) and PM₁₀ (`1`) are the
usual "limit exceedance" questions; O₃ (`3`) for summer-ozone.

## Step 2 — Fetch the annual data

**Annual balance** — the per-station yearly figure for one pollutant:

```bash
luftqualitaet --compact annual-balances --component 1 --year 2023 --lang en
```

`.data` is an **array of 4-element rows**, `["<station id>", "<value>", "<index>",
"<index2>"]` — station id first, then the annual figure (e.g. the annual mean in
the component's unit), then two AQ-index-band columns. **Trap:** the response also
carries an `indices` array (`["station id","component id","year","value",…]`) with
*five* labels that **do not line up** with the four-element rows — ignore it and use
the positional layout above (value is at index **1**, verified live: Essen
Gladbecker Straße ≈ 23 µg/m³ PM₁₀ for 2023).

**Transgressions** — how often the limit value was exceeded, per station:

```bash
luftqualitaet --compact transgressions --component 5 --year 2022 --lang en
```

Here `.data` is an array of rows and there **is** an `indices` array describing
them: `["station id", "day_first", "day_recent", "value of year", "4-16 values of
months"]`. Column `[3]` ("value of year") is the **total exceedance count for the
year** — that's the number to rank on; `[4..]` are the monthly breakdown. List
exceedance *types* with `luftqualitaet transgression-types --lang en`.

Both default to `--index id` (rows keyed/led by numeric station id). Most stations
report `0` exceedances — that is the normal, healthy case, not missing data.

## Step 3 — Join to station identities

The rows carry only a **station id**, never a name. Pull the station catalogue once
and join on it:

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

`.stations` is keyed by station id; from each row take idx 2 (full name), idx 3
(city), idx 16 (type: traffic/background), idx 12/13 (federal state),
idx 8 = latitude, idx 7 = longitude. (See **luftqualitaet-station-finder** for the
full positional layout and the lon-before-lat trap.) An unmatched id just means the
station isn't in the active catalogue — keep the row, label it by id.

## Step 4 — Rank and report

Sort descending by the figure that answers the question — annual `value` for
balances, the yearly exceedance count (`[3]`) for transgressions — and report the
top N with names and places:

```
Worst NO₂ exceedances, 2022 (component 5) — top 5 of 412 stations
  1. 42 days  Stuttgart Am Neckartor   traffic   · BW   (48.79, 9.21)
  2. 31 days  München Landshuter Allee traffic   · BY
  3. …
Most stations (≈390) recorded 0 exceedances.
```

Rules:
- Lead with the metric and year; show **how many stations** were in the set and how
  many were at/above the limit (count of rows with exceedances > 0).
- Rank by the right column — annual mean `value` for balances, exceedance **count**
  (`[3]`) for transgressions — and **don't confuse the two**.
- Always show the **station type** (idx 16): traffic stations dominate NO₂ rankings
  by design; calling that out is the insight.
- Filter to a region when asked (idx 12 network code / idx 13 state name).
- Give lat/lon or a map link when a few stations are highlighted.
- Mention that 0 is the common, good result — a ranking of mostly-zeros means the
  pollutant was largely within limits that year.
- For multi-year trends, repeat per year and compare the top values; don't
  interpolate years you didn't fetch.

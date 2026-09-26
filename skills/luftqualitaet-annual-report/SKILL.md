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
compatibility: >
  Requires the `luftqualitaet` CLI (npm package
  @maschinenlesbar.org/luftqualitaet-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  luftdaten.umweltbundesamt.de.
---

# Luftqualität Annual Balances & Exceedances

Answer the yearly, comparative questions — *where was a pollutant worst, and where
did it break the limit value* — by ranking the `annual-balances` /
`transgressions` rows and joining them to real station names and places.

## Tooling

This skill drives the `luftqualitaet` command. **Before anything else, validate it is available** — run `command -v luftqualitaet` (or `luftqualitaet --version`). If it is not on your PATH, STOP and inform the user that the `luftqualitaet` CLI (`@maschinenlesbar.org/luftqualitaet-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Always `--compact`. `--year` must be **≥ 2016** (the API has nothing earlier; the
CLI rejects lower years locally, exit `1`). **`transgressions` is complete only from
2019:** for 2016–2018 some components (NO₂, PM₁₀) fail with HTTP `500` (exit `1`, with
a `Hint:` line) — tell the user that year has no exceedance data upstream, and offer
`annual-balances` for it (its PM₁₀/NO₂ columns include the exceedance counts).

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

`.data` is an array of rows `["<station id>", <column 1>, <column 2>, …]`, all
values strings (or `null` where a station has no figure). **The columns depend on the
component, and sometimes the year** — the response's `.headers` object names them,
keyed by row position. Examples (live, 2026-09-15):

| component | columns (`.headers`) |
|---|---|
| NO₂ `5` | `1` annual mean µg/m³, `2` hourly means above 200 µg/m³ |
| PM₁₀ `1` | `1` annual mean µg/m³, `2` daily means above 50 µg/m³ (2023 adds `3`, the same with road-salt discount) |
| PM₂.₅ `9` | `1` annual mean µg/m³ only |
| O₃ `3` | `1` hours above 240, `2` hours above 180, `3` days with 8-h max above 120, `4` its 3-year average, `5`/`6` AOT40 — **no annual mean** |

So read `.headers` first and pick the column that answers the question; don't assume
column `1` is an annual mean (for O₃ it's a count of hours above 240 µg/m³). Ranking
on a chosen column (`col`), skipping `null`s:

```bash
luftqualitaet --compact annual-balances --component 3 --year 2025 --lang en \
  | jq -r --argjson col 3 '"ranking on: \(.headers[$col|tostring])",
      (.data | map(select(.[$col] != null)) | sort_by(.[$col] | tonumber) | reverse | .[:10][]
       | [.[0], .[$col]] | @tsv)'
```

**Trap:** the response also carries an `indices` array (`["station id","component
id","year","value","transgression type id"]`) that **does not describe** the rows —
ignore it and use `.headers`.

**Transgressions** — how often the limit value was exceeded, per station:

```bash
luftqualitaet --compact transgressions --component 5 --year 2022 --lang en
```

Here `.data` is an array of rows and there **is** an `indices` array describing
them: `["station id", "day_first", "day_recent", "value of year", "4-16 values of
months"]`. Column `[3]` ("value of year") is the **total exceedance count for the
year** — that's the number to rank on; `[4..]` are the monthly breakdown (January
first; some rows are shorter because trailing months are left out).

- **What `[3]` counts is in `.headers`**, a single entry keyed `"3"` — e.g. NO₂
  `"Number of hourly values above 200 µg/m³"` (hours), PM₁₀ `"Number of daily mean
  values above 50 µg/m³"` (days), O₃ `"Number of days with highest daily 8-hour
  averages above 120 µg/m³"` (days). Use that text for the label and the unit
  (hours vs days). Don't label from `transgression-types`: upstream that
  list mixes real names with bare numbers (`"23":"1"`, `"26":"18480"`) and
  mis-encoded German (`"Jahresmittelwert in ng/mÂ³"`).
- **The year may not be complete.** `day_recent` is the last day covered. As of
  2026-09-15, 283 of 286 O₃ stations for 2025 end at `2025-11-30` — December is
  missing — and some stations end months earlier. Report the period you ranked.

```bash
luftqualitaet --compact transgressions --component 3 --year 2025 --lang en \
  | jq -r '(.data | map(.[2]) | max) as $end
           | "counts: \(.headers | to_entries[0].value)",
             "data up to: \($end) (\(.data | map(select(.[2] < $end)) | length) stations end earlier)",
             (.data | sort_by(.[3] | tonumber) | reverse | .[:10][] | [.[0], .[3], .[2]] | @tsv)'
```

Both default to `--index id` (rows keyed/led by numeric station id). `0` exceedances
is a real, healthy result, not missing data. How common it is depends on the
pollutant: for NO₂ 2025 all but one of 410 stations had `0`, while for PM₁₀ 2024 and
O₃ 2025 most stations had at least one. A count above zero is not by itself a breach —
the EU limits allow some exceedances per year (18 hours for NO₂ above 200 µg/m³, 35 days
for PM₁₀ above 50 µg/m³; the O₃ target value allows 25 days as a 3-year average).

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

Sort descending by the figure that answers the question — the chosen `.headers` column for
balances, the yearly exceedance count (`[3]`) for transgressions — and report the
top N with names and places:

```
Most PM₁₀ exceedance days (daily mean above 50 µg/m³), 2024 (component 1)
— top 5 of 379 stations, data to 2024-12-31
  1. 17 days  Halle/Paracelsusstr.         traffic · ST  (51.4948, 11.9813)
  2. 10 days  Berlin Silbersteinstraße 5   traffic · BE
  2. 10 days  Wittenberg/Dessauer Strasse  traffic · ST
  2. 10 days  Leipzig Lützner Str.         traffic · SN
  2. 10 days  Berlin Frankfurter Allee     traffic · BE
230 of 379 stations recorded at least one exceedance day.
```

Rules:
- Lead with the metric (the `.headers` text, with its unit — hours or days) and year,
  plus the period covered (`day_recent`) if the year isn't complete; show **how many
  stations** were in the set and how many were at/above the limit (count of rows with
  exceedances > 0).
- Rank by the right column — the `.headers` column you chose for balances, exceedance
  **count** (`[3]`) for transgressions — and **don't confuse the two**.
- Always show the **station type** (idx 16): traffic stations dominate NO₂ rankings
  by design; calling that out is the insight.
- Filter to a region when asked (idx 12 network code / idx 13 state name).
- Give lat/lon or a map link when a few stations are highlighted.
- Mention that 0 is the good result — a ranking of mostly-zeros means the pollutant
  was largely within limits that year; for a ranking with many non-zero counts, say how
  many stations went past the allowed number of exceedances, not just above zero.
- For multi-year trends, repeat per year and compare the top values; don't
  interpolate years you didn't fetch.

---
name: luftqualitaet-air-report
description: >
  Produce a human-readable air-quality briefing for a German monitoring station
  over a time window, using the luftqualitaet-cli. Trigger when the user asks
  "what's the air quality in Berlin right now?", "how was the air at station 143
  yesterday?", "is the ozone high in Munich?", "give me today's air-quality index
  for Stuttgart", or wants pollutant levels / the AQ index for a place. Fetches
  the index series, decodes the 0–5 index levels into words, names the driving
  pollutant per hour, and summarises — instead of the raw nested arrays the CLI
  returns.
version: 1.0.0
userInvocable: true
---

# Luftqualität Air-Quality Report

Turn the `airquality` endpoint's deeply-nested arrays into a plain briefing: the
overall index over the window, **which pollutant drove it**, and the actual
concentrations — decoded into the official German air-quality wording.

## Tooling

This skill drives the `luftqualitaet` command. **Before anything else, validate it is available** — run `command -v luftqualitaet` (or `luftqualitaet --version`). If it is not on your PATH, STOP and inform the user that the `luftqualitaet` CLI (`@maschinenlesbar.org/luftqualitaet-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Always `--compact`. A window with no data returns `"data": {}` (exit `0`) — that's
"no measurements for that window", not an error.

## Step 1 — Resolve the station id

The user almost always names a place, not an id. If you don't already have the
numeric station id, resolve it first via the **luftqualitaet-station-finder** skill
(it reads the station list out of `meta --use measure`). Validate before querying:
an unknown station id makes the API return **HTTP 409** (the CLI exits `1`, **not**
the `4`/"not found" you'd expect).

## Step 2 — Pick a window that has data

Hours are **hour-ending, 1..24** (not 0..23): `1` = the hour ending 01:00, `24`
ends at midnight. The window is `--date-from/--time-from … --date-to/--time-to`,
ordered start-before-end (the CLI rejects a reversed window locally, exit `1`).

- "right now / today" → use today's (or yesterday's, if today is sparse) date with
  `--time-from 1 --time-to 24`. Current data exists and updates hourly.
- If a window comes back empty (`"data": {}`), widen it or step back a day rather
  than reporting "no air quality"; `airquality-limits` shows each station's
  available range (slow — `--timeout 90000`).

```bash
luftqualitaet --compact airquality \
  --station 143 \
  --date-from 2024-01-01 --time-from 1 \
  --date-to 2024-01-01 --time-to 24
```

## Step 3 — Decode the response (this is the whole job)

The payload is `.data.<stationId>.<"YYYY-MM-DD HH:MM:SS">` → an array per hour.
The layout is **positional** (the self-describing `indices` block confirms it):

```
[ "<end timestamp>",          // [0] hour-ending time
  <total index>,              // [1] overall AQ index for the hour, 0..5
  <incomplete flag>,          // [2] 1 = data incomplete that hour
  [<comp id>, <value>, <comp index>, "<y>"],   // [3..] one sub-array per pollutant
  …
]
```

Each pollutant sub-array is `[component-id, measured value, that pollutant's index
(0..5), y-value]`. The **overall index `[1]` is the worst of the per-pollutant
indices** — so the pollutant whose sub-array index equals `[1]` is the **driving
pollutant** for that hour. Map component ids with
`luftqualitaet components --lang en` (`1=PM₁₀, 2=CO, 3=O₃, 4=SO₂, 5=NO₂, 9=PM₂.₅`).

**Index level → words** (UBA's official 0–5 air-quality scale):

| index | label |
|---|---|
| 0 | very good (sehr gut) |
| 1 | good (gut) |
| 2 | moderate (mäßig) |
| 3 | poor (schlecht) |
| 4 | very poor (sehr schlecht) |
| 5 | extremely poor (außerordentlich schlecht) |

> **Don't average the index numerically** — it's an ordinal worst-case scale, not
> a quantity. Report the worst level reached and how many hours sat at each level.
> The `value` is the real concentration in the component's unit (µg/m³, mg/m³,
> ng/m³ — from `components`); cite it with the unit.

Optional enrichment: `luftqualitaet thresholds --use airquality --component <id>`
returns the concentration bands (`[…, min, max, index]`) behind each level — use
it to say "NO₂ 95 µg/m³ sits in the 61–120 band = level 1".

## Step 4 — Brief the user

Lead with the verdict, then the detail a person acts on:

```
Air quality — Berlin Grunewald (station 143), 1 Jan 2024
  Overall: mostly GOOD, peaking at MODERATE 14:00–17:00.
  Driving pollutant: O₃ (ozone) in the afternoon; PM₁₀ steady ~18 µg/m³.
  Worst hour: 16:00 — index 2 (moderate), O₃ 121 µg/m³.
  21/24 h good or better; 3 h moderate; 0 h poor.
```

Rules:
- Lead with the **worst level reached** and when, then the typical level.
- Name the **driving pollutant** (the one whose per-pollutant index sets the
  overall index), with its concentration + unit.
- Flag hours where `[2]` (incomplete) is `1` — the reading is partial.
- For a single hour ("right now"), give that hour's level, driver and value; for a
  day/range, summarise the distribution across levels — never dump 24 raw arrays.
- If `"data": {}`, say the window has no data and suggest a nearby one; don't imply
  the air was clean.

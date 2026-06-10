---
name: luftqualitaet-station-finder
description: >
  Resolve a place, city, region, or station classification to the numeric
  Umweltbundesamt air-quality station id(s) you need for every other query,
  using the luftqualitaet-cli. Trigger when the user asks "which station covers
  Berlin?", "find the air-quality station near Munich", "list traffic stations
  in NRW", "what's the station id for Stuttgart Neckartor", "show rural
  background stations", or any time a measurement/index request names a place
  rather than an id. Returns matching stations with id, name, city, type,
  setting, network and coordinates.
version: 1.0.0
userInvocable: true
---

# Luftqualität Station Finder

Every data command in this CLI (`airquality`, `measures`, `airquality-limits`)
addresses a station by **numeric id** the user never knows — they say "Berlin" or
"a traffic station near the A8". This skill turns a place / region / classification
into the right station id(s), with the metadata to pick between them.

## Tooling

This skill drives the `luftqualitaet` command. **Before anything else, validate it is available** — run `command -v luftqualitaet` (or `luftqualitaet --version`). If it is not on your PATH, STOP and inform the user that the `luftqualitaet` CLI (`@maschinenlesbar.org/luftqualitaet-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Pass `--compact` so the (large) JSON is one line, easy to pipe into `jq`. The
station list lives inside `meta` and is ~500 stations — bump `--timeout 60000`,
it can be slow.

## Step 1 — Pull the station catalogue

The full station list (with coordinates) is **only** in the `meta` bundle, under
`use=measure` (or `transgression` / `annualbalance`). It is **not** in
`use=map` (that one carries only components/scopes/xref) and **not** in any
reference command.

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

The stations are in `.stations`, an **object keyed by station id**. Each value is
a flat array — there is **no `indices` key inside `.stations`**, so memorise the
positional layout (0-based):

| idx | field | idx | field |
|---|---|---|---|
| 0 | station id | 10 | station-setting id |
| 1 | station code (e.g. `DEBE032`) | 11 | station-type id |
| 2 | full name | 12 | network code (`BE`, `BY`…) |
| 3 | city / town | 13 | network name (federal state) |
| 4 | synonym (often `""`) | 14 | setting name (`urban area`…) |
| 5 | active-from date | 15 | setting short (`urban`/`rural`…) |
| 6 | active-to date (**`null` ⇒ still active**) | 16 | type name (`background`/`traffic`/`industry`) |
| 7 | **longitude** (string) | 17 | street |
| 8 | **latitude** (string) | 18 | (usually blank) |
| 9 | network id | 19 | postcode |

> **Coordinate order trap:** index **7 is longitude, 8 is latitude** (lon comes
> first). They are strings — `Number()` them. A station with `active-to` (idx 6)
> set to a past date is **decommissioned** — prefer ones where idx 6 is `null`
> unless the user wants historical data.

## Step 2 — Filter to the request

Filter the `.stations` values by what the user asked for:

- **By place / city:** match the user's town against idx 3 (city) or idx 2 (full
  name), case-insensitively and on substrings — "Stuttgart Neckartor" lives in
  idx 2, "Berlin" in idx 3. A city often has several stations.
- **By federal state / region:** match idx 12 (network code like `NW`, `BY`) or
  idx 13 (state name). Resolve a state name to its code with
  `luftqualitaet networks --lang en` if unsure (it returns `data` keyed by id,
  rows `[id, code, name]`).
- **By station type:** "traffic", "background", "industrial" → idx 16. Canonical
  values come from `luftqualitaet station-types --lang en`
  (`1=background, 2=industry, 3=traffic`).
- **By setting:** "urban", "suburban", "rural" → idx 15 (short) / idx 14.
  Canonical values: `luftqualitaet station-settings --lang en`.
- **Nearest to a coordinate / address:** if the user gives a lat/lon (or you can
  get one for a place), compute distance from idx 7/8 to that point and return the
  closest few. Don't fabricate coordinates — if you can't get them cheaply, fall
  back to a city-name match and say so.

## Step 3 — Present the matches

Return a short ranked list, **leading with the station id** (it's the payload the
user needs next), then enough to disambiguate:

```
Stations matching "Berlin" (active):
  143  Berlin Grunewald (3.5 m)   background · rural near town · BE   52.4732, 13.2251
  174  Berlin Mitte               traffic    · urban             · BE   52.5126, 13.4109
  …
```

Rules:
- Lead each line with the **id**; that is the answer.
- Show name, **type** (idx 16) and **setting** (idx 15) — a "traffic" vs
  "background" station reads very differently for the same city.
- Show **lat, lon** (idx 8, idx 7 — display lat first for humans / map links:
  `https://www.google.com/maps?q=<lat>,<lon>`).
- Exclude decommissioned stations (idx 6 non-null) unless asked; if you drop any,
  say how many.
- If the city has many stations, summarise the count and list the most relevant
  (e.g. by type the user implied), don't dump all of them.
- Hand off: "to get the current air-quality index for station 143, use the
  **luftqualitaet-air-report** skill" — don't fetch measurements here unless asked.

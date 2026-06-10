# luftqualitaet-cli

[![CI](https://github.com/maschinenlesbar-org/luftqualitaet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/luftqualitaet-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/luftqualitaet-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/luftqualitaet-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/luftqualitaet-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/luftqualitaet-cli)

Query Germany's official **air-quality data** — measurements, indices, annual
balances and exceedances — straight from your terminal. `luftqualitaet` is a
command-line tool over the open
[Umweltbundesamt Air Data API](https://www.umweltbundesamt.de/api/air_data/v3):
look up pollutants and stations, fetch hourly or daily measurements, inspect
exceedances, and get the full picture — as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and go.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **14 commands** covering reference lists, measurements, annual balances, exceedances, thresholds and metadata.
- **Validates locally** — bad dates, reversed windows, out-of-range hours and years are caught before any request is sent.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/luftqualitaet-cli
```

This installs the **`luftqualitaet`** command. Requires **Node.js 20+**.

Check it works:

```bash
luftqualitaet --help
```

## Quickstart

No setup needed — the API is public and open, no key required. Start with the
reference lists to find the ids you'll need:

```bash
luftqualitaet components --lang en --index code
```

This returns a map of all measured pollutants keyed by their short code. Pull
out just the ids with `jq`:

```bash
luftqualitaet components --lang en | jq '.data | to_entries[] | {id: .key, name: .value[1]}'
```

Then fetch the air-quality index for a station over a day:

```bash
luftqualitaet airquality \
  --station 143 \
  --date-from 2024-01-01 --time-from 1 \
  --date-to 2024-01-01 --time-to 24
```

## Commands

### Reference lists — look up ids

These commands need no required arguments (just optional `--lang` and `--index`):

| Command | What it returns |
| --- | --- |
| `components` | Measured pollutants (PM₁₀, NO₂, O₃, …) with ids, codes and units |
| `networks` | Measurement networks (*Messnetze*) |
| `scopes` | Measurement scopes — averaging/aggregation definitions |
| `station-types` | Station-type classifications (background, traffic, industrial, …) |
| `station-settings` | Station-setting classifications (urban, suburban, rural, …) |
| `transgression-types` | Catalogue of exceedance types |

Flags for reference commands:

| Flag | Meaning |
| --- | --- |
| `--lang de\|en` | Label language (default varies by endpoint) |
| `--index id\|code` | Key the response map by numeric id or short code (where supported) |

### Data commands — measurements and aggregations

**`airquality`** — air-quality index for a station over a time window.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--station <id>` | yes | station id (positive integer) |
| `--date-from <YYYY-MM-DD>` | yes | window start date |
| `--time-from <1-24>` | yes | window start hour (hour-ending, 1..24) |
| `--date-to <YYYY-MM-DD>` | yes | window end date |
| `--time-to <1-24>` | yes | window end hour |

**`airquality-limits`** — available date range per station for air-quality data.
Takes no options.

**`measures`** — raw measurement data for a station over a time window.

Same window + station flags as `airquality`, plus:

| Flag | Required | Meaning |
| --- | --- | --- |
| `--component <id>` | no | narrow to one pollutant |
| `--scope <id>` | no | narrow to one averaging scope |

**`measures-limits`** — available date range per scope/component/station.
Takes no options.

**`annual-balances`** — annual tabulations for a component and year.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--component <id>` | yes | component id |
| `--year <YYYY>` | yes | year (>= 2016) |
| `--lang de\|en` | no | label language |
| `--index id\|code` | no | response key |

**`transgressions`** — exceedance data for a component and year.
Same flags as `annual-balances`.

**`thresholds`** — limit/threshold values for a given use case.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--use airquality\|measure` | yes | which threshold set |
| `--lang de\|en` | no | label language |
| `--component <id>` | no | narrow to one component |
| `--scope <id>` | no | narrow to one scope |

**`meta`** — combined metadata bundle (components, scopes, stations, networks,
…) for building other queries.

| Flag | Required | Meaning |
| --- | --- | --- |
| `--use measure\|airquality\|transgression\|annualbalance\|map` | yes | which bundle |
| `--lang de\|en` | no | label language |
| `--date-from`, `--date-to` | when `--use airquality` | time window (required for that use) |
| `--time-from`, `--time-to` | no | hour bounds within window |

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# What ids do the pollutants have?
luftqualitaet components --lang en --index code

# Which averaging scopes exist? (daily = 1, hourly = 2, 8h-max = 5, …)
luftqualitaet scopes --lang en

# Air-quality index for station 143 over a full day
luftqualitaet airquality \
  --station 143 \
  --date-from 2024-01-01 --time-from 1 \
  --date-to 2024-01-01 --time-to 24

# PM₁₀ (component 1) daily-average measurements, station 143
luftqualitaet measures \
  --station 143 --component 1 --scope 1 \
  --date-from 2024-06-01 --time-from 1 \
  --date-to 2024-06-01 --time-to 24

# Annual PM₁₀ balance for 2023
luftqualitaet annual-balances --component 1 --year 2023 --lang de

# NO₂ exceedances in 2022
luftqualitaet transgressions --component 5 --year 2022 --lang en

# Lookup tables for building a measurement query
luftqualitaet meta --use measure --lang de | jq 'keys'
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

UBA responses are **index + data** structures: an `indices` array names the
columns and the payload is a compact map keyed by id/code/timestamp. Most
recipes involve indexing into `.data`:

```bash
# How many stations have air-quality limits data?
luftqualitaet airquality-limits | jq '.data | keys | length'

# Pull the component name + unit for every pollutant
luftqualitaet components --lang en | jq '.data | to_entries[] | {id: .key, name: .value[1]}'

# Annual balances as compact JSON for further piping
luftqualitaet --compact annual-balances --component 1 --year 2023 | jq '.data'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
luftqualitaet --compact measures-limits | jq '.data[] | select(.[0]=="1")' | head
```

`--compact` (and every global option) works **before or after** the command —
both `luftqualitaet --compact components` and `luftqualitaet components --compact`
do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `4` | resource not found (`404` from the API) |
| `1` | any other error (network failure, bad JSON, validation error) |
| non-zero | usage / argument error (bad flag, missing required option) |

## Troubleshooting

- **`command not found: luftqualitaet`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/luftqualitaet-cli …`.
- **Exit `4` / "not found"** — the API returned a `404`. The station or component
  id may not exist, or the requested year/window is out of the available range.
  Use `airquality-limits` or `measures-limits` to discover what data is actually
  available.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`.
- **Empty `.data`** — the query matched nothing or the window has no data; use the
  `-limits` commands to find a window that has data for that station/component.
- **Reversed window error** — `--date-from`/`--time-from` must come before
  `--date-to`/`--time-to`; the CLI checks this locally before sending any request.
- **Year rejected** — `--year` must be `>= 2016`; the API does not carry data
  before that.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://www.umweltbundesamt.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI for you.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every command, flag and domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.

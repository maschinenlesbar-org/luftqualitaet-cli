# Usage

Real, use-case-driven examples for the `luftqualitaet` CLI — a client for the open
[Umweltbundesamt Air Data API](https://www.umweltbundesamt.de/api/air_data/v3)
(air-quality indices, raw measurements, annual balances, exceedances, and the
station/component metadata behind them).

## Install

```bash
npm i -g @maschinenlesbar.org/luftqualitaet-cli
```

The installed binary is **`luftqualitaet`**. All examples below assume it is on your
`PATH`. (If you are running from a checkout instead, replace `luftqualitaet` with
`node dist/src/cli/index.js`.)

Every command prints JSON to stdout, so it pipes cleanly into [`jq`](https://jqlang.github.io/jq/).
Use the global `--compact` flag to emit single-line JSON.

## Use cases

### 1. Look up component ids (which pollutant is which?)

Every measurement query needs a numeric component id. List them first so you know
that `1` is PM₁₀, `5` is NO₂, `3` is O₃, and so on.

```bash
luftqualitaet components --lang en --index code
```

`--index code` keys the result by component code (e.g. `PM10`, `NO2`) instead of by
id. Drop `--index` for the default id-keyed map. Use `--lang de` for German names.

### 2. Look up scope ids (which averaging definition?)

`measures` and `thresholds` take an optional scope id (the averaging/aggregation
definition — daily average, hourly average, 8-hour max, ...). List them to pick one.

```bash
luftqualitaet scopes --lang en
```

Typical scopes: `1` = daily average (`1TMW`), `2` = one-hour average (`1SMW`),
`5` = maximum eight-hour average (`8SMW_MAX`).

### 3. Get the air-quality index for a station over a day

Fetch the computed air-quality index for one station across an hour-ending time
window. Hours run `1`–`24`, where `24` is the hour ending at midnight.

```bash
luftqualitaet airquality \
  --station 143 \
  --date-from 2024-01-01 --time-from 1 \
  --date-to 2024-01-01 --time-to 24
```

All four window flags (`--date-from`, `--time-from`, `--date-to`, `--time-to`) plus
`--station` are required.

### 4. Discover which time windows a station actually has data for

Before requesting a window, check the available date range per station for
air-quality data so you do not ask for gaps.

```bash
luftqualitaet airquality-limits | jq '.data | keys | length'
```

This command takes no options. The response wraps the per-station limits map under
`.data` (alongside `request` and `indices` metadata), so index into `.data` to
count or inspect the stations.

### 5. Fetch raw measurements for a station + component + window

Get the underlying measured values (not the index) for a single station, narrowed
to one component and one scope over an hour-ending window. Example: PM₁₀
(component `1`) as a daily average (scope `1`) for one day.

```bash
luftqualitaet measures \
  --station 143 --component 1 --scope 1 \
  --date-from 2024-06-01 --time-from 1 \
  --date-to 2024-06-01 --time-to 24
```

`--component` and `--scope` are optional narrowing filters; the window flags and
`--station` define the query.

### 6. Find the valid date range for a measurement series

`measures-limits` reports the available date range per scope/component/station —
useful for picking a window that returns data.

```bash
luftqualitaet measures-limits --compact | jq '.data[] | select(.[0]=="1")' | head
```

`--compact` keeps the (large) payload on one line for easier streaming into `jq`.

### 7. Read the annual balance for a pollutant

Annual tabulations (*Jahresbilanzen*) summarise a component over a full year.
Example: the PM₁₀ (component `1`) balance for 2023, in German.

```bash
luftqualitaet annual-balances --component 1 --year 2023 --lang de
```

`--year` must be `>= 2016`. Use `--index code` to key the output by code, and
`--lang en` for English labels.

### 8. List exceedances for a pollutant and year

Where did NO₂ (component `5`) exceed its limits in 2022? `transgressions` returns
the recorded exceedances per component and year.

```bash
luftqualitaet transgressions --component 5 --year 2022 --lang en
```

Same constraints as annual balances: `--year >= 2016`, plus optional `--lang` and
`--index`.

### 9. Inspect the thresholds behind the air-quality index

See the threshold values used for a given use case. For air-quality index
thresholds of ozone (component `3`):

```bash
luftqualitaet thresholds --use airquality --component 3 --lang en
```

`--use` is `airquality` or `measure`. `--component` and `--scope` further narrow
the result.

### 10. Pull combined metadata to build a measurement query

`meta` returns components, scopes, networks, stations, etc. in one call — the
lookup tables you need to assemble `measures` / `airquality` queries. Then slice it
with `jq`.

```bash
# Everything needed for measurement queries (German labels)
luftqualitaet meta --use measure --lang de | jq 'keys'

# Air-quality metadata requires a window
luftqualitaet meta --use airquality \
  --date-from 2024-01-01 --date-to 2024-01-01 \
  --time-from 1 --time-to 24
```

`--use` accepts `measure`, `airquality`, `transgression`, `annualbalance`, or
`map`. When `--use airquality`, `--date-from` and `--date-to` are required (the
`--time-from` / `--time-to` window flags are also accepted).

## Global options

These flags apply to every command and go before the subcommand:

| Flag | Purpose |
| --- | --- |
| `-V, --version` | Print the CLI version. |
| `--base-url <url>` | Override the API base URL (default `https://www.umweltbundesamt.de`). |
| `--timeout <ms>` | Per-request timeout in milliseconds. |
| `--user-agent <ua>` | Set the `User-Agent` header. |
| `--max-retries <n>` | Retries for transient `429`/`503` responses. |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB). |
| `--compact` | Print JSON on a single line instead of pretty-printed. |
| `-h, --help` | Show help for the CLI or for any `<command> --help`. |

Example combining a global flag with a command:

```bash
luftqualitaet --compact components --lang de
```

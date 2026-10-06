# Glossary

A reference for the domain concepts and project-specific terms used throughout
`luftqualitaet-cli`. The underlying API is German (Umweltbundesamt); this
glossary gives the term used in the CLI/client alongside the original German
where one exists.

> **Translation table** (from the API). The CLI follows these:
>
> | German | English / API term |
> | --- | --- |
> | Luftqualität | air quality |
> | Komponente / Schadstoff | component / pollutant |
> | Messnetz | network |
> | Messumfang / Scope | scope |
> | Station / Messstation | station |
> | Stationstyp | station type |
> | Stationseinstellung | station setting |
> | Überschreitung | transgression / exceedance |
> | Jahresbilanz | annual balance |
> | Grenzwert / Schwellenwert | threshold |
> | Messwert | measure / measurement |
> | Stundenwert | hourly value |

---

## The data source

**Umweltbundesamt (UBA).** The German Federal Environment Agency
(`umweltbundesamt.de`). It collects and publishes the official German air-quality
data this tool wraps.

**Air Data API.** The UBA's open, key-free REST API for air-quality data. This
client targets the live API path `/api/air-data/v3` on
`https://luftdaten.umweltbundesamt.de` (the default base URL; the older address
`https://www.umweltbundesamt.de/api/air_data/v3` answers with a permanent redirect
there). `--base-url` (the client's `baseUrl`) takes the host only — the client adds the
API path, and refuses a base URL that already ends in it. It supersedes the **v2**
OpenAPI spec published at
[luftqualitaet.api.bund.dev](https://luftqualitaet.api.bund.dev/).

**Index + data structure.** The shape of most API responses: an `indices` array
names the columns (the row layout), and the payload is a compact map keyed by
id/code/timestamp rather than an array of labelled objects. The client returns
these payloads faithfully as raw JSON (`JsonObject` / `AirDataResult`) rather
than guessing a strict per-endpoint type, because the layout varies by endpoint
and parameters.

---

## Resources / endpoints

The client surfaces two kinds of endpoint: **data** endpoints (measurements and
aggregations for a station/window or component/year) and **reference** endpoints
(the lookup lists that give meaning to the numeric ids).

**airquality (`/airquality/json`).** Air-quality index data for one station over
a time window. The index has five levels, `0` (very good) to `4` (very poor). CLI:
`airquality`.

**airquality-limits (`/airquality/limits`).** The available date range per
station for air-quality data — use it to discover what windows you can request.
CLI: `airquality-limits`.

**measures (`/measures/json`).** Raw measurement data for a station over a
window, for one component and one scope: the response holds one series (one value
per hour), so without `component`/`scope` the API picks one rather than returning
all. The client (and so the CLI) requires both. An id the station doesn't measure gives `"data": {}`.
CLI: `measures`.

**measures-limits (`/measures/limits`).** The available date range per
scope/component/station for measurements. CLI: `measures-limits`.

**annual-balances (`/annualbalances/json`).** Annual tabulations
(*Jahresbilanzen*) for a component and a given year (`>= 2016`). Each row is a
station id followed by figures whose number and meaning depend on the component
(for O₃ there is no annual mean); the response's `headers` object names them by
row position, and its `indices` array does not match the rows. UBA evaluates them from
the **final**, checked data ("auf Basis der endgültigen Daten"), published in June of the
following year; until then the year has no rows. This is the authoritative yearly
exceedance count, and it agrees with the stations' own daily means. CLI:
`annual-balances`.

**transgressions (`/transgressions/json`).** Exceedance (*Überschreitungen*)
data for a component and year — how often a limit value was exceeded. The
response's `headers` object says what the yearly count measures (hours or days
above which value); `day_recent` shows how far the year's data reaches. UBA offers these
tables for the **running year** ("für das laufende Jahr"), built from preliminary data; a
completed year's table is not brought up to the final data, so its yearly count differs
from `annual-balances` at 10–35 % of PM₁₀ stations in 2019–2025, in both directions
(Halle/Paracelsusstr., PM₁₀ 2024: 17 days here, 8 in the annual balance and in the
station's daily means). Use it for the running year and its monthly breakdown; for a
completed year rank on `annual-balances`. CLI: `transgressions` (with a `Note:` on stderr
for a completed year).

**thresholds (`/thresholds/json`).** The limit/threshold values for a given
`use` (`airquality` or `measure`), optionally per component and scope. CLI:
`thresholds`.

**meta (`/meta/json`).** Combined metadata for a `use` — bundles components,
scopes, networks, stations, etc. needed to build other queries. CLI: `meta`.

### Reference lists

**components (`/components/json`).** The measured **components** (pollutants):
e.g. PM10, NO₂, O₃, SO₂, CO. CLI: `components`. Each row carries an id, a code
and the unit of measurement.

**networks (`/networks/json`).** The measurement **networks** (*Messnetze*) — the
federal-state and federal monitoring networks that operate the stations. CLI:
`networks`.

**scopes (`/scopes/json`).** The measurement **scopes** (*Messumfänge*) — the
aggregation/averaging definition of a measurement (e.g. hourly average,
24-hour average, the averaging time + the component it applies to). CLI:
`scopes`.

**station-types (`/stationtypes/json`).** The station-type classification (e.g.
background, traffic, industrial). CLI: `station-types`.

**station-settings (`/stationsettings/json`).** The station-setting
classification describing a station's surroundings (e.g. urban, suburban,
rural). CLI: `station-settings`.

**transgression-types (`/transgressiontypes/json`).** The catalogue of
exceedance types referenced by the transgressions data. CLI:
`transgression-types`.

---

## Key identifiers & query parameters

**station.** The numeric **station id** identifying a monitoring station. A
required parameter of `airquality` and `measures`. Station ids are 1-based, so
the CLI rejects `0` locally. Discover ids via `meta` / `airquality-limits` /
`measures-limits`. An id the API doesn't know mostly gets `"data": {}` with HTTP 200,
like a window without data (only ids far outside the catalogue get HTTP 409); the CLI then
looks the id up in the station catalogue (`meta --use measure`) and exits 4 (not found)
when it isn't there, or prints the empty answer with a `Note:` on stderr when it is.

**component.** The numeric **component id** identifying a pollutant. Required by
`annual-balances` / `transgressions` / `measures`; optional on `thresholds`.
Resolve the id ↔ pollutant mapping via `components`.

**scope.** The numeric **scope id** identifying a measurement scope (averaging
definition). Required by `measures`, optional on `thresholds`. Resolve via `scopes`.

**year.** A four-digit year for the annual aggregations; the API's earliest
year is **2016**, so the CLI rejects anything below that. `transgressions` is
complete only from **2019**: for 2016–2018 the API answers some components (NO₂,
PM₁₀) with HTTP 500, which the CLI reports with a hint.

**Time window (`date_from` / `time_from` / `date_to` / `time_to`).** The data
endpoints address a window by a start date+hour and an end date+hour. Dates are
`YYYY-MM-DD`. Hours are **hour-ending** values in the range **1..24** (not
`0..23`): hour `1` is the interval ending at 01:00, hour `24` ends at midnight.
Times are **CET (UTC+1) all year**, as the `airquality` response labels them, so in
summer they are one hour behind German local time.
The CLI validates the calendar date, the hour range, and rejects a reversed
window (start after end) before any request is sent.

---

## Enums / codes surfaced by the client

These are the closed value sets the client validates against (defined in
`src/client/enums.ts`):

**lang (`Lang`).** Response language for the labels in reference lists and
metadata: `de` | `en`. CLI: `--lang`.

**index (`IndexKind`).** How a reference list is keyed in the response: `id`
(the numeric id) | `code` (the short code). CLI: `--index`. `annual-balances` and
`transgressions` accept it too, but their rows are arrays led by the station id, so
it changes nothing there.

**use (meta) (`MetaUse`).** Which metadata bundle the `meta` endpoint returns:
`airquality` | `measure` | `transgression` | `annualbalance` | `map`. When
`use=airquality`, a time window (`--date-from` + `--date-to`) is required. For the
other uses the window is optional, but the API applies it too (`use=measure` then
lists only the stations active in it), so the client checks it the same way: both dates
or neither, hours only with dates, omitted hours sent as `1`/`24`
(`DEFAULT_META_TIME_FROM`/`DEFAULT_META_TIME_TO`; the API would otherwise use the
current hour), no reversed window. CLI: `meta --use`.

**use (thresholds) (`ThresholdUse`).** Which threshold set the `thresholds`
endpoint returns: `airquality` | `measure`. CLI: `thresholds --use`.

---

## Search & API concepts

**Retry / backoff.** The API rate-limits and can return transient **429** /
**503** responses; the engine retries those automatically, backing off linearly (200 ms,
400 ms, …) or waiting the response's `Retry-After` (seconds or an HTTP date) when that is
longer — a `Retry-After` of `0` or a past date never makes it retry sooner. A
`Retry-After` above 30 s is not retried: the error surfaces at once and names the wait
the server asked for (`--max-retries`, `0..10`, default `2`). A connection the server resets mid-request is
retried the same way (linear backoff); a refused connection, a DNS failure or a timeout
is not.

**Redirects.** The engine follows up to 5 HTTP redirects by default
(configurable with `--max-redirects`; `0` disables following). On a
**cross-origin** redirect it strips request headers (re-adding only the benign
`Accept` / `User-Agent`) so nothing sensitive leaks to a different origin. Credentials in
`--base-url` (`https://user:pw@mirror/`) go out as an `Authorization: Basic` header, to the
base URL's own origin (scheme, host, port) only: a same-origin redirect keeps them, relative
or absolute, a cross-origin one drops them, and a `401`/`403` after such a drop says so (an
http→https redirect: use an https base URL). Userinfo in a server's `Location` is never used.

**Response size cap (`maxResponseBytes`).** A hard cap on response body size
(default 100 MiB; `0` = unlimited) that defends against memory exhaustion from a
hostile or buggy endpoint. CLI: `--max-response-bytes`. The engine enforces it, and the
timeout, for a library user's own transport too.

**Read-only, no auth.** The UBA Air Data API needs no API key; this client
implements only the open, read-only `GET` endpoints.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `LuftqualitaetClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.

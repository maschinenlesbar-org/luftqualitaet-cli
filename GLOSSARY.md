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
client targets the live API path `/api/air_data/v3` on
`https://www.umweltbundesamt.de` (the default base URL). It supersedes the **v2**
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
a time window. CLI: `airquality`.

**airquality-limits (`/airquality/limits`).** The available date range per
station for air-quality data — use it to discover what windows you can request.
CLI: `airquality-limits`.

**measures (`/measures/json`).** Raw measurement data for a station over a
window, optionally narrowed to one component and/or scope. CLI: `measures`.

**measures-limits (`/measures/limits`).** The available date range per
scope/component/station for measurements. CLI: `measures-limits`.

**annual-balances (`/annualbalances/json`).** Annual tabulations
(*Jahresbilanzen*) for a component and a given year (`>= 2016`). CLI:
`annual-balances`.

**transgressions (`/transgressions/json`).** Exceedance (*Überschreitungen*)
data for a component and year — how often a limit value was exceeded. CLI:
`transgressions`.

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
`measures-limits`.

**component.** The numeric **component id** identifying a pollutant. Required by
`annual-balances` / `transgressions`; optional on `measures` / `thresholds`.
Resolve the id ↔ pollutant mapping via `components`.

**scope.** The numeric **scope id** identifying a measurement scope (averaging
definition). Optional on `measures` / `thresholds`. Resolve via `scopes`.

**year.** A four-digit year for the annual aggregations; the API's earliest
year is **2016**, so the CLI rejects anything below that.

**Time window (`date_from` / `time_from` / `date_to` / `time_to`).** The data
endpoints address a window by a start date+hour and an end date+hour. Dates are
`YYYY-MM-DD`. Hours are **hour-ending** values in the range **1..24** (not
`0..23`): hour `1` is the interval ending at 01:00, hour `24` ends at midnight.
The CLI validates the calendar date, the hour range, and rejects a reversed
window (start after end) before any request is sent.

---

## Enums / codes surfaced by the client

These are the closed value sets the client validates against (defined in
`src/client/enums.ts`):

**lang (`Lang`).** Response language for the labels in reference lists and
metadata: `de` | `en`. CLI: `--lang`.

**index (`IndexKind`).** How a reference list is keyed in the response: `id`
(the numeric id) | `code` (the short code). CLI: `--index`.

**use (meta) (`MetaUse`).** Which metadata bundle the `meta` endpoint returns:
`airquality` | `measure` | `transgression` | `annualbalance` | `map`. When
`use=airquality`, a time window (`--date-from` + `--date-to`) is required. CLI:
`meta --use`.

**use (thresholds) (`ThresholdUse`).** Which threshold set the `thresholds`
endpoint returns: `airquality` | `measure`. CLI: `thresholds --use`.

---

## Search & API concepts

**Retry / backoff.** The API rate-limits and can return transient **429** /
**503** responses; the engine retries those automatically with linear backoff
(`--max-retries`, default `2`).

**Redirects.** The engine follows up to 5 HTTP redirects. On a **cross-origin**
redirect it strips request headers (re-adding only the benign `Accept` /
`User-Agent`) so nothing sensitive leaks to a different origin.

**Response size cap (`maxResponseBytes`).** A hard cap on response body size
(default 100 MiB; `0` = unlimited) that defends against memory exhaustion from a
hostile or buggy endpoint. CLI: `--max-response-bytes`.

**Read-only, no auth.** The UBA Air Data API needs no API key; this client
implements only the open, read-only `GET` endpoints.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `LuftqualitaetClient`, the request engine, transport, retry/backoff, error
> types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.

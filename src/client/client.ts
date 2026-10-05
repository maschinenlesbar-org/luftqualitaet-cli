// LuftqualitaetClient — a typed client over the open (no-auth) Air Data API of
// the Umweltbundesamt (https://luftdaten.umweltbundesamt.de/api/air-data/v3).
//
//   client.components({ lang: "de" })
//   client.airquality({ date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 })

import { RequestEngine, type EngineOptions } from "./engine.js";
import { LuftValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";
import type {
  AirDataResult,
  ListParams,
  WindowParams,
  MeasuresParams,
  YearComponentParams,
  ThresholdParams,
  MetaParams,
} from "./types.js";
import { LangValues, MetaUseValues, ThresholdUseValues, type Lang } from "./enums.js";
import {
  assertId,
  assertListParams,
  assertKnownParams,
  assertParams,
  assertValid,
  assertOneOf,
  assertWindow,
  assertWindowParams,
  assertYear,
  optional,
  type FilterOptions,
  type Problem,
} from "./validate.js";

const WINDOW_KEYS = ["date_from", "time_from", "date_to", "time_to", "station"] as const;
const LIST_KEYS = ["lang", "index"] as const;

/** The parameters each call takes (the API ignores any other; see `assertKnownParams`). */
export const CALL_PARAMS = {
  airquality: WINDOW_KEYS,
  measures: [...WINDOW_KEYS, "component", "scope"],
  annualBalances: ["component", "year", ...LIST_KEYS],
  transgressions: ["component", "year", ...LIST_KEYS],
  components: LIST_KEYS,
  networks: LIST_KEYS,
  scopes: LIST_KEYS,
  thresholds: ["use", "lang", "component", "scope"],
  meta: ["use", "lang", "date_from", "date_to", "time_from", "time_to"],
} as const satisfies Record<string, readonly string[]>;

/**
 * The window hours `meta()` sends when dates are given without hours: the full day.
 * The API would otherwise fill a missing hour with the current hour, which can
 * reverse a window that passed the order check.
 */
export const DEFAULT_META_TIME_FROM = 1;
export const DEFAULT_META_TIME_TO = 24;

/** The API path the client appends to the base URL (the host). */
export const API_PATH = "/api/air-data/v3";
const API = API_PATH;

/**
 * A base URL must not already end in the API path, in the current or the old
 * spelling (`/api/air-data/v3`, `/api/air_data/v3`): the client appends it, so the
 * API's documented address would request `/api/air-data/v3/api/air-data/v3/...` and
 * get a 404. The reason names the host to use instead. A value that does not parse
 * passes here (the engine reports it).
 */
export const baseUrlApiPathProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const apiPath = /\/api\/air[-_]data\/v3\/*$/.exec(url.pathname);
  if (!apiPath) return undefined;
  // (url.origin carries no userinfo, so nothing secret is echoed.)
  const prefix = url.pathname.slice(0, apiPath.index);
  return (
    `Leave out ${apiPath[0].replace(/\/+$/, "")}: the base URL is the host, and the client adds ` +
    `${API_PATH} itself (try ${url.origin}${prefix}).`
  );
};

/** A JSON object that isn't an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The documented envelopes of the API's answers, as seen on the live API (2026-10):
 *
 * - `list` — the reference lists and thresholds: `{ count, indices: [...], "<id>": [...] }`.
 * - `window` — `airquality`/`measures`: `{ request, indices, data: { <station>: ... } }`;
 *   no data in the window (or an unknown station) is `data: {}`.
 * - `limits` — `*-limits`: `{ request, indices, data: { ... } }`.
 * - `annual` — `annual-balances`/`transgressions`: `{ request, indices: [...], headers, data }`,
 *   `data` an array of rows (or `{}` when the year has none).
 * - `meta` — `{ request, ... }`.
 */
export type ResponseShape = "list" | "window" | "limits" | "annual" | "meta";

/**
 * Why `value` is not an answer of the documented `shape`, or undefined when it is. The
 * client checks every 2xx body with it, so `null`, `{}`, an error object or a proxy's
 * text is a LuftParseError instead of data (or an empty result read as "nothing found").
 */
export function responseShapeProblem(shape: ResponseShape, value: unknown): string | undefined {
  if (!isRecord(value)) return `expected a JSON object, got ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}`;
  switch (shape) {
    case "list":
      if (typeof value["count"] !== "number") return "expected a numeric count";
      if (!Array.isArray(value["indices"])) return "expected an indices array";
      return undefined;
    case "window":
    case "limits":
      if (!isRecord(value["request"])) return "expected a request object";
      if (!isRecord(value["data"])) return "expected a data object";
      return undefined;
    case "annual":
      if (!isRecord(value["request"])) return "expected a request object";
      if (!Array.isArray(value["indices"])) return "expected an indices array";
      if (!Array.isArray(value["data"]) && !isRecord(value["data"])) return "expected data rows";
      return undefined;
    case "meta":
      if (!isRecord(value["request"])) return "expected a request object";
      return undefined;
  }
}

const shaped = (shape: ResponseShape) => (value: unknown) => responseShapeProblem(shape, value);

/**
 * The month (June) of the following year in which UBA publishes a year's final, checked
 * data — and with it the annual balances ("Erst im Juni des Folgejahres werden die finalen
 * Daten bereitgestellt", UBA, Schnittstellenbeschreibung Luftdaten-API, 17 Dec 2025).
 */
export const FINAL_DATA_MONTH = 6;

/** True when `data` (an annual answer's rows) holds no row. */
function hasNoRows(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  return isRecord(data) && Object.keys(data).length === 0;
}

/**
 * What a reader of an annual answer for `year` must be told, or undefined. Upstream the two
 * endpoints count from different data (UBA, Schnittstellenbeschreibung Luftdaten-API):
 * `transgressions` is the exceedance table *for the running year*, built from preliminary
 * data, while `annualBalances` is evaluated "auf Basis der endgültigen Daten", published in
 * June of the following year. A completed year's transgressions table is not brought up to
 * the final data: for 2019–2025 its yearly count differs from the annual balance at 10–35 %
 * of PM₁₀ stations, in both directions, and the annual balance agrees with the station's
 * own daily means (Halle/Paracelsusstr., PM₁₀ 2024: transgressions 17 days, annual balance
 * and daily means 8). So:
 *
 * - `transgressions` for a completed year: say the counts are preliminary and name
 *   `annualBalances` (CLI `annual-balances`) as the year's exceedance count.
 * - `annualBalances` without rows: say there is no annual balance (yet), and when.
 *
 * `now` is the reference date (default: today); the CLI prints the note on stderr.
 */
export function annualDataNote(
  kind: "transgressions" | "annualBalances",
  year: number,
  result: AirDataResult,
  now: Date = new Date(),
): string | undefined {
  const current = now.getFullYear();
  const finalOut = current > year + 1 || (current === year + 1 && now.getMonth() + 1 >= FINAL_DATA_MONTH);
  if (kind === "annualBalances") {
    if (!hasNoRows(result["data"])) return undefined;
    if (year >= current) {
      return `No annual balance for ${year}: UBA publishes it from the final data in June ${year + 1}. ` +
        "For the running year's preliminary exceedance counts use transgressions.";
    }
    return finalOut
      ? `No annual balance for ${year} for this component.`
      : `No annual balance for ${year} yet: UBA publishes it from the final data in June ${year + 1}. ` +
          "Until then transgressions has the (preliminary) exceedance counts.";
  }
  if (year >= current) return undefined;
  return (
    `transgressions is UBA's exceedance table for the running year, from preliminary data; ` +
    `for ${year} its counts were not updated to the final data and can differ from the stations' ` +
    `own values. ` +
    (finalOut
      ? `For ${year}'s exceedance counts use annual-balances (final data).`
      : `annual-balances will have ${year}'s final counts from June ${year + 1}.`)
  );
}

/**
 * What a reader of an `airquality`/`measures` answer must be told when it has no data, or
 * undefined when it has some. The API answers an unknown station id like a window without
 * data — HTTP 200 with `data: {}` ("Ungültige Abfragen liefern einen JSON ohne Daten
 * zurück", UBA); only ids far outside the catalogue get HTTP 409 — so an empty answer can
 * mean either, and the note says how to tell. The CLI prints it on stderr.
 */
export function stationDataNote(result: AirDataResult, station: number): string | undefined {
  if (!hasNoRows(result["data"])) return undefined;
  return (
    `No data for station ${station} in this window. The API answers an unknown station id the ` +
    `same way: check the id (meta --use measure lists the stations) and the window ` +
    `(airquality-limits / measures-limits show each station's range).`
  );
}

/**
 * `result` with each station's hours (keyed `"YYYY-MM-DD HH:MM:SS"`, the hour's start in
 * CET) in time order. The API sometimes lists the newest hours out of order — today's
 * answer for a station read `… 10:00, 13:00, 11:00, 12:00` — so "the last entry" was not
 * the newest hour. Only the key order changes; the values are the API's.
 */
export function inTimeOrder(result: AirDataResult): AirDataResult {
  const data = result["data"];
  if (!isRecord(data)) return result;
  for (const [station, hours] of Object.entries(data)) {
    if (!isRecord(hours)) continue;
    const keys = Object.keys(hours);
    const sorted = [...keys].sort();
    if (keys.every((key, i) => key === sorted[i])) continue;
    (data as Record<string, unknown>)[station] = Object.fromEntries(sorted.map((key) => [key, hours[key]]));
  }
  return result;
}

/** `component` + `year` (+ optional lang/index) of the annual endpoints. */
function assertYearComponent(params: YearComponentParams): void {
  assertId("component", params.component);
  assertYear(params.year);
  assertListParams(params);
}

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
}

export class LuftqualitaetClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
    if (options.baseUrl !== undefined) assertValid("baseUrl", options.baseUrl, baseUrlApiPathProblem);
  }

  // --- Air-quality index & raw measures -------------------------------------

  /**
   * Air-quality index data for a station over a time window: `data.<station>.<hour start>`
   * → `[end, index, incomplete, [component, value, index, y]…]`, the hours in time order
   * ({@link inTimeOrder}).
   */
  async airquality(params: WindowParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("airquality", params, CALL_PARAMS.airquality, options);
    assertWindowParams(params);
    return inTimeOrder(await this.engine.getJson(`${API}/airquality/json`, prune({ ...params }), shaped("window")));
  }

  /** The available date range per station for air-quality data. */
  airqualityLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/airquality/limits`, undefined, shaped("limits"));
  }

  /**
   * Raw measurement data for a station over a window — one component/scope series.
   * Both are required: without them the API would pick a series itself (see
   * `MeasuresParams`).
   */
  async measures(params: MeasuresParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("measures", params, CALL_PARAMS.measures, options);
    assertWindowParams(params);
    assertId("component", params.component);
    assertId("scope", params.scope);
    return inTimeOrder(await this.engine.getJson(`${API}/measures/json`, prune({ ...params }), shaped("window")));
  }

  /** The available date range per scope/component/station for measurements. */
  measuresLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/measures/limits`, undefined, shaped("limits"));
  }

  // --- Aggregations ---------------------------------------------------------

  /**
   * Annual tabulations (*Jahresbilanzen*) for a component and year (>= 2016): per station
   * the annual mean and the exceedance counts the limit values define, named by the
   * answer's `headers`. Evaluated by UBA from the **final** (checked) data, published in
   * June of the following year; before that the year has no rows (`data: {}`). This is the
   * authoritative yearly exceedance count — see {@link annualDataNote}.
   */
  async annualBalances(params: YearComponentParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("annualBalances", params, CALL_PARAMS.annualBalances, options);
    assertYearComponent(params);
    return this.engine.getJson(`${API}/annualbalances/json`, prune({ ...params }), shaped("annual"));
  }

  /**
   * Exceedance tables (*Überschreitungen*) for a component and year: per station the
   * yearly count (`[3]`, named by `headers`), the period covered (`day_first`,
   * `day_recent`) and the monthly counts. UBA builds them for the **running year** from
   * preliminary data; a completed year's table is not updated to the final data and its
   * counts can differ from `annualBalances` and from the station's own daily values (10–35 %
   * of PM₁₀ stations in 2019–2025). For a completed year's exceedance count use
   * `annualBalances` — see {@link annualDataNote}.
   */
  async transgressions(params: YearComponentParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("transgressions", params, CALL_PARAMS.transgressions, options);
    assertYearComponent(params);
    return this.engine.getJson(`${API}/transgressions/json`, prune({ ...params }), shaped("annual"));
  }

  // --- Reference lists ------------------------------------------------------

  async components(params: ListParams = {}, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("components", params, CALL_PARAMS.components, options);
    assertListParams(params);
    return this.engine.getJson(`${API}/components/json`, prune({ ...params }), shaped("list"));
  }

  async networks(params: ListParams = {}, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("networks", params, CALL_PARAMS.networks, options);
    assertListParams(params);
    return this.engine.getJson(`${API}/networks/json`, prune({ ...params }), shaped("list"));
  }

  async scopes(params: ListParams = {}, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("scopes", params, CALL_PARAMS.scopes, options);
    assertListParams(params);
    return this.engine.getJson(`${API}/scopes/json`, prune({ ...params }), shaped("list"));
  }

  async stationSettings(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/stationsettings/json`, prune({ lang }), shaped("list"));
  }

  async stationTypes(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/stationtypes/json`, prune({ lang }), shaped("list"));
  }

  async transgressionTypes(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/transgressiontypes/json`, prune({ lang }), shaped("list"));
  }

  /** Thresholds for a use (airquality | measure), optional component/scope. */
  async thresholds(params: ThresholdParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("thresholds", params, CALL_PARAMS.thresholds, options);
    assertOneOf("use", params.use, ThresholdUseValues);
    optional(params.lang, (v) => assertOneOf("lang", v, LangValues));
    optional(params.component, (v) => assertId("component", v));
    optional(params.scope, (v) => assertId("scope", v));
    return this.engine.getJson(`${API}/thresholds/json`, prune({ ...params }), shaped("list"));
  }

  /**
   * Combined metadata for a use (components, scopes, networks, stations, ...).
   * `use: "airquality"` needs `date_from` and `date_to`; omitted hours are sent as
   * `DEFAULT_META_TIME_FROM`/`DEFAULT_META_TIME_TO`.
   */
  async meta(params: MetaParams, options: FilterOptions = {}): Promise<AirDataResult> {
    assertParams("params", params);
    assertKnownParams("meta", params, CALL_PARAMS.meta, options);
    assertOneOf("use", params.use, MetaUseValues);
    optional(params.lang, (v) => assertOneOf("lang", v, LangValues));
    // use=airquality needs a date window: the API requires one for that bundle.
    if (params.use === "airquality" && (params.date_from === undefined || params.date_to === undefined)) {
      throw new LuftValidationError("Invalid meta window: use=airquality requires date_from and date_to.");
    }
    // For the other uses dates are optional; when given, both are needed and the
    // whole window is checked. Omitted hours default to the full
    // day (DEFAULT_META_TIME_FROM/TO) and are sent: the API would otherwise fill a
    // missing hour with the current hour, which can reverse an accepted window.
    if (params.date_from !== undefined || params.date_to !== undefined) {
      if (params.date_from === undefined || params.date_to === undefined) {
        throw new LuftValidationError(
          "Invalid meta window: date_from and date_to go together; give both, or neither.",
        );
      }
      const time_from = params.time_from ?? DEFAULT_META_TIME_FROM;
      const time_to = params.time_to ?? DEFAULT_META_TIME_TO;
      assertWindow(params.date_from, time_from, params.date_to, time_to);
      const { use, lang, date_from, date_to } = params;
      return this.engine.getJson(
        `${API}/meta/json`,
        prune({ use, lang, date_from, date_to, time_from, time_to }),
        shaped("meta"),
      );
    }
    if (params.time_from !== undefined || params.time_to !== undefined) {
      throw new LuftValidationError("Invalid meta window: time_from/time_to need date_from and date_to.");
    }
    return this.engine.getJson(`${API}/meta/json`, prune({ ...params }), shaped("meta"));
  }
}

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
  assertValid,
  assertOneOf,
  assertWindow,
  assertWindowParams,
  assertYear,
  optional,
  type Problem,
} from "./validate.js";

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

  /** Air-quality index data for a station over a time window. */
  async airquality(params: WindowParams): Promise<AirDataResult> {
    assertWindowParams(params);
    return this.engine.getJson(`${API}/airquality/json`, prune({ ...params }), shaped("window"));
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
  async measures(params: MeasuresParams): Promise<AirDataResult> {
    assertWindowParams(params);
    assertId("component", params.component);
    assertId("scope", params.scope);
    return this.engine.getJson(`${API}/measures/json`, prune({ ...params }), shaped("window"));
  }

  /** The available date range per scope/component/station for measurements. */
  measuresLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/measures/limits`, undefined, shaped("limits"));
  }

  // --- Aggregations ---------------------------------------------------------

  /** Annual tabulations for a component and year (>= 2016). */
  async annualBalances(params: YearComponentParams): Promise<AirDataResult> {
    assertYearComponent(params);
    return this.engine.getJson(`${API}/annualbalances/json`, prune({ ...params }), shaped("annual"));
  }

  /** Exceedance (Überschreitungen) data for a component and year. */
  async transgressions(params: YearComponentParams): Promise<AirDataResult> {
    assertYearComponent(params);
    return this.engine.getJson(`${API}/transgressions/json`, prune({ ...params }), shaped("annual"));
  }

  // --- Reference lists ------------------------------------------------------

  async components(params: ListParams = {}): Promise<AirDataResult> {
    assertListParams(params);
    return this.engine.getJson(`${API}/components/json`, prune({ ...params }), shaped("list"));
  }

  async networks(params: ListParams = {}): Promise<AirDataResult> {
    assertListParams(params);
    return this.engine.getJson(`${API}/networks/json`, prune({ ...params }), shaped("list"));
  }

  async scopes(params: ListParams = {}): Promise<AirDataResult> {
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
  async thresholds(params: ThresholdParams): Promise<AirDataResult> {
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
  async meta(params: MetaParams): Promise<AirDataResult> {
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

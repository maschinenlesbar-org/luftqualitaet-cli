// LuftqualitaetClient — a typed client over the open (no-auth) Air Data API of
// the Umweltbundesamt (https://luftdaten.umweltbundesamt.de/api/air-data/v3).
//
//   client.components({ lang: "de" })
//   client.airquality({ date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 })

import { RequestEngine, type EngineOptions } from "./engine.js";
import { LuftError } from "./errors.js";
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
  assertOneOf,
  assertWindow,
  assertWindowParams,
  assertYear,
  optional,
} from "./validate.js";

/** The API path the client appends to the base URL (the host). */
export const API_PATH = "/api/air-data/v3";
const API = API_PATH;

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
  }

  // --- Air-quality index & raw measures -------------------------------------

  /** Air-quality index data for a station over a time window. */
  async airquality(params: WindowParams): Promise<AirDataResult> {
    assertWindowParams(params);
    return this.engine.getJson(`${API}/airquality/json`, prune({ ...params }));
  }

  /** The available date range per station for air-quality data. */
  airqualityLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/airquality/limits`);
  }

  /**
   * Raw measurement data for a station over a window — one component/scope series;
   * give both, or the API picks the series (see `MeasuresParams`).
   */
  async measures(params: MeasuresParams): Promise<AirDataResult> {
    assertWindowParams(params);
    optional(params.component, (v) => assertId("component", v));
    optional(params.scope, (v) => assertId("scope", v));
    return this.engine.getJson(`${API}/measures/json`, prune({ ...params }));
  }

  /** The available date range per scope/component/station for measurements. */
  measuresLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/measures/limits`);
  }

  // --- Aggregations ---------------------------------------------------------

  /** Annual tabulations for a component and year (>= 2016). */
  async annualBalances(params: YearComponentParams): Promise<AirDataResult> {
    assertYearComponent(params);
    return this.engine.getJson(`${API}/annualbalances/json`, prune({ ...params }));
  }

  /** Exceedance (Überschreitungen) data for a component and year. */
  async transgressions(params: YearComponentParams): Promise<AirDataResult> {
    assertYearComponent(params);
    return this.engine.getJson(`${API}/transgressions/json`, prune({ ...params }));
  }

  // --- Reference lists ------------------------------------------------------

  async components(params: ListParams = {}): Promise<AirDataResult> {
    assertListParams(params);
    return this.engine.getJson(`${API}/components/json`, prune({ ...params }));
  }

  async networks(params: ListParams = {}): Promise<AirDataResult> {
    assertListParams(params);
    return this.engine.getJson(`${API}/networks/json`, prune({ ...params }));
  }

  async scopes(params: ListParams = {}): Promise<AirDataResult> {
    assertListParams(params);
    return this.engine.getJson(`${API}/scopes/json`, prune({ ...params }));
  }

  async stationSettings(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/stationsettings/json`, prune({ lang }));
  }

  async stationTypes(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/stationtypes/json`, prune({ lang }));
  }

  async transgressionTypes(lang?: Lang): Promise<AirDataResult> {
    optional(lang, (v) => assertOneOf("lang", v, LangValues));
    return this.engine.getJson(`${API}/transgressiontypes/json`, prune({ lang }));
  }

  /** Thresholds for a use (airquality | measure), optional component/scope. */
  async thresholds(params: ThresholdParams): Promise<AirDataResult> {
    assertOneOf("use", params.use, ThresholdUseValues);
    optional(params.lang, (v) => assertOneOf("lang", v, LangValues));
    optional(params.component, (v) => assertId("component", v));
    optional(params.scope, (v) => assertId("scope", v));
    return this.engine.getJson(`${API}/thresholds/json`, prune({ ...params }));
  }

  /** Combined metadata for a use (components, scopes, networks, stations, ...). */
  async meta(params: MetaParams): Promise<AirDataResult> {
    assertOneOf("use", params.use, MetaUseValues);
    optional(params.lang, (v) => assertOneOf("lang", v, LangValues));
    // Dates are optional (required for use=airquality by the API); when given, both
    // are needed and the whole window is checked. Omitted hours are left to the
    // caller: the API then fills them with the current hour (the CLI sends 1/24).
    if (params.date_from !== undefined || params.date_to !== undefined) {
      assertWindow(params.date_from, params.time_from ?? 1, params.date_to, params.time_to ?? 24);
    } else if (params.time_from !== undefined || params.time_to !== undefined) {
      throw new LuftError("Invalid meta window: time_from/time_to need date_from and date_to.");
    }
    return this.engine.getJson(`${API}/meta/json`, prune({ ...params }));
  }
}

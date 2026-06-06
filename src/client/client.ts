// LuftqualitaetClient — a typed client over the open (no-auth) Air Data API of
// the Umweltbundesamt (https://www.umweltbundesamt.de/api/air_data/v3).
//
//   client.components({ lang: "de" })
//   client.airquality({ date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 })

import { RequestEngine, type EngineOptions } from "./engine.js";
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
import type { Lang } from "./enums.js";

const API = "/api/air_data/v3";

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
  airquality(params: WindowParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/airquality/json`, prune({ ...params }));
  }

  /** The available date range per station for air-quality data. */
  airqualityLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/airquality/limits`);
  }

  /** Raw measurement data for a station over a window (optional component/scope). */
  measures(params: MeasuresParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/measures/json`, prune({ ...params }));
  }

  /** The available date range per scope/component/station for measurements. */
  measuresLimits(): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/measures/limits`);
  }

  // --- Aggregations ---------------------------------------------------------

  /** Annual tabulations for a component and year (>= 2016). */
  annualBalances(params: YearComponentParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/annualbalances/json`, prune({ ...params }));
  }

  /** Exceedance (Überschreitungen) data for a component and year. */
  transgressions(params: YearComponentParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/transgressions/json`, prune({ ...params }));
  }

  // --- Reference lists ------------------------------------------------------

  components(params: ListParams = {}): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/components/json`, prune({ ...params }));
  }

  networks(params: ListParams = {}): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/networks/json`, prune({ ...params }));
  }

  scopes(params: ListParams = {}): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/scopes/json`, prune({ ...params }));
  }

  stationSettings(lang?: Lang): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/stationsettings/json`, prune({ lang }));
  }

  stationTypes(lang?: Lang): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/stationtypes/json`, prune({ lang }));
  }

  transgressionTypes(lang?: Lang): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/transgressiontypes/json`, prune({ lang }));
  }

  /** Thresholds for a use (airquality | measure), optional component/scope. */
  thresholds(params: ThresholdParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/thresholds/json`, prune({ ...params }));
  }

  /** Combined metadata for a use (components, scopes, networks, stations, ...). */
  meta(params: MetaParams): Promise<AirDataResult> {
    return this.engine.getJson(`${API}/meta/json`, prune({ ...params }));
  }
}

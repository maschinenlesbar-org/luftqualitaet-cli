// Domain types for the Umweltbundesamt Air Data API (umweltbundesamt.de).
//
// The API returns "index + data" structures whose row layout is described by an
// `indices` array and whose payload shape varies by endpoint and parameters, so
// responses are exposed as faithful raw `JsonObject`s. The parameter objects for
// the data endpoints are typed precisely.

import type { Lang, IndexKind, MetaUse, ThresholdUse } from "./enums.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A generic UBA response (typically `{ request, indices, data, count, ... }`). */
export type AirDataResult = JsonObject;

/** Common options for the reference-list endpoints. */
export interface ListParams {
  lang?: Lang;
  index?: IndexKind;
}

/** The time window + station shared by the data endpoints. */
export interface WindowParams {
  /** Start date, YYYY-MM-DD. */
  date_from: string;
  /** Start hour, 1..24. */
  time_from: number;
  /** End date, YYYY-MM-DD. */
  date_to: string;
  /** End hour, 1..24. */
  time_to: number;
  /** Station id. */
  station: number;
}

/** Parameters for `/measures/json` (a window plus optional component/scope). */
export interface MeasuresParams extends WindowParams {
  component?: number;
  scope?: number;
}

/** Parameters for `/annualbalances/json` and `/transgressions/json`. */
export interface YearComponentParams {
  component: number;
  /** Four-digit year, >= 2016. */
  year: number;
  lang?: Lang;
  index?: IndexKind;
}

/** Parameters for `/thresholds/json`. */
export interface ThresholdParams {
  use: ThresholdUse;
  lang?: Lang;
  component?: number;
  scope?: number;
}

/** Parameters for `/meta/json`. */
export interface MetaParams {
  use: MetaUse;
  lang?: Lang;
  date_from?: string;
  date_to?: string;
  time_from?: number;
  time_to?: number;
}

// Public entry point for the API client library.

export {
  LuftqualitaetClient,
  API_PATH,
  DEFAULT_META_TIME_FROM,
  DEFAULT_META_TIME_TO,
  CALL_PARAMS,
  FINAL_DATA_MONTH,
  annualDataNote,
  stationDataNote,
  catalogueHasStation,
  inTimeOrder,
  baseUrlApiPathProblem,
  responseShapeProblem,
} from "./client.js";
export type { ResponseShape } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  MAX_MESSAGE_TEXT,
  assertHeaderValue,
  cleartextProblem,
  cutForMessage,
  isTransientNetworkError,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  LuftError,
  LuftApiError,
  LuftNetworkError,
  LuftParseError,
  LuftValidationError,
  LuftNotFoundError,
  redactUrl,
  credentialsIn,
  redactCredentials,
} from "./errors.js";

export {
  MIN_YEAR,
  assertDate,
  assertHour,
  assertId,
  assertKnownParams,
  assertParams,
  assertWindow,
  assertValid,
  assertYear,
  baseUrlProblem,
  baseUrlWhitespaceProblem,
  headerValueProblem,
  nonBlankProblem,
} from "./validate.js";
export type { FilterOptions, Problem } from "./validate.js";

export * from "./enums.js";
export * from "./types.js";

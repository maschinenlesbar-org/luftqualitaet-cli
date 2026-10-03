// Parameter checks for the library client. The CLI validates its options at parse
// time, but library callers reach the client directly, and the API does not reject
// most bad values: it answers with an empty result or fills in its own defaults.
// So the client checks what it sends and throws a LuftValidationError (a rejected
// promise, no request) with `Invalid <name>: <reason>`.
//
// A rule is a pure function: `<thing>Problem(value)` returns the reason a value is
// invalid, or `undefined` when it is valid. The library enforces it with
// assertValid() before any request; the CLI's commander parsers call the same
// function and turn the reason into a usage error, so a rule is written once and
// the CLI and the library cannot drift apart.

import { LuftValidationError } from "./errors.js";
import { IndexValues, LangValues } from "./enums.js";
import type { WindowParams } from "./types.js";

/** The earliest year the annual endpoints (`annualBalances`, `transgressions`) serve. */
export const MIN_YEAR = 2016;

/** A rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link LuftValidationError} with the message `Invalid <name>: <reason>`
 * when `problem(value)` finds a reason; otherwise return `value` unchanged. Call it
 * before any request, so a rejected input sends nothing. Async methods call it
 * inside their body, so the rejection arrives as a rejected promise rather than a
 * synchronous throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new LuftValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function invalid(name: string, expected: string, value: unknown): never {
  throw new LuftValidationError(`Invalid ${name}: expected ${expected}, got ${describe(value)}.`);
}

/** A real calendar date in `YYYY-MM-DD` form. */
export function assertDate(name: string, value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Round-trip through Date to catch month/day overflow (as the CLI's parseDate
    // does; Date.UTC maps years 0-99 to 1900-1999, so those are rejected too).
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return value as string;
    }
  }
  return invalid(name, "a calendar date as YYYY-MM-DD", value);
}

/** An hour-ending value, an integer 1..24. */
export function assertHour(name: string, value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 24) return value;
  return invalid(name, "an hour from 1 to 24", value);
}

/** A positive integer id (station, component, scope). */
export function assertId(name: string, value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return invalid(name, "a positive integer", value);
}

/** A four-digit year >= `MIN_YEAR`. */
export function assertYear(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= MIN_YEAR && value <= 9999) {
    return value;
  }
  return invalid("year", `a four-digit year >= ${MIN_YEAR}`, value);
}

/** One of a closed value set. */
export function assertOneOf<T extends string>(name: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return invalid(name, `one of ${allowed.join(", ")}`, value);
}

/** Check an optional value with `check` when it is set. */
export function optional<T>(value: T | undefined, check: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : check(value);
}

/** `lang` and `index`, both optional. */
export function assertListParams(params: { lang?: unknown; index?: unknown }): void {
  optional(params.lang, (v) => assertOneOf("lang", v, LangValues));
  optional(params.index, (v) => assertOneOf("index", v, IndexValues));
}

/** A date + hour-ending window, in order (start not after end). */
export function assertWindow(dateFrom: unknown, timeFrom: unknown, dateTo: unknown, timeTo: unknown): void {
  const df = assertDate("date_from", dateFrom);
  const tf = assertHour("time_from", timeFrom);
  const dt = assertDate("date_to", dateTo);
  const tt = assertHour("time_to", timeTo);
  if (df > dt || (df === dt && tf > tt)) {
    throw new LuftValidationError(`Invalid window: the start (${df} hour ${tf}) is after the end (${dt} hour ${tt}).`);
  }
}

/** The window + station of `airquality` / `measures`. */
export function assertWindowParams(params: WindowParams): void {
  assertWindow(params.date_from, params.time_from, params.date_to, params.time_to);
  assertId("station", params.station);
}

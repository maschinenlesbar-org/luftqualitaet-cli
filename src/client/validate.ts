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

import { LuftValidationError, redactUrl } from "./errors.js";
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

/** A non-blank string (not `""`, not only whitespace). */
export const nonBlankProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A value that ends up in an HTTP header (the User-Agent) must be a non-blank
 * string of Latin-1 characters without control characters (tab is allowed, as in
 * HTTP). Node's HTTP layer would otherwise throw an opaque "Invalid character in
 * header content" TypeError at request time, and a custom transport would get a
 * CR/LF through (header injection). Checked by char code so the source stays free
 * of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * A base URL must not carry whitespace or control characters. `new URL()` trims
 * surrounding whitespace and drops tab/CR/LF inside silently, but the engine joins
 * the raw string to each request path, so `"https://h "` would request
 * `https://h /api/air-data/v3/...` and a custom transport would see the raw value.
 * Reject rather than guess.
 */
export const baseUrlWhitespaceProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  return undefined;
};

/**
 * Every engine rule for a base URL, in order: a URL that parses, the `http:` or
 * `https:` scheme, no query or fragment — request paths are appended to the base URL
 * as a string, so a `?` or `#` would swallow every path (`http://h/#f` requests `/`)
 * — no whitespace or control characters (see {@link baseUrlWhitespaceProblem}), and no
 * `%` in the userinfo that doesn't start an escape (`%25` for a literal one): the engine
 * percent-decodes it for the Authorization header.
 * The reasons never echo the URL, so a credential in it cannot leak. (A path that
 * already ends in the API path is the client's rule, `baseUrlApiPathProblem`.)
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape fails there ("URI malformed") at request time, as a raw URIError. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return baseUrlWhitespaceProblem(value);
};

/**
 * The rejected value as the message shows it: a string quoted, with any URL userinfo
 * cut out (`redactUrl`), so a credential URL typed into the wrong option or parameter
 * (`--lang https://u:pw@h`) never reaches the message.
 */
function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(redactUrl(value)) : String(value);
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

/**
 * A parameter object: a plain object, not null, an array or a primitive. Checked first, so a
 * wrong-typed argument (`airquality(null)`) is a LuftValidationError rather than a raw
 * TypeError from reading its fields.
 */
export function assertParams<T>(name: string, value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LuftValidationError(`Invalid ${name}: expected an object of parameters, got ${describe(value)}.`);
  }
  return value;
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

// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { LuftError } from "../client/errors.js";
import { baseUrlApiPathProblem } from "../client/client.js";
import { DEFAULT_BASE_URL, cleartextProblem, type EngineOptions, type RetryEvent } from "../client/engine.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";

/**
 * Strictly parse a plain decimal integer string into a number.
 *
 * Unlike `Number()`, this rejects hex (`0x..`), binary (`0b..`), octal (`0o..`),
 * scientific (`1e3`), explicit-sign (`+5`), and whitespace-padded forms: only an
 * optional leading `-` followed by ASCII digits is accepted. It also rejects
 * values that cannot be represented exactly as a JS integer (`> 2^53 - 1`), so a
 * user-supplied id is never silently rounded before being sent. Returns
 * `undefined` on any non-conforming input; callers map that to a clear error.
 */
function parseStrictInt(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}

/**
 * commander value-parser for `--base-url`: the library's {@link baseUrlProblem}
 * (an absolute http(s) URL, no query or fragment, no whitespace) and
 * {@link baseUrlApiPathProblem} (not ending in the API path), so a bad value is a
 * usage error at parse time, before any client is built. The CLI keeps no rules of
 * its own.
 */
export function parseBaseUrl(value: string): string {
  for (const problem of [baseUrlProblem, baseUrlApiPathProblem]) {
    const reason = problem(value);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * commander takes the next argv entry as the value even when it is a flag
 * (`--user-agent --compact` swallowed `--compact`), so a value starting with `--` is
 * refused. The rest is the library's {@link headerValueProblem} — blank, control
 * characters other than tab, DEL and characters above U+00FF are rejected — so a bad
 * value is a usage error here instead of an opaque failure at request time.
 */
export function parseHeaderValue(value: string): string {
  if (value.startsWith("--")) {
    throw new InvalidArgumentError("Expected a value, got another option. Give the option its value first.");
  }
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  const n = parseStrictInt(value);
  if (n === undefined || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseStrictInt(value);
    if (n === undefined || n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer in the range ${min}..${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser: a positive integer (>= 1). Used for ids — station,
 * component and scope ids are 1-based in this API, so `0` is a user error that
 * should be caught locally rather than sent.
 */
export function parsePositiveIntArg(value: string): number {
  const n = parseStrictInt(value);
  if (n === undefined || n < 1) {
    throw new InvalidArgumentError("Expected a positive integer (>= 1).");
  }
  return n;
}

/**
 * commander value-parser: an hour in the API's hour-ending range `1..24`.
 * (The UBA API uses hour-ending times; `0` and `> 24` are invalid.)
 */
export function parseHour(value: string): number {
  const n = parseStrictInt(value);
  if (n === undefined || n < 1 || n > 24) {
    throw new InvalidArgumentError("Expected an hour in the range 1..24.");
  }
  return n;
}

/** commander value-parser: a four-digit year, `>= 2016` (the API's earliest). */
export function parseYear(value: string): number {
  const n = parseStrictInt(value);
  if (n === undefined || n < 2016 || n > 9999) {
    throw new InvalidArgumentError("Expected a four-digit year >= 2016.");
  }
  return n;
}

/**
 * commander value-parser for `--lang`. Rejects a flag-like value (one starting
 * with `-`): commander would otherwise consume the *next* option (e.g. `--index`)
 * as this option's value, producing a confusing downstream "too many arguments"
 * error. Membership in the allowed set is checked by the client, before any request.
 */
export function parseLangArg(value: string): string {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError("Option '--lang' requires a value (e.g. de | en).");
  }
  return value;
}

/** commander value-parser for `--use` (thresholds, meta); see `parseLangArg`. */
export function parseUseArg(value: string): string {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError("Option '--use' requires a value (e.g. airquality | measure).");
  }
  return value;
}

/** commander value-parser for `--index`; see `parseLangArg`. */
export function parseIndexArg(value: string): string {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError("Option '--index' requires a value (e.g. id | code).");
  }
  return value;
}

/**
 * Make giving a single-value option twice a usage error, on `command` and every
 * subcommand. Commander keeps the last value silently: `--station 143 --station 172`
 * fetched station 172 alone, and `--year 2024 --year 2025` one year, with nothing telling
 * the user a value was dropped. Flags without a value are left alone. Call it once on a
 * freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxRedirects !== undefined) options.maxRedirects = global.maxRedirects;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a LuftError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new LuftError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before the first request) it writes one
 * WARN record of `luftqualitaet.http` to stderr when the base URL is plain `http:` to a host
 * other than loopback (cleartextProblem). Help, version and usage errors never reach
 * an action, so they never warn.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const cleartext = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
    if (cleartext !== undefined) logOf(deps).warn("http", cleartext);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { LuftError } from "../client/errors.js";
import { API_PATH } from "../client/client.js";
import type { EngineOptions } from "../client/engine.js";
import { IndexValues, LangValues } from "../client/enums.js";
import type { IndexKind, Lang } from "../client/enums.js";

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
 * commander value-parser for `--base-url`: an absolute http(s) URL. A malformed
 * or non-http(s) value (`file:`, `ftp:`, `notaurl`) is a usage error at parse
 * time, before any client is built.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path ("http://h/#f" requests "/" for every command).
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  // new URL() trims surrounding whitespace silently; the raw value is what the
  // engine uses, so reject it rather than guess.
  if (value !== value.trim()) {
    throw new InvalidArgumentError("A base URL cannot have surrounding whitespace.");
  }
  // The client appends the API path, so a base URL that already ends in it (the
  // API's documented address, current or old spelling) would double it.
  const apiPath = /\/api\/air[-_]data\/v3\/*$/.exec(url.pathname);
  if (apiPath) {
    const prefix = url.pathname.slice(0, apiPath.index);
    throw new InvalidArgumentError(
      `Leave out ${apiPath[0].replace(/\/+$/, "")}: the base URL is the host, and the CLI adds ` +
        `${API_PATH} itself (try ${url.origin}${prefix}).`,
    );
  }
  return value;
}

/** commander value-parser: reject a blank value (`""` or only whitespace). */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * commander takes the next argv entry as the value even when it is a flag
 * (`--user-agent --compact` swallowed `--compact`), so a value starting with `--` is
 * refused. Node's HTTP layer throws an opaque "Invalid character in header content"
 * at request time for a CR/LF (or any other C0 control or DEL) and for any character
 * above U+00FF, which surfaced as "Unexpected error". Reject those here as a usage
 * error, along with a blank value. Tab is allowed, as in HTTP. Checked by char code
 * so the source stays free of control bytes.
 */
export function parseHeaderValue(value: string): string {
  if (value.startsWith("--")) {
    throw new InvalidArgumentError("Expected a value, got another option. Give the option its value first.");
  }
  parseNonEmpty(value);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new InvalidArgumentError("Value contains control characters.");
    }
    if (c > 0xff) {
      throw new InvalidArgumentError("Value contains characters outside Latin-1 (above U+00FF).");
    }
  }
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
 * error. Membership in the allowed set is still validated later by `lang()`.
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
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a LuftError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new LuftError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Resolve and validate the optional `--lang` option shared by many commands. */
export function lang(opts: Record<string, unknown>): Lang | undefined {
  return opts["lang"] === undefined
    ? undefined
    : assertEnum(String(opts["lang"]), LangValues, "lang");
}

/** Resolve and validate the optional `--index` option shared by many commands. */
export function index(opts: Record<string, unknown>): IndexKind | undefined {
  return opts["index"] === undefined
    ? undefined
    : assertEnum(String(opts["index"]), IndexValues, "index");
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

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

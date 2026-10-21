// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { logOf, type CliDeps } from "./io.js";
import { LuftError } from "@maschinenlesbar.org/luftqualitaet-client/internal/errors";
import { baseUrlApiPathProblem } from "@maschinenlesbar.org/luftqualitaet-client/internal/client";
import { DEFAULT_BASE_URL, cleartextProblem, isBidiControl, type EngineOptions, type RetryEvent } from "@maschinenlesbar.org/luftqualitaet-client/internal/engine";
import { baseUrlProblem, headerValueProblem, tokenProblem } from "@maschinenlesbar.org/luftqualitaet-client/internal/validate";

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
 * Refuse a value the library's token rule refuses ({@link tokenProblem}): blank (or only
 * invisible characters), a lone surrogate, a control or format character. Every value parser
 * of an id, hour, year or date calls it first, so such a value is named, and shown escaped
 * (`"a\u200bb" contains an invisible or control character (U+200B).`), instead of only "Expected
 * a positive integer".
 */
export function assertToken(value: string): void {
  const problem = tokenProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
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
  assertToken(value);
  const n = parseStrictInt(value);
  if (n === undefined || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    assertToken(value);
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
  assertToken(value);
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
  assertToken(value);
  const n = parseStrictInt(value);
  if (n === undefined || n < 1 || n > 24) {
    throw new InvalidArgumentError("Expected an hour in the range 1..24.");
  }
  return n;
}

/** commander value-parser: a four-digit year, `>= 2016` (the API's earliest). */
export function parseYear(value: string): number {
  assertToken(value);
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
 * Make giving a single-value option twice a usage error, on `command` and every subcommand.
 * Commander keeps the last value silently: `--station 143 --station 172` fetched station 172
 * alone, and `--year 2024 --year 2025` one year, with nothing telling the user a value was
 * dropped. A repeatable option, declared the commander way with an array default, is left
 * alone: each value adds to the list; so is a plain flag (`--compact --compact` means the same).
 *
 * A boolean that can be switched both ways is guarded too: an optional-value option
 * (`--x [bool]`) and a negatable pair (`--x` / `--no-x`). commander calls no value parser for a
 * bare `--x`, so `--x false --x` turned into true silently. Those are counted per attribute
 * from commander's `option:<name>` events, which fire for every occurrence. This CLI declares
 * none today; the guard is the kit's. Call it once on a freshly built program: the check counts
 * per program.
 */
export function forbidRepeatedOptions(command: Command): void {
  const switches = new Set(command.options.filter((o) => o.negate || o.optional).map((o) => o.attributeName()));
  const seen = new Set<string>();
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (switches.has(attribute)) {
      const names = command.options.filter((o) => o.attributeName() === attribute).map((o) => o.long ?? o.short);
      command.on(`option:${option.name()}`, () => {
        if (seen.has(attribute)) command.error(`error: ${names.join(" / ")} may be given only once.`, { code: "commander.optionRepeated" });
        seen.add(attribute);
      });
      continue;
    }
    if (!option.required || option.variadic || Array.isArray(option.defaultValue)) continue;
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
 * Printing the answer failed: it is nested too deeply, or too large, to print. An ERROR record
 * of `luftqualitaet.output`, exit 1.
 */
export class OutputError extends LuftError {}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1)
 * that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
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
    // Text in an answer replaced with U+FFFD is never silent: one WARN record of the api area.
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

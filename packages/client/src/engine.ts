// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { constants } from "node:buffer";
import { TextDecoder } from "node:util";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  LuftApiError,
  LuftError,
  LuftNetworkError,
  LuftParseError,
  LuftValidationError,
  MAX_MESSAGE_TEXT,
  TextBuilder,
  credentialsIn,
  cutText,
  cutForMessage,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem } from "./validate.js";

/**
 * The API's host. The client appends the API path (`API_PATH`, `/api/air-data/v3`).
 * The old address `https://www.umweltbundesamt.de` + `/api/air_data/v3` answers every
 * request with a permanent 301 to this host and path.
 */
export const DEFAULT_BASE_URL = "https://luftdaten.umweltbundesamt.de";
const DEFAULT_USER_AGENT = "luftqualitaet-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large, not a number) makes the constructor throw a
 * LuftValidationError, as does a `transport` or `sleep` that is not a function.
 */
export interface EngineOptions {
  /**
   * Base URL of the API: the host (plus an optional path prefix on a mirror), without
   * the API path, which the client appends. Defaults to https://luftdaten.umweltbundesamt.de.
   * A value that breaks a rule of {@link validateBaseUrl} (not http(s), a query or
   * fragment, whitespace or control characters) throws a LuftValidationError, and so
   * does (in the client) a path that already ends in the API path.
   */
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header (default `luftqualitaet-cli`). A blank value, a
   * control character other than tab, or a character above U+00FF throws a
   * LuftValidationError.
   */
  userAgent?: string | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not only
   * idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by the engine
   * for every transport.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and for a GET whose
   * connection was reset (see {@link isTransientNetworkError}), 0..`MAX_RETRIES` (10).
   * Each waits `retryDelayMs * attempt`, or a 429/503's `Retry-After` when that is
   * longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the LuftApiError
   * says so).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. It is also the floor under a
   * `Retry-After`: the header can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number | undefined;
  /** Number of HTTP redirects (301/302/303/307/308) to follow, 0..`MAX_REDIRECTS` (20). Defaults to 5. */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Enforced by the engine for every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `luftqualitaet.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or a LuftParseError. Matched by name anywhere in a JSON answer, an escaped name
   * (`"\u005fversion_"`) included. Defaults to none (the Air Data API needs none); anything but
   * a set or list of non-empty strings makes the constructor throw a LuftValidationError. The
   * set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Upper bound for `maxRetries` (and the CLI's `--max-retries`). */
export const MAX_RETRIES = 10;

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
export const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws a LuftValidationError. Without this a negative or NaN
 * `timeoutMs` silently disabled the timeout, and `maxRedirects: Infinity` followed a
 * loop forever.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new LuftValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once, naming the requested wait: retrying early would only land inside the window
 * the server asked us to wait out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * The most server text (in UTF-16 units) `sanitizeServerText` reads; a longer text is cut first.
 * Every message keeps far less of it (MAX_MESSAGE_TEXT, 500 characters), and cleaning all of a
 * 16 MB error detail, one string node per character, exhausted a small heap.
 */
const MAX_SERVER_TEXT = 16 * 1024;

/**
 * A whole terminal escape sequence: a CSI (`ESC [` or the 8-bit U+009B, parameters,
 * intermediates, final byte), a terminated control string (OSC/DCS/SOS/PM/APC, `ESC ]` …
 * up to BEL or ST, or their 8-bit forms) or a short `ESC` sequence. Dropping only the
 * control bytes left the printable rest behind (`ESC ] 0 ; title BEL` became `]0;title`).
 * An unterminated control string is left to the per-character filter, so it cannot
 * swallow the rest of the message. A control string's body ends at an ESC or at another
 * introducer: with the introducers allowed inside it, an unterminated run of them was matched
 * from each one to the end of the text, quadratic (100 000 × U+009D took 16 s). Written with
 * escapes, so the source holds no control bytes.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[\u0020-\u002f]*[\u0030-\u007e]/g;

/**
 * What `sanitizeServerText` drops once the escape sequences are gone: the C0 controls but the
 * whitespace ones (TAB to CR), DEL, the C1 controls, and every format character (General
 * Category Cf: bidi controls, zero-width characters, U+00AD, U+FEFF, …).
 */
const DROPPED_CHAR = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

/**
 * Make a string that originates in an attacker-controlled response — here the API
 * error `detail` extracted from the response body — safe to print into an error
 * message on stderr:
 *
 * - Whole escape sequences (CSI, OSC and other control strings) are dropped first,
 *   then any remaining C0 and C1 controls and DEL. `JSON.parse` decodes a JSON-escaped ESC
 *   (a backslash-u-001b sequence) into a real ESC byte; printed raw, a hostile or
 *   MITM'd endpoint could drive ANSI/OSC sequences into the terminal (display
 *   spoofing, title changes).
 * - Unicode format characters (General Category Cf) are dropped: the bidi controls
 *   (isBidiControl), so server text cannot reorder the visible message, and the
 *   invisible ones — zero-width space/joiners, word joiner, soft hyphen, BOM — so
 *   two messages that look identical are identical.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and a server
 *   cannot forge an `Error:` line of its own.
 * - Only the first MAX_SERVER_TEXT (16 384) units are read, and every step is a linear
 *   regex replace: a hostile error body costs neither seconds nor the heap. A caller that
 *   scrubs credentials does so first, so a cut never splits one.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL, C1 and bidi characters raw.
 * Written with escapes so no raw control byte appears in this source.
 */
export function sanitizeServerText(text: string): string {
  return cutText(text, MAX_SERVER_TEXT).replace(ESCAPE_SEQUENCE, "").replace(DROPPED_CHAR, "").replace(/\s+/g, " ").trim();
}

/**
 * True for a bidi control: U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069. A terminal
 * applies them to the text that follows, so an override in server text can reorder what the
 * user sees ("Trojan Source" spoofing). The CLI escapes them in its JSON output.
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Check a base URL against every rule of {@link baseUrlProblem} — unparseable, a
 * scheme other than `http:`/`https:`, a query or fragment, whitespace or control
 * characters — and return it with trailing slashes stripped. A bad value throws a
 * LuftValidationError ("Invalid baseUrl: <reason>"): it is a configuration error,
 * not a transport failure. The default transport still gates the scheme per hop,
 * but the engine may be handed a custom transport that does no such check, so the
 * configured value is checked here, on the raw value, before any request.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/** True for a loopback host name: `localhost`, `127.0.0.0/8`, `::1` (as `URL.hostname` gives them). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * What travels unencrypted when requests go to `baseUrl`, as one sentence — or
 * `undefined` when nothing does: an `https:` URL, a URL that does
 * not parse (the base-URL check reports that), or a loopback host (`localhost`,
 * `127.0.0.0/8`, `::1`). The sentence names the host (`url.host`, host and port) and what
 * is sent with each request: the base URL's own credentials (userinfo) and any other
 * secret passed as a noun phrase in `secrets` (e.g. `"the API key"`). It never contains
 * a password or key. The CLI logs it as a `WARN` record of `luftqualitaet.http` on stderr
 * (once per run, before the first request).
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const sent = [...secrets];
  if (url.username !== "" || url.password !== "") sent.push("the base URL's credentials");
  if (sent.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  // "the base URL's credentials" and any pair are plural; a single secret phrase is not.
  const verb = sent.length === 1 && secrets.length === 1 ? "is" : "are";
  return `${sent.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

/**
 * Check a value bound for an HTTP header (see {@link headerValueProblem}) and
 * return it unchanged; anything else throws a LuftValidationError naming `name`
 * ("Invalid userAgent: Value contains control characters.").
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. Node's transport
 * lower-cases them; a custom one may not (`Retry-After`, `Location`, `Content-Type`), and
 * a fetch transport naturally returns its `Headers` object, which has no plain properties.
 * Such an object (anything with `get` and `forEach`: `Headers`, a `Map`) is copied.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  // Records built from an answer have no prototype: a header named `__proto__` is an own
  // entry like any other, never the record's prototype (whose entries would read as headers).
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record = Object.create(null) as Record<string, string>;
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** The first value of a header (a repeated one arrives as an array). */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a LuftNetworkError caused by a reset or aborted connection, which the engine
 * retries — whichever transport raised it (a Node error, fetch's TypeError with an undici
 * cause). A refused connection, a DNS failure or a timeout is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof LuftNetworkError && hasTransientCode(err.cause);
}

// The message-text cut lives with the error types (validate.ts quotes values too); it is
// exported from here as before.
export { MAX_MESSAGE_TEXT, cutForMessage };
// quoteValue lives with the other message helpers (validate.ts quotes refused values with it).
export { quoteValue } from "./errors.js";

/**
 * `form` and its spelling in a URL (`encodeURIComponent`): a server that puts a credential into
 * a URL, a redirect's Location, percent-encodes it. A form that has no such spelling (a lone
 * surrogate) is kept as it is.
 */
function urlSpellings(form: string): string[] {
  try {
    return [form, encodeURIComponent(form)];
  } catch {
    return [form];
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a LuftValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new LuftValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** `#baseUrl` without its userinfo: what every request URL starts with (the userinfo goes as a header). */
  readonly #requestBase: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /**
   * The forms a server echoes that userinfo back in (the Basic value, the decoded
   * `user:password`, the password or token alone; `echoedCredentialForms`), each also
   * percent-encoded as in a URL (`urlSpellings`), longest first, so a password never leaves
   * half of the `user:password` around it.
   */
  readonly #echoed: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new LuftValidationError("Invalid options: expected an object of engine options.");
    }
    for (const name of ["transport", "sleep", "onRetry", "onWarning"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new LuftValidationError(`Invalid option ${name}: expected a function.`);
      }
    }
    // The raw value is checked before the trailing-slash strip, so "https://h/ "
    // cannot slip past it; only an omitted baseUrl selects the default. Checked
    // here, not only in the default transport: a library consumer that injects a
    // custom transport would otherwise get no gating at all.
    const baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    // Requests go to the base URL as WHATWG parses it, the reading every check of it makes (the
    // host, the cleartext warning, the Authorization header), never to a text-based reading of
    // the string: a transport that reads the URL as text reaches the same host.
    const parsed = new URL(baseUrl);
    this.#baseUrl = parsed.href.replace(/\/+$/, "");
    parsed.username = "";
    parsed.password = "";
    this.#requestBase = parsed.href.replace(/\/+$/, "");
    // The userinfo as typed and as sent (WHATWG percent-encodes some of its characters).
    const userinfos = [...new Set([...credentialsIn(baseUrl), ...credentialsIn(this.#baseUrl)])];
    this.#credentials = userinfos.flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.#echoed = [...new Set(userinfos.flatMap(echoedCredentialForms).flatMap(urlSpellings))].sort((a, b) => b.length - a.length);
    this.transport = options.transport ?? nodeHttpTransport;
    // Only an omitted userAgent selects the default: a blank one is an error, and a
    // malformed one fails here rather than at request time.
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
    this.onRetry = options.onRetry;
    this.onWarning = options.onWarning;
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /**
   * Tell `onRetry` about a retry (`shown`: the URL as messages name it, userinfo redacted and,
   * after a redirect, the credentials echoed in it scrubbed), then wait. A throwing callback
   * never breaks the request.
   */
  private async backOff(attempt: number, delayMs: number, shown: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: shown,
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL, the Authorization header or the decoded `user:password`) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactSecrets(redactCredentials(text, this.#credentials), this.#echoed);
  }

  /**
   * An error body, already scrubbed as sent, as `LuftApiError.body` keeps it: when it is
   * JSON with an escape in it, checked decoded too. An escape (`\"`, `\u00e4`) hides an echoed
   * credential from the scrub of the text as sent, while a caller who parses the body sees it. Such
   * a body is kept as the decoded JSON written again (`JSON.stringify`, one spelling per character)
   * with the credential scrubbed in that spelling. A body that doesn't parse is text nobody
   * decodes, and stays as sent; one too deeply nested to write again is left out.
   */
  private scrubBody(scrubbed: string): string {
    if (this.#echoed.length === 0 || !scrubbed.includes("\\")) return scrubbed;
    let decoded: unknown;
    try {
      decoded = JSON.parse(scrubbed);
    } catch {
      return scrubbed;
    }
    let rewritten: string;
    try {
      rewritten = JSON.stringify(decoded);
    } catch {
      return "";
    }
    const spelled = this.#echoed.map((form) => JSON.stringify(form).slice(1, -1));
    return spelled.some((form) => rewritten.includes(form)) ? redactSecrets(rewritten, spelled) : scrubbed;
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && this.scrub(cause.stack ?? "") === (cause.stack ?? "")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters. It keeps the
   * base URL's userinfo; `request()` sends it as an Authorization header instead.
   */
  buildUrl(path: string, query?: QueryParams): string {
    return this.composeUrl(this.#baseUrl, path, query);
  }

  /**
   * The request URL as an error about the answer shows it: absolute (so a message names the
   * host that gave a bad answer, which matters with a custom base URL), without the base URL's
   * userinfo (as the network errors show it), cut at MAX_MESSAGE_TEXT characters. It never
   * throws: describing a URL for a message does not validate it.
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(redactUrl(this.composeUrl(this.#requestBase, path, query)));
  }

  /** `base` + path + query string. */
  private composeUrl(base: string, path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${base}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new LuftNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, Math.min(this.timeoutMs, MAX_TIMEOUT_MS));
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    // The transport never sees the base URL's userinfo: the engine sends it as an
    // Authorization header, per hop, so a redirect to the same origin (relative or
    // absolute) keeps it and one to another origin or scheme drops it. A transport such
    // as fetch also refuses a URL with credentials outright.
    let url = this.composeUrl(this.#requestBase, path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    const authorization = basicAuthorization(this.#baseUrl);
    if (authorization !== undefined) headers["Authorization"] = authorization;
    /** Why a redirect dropped the base URL's credentials, for a 401/403 message. */
    let dropped: string | undefined;
    // The URL as messages name it: after a redirect, the Location as the server sent it with the
    // credentials scrubbed, then resolved (`redirectTarget`). Resolving first would percent-encode
    // an echoed password in a new spelling (`'` as `%27` in a query) no scrub matches. The
    // request itself goes to the Location as sent.
    let shown = redactUrl(url);

    // Only an idempotent request is sent again after a reset: request() is public, and a
    // POST re-sent may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          redirect: "manual",
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a proxy) reset is the network-level twin of a 503:
        // retry an idempotent request, whichever transport reported it. Timeouts are not
        // retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.backOff(attempt, this.retryDelayMs * attempt, shown);
          continue;
        }
        // The default transport rejects with LuftNetworkError only; an injected one may
        // throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a LuftError — and scrub that text.
        if (cause instanceof LuftError && !(cause instanceof LuftNetworkError)) throw cause;
        // Every network failure names the request — a timeout (the transport's or the
        // engine's deadline), a refused connection, a DNS failure, a reset — with the
        // original as the cause; one that names it already is passed on.
        const prefix = `${method} ${shown} failed: `;
        if (cause instanceof LuftNetworkError && cause.message.startsWith(prefix) && this.scrub(cause.message) === cause.message) {
          throw cause;
        }
        // A transport's text names the URL it was given; the message names the one shown.
        const reason = (cause instanceof Error ? cause.message : String(cause)).split(url).join(shown);
        throw new LuftNetworkError(`${prefix}${cutForMessage(sanitizeServerText(this.scrub(reason)))}`, {
          cause: this.scrubCause(cause),
        });
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError (or, with no status, as success),
      // outside the LuftError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new LuftNetworkError(
          `${method} ${shown} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried the Authorization header to another host, and
      // the answer is not the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new LuftNetworkError(
          `${method} ${shown} failed: the transport followed a redirect to another origin ` +
            `(${cutForMessage(sanitizeServerText(redactUrl(this.scrub(finalUrl))))}); a transport must not follow redirects ` +
            `(HttpRequest.redirect is "manual").`,
        );
      }

      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoders expect.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new LuftNetworkError(`${method} ${shown} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at
      // once and names the wait the server asked for.
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      const tooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
      if (retryable && !tooLong && attempt < this.maxRetries) {
        attempt += 1;
        // Back off linearly from retryDelayMs. A Retry-After can ask for longer, never for
        // less: `Retry-After: 0` or a date in the past turned the retries into a zero-delay
        // burst against a server that had just asked for less load.
        const backoff = this.retryDelayMs * attempt;
        await this.backOff(attempt, retryAfter === undefined ? backoff : Math.max(retryAfter, backoff), shown, status);
        continue;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      if (status >= 300 && status < 400 && redirects < this.maxRedirects) {
        const location = headerValue(responseHeaders["location"]);
        if (typeof location === "string" && location.length > 0) {
          // A hostile server can send an unparsable Location; wrap the parse so
          // it surfaces as a typed LuftNetworkError (matchable by library
          // consumers) rather than a raw TypeError reported as "Unexpected error".
          let target: URL;
          try {
            target = new URL(location, url);
          } catch {
            // No `cause`: Node's "Invalid URL" TypeError carries the request URL, password
            // included, as its `base` property. The Location is the server's text, shown
            // without its own or the base URL's userinfo.
            throw new LuftNetworkError(
              `Invalid redirect Location ${JSON.stringify(cutForMessage(sanitizeServerText(redactUrl(this.scrub(location)))))} from ${shown}`,
            );
          }
          // Only http(s) is followed, checked here and not only by the built-in transport:
          // a custom transport must never be handed a file:, data: or javascript: URL.
          if (target.protocol !== "http:" && target.protocol !== "https:") {
            throw new LuftNetworkError(
              `Refusing to follow redirect to unsupported protocol "${cutForMessage(sanitizeServerText(this.scrub(target.protocol)))}" from ${method} ${shown}`,
            );
          }
          // Userinfo in a Location is not used: credentials come from the base URL only,
          // as the Authorization header, never from a server.
          target.username = "";
          target.password = "";
          // Cross-origin redirect (scheme, host or port differ): strip every request
          // header but the benign Accept/User-Agent, so the base URL's Authorization is
          // never sent to an origin it wasn't issued for. The same origin keeps it,
          // whether the Location is relative or absolute.
          const from = new URL(url);
          if (target.origin !== from.origin) {
            if (headers["Authorization"] !== undefined && dropped === undefined) {
              dropped =
                from.protocol === "http:" && target.protocol === "https:" && from.hostname === target.hostname
                  ? "the server redirected http→https, which dropped the base URL's credentials; use an https base URL"
                  : `the redirect to ${cutForMessage(sanitizeServerText(this.scrub(target.origin)))} dropped the base URL's credentials (they are sent to their own origin only)`;
            }
            for (const key of Object.keys(headers)) delete headers[key];
            headers["Accept"] = options.accept;
            headers["User-Agent"] = this.userAgent;
          }
          shown = redirectTarget(shown, location, (text) => this.scrub(text)) ?? shown;
          url = target.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, shown, status, body, status === 401 || status === 403 ? dropped : undefined, {
          retries: attempt,
          ...(tooLong ? { retryAfterMs: retryAfter } : {}),
        });
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * Perform a GET expecting JSON and parse it into `T`. With `shape`, the parsed body must
   * pass it (see `responseShapeProblem` in client.ts): a 2xx body without the documented
   * envelope (`null`, `{}`, an error object, a proxy's text) is a LuftParseError, never data.
   * An empty (or whitespace-only) body is one too: every endpoint answers with a JSON document.
   * Every error about the answer names the request (`GET <url>: …`, without the userinfo).
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams, shape?: (value: unknown) => string | undefined): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    // The Content-Type is server text a message may quote (a charset, the type): scrubbed first.
    const contentType = this.scrub(res.contentType);
    const decoded = decodeBody(res.data, contentType, request);
    if (decoded.text.trim() === "") {
      // A broken answer, not "no results": printed as nothing with exit 0, it would let a
      // script carry on as if the API had found nothing.
      throw new LuftParseError(`${request}: empty response body.`);
    }
    const repaired = wellFormedEscapes(decoded.text);
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (cause) {
      // A maintenance or proxy page answered with 200: say what it was.
      const type = contentType.split(";")[0]?.trim() ?? "";
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(sanitizeServerText(type))}")` : "";
      throw new LuftParseError(`${request}: the answer is not valid JSON${hint}.`, { cause });
    }
    // JSON.parse rounds and overflows numbers silently: refuse the answer rather than print a
    // changed value.
    if (inexact !== undefined) {
      throw new LuftParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const problem = shape?.(value);
    if (problem !== undefined) {
      throw new LuftParseError(`${request}: unexpected response shape: ${problem}. The server may be down or behind a proxy.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return value as T;
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    hint: string | undefined,
    retry: { retries: number; retryAfterMs?: number },
  ): LuftApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it. One too
    // large to be a string (maxResponseBytes lifted) is left out: the status is the error.
    let raw = "";
    try {
      raw = body.toString("utf8");
    } catch (err) {
      if (!isStringTooLong(err)) throw err;
    }
    const text = this.scrub(raw);
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body, decoded: scrubbed again (a JSON escape hid the
    // credential from the scrub above), then stripped of control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message, and cut.
    if (detail !== undefined) detail = cutForMessage(sanitizeServerText(this.scrub(detail)));
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    return new LuftApiError({
      status,
      url,
      method,
      body: this.scrubBody(text),
      detail,
      retries: retry.retries,
      ...(retry.retryAfterMs === undefined ? {} : { retryAfterMs: retry.retryAfterMs, maxRetryAfterMs: MAX_RETRY_AFTER_MS }),
    });
  }
}

/**
 * The `Authorization` header for a URL's userinfo (`Basic base64(user:password)`, both
 * percent-decoded, as Node's own http client builds it), or undefined without userinfo.
 */
function basicAuthorization(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return undefined;
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

/** The origin (scheme, host, port) of a URL, or the value itself if it doesn't parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn
 * a valid answer into a parse error, and a Latin-1 body keeps its umlauts. An unknown charset
 * label is a LuftParseError naming `request` (`GET <url>`). Bytes that are not valid in the charset become
 * U+FFFD, and `replaced` counts them: exactly for UTF-8 and the single-byte charsets; for
 * UTF-16 a U+FFFD the server sent counts too.
 */
export function decodeBody(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new LuftParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** V8's longest string (2^29 − 24 characters on 64-bit). */
const MAX_STRING_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * True for V8's error for a string past its longest one (2^29 − 24 characters on 64-bit): a body
 * of 512 MB and more, possible once `maxResponseBytes` is lifted, can't be decoded into one.
 */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode: it used to escape as a plain Error ("Unexpected error"). */
function tooLargeForText(request: string, body: Buffer): LuftParseError {
  return new LuftParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest string is ${MAX_STRING_LENGTH} characters).`,
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  const out = new TextBuilder();
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out.push(json.slice(copied, i), "\\ufffd");
    copied = i + 6;
    replaced++;
    i += 5;
  }
  if (replaced === 0) return { json, replaced };
  out.push(json.slice(copied));
  return { json: out.toString(), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The absolute, printable form of a `Location` header: the base URL's credentials scrubbed
 * (`scrub`) as sent, before resolving percent-encodes what is left of them in a new spelling
 * (`'` as `%27` in a query); resolved against the URL shown so far, userinfo redacted,
 * control/bidi characters stripped and cut (it is server text bound for stderr). An unparseable
 * value is shown cleaned as it came.
 */
function redirectTarget(shownUrl: string, location: string, scrub: (text: string) => string): string | undefined {
  const sent = scrub(location);
  let target: string;
  try {
    target = redactUrl(new URL(sent, shownUrl).href);
  } catch {
    target = sent;
  }
  const clean = cutForMessage(sanitizeServerText(target));
  return clean === "" ? undefined : clean;
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  // The zeros are counted with index loops: `/0+$/` tried a match at every zero of a run that
  // doesn't end the text, quadratic in the run, and one `1.<64 000 zeros>1e300` in an answer held
  // the CLI for seconds, past --timeout (the scan runs once the answer is in).
  const all = whole + fraction;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 0x30) start++;
  let end = all.length;
  while (end > start && all.charCodeAt(end - 1) === 0x30) end--;
  return { negative: sign === "-", digits: all.slice(start, end), exponent: Number(exp) - fraction.length + (all.length - end) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings and looks at every
 * number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: TextBuilder | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out ??= new TextBuilder();
      out.push(json.slice(copied, at), '"', literal, '"');
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  if (out === undefined) return { json, inexact };
  out.push(json.slice(copied));
  return { json: out.toString(), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly, or
 * undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one past
 * 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}

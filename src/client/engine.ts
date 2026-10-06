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
import { TextDecoder } from "node:util";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  LuftApiError,
  LuftError,
  LuftNetworkError,
  LuftParseError,
  LuftValidationError,
  credentialsIn,
  redactCredentials,
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
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `luftqualitaet-cli`). A blank value, a
   * control character other than tab, or a character above U+00FF throws a
   * LuftValidationError.
   */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not only
   * idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by the engine
   * for every transport.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and for a GET whose
   * connection was reset (see {@link isTransientNetworkError}), 0..`MAX_RETRIES` (10).
   * Each waits `retryDelayMs * attempt`, or a 429/503's `Retry-After` when that is
   * longer (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the LuftApiError
   * says so).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly), an integer
   * 0..`MAX_RETRY_AFTER_MS` (30 000). Defaults to 200. It is also the floor under a
   * `Retry-After`: the header can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number;
  /** Number of HTTP redirects (301/302/303/307/308) to follow, 0..`MAX_REDIRECTS` (20). Defaults to 5. */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * Enforced by the engine for every transport.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
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
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response — the error detail
 * and any echoed Content-Type. `JSON.parse` decodes a JSON string escape for the
 * ESC code point in an error body into a real ESC byte, so without this a hostile
 * or MITM'd endpoint could drive ANSI/OSC escape sequences into the user's
 * terminal when the message is printed raw to stderr. The CLI's JSON output is
 * escaped separately (`escapeControlChars` in cli/shared.ts): `JSON.stringify`
 * alone leaves DEL and the C1 range raw.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // Keep tab (0x09) and newline (0x0a); drop the rest of C0, DEL, and C1.
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
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
 * What travels unencrypted when requests go to `baseUrl`, as one sentence for a
 * `warning: ` line — or `undefined` when nothing does: an `https:` URL, a URL that does
 * not parse (the base-URL check reports that), or a loopback host (`localhost`,
 * `127.0.0.0/8`, `::1`). The sentence names the host (`url.host`, host and port) and what
 * is sent with each request: the base URL's own credentials (userinfo) and any other
 * secret passed as a noun phrase in `secrets` (e.g. `"the API key"`). It never contains
 * a password or key. The CLI prints it once per run, before the first request.
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
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = value;
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
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

/**
 * Longest server text (in characters) an error message shows; `LuftApiError.body` keeps
 * the whole body. A proxy's 200 kB error page would otherwise flood the terminal.
 */
export const MAX_MESSAGE_TEXT = 500;

/** `text` cut to {@link MAX_MESSAGE_TEXT} characters, marked with "…" when cut. */
export function cutForMessage(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_MESSAGE_TEXT ? text : `${chars.slice(0, MAX_MESSAGE_TEXT).join("")}…`;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident. Messages show request URLs through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new LuftValidationError("Invalid options: expected an object of engine options.");
    }
    for (const name of ["transport", "sleep"] as const) {
      if (options[name] !== undefined && typeof options[name] !== "function") {
        throw new LuftValidationError(`Invalid option ${name}: expected a function.`);
      }
    }
    // The raw value is checked before the trailing-slash strip, so "https://h/ "
    // cannot slip past it; only an omitted baseUrl selects the default. Checked
    // here, not only in the default transport: a library consumer that injects a
    // custom transport would otherwise get no gating at all.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
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
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Request cannot be constructed from a URL that
   * includes credentials: <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
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
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
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
    const [userinfo] = credentialsIn(this.#baseUrl);
    let url = this.composeUrl(
      userinfo === undefined ? this.#baseUrl : this.#baseUrl.replace(`://${userinfo}@`, "://"),
      path,
      options.query,
    );
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };
    const authorization = basicAuthorization(this.#baseUrl);
    if (authorization !== undefined) headers["Authorization"] = authorization;
    /** Why a redirect dropped the base URL's credentials, for a 401/403 message. */
    let dropped: string | undefined;

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
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with LuftNetworkError only; an injected one may
        // throw anything, and its text may carry the request URL with the base URL's
        // password (fetch refuses a URL with credentials and quotes it). Keep the
        // library's error contract — every failure is a LuftError — and scrub that text.
        if (cause instanceof LuftError && !(cause instanceof LuftNetworkError)) throw cause;
        if (cause instanceof LuftNetworkError && this.scrub(cause.message) === cause.message) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new LuftNetworkError(
          `${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError (or, with no status, as success),
      // outside the LuftError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new LuftNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport must not follow redirects itself (`redirect: "manual"`): one that did
      // (fetch's default) may have carried the Authorization header to another host, and
      // the answer is not the one asked for. Reject it when it says so (`url`).
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && originOf(finalUrl) !== originOf(url)) {
        throw new LuftNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${sanitizeServerText(redactUrl(this.scrub(finalUrl)))}); a transport must not follow redirects ` +
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
        throw new LuftNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
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
        await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
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
              `Invalid redirect Location ${JSON.stringify(sanitizeServerText(redactUrl(this.scrub(location))))} from ${redactUrl(url)}`,
            );
          }
          // Only http(s) is followed, checked here and not only by the built-in transport:
          // a custom transport must never be handed a file:, data: or javascript: URL.
          if (target.protocol !== "http:" && target.protocol !== "https:") {
            throw new LuftNetworkError(
              `Refusing to follow redirect to unsupported protocol "${target.protocol}" from ${method} ${redactUrl(url)}`,
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
                  : `the redirect to ${target.origin} dropped the base URL's credentials (they are sent to their own origin only)`;
            }
            for (const key of Object.keys(headers)) delete headers[key];
            headers["Accept"] = options.accept;
            headers["User-Agent"] = this.userAgent;
          }
          url = target.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, body, status === 401 || status === 403 ? dropped : undefined, {
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
   * envelope (`null`, `{}`, an error object, a proxy's text) is a LuftParseError naming the
   * path, never data.
   */
  async getJson<T>(path: string, query?: QueryParams, shape?: (value: unknown) => string | undefined): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, path);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      // A maintenance or proxy page answered with 200: say what it was.
      const type = res.contentType === "" ? "" : ` (Content-Type ${JSON.stringify(sanitizeServerText(res.contentType))})`;
      throw new LuftParseError(`Failed to parse JSON response from ${path}${type}`, { cause });
    }
    const problem = shape?.(value);
    if (problem !== undefined) {
      throw new LuftParseError(`Unexpected response from ${path}: ${problem}. The server may be down or behind a proxy.`);
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
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = cutForMessage(sanitizeServerText(detail));
    if (hint !== undefined) detail = detail === undefined ? hint : `${detail}; ${hint}`;
    return new LuftApiError({
      status,
      url,
      method,
      body: text,
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
 * JSON.parse then rejects, so a BOM added by a proxy or a backend change cannot turn a
 * valid answer into a parse error, and a Latin-1 body keeps its umlauts. An unknown
 * charset label is a LuftParseError.
 */
export function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new LuftParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`);
  }
  return decoder.decode(body);
}

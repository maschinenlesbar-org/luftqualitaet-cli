// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { LuftNetworkError, credentialsIn, redactCredentials, redactUrl, typedUrlCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Aborted when the engine's overall deadline (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline either way,
   * and enforces `maxResponseBytes` on the body it gets back, so neither limit depends on it.
   */
  signal?: AbortSignal;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects. The engine
   * follows them itself and decides per hop whether the `Authorization` header goes along
   * (same origin only). A fetch-based transport passes it on: `fetch(url, { redirect })`.
   */
  redirect?: "manual";
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL the response came from, if the transport knows it (fetch's `response.url`).
   * When it is on another origin than the request, the transport followed a redirect
   * itself and the engine rejects the response with a LuftNetworkError.
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded the size limit of ${maxBytes} bytes (maxResponseBytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs). The body's chunks are joined as they arrive
 * (every COALESCE_CHUNKS chunks or COALESCE_BYTES), so memory follows the bytes received, not
 * the number of chunks a server splits them into.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new LuftNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(new LuftNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;
    const timeoutMs = request.timeoutMs;

    // Wall-clock deadline for the whole request. `req.setTimeout()` below is an
    // *idle-socket* timeout that resets on every received byte, so a slow-drip
    // server that sends one byte just under the idle window (and stays under
    // maxResponseBytes) could keep the request alive indefinitely. A single fixed
    // timer bounds the total time from request start to `end`, independent of the
    // byte cadence.
    let deadline: NodeJS.Timeout | undefined;
    const clearDeadline = (): void => {
      if (deadline !== undefined) {
        clearTimeout(deadline);
        deadline = undefined;
      }
    };

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them or
        // COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks a
        // server chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
        const chunks: Buffer[] = [];
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            clearDeadline();
            res.destroy();
            reject(new LuftNetworkError(sizeLimitMessage(maxBytes)));
            return;
          }
          pending.push(chunk);
          pendingBytes += chunk.length;
          if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
            chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
            pending = [];
            pendingBytes = 0;
          }
        });
        res.on("end", () => {
          if (aborted) return;
          clearDeadline();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat([...chunks, ...pending]),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          clearDeadline();
          reject(new LuftNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    // Only treat the timeout as a *timeout* if the socket was actually
    // connected. A pending DNS/connect failure can outrace the timer (an
    // unresolvable host may take longer to fail than the timeout window); in
    // that case we want the real DNS/connect failure to surface, not a
    // misleading "Request timed out" message.
    let connected = false;
    let dnsError: Error | undefined;
    req.on("socket", (socket) => {
      // A keep-alive socket reused from the agent is already connected and never
      // emits "lookup"/"connect" again; adding listeners to it would pile up one
      // pair per request (MaxListenersExceededWarning after 10) and leave
      // `connected` false on a healthy connection.
      if (!socket.connecting) {
        connected = true;
        return;
      }
      // A failed DNS lookup reports here before the socket emits "error";
      // capture it so a racing timeout can report the true cause.
      const onLookup = (err: Error | null): void => {
        if (err) dnsError = err;
      };
      const onConnect = (): void => {
        connected = true;
      };
      socket.on("lookup", onLookup);
      socket.once("connect", onConnect);
      // The socket outlives this request (keep-alive), so detach both listeners
      // when the request is done with it.
      req.once("close", () => {
        socket.off("lookup", onLookup);
        socket.off("connect", onConnect);
      });
    });

    if (timeoutMs && timeoutMs > 0) {
      // Idle-socket timeout (resets on activity). Reports the true failure phase
      // (connected timeout vs. DNS/connect failure) as before.
      req.setTimeout(Math.min(timeoutMs, MAX_TIMEOUT_MS), () => {
        if (connected) {
          req.destroy(new LuftNetworkError(`Request timed out after ${timeoutMs}ms`));
        } else if (dnsError) {
          // DNS resolution already failed; report that, not a timeout.
          req.destroy(new LuftNetworkError(dnsError.message, { cause: dnsError }));
        } else {
          // Still in the connect/DNS phase with no socket yet. Attribute the
          // failure to that phase rather than claiming a generic request timeout.
          req.destroy(
            new LuftNetworkError(
              `Could not connect to ${url.host} within ${timeoutMs}ms (host unresolved or unreachable)`,
            ),
          );
        }
      });
      // ...plus a hard wall-clock deadline that does *not* reset on activity, so a
      // slow drip cannot outlast the caller's timeout budget (see LQ-02). This
      // bounds total time; maxResponseBytes bounds total size.
      deadline = setTimeout(() => {
        req.destroy(new LuftNetworkError(`Request exceeded the ${timeoutMs}ms deadline`));
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
      // Don't let the deadline timer keep the event loop alive on its own.
      deadline.unref?.();
    }

    if (request.signal !== undefined) {
      const abort = (): void => {
        req.destroy(new LuftNetworkError(`Request exceeded the ${request.timeoutMs ?? 0}ms deadline`));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      req.once("close", () => request.signal?.removeEventListener("abort", abort));
    }

    req.on("error", (err) => {
      clearDeadline();
      // A timeout destroy already passes an LuftNetworkError; don't double-wrap.
      reject(err instanceof LuftNetworkError ? err : new LuftNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });

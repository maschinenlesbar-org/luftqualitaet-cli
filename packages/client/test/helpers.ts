// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/http.js";

/**
 * A 2xx body with every documented envelope key (see `responseShapeProblem`): a list's
 * `count` + `indices`, a data answer's `request` + `data`, an annual table's `headers`.
 * Tests that only care about the request use it as "a valid answer" for any endpoint.
 */
export const OK_BODY = { request: {}, count: 0, indices: [], data: {}, headers: {} };

/**
 * An `airquality`/`measures` answer with data (one station, no hours): a valid window that
 * needs no station-catalogue lookup, for tests that only care about the request. (An
 * answer without data makes the client look the station up in `meta?use=measure`.)
 */
export const WINDOW_BODY = { request: {}, indices: {}, data: { "143": {} } };

/** A `meta?use=measure` answer whose station catalogue lists `ids`. */
export function catalogueBody(ids: number[]): { request: object; stations: Record<string, unknown[]> } {
  return { request: {}, stations: Object.fromEntries(ids.map((id) => [String(id), [String(id), `DE${id}`, `Station ${id}`]])) };
}

/** `responder` for every request except the station catalogue, which lists `ids`. */
export function withCatalogue(
  ids: number[],
  responder: (req: HttpRequest) => HttpResponse,
): (req: HttpRequest) => HttpResponse {
  return (req) => (new URL(req.url).pathname.endsWith("/meta/json") ? jsonResponse(catalogueBody(ids)) : responder(req));
}

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}

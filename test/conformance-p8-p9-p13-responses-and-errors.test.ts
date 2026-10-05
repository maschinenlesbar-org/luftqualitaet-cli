// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { LuftqualitaetClient as Client } from "../src/client/client.js";
import {
  LuftError as BaseError,
  LuftParseError as ParseError,
  LuftValidationError as ValidationError,
} from "../src/client/errors.js";
import type { WindowParams } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.components();
const textBody = (text: string): unknown => ({ count: 1, indices: ["component id", "component name"], "1": ["1", text] });
const readText = (result: unknown): string => (result as Record<string, string[]>)["1"]![1]!;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [null, {}, [], "text", 42, { count: "1", indices: [] }, { error: "boom" }, { count: 1, indices: null }];
const window: WindowParams = { date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 };
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["components(null)", () => new Client().components(null as unknown as {})],
  ["components(5)", () => new Client().components(5 as unknown as {})],
  ["airquality(null)", () => new Client().airquality(null as unknown as WindowParams)],
  ["airquality station '143'", () => new Client().airquality({ ...window, station: "143" as unknown as number })],
  ["annualBalances year '2024'", () => new Client().annualBalances({ component: 1, year: "2024" as unknown as number })],
  ["meta(undefined)", () => new Client().meta(undefined as unknown as { use: "measure" })],
  ["stationTypes(5)", () => new Client().stationTypes(5 as unknown as "de")],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["options: null", () => new Client(null as unknown as {})],
  ["transport: 5", () => new Client({ transport: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});

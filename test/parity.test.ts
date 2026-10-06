// CLI <-> library parity: the same input through run() and through the library
// call, on one recording mock transport, must give the same outcome — both reject
// with no request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftNetworkError, LuftNotFoundError, LuftValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import type { MeasuresParams, MetaParams } from "../src/client/types.js";
import { jsonResponse, parity, requestShapes, withCatalogue } from "./helpers.js";

const meta = (params: MetaParams) => (transport: Transport) => new LuftqualitaetClient({ transport }).meta(params);

// ---- Finding 1: meta sends the default window hours 1/24 it checks against ----

test("meta: dates without hours send time_from=1 and time_to=24 on both sides", async () => {
  for (const [argv, params, from, to] of [
    [["--use", "measure", "--date-from", "2024-03-05", "--date-to", "2024-03-06"],
      { use: "measure", date_from: "2024-03-05", date_to: "2024-03-06" }, "1", "24"],
    [["--use", "airquality", "--date-from", "2024-03-05", "--date-to", "2024-03-05", "--time-from", "22"],
      { use: "airquality", date_from: "2024-03-05", date_to: "2024-03-05", time_from: 22 }, "22", "24"],
    [["--use", "airquality", "--date-from", "2024-03-05", "--date-to", "2024-03-05", "--time-to", "2"],
      { use: "airquality", date_from: "2024-03-05", date_to: "2024-03-05", time_to: 2 }, "1", "2"],
    [["--use", "airquality", "--date-from", "2024-03-05", "--date-to", "2024-03-05", "--time-from", "3", "--time-to", "9"],
      { use: "airquality", date_from: "2024-03-05", date_to: "2024-03-05", time_from: 3, time_to: 9 }, "3", "9"],
  ] as const) {
    const { cli, lib } = await parity(["--compact", "meta", ...argv], meta(params as MetaParams));
    const label = argv.join(" ");
    assert.equal(cli.code, 0, label);
    assert.ok(lib.ok, label);
    assert.equal(cli.requests.length, 1, label);
    assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url), label);
    const q = new URL(lib.requests[0]!.url).searchParams;
    assert.equal(q.get("time_from"), from, label);
    assert.equal(q.get("time_to"), to, label);
  }
});

test("meta: without dates no hours are sent on either side", async () => {
  const { cli, lib } = await parity(["--compact", "meta", "--use", "measure"], meta({ use: "measure" }));
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
  assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
  assert.equal(new URL(lib.requests[0]!.url).search, "?use=measure");
});

// ---- Finding 2: meta use=airquality needs a date window on both sides ----

test("meta: use=airquality without dates is rejected by both, with no request", async () => {
  for (const [argv, params] of [
    [["--use", "airquality"], { use: "airquality" }],
    [["--use", "airquality", "--lang", "en"], { use: "airquality", lang: "en" }],
  ] as const) {
    const { cli, lib } = await parity(["--compact", "meta", ...argv], meta(params as MetaParams));
    const label = argv.join(" ");
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.equal(
      (lib as { error: Error }).error.message,
      "Invalid meta window: use=airquality requires date_from and date_to.",
      label,
    );
    assert.equal(cli.err, `Error: ${(lib as { error: Error }).error.message}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("meta: use=airquality with a full window sends the same request on both sides", async () => {
  const { cli, lib } = await parity(
    ["--compact", "meta", "--use", "airquality", "--date-from", "2024-01-01", "--date-to", "2024-01-02"],
    meta({ use: "airquality", date_from: "2024-01-01", date_to: "2024-01-02" }),
  );
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
  assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
});

// ---- Finding 3: measures needs component and scope on both sides ----

const measuresWindow = ["--date-from", "2024-01-01", "--time-from", "1", "--date-to", "2024-01-02", "--time-to", "24", "--station", "143"];
const measuresParams = { date_from: "2024-01-01", time_from: 1, date_to: "2024-01-02", time_to: 24, station: 143 };

test("measures: a missing component or scope is rejected by both, with no request", async () => {
  for (const [extra, params, missing] of [
    [[], {}, "component"],
    [["--scope", "2"], { scope: 2 }, "component"],
    [["--component", "1"], { component: 1 }, "scope"],
  ] as const) {
    const { cli, lib } = await parity(["--compact", "measures", ...measuresWindow, ...extra], (transport) =>
      new LuftqualitaetClient({ transport }).measures({ ...measuresParams, ...params } as MeasuresParams),
    );
    const label = extra.join(" ") || "neither";
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.match(cli.err, new RegExp(`required option '--${missing} <id>' not specified`), label);
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.equal(
      (lib as { error: Error }).error.message,
      `Invalid ${missing}: expected a positive integer, got undefined.`,
      label,
    );
    assert.equal(lib.requests.length, 0, label);
  }
});

test("measures: with component and scope both sides send the same request", async () => {
  // An answer without data: both sides then look station 143 up in the catalogue too.
  const { cli, lib } = await parity(
    ["--compact", "measures", ...measuresWindow, "--component", "1", "--scope", "2"],
    (transport) => new LuftqualitaetClient({ transport }).measures({ ...measuresParams, component: 1, scope: 2 }),
    withCatalogue([143], () => jsonResponse({ request: {}, indices: {}, data: {} })),
  );
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
  assert.equal(cli.requests.length, 2);
  assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
});

test("an unknown station: both sides reject after the same two requests (CLI exit 4)", async () => {
  const { cli, lib } = await parity(
    ["--compact", "measures", ...measuresWindow, "--component", "1", "--scope", "2"],
    (transport) => new LuftqualitaetClient({ transport }).measures({ ...measuresParams, component: 1, scope: 2 }),
    withCatalogue([172], () => jsonResponse({ request: {}, indices: {}, data: {} })),
  );
  assert.equal(cli.code, 4);
  assert.ok(!lib.ok && lib.error instanceof LuftNotFoundError && lib.error.station === 143);
  assert.equal(cli.requests.length, 2);
  assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
});

// ---- Finding 5: the User-Agent rules are the library's ----

test("userAgent: blank, control and non-Latin-1 values are rejected by both, with no request", async () => {
  for (const [ua, reason] of [
    ["", "Expected a non-empty value."],
    ["   ", "Expected a non-empty value."],
    ["a\r\nX-Evil: 1", "Value contains control characters."],
    ["a\u0000b", "Value contains control characters."],
    ["a\u007fb", "Value contains control characters."],
    ["€", "Value contains characters outside Latin-1 (above U+00FF)."],
    ["日本", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    const { cli, lib } = await parity([`--user-agent=${ua}`, "--compact", "scopes"], (transport) =>
      new LuftqualitaetClient({ userAgent: ua, transport }).scopes(),
    );
    const label = JSON.stringify(ua);
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(cli.err.includes(reason), label);
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.equal((lib as { error: Error }).error.message, `Invalid userAgent: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("userAgent: tab and Latin-1 values are sent identically by both", async () => {
  for (const ua of ["a\tb", "café/1.0"]) {
    const { cli, lib } = await parity([`--user-agent=${ua}`, "--compact", "scopes"], (transport) =>
      new LuftqualitaetClient({ userAgent: ua, transport }).scopes(),
    );
    assert.equal(cli.code, 0, ua);
    assert.ok(lib.ok, ua);
    assert.deepEqual(requestShapes(lib.requests), requestShapes(cli.requests), ua);
    assert.equal(lib.requests[0]!.headers?.["User-Agent"], ua);
  }
});

// ---- Finding 4: base-URL whitespace and API-path rules are the library's ----

test("baseUrl: the API path or whitespace in it is rejected by both, with no request", async () => {
  const leaveOut = (spelling: string, origin: string) =>
    `Leave out ${spelling}: the base URL is the host, and the client adds /api/air-data/v3 itself (try ${origin}).`;
  for (const [baseUrl, reason] of [
    ["https://luftdaten.umweltbundesamt.de/api/air-data/v3", leaveOut("/api/air-data/v3", "https://luftdaten.umweltbundesamt.de")],
    ["https://www.umweltbundesamt.de/api/air_data/v3/", leaveOut("/api/air_data/v3", "https://www.umweltbundesamt.de")],
    ["http://mirror.test/uba/api/air-data/v3", leaveOut("/api/air-data/v3", "http://mirror.test/uba")],
    ["https://luftdaten.umweltbundesamt.de ", "A base URL cannot have surrounding whitespace."],
    [" https://luftdaten.umweltbundesamt.de", "A base URL cannot have surrounding whitespace."],
    ["https://luftdaten.umweltbundesamt.de\n", "A base URL cannot have surrounding whitespace."],
    ["https://luftdaten.umweltbundesamt.de/ ", "A base URL cannot have surrounding whitespace."],
    ["https://mirror.test/a\tb", "A base URL cannot contain whitespace or control characters."],
    ["https://mirror.test/a b", "A base URL cannot contain whitespace or control characters."],
  ] as const) {
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "networks"], (transport) =>
      new LuftqualitaetClient({ baseUrl, transport }).networks(),
    );
    const label = JSON.stringify(baseUrl);
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(cli.err.includes(reason), `${label}: ${cli.err}`);
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.equal((lib as { error: Error }).error.message, `Invalid baseUrl: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

test("baseUrl: a host or a mirror prefix gives the identical request on both sides", async () => {
  for (const baseUrl of ["https://luftdaten.umweltbundesamt.de", "http://mirror.test/uba/"]) {
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "networks"], (transport) =>
      new LuftqualitaetClient({ baseUrl, transport }).networks(),
    );
    assert.equal(cli.code, 0, baseUrl);
    assert.ok(lib.ok, baseUrl);
    assert.deepEqual(requestShapes(lib.requests), requestShapes(cli.requests), baseUrl);
  }
});

// ---- Finding 7: an invalid base URL is a validation error, not a network error ----

test("baseUrl: every invalid shape is a LuftValidationError with the CLI's reason", async () => {
  for (const [baseUrl, reason] of [
    ["", "Expected an absolute http(s) URL."],
    ["   ", "Expected an absolute http(s) URL."],
    ["notaurl", "Expected an absolute http(s) URL."],
    ["ftp://x", 'Unsupported scheme "ftp:". Expected an http(s) URL.'],
    ["file:///etc/passwd", 'Unsupported scheme "file:". Expected an http(s) URL.'],
    ["https://x/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://x/#f", "A base URL cannot have a query (?) or fragment (#)."],
  ] as const) {
    const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "components"], (transport) =>
      new LuftqualitaetClient({ baseUrl, transport }).components(),
    );
    const label = JSON.stringify(baseUrl);
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(cli.err.includes(reason), `${label}: ${cli.err}`);
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.ok(!(lib.error instanceof LuftNetworkError), label);
    assert.equal((lib as { error: Error }).error.message, `Invalid baseUrl: ${reason}`, label);
    assert.equal(lib.requests.length, 0, label);
  }
});

// ---- Finding 6: one check, one message — the CLI reports the library's error ----

test("rejected inputs give the library's message on both sides, with no request", async () => {
  const win = { date_from: "2024-01-02", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 };
  const cases: [string[], (c: LuftqualitaetClient) => Promise<unknown>][] = [
    [
      ["airquality", "--date-from", "2024-01-02", "--time-from", "1", "--date-to", "2024-01-01", "--time-to", "24", "--station", "143"],
      (c) => c.airquality(win),
    ],
    [
      ["measures", "--date-from", "2024-01-01", "--time-from", "5", "--date-to", "2024-01-01", "--time-to", "3", "--station", "143", "--component", "1", "--scope", "2"],
      (c) => c.measures({ date_from: "2024-01-01", time_from: 5, date_to: "2024-01-01", time_to: 3, station: 143, component: 1, scope: 2 }),
    ],
    [["meta", "--use", "measure", "--date-from", "2024-01-01"], (c) => c.meta({ use: "measure", date_from: "2024-01-01" })],
    [["meta", "--use", "map", "--date-to", "2024-01-01"], (c) => c.meta({ use: "map", date_to: "2024-01-01" })],
    [["meta", "--use", "measure", "--time-from", "3"], (c) => c.meta({ use: "measure", time_from: 3 })],
    [["meta", "--use", ""], (c) => c.meta({ use: "" as "map" })],
    [["thresholds", "--use", "map"], (c) => c.thresholds({ use: "map" as "measure" })],
    [["components", "--lang", ""], (c) => c.components({ lang: "" as "de" })],
    [["networks", "--index", "x"], (c) => c.networks({ index: "x" as "id" })],
    [["station-types", "--lang", "fr"], (c) => c.stationTypes("fr" as "de")],
    [["annual-balances", "--component", "1", "--year", "2020", "--index", "name"], (c) => c.annualBalances({ component: 1, year: 2020, index: "name" as "id" })],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib } = await parity(["--compact", ...argv], (transport) => call(new LuftqualitaetClient({ transport })));
    const label = argv.join(" ");
    assert.ok(!lib.ok && lib.error instanceof LuftValidationError, label);
    assert.equal(lib.requests.length, 0, label);
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.equal(cli.err, `Error: ${(lib as { error: Error }).error.message}`, label);
  }
});

test("meta: a half date window names the pairing rule", async () => {
  const { lib } = await parity(["--compact", "meta", "--use", "measure", "--date-from", "2024-01-01"], meta({ use: "measure", date_from: "2024-01-01" }));
  assert.ok(!lib.ok);
  assert.equal(
    (lib as { error: Error }).error.message,
    "Invalid meta window: date_from and date_to go together; give both, or neither.",
  );
});

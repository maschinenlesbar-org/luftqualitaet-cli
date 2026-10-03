// CLI <-> library parity: the same input through run() and through the library
// call, on one recording mock transport, must give the same outcome — both reject
// with no request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import type { MeasuresParams, MetaParams } from "../src/client/types.js";
import { parity, requestShapes } from "./helpers.js";

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
  const { cli, lib } = await parity(
    ["--compact", "measures", ...measuresWindow, "--component", "1", "--scope", "2"],
    (transport) => new LuftqualitaetClient({ transport }).measures({ ...measuresParams, component: 1, scope: 2 }),
  );
  assert.equal(cli.code, 0);
  assert.ok(lib.ok);
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

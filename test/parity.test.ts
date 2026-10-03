// CLI <-> library parity: the same input through run() and through the library
// call, on one recording mock transport, must give the same outcome — both reject
// with no request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import type { MetaParams } from "../src/client/types.js";
import { parity } from "./helpers.js";

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

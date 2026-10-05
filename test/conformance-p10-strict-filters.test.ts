// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never turns into
// the whole, unfiltered set with exit 0. Unknown, misspelled and prototype keys and
// wrong-typed values are the library's validation error before any request; a repeated
// single-value flag is a usage error; a filter value that matched nothing is reported.
// Copied from pegel-online-cli; only the adapter block differs per repo (the matched-run case
// moved into it).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { LuftqualitaetClient as Client } from "../src/client/client.js";
import { LuftValidationError as ValidationError } from "../src/client/errors.js";
type Params = Record<string, unknown>;
/** The filtered library call (one measurement series of a station over a window). */
const listCall = (client: Client, params: Params): Promise<unknown> =>
  client.measures(params as unknown as Parameters<Client["measures"]>[0]);
const window = { date_from: "2026-10-04", time_from: 1, date_to: "2026-10-04", time_to: 24, station: 172 };
/** A valid filter, and parameter objects that must be rejected before any request. */
const validParams: Params = { ...window, component: 1, scope: 2 };
const badParams: Array<[string, Params]> = [
  ["unknown key", { ...validParams, network: 3 }],
  ["misspelled key", { ...window, componet: 1, scope: 2 }],
  ["__proto__", { ...validParams, ...(JSON.parse('{"__proto__": {"component": 5}}') as Params) }],
  ["constructor", { ...validParams, ...(JSON.parse('{"constructor": "x"}') as Params) }],
  ["array where one value belongs", { ...validParams, component: [1, 5] }],
  ["NaN", { ...validParams, station: Number.NaN }],
  ["object", { ...validParams, scope: { a: 1 } }],
  ["string where an integer belongs", { ...validParams, station: "172" }],
  ["a key of another call", { ...validParams, lang: "de" }],
];
/** CLI argv with a single-value flag given twice. */
const repeatedFlags: string[][] = [
  ["airquality", "--station", "143", "--station", "172", "--date-from", "2026-10-04", "--time-from", "1", "--date-to", "2026-10-04", "--time-to", "24"],
  ["annual-balances", "--component", "1", "--year", "2024", "--year", "2025"],
  ["components", "--lang", "de", "--lang", "en"],
  ["--timeout", "1000", "--timeout", "2000", "components"],
];
/** luftqualitaet keeps commander's usage-error exit code, 1. */
const USAGE_EXIT = 1;
/**
 * A filter value the server matches nothing for, the answer it gives, and what stderr must
 * name. The API answers an unknown station id like an empty window (`data: {}`).
 */
const unmatched: Array<{ argv: string[]; answer: unknown; names: RegExp }> = [];
/** A run whose filter matched: nothing on stderr. */
const matchedArgv = ["measures", "--station", "172", "--component", "1", "--scope", "2", "--date-from", "2026-10-04", "--time-from", "1", "--date-to", "2026-10-04", "--time-to", "2"];
const matchedAnswer: unknown = { request: {}, indices: {}, data: { "172": { "2026-10-04 00:00:00": [1, 2, 20, "2026-10-04 01:00:00", "0"] } } };
// --------------------------------------------------------------------------------------

function recorder(answer: unknown = matchedAnswer) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(answer)) };
  };
  return { calls, transport };
}

function cli(answer: unknown = matchedAnswer) {
  const out: string[] = [];
  const err: string[] = [];
  const r = recorder(answer);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new Client({ ...opts, transport: r.transport }),
  };
  return { deps, out, err, calls: r.calls };
}

test("P10: unknown keys and wrong-typed values are rejected before any request", async () => {
  const ok = recorder();
  await listCall(new Client({ transport: ok.transport }), validParams);
  assert.equal(ok.calls.length, 1);
  for (const [label, params] of badParams) {
    const r = recorder();
    await assert.rejects(listCall(new Client({ transport: r.transport }), params), ValidationError, label);
    assert.equal(r.calls.length, 0, label);
  }
});

test("P10: a repeated single-value flag is a usage error", async () => {
  for (const argv of repeatedFlags) {
    const c = cli();
    assert.equal(await run(argv, c.deps), USAGE_EXIT, argv.join(" "));
    assert.equal(c.calls.length, 0, argv.join(" "));
    assert.match(c.err.join("\n"), /may be given only once/);
  }
});

test("P10: a filter value that matched nothing is reported on stderr", async () => {
  for (const { argv, answer, names } of unmatched) {
    const c = cli(answer);
    assert.equal(await run(argv, c.deps), 0, argv.join(" "));
    assert.match(c.err.join("\n"), names, argv.join(" "));
  }
  // Every value matched: nothing on stderr.
  const c = cli(matchedAnswer);
  assert.equal(await run(matchedArgv, c.deps), 0);
  assert.deepEqual(c.err, []);
});

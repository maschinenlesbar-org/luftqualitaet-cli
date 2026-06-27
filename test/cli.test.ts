import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { LuftqualitaetClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

const API = "/api/air_data/v3";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new LuftqualitaetClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("components --lang de --index code builds the query", async () => {
  const cli = makeCli(() => jsonResponse({ count: 0 }));
  const code = await run(["components", "--lang", "de", "--index", "code"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/components/json`);
  assert.equal(url.searchParams.get("lang"), "de");
});

test("components rejects an invalid lang before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["components", "--lang", "fr"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid lang/);
});

test("airquality requires the window options", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["airquality", "--station", "143"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality with full window builds the request", async () => {
  const cli = makeCli(() => jsonResponse({ data: {} }));
  const code = await run(
    [
      "airquality",
      "--date-from", "2024-01-01",
      "--time-from", "1",
      "--date-to", "2024-01-01",
      "--time-to", "24",
      "--station", "143",
    ],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("station"), "143");
});

test("thresholds rejects an invalid use", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["thresholds", "--use", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["networks"], cli.deps);
  assert.equal(code, 4);
});

// --- Domain validation at the CLI boundary ----------------------------------

const fullWindow = [
  "--date-from", "2024-01-01",
  "--time-from", "1",
  "--date-to", "2024-01-01",
  "--time-to", "24",
  "--station", "143",
];

function withWindowArg(replace: Record<string, string>): string[] {
  const args = [...fullWindow];
  for (const [flag, value] of Object.entries(replace)) {
    const i = args.indexOf(flag);
    args[i + 1] = value;
  }
  return args;
}

test("airquality rejects time-from below 1 (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["airquality", ...withWindowArg({ "--time-from": "0" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects time-to above 24 (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["airquality", ...withWindowArg({ "--time-to": "25" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects station 0 (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["airquality", ...withWindowArg({ "--station": "0" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects a malformed date (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["airquality", ...withWindowArg({ "--date-from": "2024-1-1" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("annual-balances rejects a year before 2016 (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["annual-balances", "--component", "1", "--year", "2015"],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("annual-balances builds the request for a valid year", async () => {
  const cli = makeCli(() => jsonResponse({ data: {} }));
  const code = await run(
    ["annual-balances", "--component", "1", "--year", "2023", "--lang", "de"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/annualbalances/json`);
  assert.equal(url.searchParams.get("year"), "2023");
});

test("transgressions builds the request", async () => {
  const cli = makeCli(() => jsonResponse({ data: {} }));
  const code = await run(["transgressions", "--component", "5", "--year", "2020"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${API}/transgressions/json`);
});

test("measures forwards optional component/scope", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["measures", ...fullWindow, "--component", "5", "--scope", "2"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/measures/json`);
  assert.equal(url.searchParams.get("component"), "5");
  assert.equal(url.searchParams.get("scope"), "2");
});

test("components rejects an invalid index before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["components", "--index", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid index/);
});

test("meta rejects an invalid use before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["meta", "--use", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid use/);
});

test("meta --use airquality requires a date window (no request)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["meta", "--use", "airquality"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /requires --date-from and --date-to/);
});

test("meta --use measure needs no window", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["meta", "--use", "measure"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("use"), "measure");
});

test("station-types passes a positional lang", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["station-types", "--lang", "de"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/stationtypes/json`);
  assert.equal(url.searchParams.get("lang"), "de");
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse({ a: 1, b: 2 }));
  const code = await run(["--compact", "components"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join(""), '{"a":1,"b":2}');
});

test("no command prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0); // never touched the network
  assert.equal(cli.err.length, 0); // help went to stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: luftqualitaet/);
});

test("a global flag without a command still shows help on stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: luftqualitaet/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["boguscmd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /unknown command 'boguscmd'/);
});

test("meta --use airquality rejects a reversed date window before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["meta", "--use", "airquality", "--date-from", "2024-12-31", "--date-to", "2024-01-01"],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Window start .* is after window end/);
});

test("meta --use airquality rejects reversed hours on the same date before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    [
      "meta", "--use", "airquality",
      "--date-from", "2024-01-01", "--date-to", "2024-01-01",
      "--time-from", "10", "--time-to", "2",
    ],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("meta rejects --time-from/--time-to for a non-airquality use", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["meta", "--use", "measure", "--time-from", "1", "--time-to", "5"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /apply only to --use airquality/);
});

test("--max-redirects is parsed and passed through to the client", async () => {
  let seen: number | undefined;
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {} },
    createClient: (opts) => {
      seen = opts.maxRedirects;
      return new LuftqualitaetClient({
        ...opts,
        transport: makeMockTransport(() => jsonResponse({})).transport,
      });
    },
  };
  const code = await run(["--max-redirects", "0", "components"], deps);
  assert.equal(code, 0);
  assert.equal(seen, 0);
});

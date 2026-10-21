import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { forbidRepeatedOptions, renderJson } from "../src/cli/shared.js";
import { buildProgram } from "../src/cli/program.js";
import { LuftqualitaetClient } from "@maschinenlesbar.org/luftqualitaet-client/internal/client";
import { credentialsIn } from "@maschinenlesbar.org/luftqualitaet-client/internal/errors";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/luftqualitaet-client/internal/http";
import { makeMockTransport, jsonResponse, rawResponse, OK_BODY, WINDOW_BODY, withCatalogue, untimed } from "./helpers.js";

const API = "/api/air-data/v3";

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
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["components", "--lang", "de", "--index", "code"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/components/json`);
  assert.equal(url.searchParams.get("lang"), "de");
});

test("components rejects an invalid lang before any request", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["components", "--lang", "fr"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid lang/);
});

test("airquality requires the window options", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["airquality", "--station", "143"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality with full window builds the request", async () => {
  const cli = makeCli(() => jsonResponse(WINDOW_BODY));
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
  const cli = makeCli(() => jsonResponse(OK_BODY));
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
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["airquality", ...withWindowArg({ "--time-from": "0" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects time-to above 24 (no request)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["airquality", ...withWindowArg({ "--time-to": "25" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects station 0 (no request)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["airquality", ...withWindowArg({ "--station": "0" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("airquality rejects a malformed date (no request)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["airquality", ...withWindowArg({ "--date-from": "2024-1-1" })], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("annual-balances rejects a year before 2016 (no request)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(
    ["annual-balances", "--component", "1", "--year", "2015"],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("annual-balances builds the request for a valid year", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
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
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["transgressions", "--component", "5", "--year", "2020"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${API}/transgressions/json`);
});

test("measures requires --component and --scope (the API would pick one series)", async () => {
  for (const extra of [[], ["--component", "5"], ["--scope", "2"]]) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run(["measures", ...fullWindow, ...extra], cli.deps);
    assert.equal(code, 1, extra.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /required option '--(component|scope) <id>' not specified/);
  }
});

test("measures forwards component/scope", async () => {
  const cli = makeCli(() => jsonResponse(WINDOW_BODY));
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
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["components", "--index", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid index/);
});

test("meta rejects an invalid use before any request", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["meta", "--use", "bogus"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid use/);
});

test("meta --use airquality requires a date window (no request)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["meta", "--use", "airquality"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /use=airquality requires date_from and date_to/);
});

test("meta --use measure needs no window", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["meta", "--use", "measure"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("use"), "measure");
});

test("station-types passes a positional lang", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["station-types", "--lang", "de"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${API}/stationtypes/json`);
  assert.equal(url.searchParams.get("lang"), "de");
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli(() => jsonResponse({ count: 1, indices: [] }));
  const code = await run(["--compact", "components"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.out.join(""), '{"count":1,"indices":[]}');
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { count: 1, indices: [], name: `Station${controls}`, code: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "components"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Station\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("bidi controls in server data are escaped in the JSON output", async () => {
  // A right-to-left override in a station name reorders what the terminal shows after it
  // ("Trojan Source"); JSON.stringify leaves it raw.
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const served = { count: 1, indices: [], name: `Station ${String.fromCharCode(...bidi)} evil` };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "components"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.deepEqual([...text].filter((c) => bidi.includes(c.charCodeAt(0))), [], format.join(" "));
    assert.ok(text.includes("\\u202e"), text);
    assert.ok(text.includes(bidi.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("")), text);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("no command prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0); // never touched the network
  assert.equal(cli.err.length, 0); // help went to stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: luftqualitaet/);
});

test("a global flag without a command still shows help on stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["--compact"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: luftqualitaet/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["boguscmd"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /unknown command 'boguscmd'/);
});

test("meta --use airquality rejects a reversed date window before any request", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(
    ["meta", "--use", "airquality", "--date-from", "2024-12-31", "--date-to", "2024-01-01"],
    cli.deps,
  );
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid window: the start .* is after the end/);
});

test("meta --use airquality sends the 1/24 hour defaults it validates against", async () => {
  // Upstream fills a missing hour with the *current* hour, which could reverse a
  // window the CLI accepted (e.g. --time-from 20 on one day at 10:00).
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(
    ["meta", "--use", "airquality", "--date-from", "2024-01-01", "--date-to", "2024-01-01", "--time-from", "20"],
    cli.deps,
  );
  assert.equal(code, 0);
  const q = new URL(cli.mt.last().url).searchParams;
  assert.equal(q.get("time_from"), "20");
  assert.equal(q.get("time_to"), "24");

  const none = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(
    await run(["meta", "--use", "airquality", "--date-from", "2024-01-01", "--date-to", "2024-01-02"], none.deps),
    0,
  );
  const q2 = new URL(none.mt.last().url).searchParams;
  assert.equal(q2.get("time_from"), "1");
  assert.equal(q2.get("time_to"), "24");
});

test("meta --use airquality rejects reversed hours on the same date before any request", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
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

test("meta rejects --time-from/--time-to without dates", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["meta", "--use", "measure", "--time-from", "1", "--time-to", "5"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /time_from\/time_to need date_from and date_to/);
});

test("meta checks the window for every use, not only airquality", async () => {
  const reversed = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(
    await run(["meta", "--use", "measure", "--date-from", "2025-01-01", "--date-to", "2024-01-01"], reversed.deps),
    1,
  );
  assert.equal(reversed.mt.calls.length, 0);
  assert.match(reversed.err.join("\n"), /Invalid window: the start .* is after the end/);

  const half = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["meta", "--use", "map", "--date-to", "2024-01-01"], half.deps), 1);
  assert.equal(half.mt.calls.length, 0);
  assert.match(half.err.join("\n"), /go together/);

  const ok = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(
    await run(
      ["meta", "--use", "measure", "--date-from", "2024-01-01", "--date-to", "2024-01-02", "--time-to", "6"],
      ok.deps,
    ),
    0,
  );
  const q = new URL(ok.mt.last().url).searchParams;
  assert.equal(q.get("date_from"), "2024-01-01");
  assert.equal(q.get("time_from"), "1");
  assert.equal(q.get("time_to"), "6");
});

test("an invalid global option value exits 1 without leaving run()", async () => {
  // The help probe parses the global options too; it must not process.exit().
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["--max-retries", "-1", "components"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  // Reported once, by the real parse (the probe is silenced).
  assert.equal(cli.err.filter((line) => /argument '-1' is invalid/.test(line)).length, 1);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--timeout", "2147483647", "components"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  // Commander parse errors exit 1 in this CLI.
  const over = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--timeout", "2147483648", "components"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /0\.\.2147483647/);
});

test("--max-redirects is parsed and passed through to the client", async () => {
  let seen: number | undefined;
  const deps: CliDeps = {
    io: { out: () => {}, err: () => {} },
    createClient: (opts) => {
      seen = opts.maxRedirects;
      return new LuftqualitaetClient({
        ...opts,
        transport: makeMockTransport(() => jsonResponse(OK_BODY)).transport,
      });
    },
  };
  const code = await run(["--max-redirects", "0", "components"], deps);
  assert.equal(code, 0);
  assert.equal(seen, 0);
});

// --- --base-url validation at parse time -------------------------------------

for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
  test(`--base-url ${bad} is a usage error (no request)`, async () => {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run(["--base-url", bad, "networks"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /--base-url/);
  });
}

test("--base-url accepts an http(s) URL", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  const code = await run(["--base-url", "http://localhost:8080", "networks"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).origin, "http://localhost:8080");
});

test("the default base URL is the API's current host, so no 301 hop is needed", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["scopes"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/scopes/json");
});

for (const [base, hint] of [
  ["https://luftdaten.umweltbundesamt.de/api/air-data/v3", "try https://luftdaten.umweltbundesamt.de)"],
  ["https://www.umweltbundesamt.de/api/air_data/v3/", "try https://www.umweltbundesamt.de)"],
  ["http://mirror.test/uba/api/air-data/v3", "try http://mirror.test/uba)"],
] as const) {
  test(`--base-url ${base} (with the API path) is a usage error with a hint`, async () => {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    assert.equal(await run(["--base-url", base, "scopes"], cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    const text = cli.err.join("\n");
    assert.match(text, /Leave out \/api\/air[-_]data\/v3: the base URL is the host, and the client adds \/api\/air-data\/v3 itself/);
    assert.ok(text.includes(hint), text);
  });
}

test("--base-url with a path prefix keeps it in front of the API path", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--base-url", "http://mirror.test/uba/", "scopes"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "http://mirror.test/uba/api/air-data/v3/scopes/json");
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["99999999999", false]] as const) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run(["--max-retries", value, "scopes"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /Expected an integer in the range 0\.\.10\./);
    }
  }
});

test("transgressions before 2019: an upstream 500 gets a hint naming the year floor", async () => {
  const cli = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["transgressions", "--component", "5", "--year", "2018"], cli.deps), 1);
  const text = untimed(cli.err.join("\n"));
  assert.match(text, /^INFO  \[luftqualitaet\.api\] The API has no transgressions for some components before 2019/m);
  assert.match(text, /^ERROR \[luftqualitaet\.api\] HTTP 500/m);

  const later = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["transgressions", "--component", "5", "--year", "2019"], later.deps), 1);
  assert.doesNotMatch(untimed(later.err.join("\n")), /^INFO /m);

  const balances = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["annual-balances", "--component", "5", "--year", "2018"], balances.deps), 1);
  assert.doesNotMatch(untimed(balances.err.join("\n")), /^INFO /m);
});

test("airquality/measures: an upstream 409 (unknown station) gets a hint, exit 1", async () => {
  for (const cmd of [["airquality"], ["measures", "--component", "5", "--scope", "2"]]) {
    const cli = makeCli(() => rawResponse("<html>conflict</html>", "text/html", 409));
    assert.equal(await run([...cmd, ...withWindowArg({ "--station": "999999" })], cli.deps), 1);
    const text = untimed(cli.err.join("\n"));
    assert.match(text, /^INFO  \[luftqualitaet\.api\] The API answers an unknown station id with HTTP 409\. Check that station 999999 exists/m);
    assert.match(text, /^ERROR \[luftqualitaet\.api\] HTTP 409/m);
  }
  const other = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["airquality", ...fullWindow], other.deps), 1);
  assert.doesNotMatch(untimed(other.err.join("\n")), /^INFO /m);
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18122/echo?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18122/echo#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18122?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://luftdaten.umweltbundesamt.de", /cannot have surrounding whitespace/],
    ["https://luftdaten.umweltbundesamt.de\t", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run(["--base-url", baseUrl, "components"], cli.deps);
    assert.equal(code, 1, baseUrl);
    assert.equal(cli.mt.calls.length, 0, baseUrl);
    assert.match(cli.err.join("\n"), message, baseUrl);
  }
});

test("credentials in --base-url are redacted from error messages", async () => {
  const cli = makeCli(() => jsonResponse({ message: "status 404" }, 404));
  const code = await run(["--compact", "--base-url", "http://user:secret@127.0.0.1:18122/s/404", "components"], cli.deps);
  assert.equal(code, 4);
  const text = cli.err.join("\n");
  assert.doesNotMatch(text, /secret|user:/);
  assert.match(text, /HTTP 404 for GET http:\/\/127\.0\.0\.1:18122\/s\/404\/api\/air-data\/v3\/components\/json/);
  // The userinfo travels as the Authorization header, never in the URL the transport sees.
  assert.match(cli.mt.last().url, /^http:\/\/127\.0\.0\.1:18122\//);
  assert.equal(cli.mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:secret").toString("base64")}`);
});

test("--user-agent: blank, flag-like, control or non-Latin-1 values are usage errors", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["--compact", /Expected a value, got another option/],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["bot \u2603", /Value contains characters outside Latin-1/],
  ] as const) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run(["--user-agent", ua, "components"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message, JSON.stringify(ua));
  }
  const ok = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--user-agent", "my-bot/1.0\t(Grüße)", "components"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my-bot/1.0\t(Grüße)");
});

test("--use does not swallow the next option", async () => {
  for (const cmd of ["thresholds", "meta"]) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    const code = await run([cmd, "--use", "--component", "5"], cli.deps);
    assert.equal(code, 1, cmd);
    assert.equal(cli.mt.calls.length, 0, cmd);
    assert.match(cli.err.join("\n"), /Option '--use' requires a value/, cmd);
  }
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7, 01#2)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26), the stack, and
  // the answer: V8 takes its iterative path only when no object has an integer-like key, and
  // every UBA answer has one ("1", the station ids). So it is probed here, never assumed.
  const depth = 200_000;
  for (const key of ["1", "x"]) {
    const body = `{"count":1,"indices":[],${JSON.stringify(key)}:${"[".repeat(depth)}${"]".repeat(depth)}}`;
    let compactPrints = true;
    try {
      JSON.stringify(JSON.parse(body));
    } catch {
      compactPrints = false;
    }
    const deep = () => rawResponse(body, "application/json");
    const pretty = makeCli(deep);
    assert.equal(await run(["components"], pretty.deps), 1);
    assert.deepEqual(pretty.out, []);
    assert.equal(
      untimed(pretty.err.join("\n")),
      `ERROR [luftqualitaet.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
      key,
    );
    const compact = makeCli(deep);
    assert.equal(await run(["--compact", "components"], compact.deps), compactPrints ? 0 : 1, key);
    if (compactPrints) assert.equal(compact.out.join("").length, body.length, key);
    else assert.equal(untimed(compact.err.join("\n")), "ERROR [luftqualitaet.output] The answer is nested too deeply to print.", key);
  }
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse(OK_BODY));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeCli(() => jsonResponse(OK_BODY));
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse(OK_BODY));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("transgressions for a completed year prints the data and a note naming annual-balances (03#1, 06#1)", async () => {
  const body = { request: {}, indices: [], headers: { "3": "Number of daily mean values above 50 µg/m³" }, data: [["1789", "2024-01-01", "2024-12-31", "17"]] };
  const cli = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--compact", "transgressions", "--component", "1", "--year", "2019"], cli.deps), 0);
  assert.deepEqual(JSON.parse(cli.out.join("")), body);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[luftqualitaet\.api\] transgressions is UBA's exceedance table for the running year, from preliminary data/);
  assert.match(cli.err.join("\n"), /use annual-balances \(final data\)/);
});

test("annual-balances without rows says when the year's balance comes", async () => {
  const cli = makeCli(() => jsonResponse({ request: {}, indices: [], headers: {}, data: {} }));
  const next = new Date().getFullYear() + 1;
  assert.equal(await run(["--compact", "annual-balances", "--component", "1", "--year", String(next)], cli.deps), 0);
  assert.match(untimed(cli.err.join("\n")), new RegExp(`^INFO  \\[luftqualitaet\\.api\\] No annual balance for ${next}: UBA publishes it from the final data in June ${next + 1}`));
});

test("an empty answer for a station the catalogue lacks exits 4 naming it; a listed one exits 0 with a note (02#1)", async () => {
  const empty = { request: {}, indices: {}, data: {}, count: 0 };
  const window = ["--date-from", "2026-10-04", "--time-from", "1", "--date-to", "2026-10-04", "--time-to", "2"];
  const commands = (station: string) => [
    ["airquality", "--station", station, ...window],
    ["measures", "--station", station, "--component", "5", "--scope", "2", ...window],
  ];
  for (const argv of commands("2")) {
    // Unknown: one more request, to the station catalogue; exit 4, nothing on stdout.
    const cli = makeCli(withCatalogue([143, 172], () => jsonResponse(empty)));
    assert.equal(await run(["--compact", ...argv], cli.deps), 4, argv.join(" "));
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err.map(untimed), [
      "ERROR [luftqualitaet.api] Station 2 not found: the API answered with no data, and the station catalogue (meta --use measure) has no station with this id.",
    ]);
    assert.deepEqual(cli.mt.calls.map((r) => new URL(r.url).pathname.split("/").slice(-2).join("/")), [`${argv[0]}/json`, "meta/json"]);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("use"), "measure");
  }
  for (const argv of commands("172")) {
    // Listed: the empty answer stands, with the note.
    const cli = makeCli(withCatalogue([143, 172], () => jsonResponse(empty)));
    assert.equal(await run(["--compact", ...argv], cli.deps), 0, argv.join(" "));
    assert.deepEqual(JSON.parse(cli.out.join("")), empty);
    // measures names its series: an unknown scope or a component the station doesn't measure
    // gives the same empty answer as a window without data (04#2).
    assert.deepEqual(cli.err.map(untimed), [
      argv[0] === "measures"
        ? "INFO  [luftqualitaet.api] No data for station 172, component 5, scope 2 in this window (the station is in the catalogue). " +
          "The station may not measure this component in this scope (scopes lists the scope ids), or the window has none: " +
          "measures-limits shows each station's components, scopes and range."
        : "INFO  [luftqualitaet.api] No data for station 172 in this window (the station is in the catalogue). Check the window: airquality-limits / measures-limits show each station's range.",
    ], argv.join(" "));
  }
  // Data: no lookup, no note.
  const cli = makeCli(() => jsonResponse({ request: {}, indices: {}, data: { "2": { "2026-10-04 00:00:00": ["2026-10-04 01:00:00", 1, 0] } } }));
  assert.equal(await run(["--compact", "airquality", "--station", "2", ...window], cli.deps), 0);
  assert.deepEqual(cli.err, []);
  assert.equal(cli.mt.calls.length, 1);
  // A catalogue without a stations object is a parse error (exit 1), never "unknown".
  const odd = makeCli((req) => jsonResponse(new URL(req.url).pathname.endsWith("/meta/json") ? { request: {} } : empty));
  assert.equal(await run(["--compact", "airquality", "--station", "2", ...window], odd.deps), 1);
  assert.match(odd.err.join("\n"), /GET https:\/\/luftdaten\.umweltbundesamt\.de\/api\/air-data\/v3\/meta\/json\?use=measure: unexpected station catalogue: expected a stations object\./);
});

test("an a:b@c argument (a User-Agent, a typed value) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ ...OK_BODY, note: "run:2026-10-09@x" }));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "components"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"note": "run:2026-10-09@x"/);
  const typed = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--timeout", "run:2026-10-09@x", "components"], typed.deps), 1);
  assert.ok(typed.err.some((line) => line.includes("'run:2026-10-09@x'")), typed.err.join("\n"));
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A base URL typed without its scheme is still read as one: its password is never echoed.
  const bare = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["--base-url", "alice:hunter2-pw@mirror.example", "components"], bare.deps), 1);
  assert.ok(!bare.err.join("\n").includes("hunter2-pw"), bare.err.join("\n"));
});

test("help for an unknown command logs an ERROR \"missing command\", then the help one INFO record per line (L5)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["help", "frobnicate"], cli.deps), 1);
  const records = cli.err.map(untimed);
  assert.equal(records[0], "ERROR [luftqualitaet.cli] missing command: `luftqualitaet <subcommand>`");
  assert.ok(records.length > 3, records.join("\n"));
  for (const record of records.slice(1)) assert.match(record, /^INFO  \[luftqualitaet\.cli\] .*\S$/);
  assert.ok(records.some((record) => /\] Usage: luftqualitaet /.test(record)), records.join("\n"));
  assert.deepEqual(cli.out, []);
});

test("the help after a usage error is one INFO record per line; a suggestion is part of the ERROR (L5)", async () => {
  const cli = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["components", "--no-such-option"], cli.deps), 1);
  const records = cli.err.map(untimed);
  assert.equal(records[0], "ERROR [luftqualitaet.cli] unknown option '--no-such-option'");
  assert.ok(records.length > 3, records.join("\n"));
  for (const record of records.slice(1)) {
    assert.match(record, /^INFO  \[luftqualitaet\.cli\] .*\S$/);
    assert.doesNotMatch(record, /\\n/, "one line of the help per record");
  }
  const typo = makeCli(() => jsonResponse(OK_BODY));
  assert.equal(await run(["airqualty"], typo.deps), 1);
  assert.equal(untimed(typo.err[0] ?? ""), "ERROR [luftqualitaet.cli] unknown command 'airqualty' (Did you mean airquality?)");
});

test("a parse error is logged in the format commander would have parsed (L6)", async () => {
  const isJsonl = (line: string): boolean => line.startsWith("{");
  const cases: [string[], boolean][] = [
    // forbidRepeatedOptions keeps the first --log-format and rejects the second.
    [["--log-format", "jsonl", "--log-format", "text", "components"], true],
    [["--log-format", "text", "--log-format", "jsonl", "components"], false],
    // --log-format is --user-agent's value (refused: it looks like an option).
    [["--user-agent", "--log-format", "jsonl", "components"], false],
    // commander takes the program's --log-format out first; --lang is left without its value.
    [["components", "--lang", "--log-format", "jsonl"], true],
  ];
  for (const [argv, jsonl] of cases) {
    const cli = makeCli(() => jsonResponse(OK_BODY));
    assert.equal(await run(argv, cli.deps), 1, argv.join(" "));
    assert.ok(cli.err.length > 0 && cli.err.every((line) => isJsonl(line) === jsonl), `${argv.join(" ")}:\n${cli.err.join("\n")}`);
  }
});

test("the log format is the one commander parsed, not what an option's value looks like (L6)", async () => {
  // commander takes "--" as the User-Agent (refused) and the scan must not stop there either.
  const cli = makeCli(() => jsonResponse(OK_BODY, 500));
  assert.notEqual(await run(["--user-agent", "--", "--log-format", "jsonl", "components"], cli.deps), 0);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
});

test("a malformed answer, the station catalogue's included, is an ERROR record of luftqualitaet.api (L9)", async () => {
  const answers: HttpResponse[] = [
    rawResponse("<html>not json</html>", "application/json"),
    rawResponse("<!doctype html><html>a proxy</html>", "text/html"),
    jsonResponse([]),
    jsonResponse({ count: "1", indices: [] }),
    rawResponse("", "application/json"),
    rawResponse(JSON.stringify(OK_BODY), "application/json; charset=x-unknown"),
  ];
  for (const answer of answers) {
    const cli = makeCli(() => answer);
    assert.equal(await run(["components"], cli.deps), 1);
    assert.match(untimed(cli.err[0] ?? ""), /^ERROR \[luftqualitaet\.api\] /, cli.err.join("\n"));
  }
  // An empty window, and a catalogue without a `stations` object.
  const catalogue = makeCli((req) =>
    new URL(req.url).pathname.endsWith("/meta/json") ? jsonResponse({ request: {} }) : jsonResponse({ request: {}, indices: {}, data: {} }),
  );
  const window = ["--date-from", "2026-10-01", "--time-from", "1", "--date-to", "2026-10-01", "--time-to", "24", "--station", "7"];
  assert.equal(await run(["airquality", ...window], catalogue.deps), 1);
  assert.match(untimed(catalogue.err[0] ?? ""), /^ERROR \[luftqualitaet\.api\] GET \S+\/meta\/json\?use=measure: unexpected station catalogue/, catalogue.err.join("\n"));
});

test("a 409 from the station catalogue lookup gets no unknown-station hint, only its own ERROR (01-1)", async () => {
  for (const command of ["airquality", "measures"]) {
    const cli = makeCli((req) =>
      new URL(req.url).pathname.endsWith("/meta/json")
        ? rawResponse("<html>conflict</html>", "text/html", 409)
        : jsonResponse({ request: {}, indices: {}, data: {} }),
    );
    const extra = command === "measures" ? ["--component", "1", "--scope", "2"] : [];
    const window = ["--date-from", "2026-10-01", "--time-from", "1", "--date-to", "2026-10-01", "--time-to", "24", "--station", "7"];
    assert.equal(await run([command, ...window, ...extra], cli.deps), 1);
    const records = cli.err.map(untimed);
    assert.equal(records.length, 1, records.join("\n"));
    assert.match(records[0] ?? "", /^ERROR \[luftqualitaet\.api\] HTTP 409 for GET .*\/meta\/json\?use=measure/);
  }
});

test("a boolean that can be switched both ways may be given only once: optional value, or --x / --no-x (T11)", async () => {
  // commander calls no value parser for a bare `--is-open`, so `--is-open false --is-open` turned
  // into true without a word (fragdenstaat-cli); `--x --no-x` keeps the last one the same way.
  const build = () => {
    const program = buildProgram(makeCli(() => jsonResponse(OK_BODY)).deps);
    const seen: unknown[] = [];
    program
      .command("flags")
      .option("--is-open [bool]", "optional value", (value: string) => value === "true")
      .option("--cache", "negatable")
      .option("--no-cache", "negatable")
      .option("--archived", "plain flag")
      .action((opts: Record<string, unknown>) => void seen.push(opts));
    forbidRepeatedOptions(program);
    for (const command of program.commands) command.exitOverride().configureOutput({ writeErr: () => {}, outputError: () => {} });
    program.exitOverride();
    return { program, seen };
  };
  for (const argv of [
    ["--is-open", "false", "--is-open"],
    ["--is-open", "--is-open", "false"],
    ["--is-open", "--is-open"],
    ["--cache", "--no-cache"],
    ["--no-cache", "--no-cache"],
  ]) {
    const { program, seen } = build();
    await assert.rejects(program.parseAsync(["flags", ...argv], { from: "user" }), (err: Error) => /may be given only once/.test(err.message), argv.join(" "));
    assert.deepEqual(seen, [], argv.join(" "));
  }
  for (const [argv, expected] of [
    [["--is-open", "false"], { isOpen: false }],
    [["--is-open"], { isOpen: true }],
    [["--no-cache", "--archived", "--archived"], { cache: false, archived: true }],
  ] as const) {
    const { program, seen } = build();
    await program.parseAsync(["flags", ...argv], { from: "user" });
    assert.deepEqual(seen, [expected], argv.join(" "));
  }
});

test("the README's --log-format jsonl example runs as shown: an ERROR record of api for an unknown station (04#1)", async () => {
  const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8");
  const line = /^luftqualitaet (--log-format jsonl .*?) 2>log\.jsonl\s+# (.*)$/m.exec(readme);
  assert.ok(line, "the README has the jsonl example");
  const argv = line[1]!.split(/\s+/);
  const empty = { request: {}, indices: {}, data: {} };
  const cli = makeCli(withCatalogue([143], () => jsonResponse(empty)));
  assert.equal(await run(argv, cli.deps), 4, cli.err.join("\n"));
  const record = JSON.parse(cli.err[0] ?? "{}") as { level?: string; topic?: string; msg?: string };
  assert.deepEqual([record.level, record.topic], ["ERROR", "luftqualitaet.api"]);
  assert.match(record.msg ?? "", /^Station 2 not found: /);
  assert.match(line[2]!, /"topic":"luftqualitaet\.api","msg":"Station 2 not found: …"/);
});

test("a URL with a password anywhere in an argument is redacted on stderr: padded, mid-phrase, dash-led, encoded (T15)", async () => {
  const url = "https://bob:s3cretpw@mirror.example/x";
  const window = ["--date-from", "2024-01-01", "--time-from", "1", "--date-to", "2024-01-01", "--time-to", "24"];
  const cases: string[][] = [];
  for (const value of [` ${url}`, `\t${url}`, `x ${url} y`, ` -${url}`, `de${url}`, encodeURIComponent(` ${url}`)]) {
    cases.push(
      ["components", "--lang", value], // the library's refusal quotes it
      ["thresholds", "--use", value],
      ["airquality", ...window, "--station", value], // commander's echo of a rejected value
      ["airquality", "--date-from", value, "--time-from", "1", "--date-to", "2024-01-01", "--time-to", "24", "--station", "1"],
      [value], // an unknown command
      ["components", value], // a stray argument
    );
  }
  for (const argv of cases) {
    for (const format of [[], ["--log-format", "jsonl"]]) {
      const cli = makeCli(() => jsonResponse(OK_BODY));
      const code = await run([...format, ...argv], cli.deps);
      const err = cli.err.join("\n");
      assert.notEqual(code, 0, argv.join(" "));
      assert.ok(err !== "", argv.join(" "));
      assert.ok(!err.includes("s3cretpw") && !err.includes("bob:"), `${JSON.stringify(argv)}: ${err}`);
      assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    }
  }
});

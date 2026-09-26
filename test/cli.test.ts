import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { LuftqualitaetClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

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

test("measures requires --component and --scope (the API would pick one series)", async () => {
  for (const extra of [[], ["--component", "5"], ["--scope", "2"]]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["measures", ...fullWindow, ...extra], cli.deps);
    assert.equal(code, 1, extra.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /required option '--(component|scope) <id>' not specified/);
  }
});

test("measures forwards component/scope", async () => {
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { name: `Station${controls}`, code: String.fromCharCode(0x1b) + "[31m" };
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

test("meta --use airquality sends the 1/24 hour defaults it validates against", async () => {
  // Upstream fills a missing hour with the *current* hour, which could reverse a
  // window the CLI accepted (e.g. --time-from 20 on one day at 10:00).
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(
    ["meta", "--use", "airquality", "--date-from", "2024-01-01", "--date-to", "2024-01-01", "--time-from", "20"],
    cli.deps,
  );
  assert.equal(code, 0);
  const q = new URL(cli.mt.last().url).searchParams;
  assert.equal(q.get("time_from"), "20");
  assert.equal(q.get("time_to"), "24");

  const none = makeCli(() => jsonResponse({}));
  assert.equal(
    await run(["meta", "--use", "airquality", "--date-from", "2024-01-01", "--date-to", "2024-01-02"], none.deps),
    0,
  );
  const q2 = new URL(none.mt.last().url).searchParams;
  assert.equal(q2.get("time_from"), "1");
  assert.equal(q2.get("time_to"), "24");
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

test("meta rejects --time-from/--time-to without dates", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["meta", "--use", "measure", "--time-from", "1", "--time-to", "5"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /need --date-from and --date-to/);
});

test("meta checks the window for every use, not only airquality", async () => {
  const reversed = makeCli(() => jsonResponse({}));
  assert.equal(
    await run(["meta", "--use", "measure", "--date-from", "2025-01-01", "--date-to", "2024-01-01"], reversed.deps),
    1,
  );
  assert.equal(reversed.mt.calls.length, 0);
  assert.match(reversed.err.join("\n"), /Window start .* is after window end/);

  const half = makeCli(() => jsonResponse({}));
  assert.equal(await run(["meta", "--use", "map", "--date-to", "2024-01-01"], half.deps), 1);
  assert.equal(half.mt.calls.length, 0);
  assert.match(half.err.join("\n"), /go together/);

  const ok = makeCli(() => jsonResponse({}));
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
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--max-retries", "-1", "components"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.mt.calls.length, 0);
  // Reported once, by the real parse (the probe is silenced).
  assert.equal(cli.err.filter((line) => /argument '-1' is invalid/.test(line)).length, 1);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--timeout", "2147483647", "components"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  // Commander parse errors exit 1 in this CLI.
  const over = makeCli(() => jsonResponse({}));
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
        transport: makeMockTransport(() => jsonResponse({})).transport,
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
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--base-url", bad, "networks"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /--base-url/);
  });
}

test("--base-url accepts an http(s) URL", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--base-url", "http://localhost:8080", "networks"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).origin, "http://localhost:8080");
});

test("the default base URL is the API's current host, so no 301 hop is needed", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["scopes"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/scopes/json");
});

for (const [base, hint] of [
  ["https://luftdaten.umweltbundesamt.de/api/air-data/v3", "try https://luftdaten.umweltbundesamt.de)"],
  ["https://www.umweltbundesamt.de/api/air_data/v3/", "try https://www.umweltbundesamt.de)"],
  ["http://mirror.test/uba/api/air-data/v3", "try http://mirror.test/uba)"],
] as const) {
  test(`--base-url ${base} (with the API path) is a usage error with a hint`, async () => {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["--base-url", base, "scopes"], cli.deps), 1);
    assert.equal(cli.mt.calls.length, 0);
    const text = cli.err.join("\n");
    assert.match(text, /Leave out \/api\/air[-_]data\/v3: the base URL is the host, and the CLI adds \/api\/air-data\/v3 itself/);
    assert.ok(text.includes(hint), text);
  });
}

test("--base-url with a path prefix keeps it in front of the API path", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--base-url", "http://mirror.test/uba/", "scopes"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "http://mirror.test/uba/api/air-data/v3/scopes/json");
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["99999999999", false]] as const) {
    const cli = makeCli(() => jsonResponse({}));
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
  const text = cli.err.join("\n");
  assert.match(text, /Hint: the API has no transgressions for some components before 2019/);
  assert.match(text, /Error: HTTP 500/);

  const later = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["transgressions", "--component", "5", "--year", "2019"], later.deps), 1);
  assert.doesNotMatch(later.err.join("\n"), /Hint:/);

  const balances = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["annual-balances", "--component", "5", "--year", "2018"], balances.deps), 1);
  assert.doesNotMatch(balances.err.join("\n"), /Hint:/);
});

test("airquality/measures: an upstream 409 (unknown station) gets a hint, exit 1", async () => {
  for (const cmd of [["airquality"], ["measures", "--component", "5", "--scope", "2"]]) {
    const cli = makeCli(() => rawResponse("<html>conflict</html>", "text/html", 409));
    assert.equal(await run([...cmd, ...withWindowArg({ "--station": "999999" })], cli.deps), 1);
    const text = cli.err.join("\n");
    assert.match(text, /Hint: the API answers an unknown station id with HTTP 409\. Check that station 999999 exists/);
    assert.match(text, /Error: HTTP 409/);
  }
  const other = makeCli(() => jsonResponse({}, 500));
  assert.equal(await run(["airquality", ...fullWindow], other.deps), 1);
  assert.doesNotMatch(other.err.join("\n"), /Hint:/);
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18122/echo?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18122/echo#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18122?", /cannot have a query \(\?\) or fragment \(#\)/],
    [" https://luftdaten.umweltbundesamt.de", /cannot have surrounding whitespace/],
    ["https://luftdaten.umweltbundesamt.de\t", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
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
  assert.match(text, /HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:18122\/s\/404\/api\/air-data\/v3\/components\/json/);
  // The request itself keeps the userinfo (Node sends it as Basic auth).
  assert.match(cli.mt.last().url, /^http:\/\/user:secret@/);
});

test("--user-agent: blank, flag-like, control or non-Latin-1 values are usage errors", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["--compact", /Expected a value, got another option/],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["bot \u2603", /Value contains characters outside Latin-1/],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["--user-agent", ua, "components"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0, JSON.stringify(ua));
    assert.match(cli.err.join("\n"), message, JSON.stringify(ua));
  }
  const ok = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--user-agent", "my-bot/1.0\t(Grüße)", "components"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my-bot/1.0\t(Grüße)");
});

test("--use does not swallow the next option", async () => {
  for (const cmd of ["thresholds", "meta"]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run([cmd, "--use", "--component", "5"], cli.deps);
    assert.equal(code, 1, cmd);
    assert.equal(cli.mt.calls.length, 0, cmd);
    assert.match(cli.err.join("\n"), /Option '--use' requires a value/, cmd);
  }
});

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const deep = () => rawResponse("[".repeat(depth) + "]".repeat(depth), "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["components"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(pretty.err.join("\n"), "Error: The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run(["--compact", "components"], compact.deps);
  if (code === 0) assert.equal(compact.out.join("").length, 2 * depth);
  else assert.equal(compact.err.join("\n"), "Error: The response is nested too deeply to print.");
});

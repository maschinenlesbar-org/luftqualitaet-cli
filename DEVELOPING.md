# Developing & integrating

This document covers `luftqualitaet-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`luftqualitaet`) and a typed API client
(`LuftqualitaetClient`) for the
[Umweltbundesamt Air Data API](https://luftdaten.umweltbundesamt.de/)
(`luftdaten.umweltbundesamt.de/api/air-data/v3`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed parameter objects and the `lang`/`index`/`use` enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the UBA Air Data API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
luftqualitaet --help
```

## Library usage

```ts
import { LuftqualitaetClient, LuftApiError } from "@maschinenlesbar.org/luftqualitaet-cli";

const client = new LuftqualitaetClient(); // defaults to https://luftdaten.umweltbundesamt.de

const components = await client.components({ lang: "de" });
const aq = await client.airquality({
  date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143,
});

try {
  await client.thresholds({ use: "measure" });
} catch (err) {
  if (err instanceof LuftApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new LuftqualitaetClient({
  baseUrl: "https://luftdaten.umweltbundesamt.de", // the host; the client adds API_PATH (/api/air-data/v3)
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 and resets are retried (linear backoff, or a longer Retry-After)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
  bigIntegerKeys: new Set(["_version_"]), // members whose numbers may pass 2^53: delivered as strings
  onWarning: (message) => console.warn(message), // an answer delivered changed (U+FFFD), see Decoding
});
```

The numeric options must be integers in range — `timeoutMs` 0..2^31−1, `maxRetries`
0..`MAX_RETRIES` (10), `retryDelayMs` 0..30 000, `maxRedirects` 0..`MAX_REDIRECTS` (20),
`maxResponseBytes` 0..2^53−1 — or the constructor throws a `LuftValidationError` naming
the option (`Invalid option timeoutMs: expected an integer from 0 to 2147483647, got NaN.`);
so does an options value that isn't an object, and a `transport` or `sleep` that isn't a
function. Every method checks that its parameter object is an object first
(`assertParams`), so a wrong-typed call (`airquality(null)`) is a `LuftValidationError`,
never a raw `TypeError`. Server text in an error message is cut at 500 characters
(`MAX_MESSAGE_TEXT`, `cutForMessage`, which counts code points, so a cut never splits a
character), and so is every other value an own message quotes from a server answer or the
user's input (a redirect target, a Content-Type or charset, a transport's error text, a
rejected parameter value, after its userinfo is cut out), so `err.message` stays bounded
for a library caller; `LuftApiError.body` keeps the whole body.

Every optional field of the option and parameter types (`EngineOptions`, `FilterOptions`,
`ListParams`, `YearComponentParams`, `ThresholdParams`, `MetaParams`) is declared
`?: T | undefined`: a field given as `undefined` means the same as one left out (its
default, or no parameter), so `new LuftqualitaetClient({ baseUrl: process.env.X })`
compiles in a consumer that sets `exactOptionalPropertyTypes`.

**Annual balances vs transgressions.** Both answer "how often was the limit exceeded",
but from different data (UBA's Schnittstellenbeschreibung Luftdaten-API): `annualBalances`
from the final data, published in June of the following year; `transgressions` is the
running year's table from preliminary data and is not updated for a completed year (it
disagrees at 10–35 % of PM₁₀ stations in 2019–2025). `annualDataNote(kind, year, result)`
(exported) returns what to tell the reader — the CLI logs it as an `INFO` record of `luftqualitaet.api` on stderr: a
completed year's transgressions are preliminary and `annual-balances` has the count; an
annual balance without rows comes in June of the following year (`FINAL_DATA_MONTH`).

**Hour order.** `airquality()` and `measures()` return each station's hours in time
order (`inTimeOrder`, exported): the API sometimes lists the newest hours out of order
(`… 10:00, 13:00, 11:00, 12:00`), so the last entry wasn't the newest hour. Only the key
order changes.

**Unknown station ids.** The API answers most unknown station ids like a window without
data (HTTP 200, `data: {}`); only ids far outside the catalogue get HTTP 409. So when
`airquality()` or `measures()` gets an answer without data, it looks the station up in the
catalogue — `meta?use=measure`, whose `stations` object is keyed by id (525 stations, ids
7..10472 on 2026-10-06), one request, only then — and rejects an id it doesn't list with
`LuftNotFoundError` (exported, `.station`; the CLI exits 4). A listed station returns the
empty answer, and `stationDataNote(result, station, series?)` (exported) says the window has no
data (for `measures`, given its component and scope, it names them: an unknown scope or a
component the station doesn't measure gives the same empty answer, and `measures-limits` shows
which station has which series); the CLI logs it as an `INFO` record of `luftqualitaet.api` on stderr (exit 0). A catalogue without a `stations`
object is a `LuftParseError`, and a failing lookup fails the call: no guess either way.
`catalogueHasStation(catalogue, station)` is the check itself. A 409 to the station query
still gets a hint (an `INFO` record) before the error (exit 1); a 409 to the catalogue
lookup gets none, since it says nothing about the station (its ERROR names the
`/meta/json?use=measure` request).

**Unknown parameters.** The API ignores a query parameter it doesn't take and answers as
if it weren't there, so each call checks its parameter object against the keys it
documents (`CALL_PARAMS`, `assertKnownParams`): a misspelled key (`componet`), a key of
another call (`lang` on `measures`) or `__proto__`/`constructor` from parsed JSON is a
`LuftValidationError` before any request. A parameter the API adds later can still be
sent with `{ allowUnknownFilters: true }` as the call's second argument (strings, finite
numbers and booleans only; a `__proto__` key is sent like any other, never dropped). In the CLI, every option takes one value; giving one twice is
a usage error (`forbidRepeatedOptions` in `shared.ts`); so would be a boolean that can be switched
both ways (`--x [bool]`, `--x` / `--no-x`) given twice, of which this CLI has none today.

`userAgent` is checked there too, with the same rule as the CLI's `--user-agent`
(`headerValueProblem`, also exported as `assertHeaderValue(name, value)`): a blank value,
a control character other than tab (CR/LF included), DEL or a character above U+00FF
throws a `LuftValidationError` (`Invalid userAgent: Value contains control characters.`)
instead of reaching a custom transport or failing at request time with Node's raw
`TypeError`. Only an omitted `userAgent` selects the default.

The methods check their parameters before any request, like the CLI: dates as real
`YYYY-MM-DD` calendar dates, hours `1..24`, a window in order, positive integer ids,
`year >= 2016`, and `lang`/`index`/`use` from their value sets. A closed value is a token
(`tokenProblem`, `normalizeToken`, both exported): refused when blank or holding only invisible
characters or combining marks, a lone surrogate, or any control or format character (a
zero-width space, a soft hyphen, a bidi control); otherwise sent trimmed and in NFC, so `" de "`
sends `de` (`DE` is still refused: case is not folded). A refused value is quoted visibly
(`quoteValue`, in `errors.ts`, re-exported by `engine.ts`: `Invalid lang: "d\u200be" contains an
invisible or control character (U+200B).`); so is a value an own message quotes (`assertKnownParams`'s
parameter name included). The kit's `textProblem`/`normalizeText` and `splitList`/`listProblem`
are exported too; the API takes no free text and no list, so nothing uses them yet. The CLI's
value parsers of ids, hours, years and dates run `tokenProblem` first (`assertToken` in
`shared.ts`), so a typed invisible character is named, not only "Expected a positive integer",
and commander's own echo of a rejected value escapes the invisible format characters
(`escapeCommanderError` in `run.ts`). A bad value is a
rejected promise with a `LuftValidationError` (a `LuftError`; `Invalid time_to: expected
an hour from 1 to 24, got 99.`), and no request is sent. The checks (`assertDate`,
`assertHour`, `assertId`, `assertWindow`, `assertYear`, `MIN_YEAR`) are exported, as is
`assertValid(name, value, problem)` with its `Problem` type: a rule is a pure function
that returns the reason a value is invalid (or `undefined`), and `assertValid` throws
`LuftValidationError` with `Invalid <name>: <reason>`. The CLI uses the same rules and
keeps no copies: its commands pass the parsed options to the client, which checks the
window order, the `meta` window pairing and the `lang`/`index`/`use` value sets, and
`run()` logs the library's message as an `ERROR` record of `luftqualitaet.cli` and maps a `LuftValidationError` to the
usage-error exit code `1`. A half `meta` window reads `Invalid meta window: date_from
and date_to go together; give both, or neither.`

`measures()` requires `component` and `scope` (both required in `MeasuresParams`):
the response holds one series, and without them the API would pick one itself, so a
call without either is a `LuftValidationError`.

`meta({ use: "airquality" })` without both `date_from` and `date_to` is a
`LuftValidationError` (`Invalid meta window: use=airquality requires date_from and
date_to.`), as the API needs a window for that bundle; the CLI's `meta` reports the
same error. `meta()` fills in omitted window hours when dates are given: `DEFAULT_META_TIME_FROM`
(`1`) and `DEFAULT_META_TIME_TO` (`24`, both exported). It checks the window with them
and sends them, because the API would otherwise use the current hour and could reverse
a window that passed the check. The CLI's `meta` passes its options straight through.

### Methods

`airquality`, `airqualityLimits`, `measures`, `measuresLimits`, `annualBalances`,
`transgressions`, `components`, `networks`, `scopes`, `stationTypes`, `stationSettings`,
`transgressionTypes`, `thresholds`, `meta`. The `LangValues` / `IndexValues` /
`MetaUseValues` / `ThresholdUseValues` enums are exported for reference.

## Architecture

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/luftqualitaet-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/luftqualitaet-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/luftqualitaet-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { LuftqualitaetClient } from
  "@maschinenlesbar.org/luftqualitaet-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/luftqualitaet-client/internal/engine`) for what the
  CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    enums.ts     # Lang / IndexKind / MetaUse / ThresholdUse value sets
    types.ts     # parameter objects (responses kept as faithful JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (cross-origin headers stripped), JSON decoding, error mapping
    errors.ts    # LuftError / LuftApiError / LuftNetworkError / LuftParseError / LuftValidationError
    validate.ts  # the parameter rules (Problem, assertValid, assertDate, ...)
    client.ts    # LuftqualitaetClient — the air-data surface over the engine
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # reference lists + data endpoints
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- UBA responses are index/data structures whose exact shape varies by endpoint, so they are returned
  as faithful raw `JsonObject`s rather than partially-guessed types.
- Rendering (`renderJson` in `shared.ts`): an answer that can't be printed is an
  `OutputError`, an ERROR record of `luftqualitaet.output` (exit 1) that names the cause:
  `The answer is nested too deeply to pretty-print.` or `The answer is too large (more than
  536870888 characters of JSON) to pretty-print.` (`… to print.` with `--compact`). It adds
  `; try --compact` only when the compact form of this very answer prints (`compactPrints`,
  probed, never assumed: V8's compact fast path is iterative on Node 26, but only for an answer
  without integer-like keys, and every UBA answer has them, `"1"` and the station ids).
  `--compact` takes V8's fast path (`JSON.stringify` without a gap) unless the answer holds a
  string or key of 64 Mi characters or more (`holdsHugeString`: iterative, linear, an array
  walked by index and an object by `for…in`, no allocation per value; `Object.entries` made a
  pair per element and cost 3–7× the time and memory of the print itself): on Node 26 the
  fast path aborts the process on a ~250 MB string, so such an answer goes through the gap
  path (an empty gap, the same text). The printed JSON escapes what `JSON.stringify` leaves raw
  although a terminal acts on it (`escapeControlChars`): DEL, the C1 range U+0080–U+009F and
  the bidi controls (`isBidiControl`, exported: U+061C, U+200E, U+200F, U+202A–U+202E,
  U+2066–U+2069), so a station name with U+202E prints as `\u202e`. Each such character becomes
  six, so the output is measured first: one longer than V8's longest string is an
  `OutputError` (`The answer is too large to print (N characters once its control characters
  are escaped).`, exit 1), before anything is built; otherwise it is built in chunks of 64 Ki
  characters and joined once (one `+=` per character made a rope of 100 M pieces, and 90 MiB of
  DEL ended in a heap out-of-memory crash, exit 134).

## Library / technical terms

**API client.** [`LuftqualitaetClient`](packages/client/src/client.ts) — the typed
wrapper over the Air Data API. Usable as a library independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client's resource methods and the transport.
`DEFAULT_BASE_URL` is `https://luftdaten.umweltbundesamt.de`; the client appends
`API_PATH` (`/api/air-data/v3`), both exported. The old `https://www.umweltbundesamt.de`
+ `/api/air_data/v3` answers every request with a permanent 301 to that host and path.
The client constructor rejects a `baseUrl` that already ends in the API path (either
spelling) with a `LuftValidationError` naming the host to use instead
(`baseUrlApiPathProblem`, exported); the CLI's `parseBaseUrl` uses the same rule.

**RawResponse.** The low-level result of a request: `{ data: Buffer,
contentType, status }` — raw bytes, never lossily decoded.

**AirDataResult / JsonObject.** The faithful raw-JSON type returned by every
client method, reflecting the API's variable index/data layout.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `LuftApiError` (non-2xx,
carries `status`/`detail`), `LuftNetworkError` (transport failure/timeout, and the default transport's
per-hop scheme check; a bad configured `baseUrl` is a `LuftValidationError` instead),
`LuftParseError` (bad JSON) and `LuftValidationError` (a rejected input, thrown before
any request), all extending `LuftError`. The CLI maps a `404` to exit code `4`, a
`LuftValidationError` to the usage-error code `1`, other errors to `1`.

**Query builder.** [`buildQueryString`](packages/client/src/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `--max-retries` (`0..MAX_RETRIES` = `0..10`, default `2`).
Each retry waits `retryDelayMs * attempt` (linear backoff, `retryDelayMs` `0..30000`,
default 200), or the response's `Retry-After` when that is longer (`parseRetryAfter`:
delay-seconds or an IMF-fixdate; anything else is ignored) — the header can lengthen a
wait, never shorten it, so `Retry-After: 0` or a past date is no burst. A `Retry-After`
above `MAX_RETRY_AFTER_MS` (30 s) is not retried: the `LuftApiError` surfaces at once,
says so ("the server asked to retry after 3600 s, longer than the 30 s the client waits;
not retried") and carries `retryAfterMs`; after spent retries the message ends
"(after N retries)" and `retries` holds the count. A GET whose connection was reset (`ECONNRESET`, `EPIPE`,
`ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the error's `cause` chain;
`isTransientNetworkError`) is retried the same number of times, after
`retryDelayMs * attempt`; a refused connection, a DNS failure or a timeout is not.
Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`luftqualitaet.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only,
whole seconds, ms under 1 s). Tests: `packages/client/test/engine.test.ts`, `apps/cli/test/retry-log.test.ts`.

**Redirects.** The engine follows up to 5 HTTP redirects by default (the
`maxRedirects` option / `--max-redirects` flag; `0` disables following). On a
**cross-origin** redirect it strips request headers (re-adding only the benign
`Accept` / `User-Agent`) so nothing leaks to a different origin.

The one credential the client can send is the userinfo of a base URL you set
(`https://user:pw@mirror/`, for a proxy or mirror behind a login). The engine never puts it
into the URL a transport sees: it sends it as an `Authorization: Basic` header per hop. A
redirect to the same origin (scheme, host and port), with a relative or an absolute
`Location`, keeps it; one that crosses an origin boundary drops it, and a `401`/`403` from
the target then says so ("the server redirected http→https, which dropped the base URL's
credentials; use an https base URL"). Userinfo in a `Location` is never used. Transports
are told `redirect: "manual"` (`HttpRequest.redirect`): the engine follows redirects
itself, and a response whose `HttpResponse.url` lies on another origin (a fetch transport
that followed one) is rejected as a `LuftNetworkError`.

**maxResponseBytes.** A hard cap on response body size (default 100 MiB; `0` =
unlimited) that defends against memory exhaustion from a hostile or buggy
endpoint. CLI: `--max-response-bytes`.

**Decoding.** A JSON body is decoded by the charset its `Content-Type` declares
(UTF-8 when it names none) with `TextDecoder`, which also drops a leading byte order
mark; an unknown charset label is a `LuftParseError`. Text is never changed silently: bytes
that aren't valid in the answer's charset and lone surrogates written as JSON escapes
(`\ud800`) become U+FFFD (the result is well-formed, so `jq` reads the CLI's output), and the
engine option `onWarning` gets one message naming the count and the request (`GET <url>: 2
characters of the answer were not valid text (invalid bytes or a lone surrogate) and replaced
with U+FFFD.`); the CLI's `action()` logs it as a `WARN` record of `luftqualitaet.api`. One
bad character never sinks a whole answer. A body too large to become one string (512 MB and
more, possible only with `maxResponseBytes: 0` or `--max-response-bytes 0`) is a
`LuftParseError`, `GET <url>: the answer is too large to read as text (N bytes; the longest
string is 536870888 characters).`, not a plain `Error` ("Unexpected error" in the CLI); an
error status with such a body keeps its `LuftApiError`, without the body. Every 2xx body must then have the
envelope its endpoint documents (`responseShapeProblem`, exported, with the shapes
`list`: `count` + `indices`; `window`/`limits`: `request` + a `data` object; `annual`:
`request` + `indices` + `data` rows; `meta`: `request`): `null`, `{}`, an error object or
a proxy's page is a `LuftParseError` (CLI exit `1`), never data or an empty result read as
"nothing found", and so is an empty body. Every error about an answer names the request, as
the network errors do: `GET <url>: …`, the URL absolute and without the base URL's userinfo
(`describeUrl`): `GET <url>: unexpected response shape: expected a numeric count. The server
may be down or behind a proxy.`, `GET <url>: the answer is not valid JSON (expected JSON, got
Content-Type "text/html").`, `GET <url>: empty response body.`, `GET <url>: unsupported
response charset "…".` and `GET <url>: unexpected station catalogue: expected a stations
object.` A number `JSON.parse` can't carry exactly is a `LuftParseError` too, never a
changed value (`GET <url>: the number <N> cannot be represented exactly.`,
`firstInexactNumber`): one out of a double's range (`1e400`, which would print as
`null`), one past 2^53 in any written form (`12345678901234567890`, `…890.0`,
`9007199254740993e0`, `9007199254740992.5`), a non-zero one too small for a double
(`1e-400`, which would become 0), and a subnormal one (below 2.2250738585072014e-308, where a
double has fewer significant digits) that would print as another number (`3e-324`, which
would print as `5e-324`). Past 2^53 and in the subnormal range the check compares the number
as it would print (`String(value)`) with the number as written, so a double a server wrote in
its shortest form (`1E23`, `1.7976931348623157E308`, `5e-324`, `1e-310`) passes, while
`12345678901234567890` (which prints as `…7000`) is refused. Between them a decimal fraction
keeps a double's precision, so the measured values (`17.384`) pass unchanged. A member named
in the engine option `bigIntegerKeys` (a set or list of non-empty member names, copied; default
none, and this client declares none: the API sends ids and values as strings or small numbers)
is the one exception: its number value is delivered as its exact literal, as written, as a JSON
string (`"1858054135406919680"`, `"5"`), whatever its size, so its type is stable. The engine
does both in one linear scan of the text before `JSON.parse` (`scanNumbers`, which quotes the
declared values in place; no reviver).

**The transport contract, enforced by the engine.** `timeoutMs` and `maxResponseBytes`
hold for every transport, not only the built-in one: the engine runs each transport call
under the overall deadline (it passes an `AbortSignal` in `HttpRequest.signal`, which the
built-in transport honours and a fetch transport should pass on, and rejects at the
deadline either way) and checks the size of the body it gets back. Response headers are
read in any case and from a `Headers` object or a `Map` too; the body may be a `Buffer`,
any `ArrayBuffer` view (fetch's `Uint8Array`) or an `ArrayBuffer`. Whatever a transport
throws, and a response without a valid status, headers object or body, becomes a
`LuftNetworkError`. A redirect to a scheme other than `http:`/`https:` is refused before
the transport is called.

**`--base-url` validation.** The base URL is checked at three points. The engine
constructor checks the raw configured value, before trailing slashes are stripped, with
the exported `validateBaseUrl` (rule: `baseUrlProblem`, the same one the CLI's
`--base-url` uses): a value that does not parse (`notaurl`, `""`), a scheme other than
`http:`/`https:` (`file:///etc/passwd`, `ftp://…`), a query (`?`) or fragment (`#`) —
paths are appended to the base URL as a string, so they would swallow every request
path — and surrounding or inner whitespace or control characters (`new URL()` would hide
them, while the raw string is joined to each path), and a `%` in the user name or password
that doesn't start an escape (write a literal `%` as `%25`) each throw a `LuftValidationError`
(`Invalid baseUrl: <reason>`). That is a configuration error, not a `LuftNetworkError`,
and it holds for a library consumer that injects a custom transport too. Only an
omitted `baseUrl` selects the default. The client constructor adds the API-path rule
(`baseUrlApiPathProblem`, above). `--base-url`'s value parser (`parseBaseUrl` in
[`shared.ts`](apps/cli/src/cli/shared.ts)) calls the same two rules, so a bad value is a usage
error at parse time, before any client is built. And the default transport
([`http.ts`](packages/client/src/http.ts)) gates the scheme on **every redirect hop**, as a
`LuftNetworkError`. Userinfo (`http://user:secret@mirror/`) is allowed — the engine sends
it as Basic auth (see **Redirects**) and request URLs in messages and `LuftApiError.url`
carry none — and `redactUrl` (exported from [`errors.ts`](packages/client/src/errors.ts))
shows it as `***@` in every error message and in `LuftApiError.url`; the base-URL
reasons never echo the URL, and a rejected parameter value is quoted with its userinfo
cut out. The CLI also redacts on output: `run.ts` (`redactionFor`, `withRedactedOutput`)
takes the exact userinfo of every URL argument (`credentialsIn`, exported) and replaces it
with `***` in everything it prints — commander's usage errors, which echo rejected values,
and the library's messages for `--lang`/`--use`/`--index` — so a password with spaces,
quotes, `#`, `?` or `/` is caught as well as an ordinary one. A URL counts wherever it
starts in an argument (`urlsWithin`: padded, after a dash, inside a phrase), and in an
argument's percent-decoded form too, and the userinfo is also replaced in its percent-encoded
form. Each `://` is found with `indexOf` and its scheme by walking back, so the search stays
linear in a long argument, and at most 64 URLs are read from one argument. Only a URL with a scheme counts (a bare `a:b@c` is a User-Agent or a typed value as
often as a credential), except as the `--base-url` value, where a `user:password@host` typed without its scheme is
still a credential. The log replaces them in each
record's *message*, before the record is cut and escaped, and writes it to the raw stderr:
the frame (time, level, topic) is never touched, and a password with DEL, C1 or bidi
characters is matched in its raw form. `redactUrl` falls back to the same
text-based cut (`redactCredentials`, exported) for a value that doesn't parse as a URL.
The engine keeps the base URL in a real `#private` field, so `console.log(client)`,
`util.inspect` and `JSON.stringify` never show it, and it scrubs the base URL's userinfo
(raw and percent-decoded) from error bodies and details, a redirect `Location` it can't
parse, a custom transport's error text and the `cause` chain — and with it the forms a
server echoes it back in (`echoedCredentialForms`, exported): the `Authorization: Basic`
value, the decoded `user:password`, and the password alone from 4 characters on
(`redactSecrets`). The CLI replaces the Basic value and the pair on stdout and stderr, the
bare password on stderr only (on stdout a short password may well occur in the data). Whatever a custom transport
throws reaches the caller as a `LuftNetworkError` (`GET <url> failed: <reason>`, the
original as `cause`), and so does every network failure of the default transport and the
engine: a timeout (`… failed: Request exceeded the 5000ms deadline`), the size cap, a
refused connection (`… failed: connect ECONNREFUSED 127.0.0.1:9`), a DNS failure and a
reset, the URL with its userinfo redacted, so a caller making several calls can tell which
one failed.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`),
everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`types.test.ts`** — compiles a consumer file with `exactOptionalPropertyTypes` against the
  built declarations (starts `tsc`, 30 s), and checks that every option given as `undefined`
  means its default.
- **`client.test.ts`** — a parameterized table over all 15 client methods asserting URL/query mapping plus parameter pruning — mocked transport.
- **`validate.test.ts`** — `assertValid`, `LuftValidationError` and its exit-code mapping, and the `parity()` helper.
- **`parity.test.ts`** — CLI ↔ library parity: one input through `run()` and through the library call on one recording mock transport (`parity()` in `apps/cli/test/helpers.ts`), asserting the same outcome.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`, `installWarningLog`); the CLI-level checks are
  P23's. `io.test.ts` tests `handleOutputErrors` and `stderrAfterStdout` with fake streams
  (a closed pipe, a stdout write error as a record, a record held behind stdout's backlog).
- **`cli.test.ts`** — end-to-end command parsing, domain validation (hour `1..24`, year `>= 2016`, positive ids, date format, conditional `meta` window) and exit codes — mocked client.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (fix plan
  `.reviews/2026-10-05-exploratory/fix-plan.md` in the workspace), one file per pattern, the same
  code in every repo apart from an adapter block at the top: P1 credential redaction in CLI output,
  P2 in library objects and errors, P3 credentials across redirects, P4/P19 base-URL validation
  (P19 skipped: no environment variable here), P5 the transport contract (timeout, size cap, body
  types, header shapes, resets), P6 the retry floor, P7 pipes and exit codes (spawns the built
  bin), P8/P9/P13 charset, 2xx envelopes and error classes, P10 unknown parameters, repeated
  options and the empty-answer note. The follow-up round of 2026-10-06 added P20 (a remote
  plain `http:` base URL gets one `WARN` record of `luftqualitaet.http` on stderr from the library's
  `cleartextProblem`, printed by `action()` in `shared.ts` before the client is built; no
  base-URL variable and no secret but the URL's own credentials here, so those two cases are
  skipped) and P21 (every relative link in `README.md` points to a file `package.json` `files`
  ships, since npmjs.com shows the README; other documents are linked by their GitHub URL).
  The kit rollout of 2026-10-21 added P24 (an input is canonicalised or refused, never sent
  raw: no text filter here, so its text case has no inputs; the station and component ids,
  query parameters, stand in for the path ids) and P25 (a number a double can't carry, and an
  empty answer, are errors on both sides; a number it carries prints as the same value). P26
  (output integrity) runs its stdout case only (`HAS_OUTPUT_OPTION = false`: there is no `-o`):
  stdout redirected to a file under `ulimit -f` exits 1 with an ERROR record of
  `luftqualitaet.output`. The fix plan of the 2026-10-21 sweep added
  P27 (a big or odd answer is printed or refused in one clean record, within memory: a large
  flat answer prints with `--compact` under a 256 MB heap, 20 MB of DEL print escaped under a
  512 MB heap, and 90 MB of DEL, too large once escaped, are an ERROR record of
  `luftqualitaet.output`; a lone surrogate or invalid bytes become U+FFFD with a `WARN` record
  of `luftqualitaet.api`; the memory cases start the built bin, 30 s).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/luftqualitaet-cli/> in English and
<https://maschinenlesbar.org/luftqualitaet-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/luftqualitaet-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `luftqualitaet.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`,
exported from `errors.ts`), and a message longer than `MAX_RECORD_MESSAGE` (4000
characters, exported) is cut at a code point and ends in `… (N more characters)`. The library's error messages keep a server's line
breaks and bidi controls, which the record escapes; every other C0 control (tab kept), DEL and
C1 are removed from server text first (`sanitizeServerText`: an error `detail`, a Content-Type,
a charset, a redirect target, a transport's reason), so a server's ESC never shows as `\u001b`
either: it is gone, and the printable rest of its sequence (`[31m`) stays as text. That is the
deliberate defence: a server's text must not drive the terminal. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the API's answers: HTTP errors, an unknown station, text replaced with U+FFFD, a malformed answer — a
`LuftParseError`: bad JSON, the wrong shape or content type, an unknown charset, a station
catalogue without stations — and the notes and hints about an answer — `annualDataNote`,
`stationDataNote`, the 409/500 hints), `http` (the
connection, the cleartext warning, one WARN per retry before it waits) and `output` (an answer too deep or too large to print, a failed or cut-short write to stdout). A failed write
to stdout other than a closed pipe (`handleOutputErrors`, in the bin shim, outside `run()`)
is an ERROR record of `luftqualitaet.output` (`Could not write to stdout: …`; with stdout a
regular file, `defaultIO.out` writes through `stdoutWriter`, every byte with `writeSync` in a
loop, so a write a full disk or a file-size limit cuts short, EFBIG or ENOSPC, is that error
and exit 1, never a shortened file with exit 0; a pipe or a terminal goes through the stream as
before), and the
shim's last-resort `Unexpected error: …` an ERROR of `luftqualitaet.cli`, both in the
format argv asks for and redacted like the run's log (`processLogger`), and so are Node's
own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`), WARN records of
`luftqualitaet.cli`: the shim installs `installWarningLog`, which removes Node's default
`warning` listener and logs `(node) <name>: <message>`. In `defaultDeps` a record waits for
stdout (`stderrAfterStdout`): it is held while stdout has a backlog and written, in order,
once it is gone, so with `2>&1 |` and a slow reader it never lands inside the data. Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it (`logFormatFromArgv`, used only for the records of a parse error: it takes the
first `--log-format`, the one `forbidRepeatedOptions` keeps, and skips the value of the
program's own value options, as commander does; a `preAction` hook then sets the format
commander parsed, so `--user-agent --log-format=jsonl` logs text), so commander's own usage
errors are records too: its `error: …` an ERROR of
`cli` (a `(Did you mean …?)` line joined to it), the help it shows after one an INFO
record per line, and `help` for an unknown command an ERROR "missing command:
`luftqualitaet <subcommand>`" before that help, so every failed run has an ERROR record
(`writeCommanderErr`). The log is built with the run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it is
escaped: the frame is never touched, and a secret is kept out of the log in either format. `CliDeps.now` makes the
timestamps testable. stdout carries data only. Conformance test P23 checks all of this,
and its body is shared across the *-cli repos (here with the `USAGE_EXIT` switch: a
usage error exits 1). Since the fix plan of the 2026-10-09 sweep it also checks that a
record is one line with nothing raw, well-formed and bounded, a secret is replaced in the
message only, commander's help is one record per line, every failure has an ERROR, the
format is commander's, a malformed answer is `api`, credentials a server echoes are
replaced and an `a:b@c` value is no credential. Its adapter sets `HELP_AFTER_ERROR = true`,
`BASE_URL_USERINFO = true` (the base URL's userinfo is sent as Basic auth) and
`OUTPUT_OPTION = undefined` (no `-o`).

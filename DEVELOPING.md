# Developing & integrating

This document covers `luftqualitaet-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`luftqualitaet`) and a typed API client
(`LuftqualitaetClient`) for the
[Umweltbundesamt Air Data API](https://www.umweltbundesamt.de/api/air_data/v3)
(`umweltbundesamt.de/api/air_data/v3`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed parameter objects and the `lang`/`index`/`use` enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the UBA Air Data API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
luftqualitaet --help
```

## Library usage

```ts
import { LuftqualitaetClient, LuftApiError } from "@maschinenlesbar.org/luftqualitaet-cli";

const client = new LuftqualitaetClient(); // defaults to https://www.umweltbundesamt.de

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
  baseUrl: "https://www.umweltbundesamt.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`airquality`, `airqualityLimits`, `measures`, `measuresLimits`, `annualBalances`,
`transgressions`, `components`, `networks`, `scopes`, `stationTypes`, `stationSettings`,
`transgressionTypes`, `thresholds`, `meta`. The `LangValues` / `IndexValues` /
`MetaUseValues` / `ThresholdUseValues` enums are exported for reference.

## Architecture

```
src/
  client/
    enums.ts     # Lang / IndexKind / MetaUse / ThresholdUse value sets
    types.ts     # parameter objects (responses kept as faithful JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (cross-origin headers stripped), JSON decoding, error mapping
    errors.ts    # LuftError / LuftApiError / LuftNetworkError / LuftParseError
    client.ts    # LuftqualitaetClient — the air-data surface over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr)
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

## Library / technical terms

**API client.** [`LuftqualitaetClient`](src/client/client.ts) — the typed
wrapper over the Air Data API. Usable as a library independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client's resource methods and the transport.
`DEFAULT_BASE_URL` is `https://www.umweltbundesamt.de`.

**RawResponse.** The low-level result of a request: `{ data: Buffer,
contentType, status }` — raw bytes, never lossily decoded.

**AirDataResult / JsonObject.** The faithful raw-JSON type returned by every
client method, reflecting the API's variable index/data layout.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `LuftApiError` (non-2xx,
carries `status`/`detail`), `LuftNetworkError` (transport failure/timeout),
`LuftParseError` (bad JSON), all extending `LuftError`. The CLI maps a `404` to
exit code `4`, other errors to `1`.

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, and encodes spaces as `%20` (not `+`).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with linear backoff, up to `--max-retries` (default `2`).

**Redirects.** The engine follows up to 5 HTTP redirects. On a **cross-origin**
redirect it strips request headers (re-adding only the benign `Accept` /
`User-Agent`) so nothing leaks to a different origin.

**maxResponseBytes.** A hard cap on response body size (default 100 MiB; `0` =
unlimited) that defends against memory exhaustion from a hostile or buggy
endpoint. CLI: `--max-response-bytes`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — a parameterized table over all 15 client methods asserting URL/query mapping plus parameter pruning — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, domain validation (hour `1..24`, year `>= 2016`, positive ids, date format, conditional `meta` window) and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

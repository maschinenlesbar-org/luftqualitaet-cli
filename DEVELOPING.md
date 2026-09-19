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

**Redirects.** The engine follows up to 5 HTTP redirects by default (the
`maxRedirects` option / `--max-redirects` flag; `0` disables following). On a
**cross-origin** redirect it strips request headers (re-adding only the benign
`Accept` / `User-Agent`) so nothing leaks to a different origin.

**maxResponseBytes.** A hard cap on response body size (default 100 MiB; `0` =
unlimited) that defends against memory exhaustion from a hostile or buggy
endpoint. CLI: `--max-response-bytes`.

**`--base-url` scheme validation.** The scheme is checked at three points.
`--base-url` has a value parser (`parseBaseUrl` in
[`shared.ts`](src/cli/shared.ts)), so a malformed or non-`http:`/`https:` value
(`notaurl`, `file:///etc/passwd`, `ftp://…`) is a usage error at parse time, before
any client is built, as in the sibling CLIs. The engine constructor re-checks the
configured base URL (`assertHttpScheme` in [`engine.ts`](src/client/engine.ts)) and
throws a typed `LuftNetworkError`, so a library consumer that injects a custom
transport can never hand it a non-http(s) base URL. And the default transport
([`http.ts`](src/client/http.ts)) gates the scheme on **every redirect hop**.

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
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/luftqualitaet-cli/> in English and
<https://maschinenlesbar-org.github.io/luftqualitaet-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/luftqualitaet-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

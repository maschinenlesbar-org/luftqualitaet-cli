# luftqualitaet-cli

A TypeScript **API client** and **command-line interface** for the open
[Umweltbundesamt Air Data API](https://luftqualitaet.api.bund.dev/)
(`umweltbundesamt.de/api/air_data`) — German **air-quality** measurements,
indices, annual balances, exceedances and the station/component metadata behind them.

> This client targets `/api/air_data/v3`, the live API path, which supersedes the
> **v2** OpenAPI spec published at [luftqualitaet.api.bund.dev](https://luftqualitaet.api.bund.dev/).

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed parameter objects and the lang/index/use enums.
- **Tested** — unit tests on Node's built-in test runner (`node --test`); every HTTP response is mocked (no real network in the suite).
- **Read-only, no auth** — the UBA Air Data API needs no key; this client only reads.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
luftqualitaet --help
```

---

## How the API works

UBA responses are **index + data** structures: an `indices` array names the
columns and the payload is a compact map keyed by id/code/timestamp. This client
returns those payloads faithfully (as JSON) and focuses on getting the request
right. Look up station ids and component ids via `meta`, `components`, etc.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://www.umweltbundesamt.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options may be given either before or after the command, e.g.
`luftqualitaet --compact components --lang de` or `luftqualitaet components --compact --lang de`.

### Commands

```text
# Reference lists
components | networks | scopes            [--lang de|en] [--index id|code]
station-types | station-settings | transgression-types   [--lang de|en]

# Data (a time window is date-from/time-from .. date-to/time-to, hour 1..24)
airquality        --date-from --time-from --date-to --time-to --station
airquality-limits
measures          --date-from --time-from --date-to --time-to --station [--component] [--scope]
measures-limits
annual-balances   --component --year [--lang] [--index]
transgressions    --component --year [--lang] [--index]
thresholds        --use airquality|measure [--lang] [--component] [--scope]
meta              --use airquality|measure|transgression|annualbalance|map [--lang] [--date-from --date-to]
```

### Examples

```bash
# Components (pollutants) in German, keyed by code
luftqualitaet components --lang de --index code

# Air-quality index for station 143 on one day
luftqualitaet airquality --date-from 2024-01-01 --time-from 1 \
  --date-to 2024-01-01 --time-to 24 --station 143

# Annual PM10 (component 1) balance for 2023
luftqualitaet annual-balances --component 1 --year 2023 --lang de

# Metadata needed to pick stations/components for a measurement query
luftqualitaet meta --use measure --lang de
```

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error, non-zero for usage errors.

---

## Library usage

```ts
import { LuftqualitaetClient, LuftApiError } from "luftqualitaet-cli";

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

---

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

---

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

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.

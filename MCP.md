# luftqualitaet-mcp

An [MCP](https://modelcontextprotocol.io/) server for the German Environment Agency's
(Umweltbundesamt, UBA) [Air Data API](https://luftdaten.umweltbundesamt.de/api/air-data/v3/doc):
about 440 active air-quality monitoring stations, the hourly air-quality index
(Luftqualitätsindex), measured pollutant series, and the yearly balances and limit-value
exceedances, as tools for AI agents. Read-only, no API key. The data is under the Datenlizenz
Deutschland – Namensnennung 2.0 (see Licence).

It is the MCP side of [luftqualitaet-cli](https://github.com/maschinenlesbar-org/luftqualitaet-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/luftqualitaet-mcp
```

This installs the **`luftqualitaet-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/luftqualitaet-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add luftqualitaet -- luftqualitaet-mcp
# or with the image:
claude mcp add luftqualitaet -- docker run -i --rm ghcr.io/maschinenlesbar-org/luftqualitaet-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "luftqualitaet": { "command": "luftqualitaet-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "luftqualitaet": { "type": "stdio", "command": "luftqualitaet-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
luftqualitaet-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http luftqualitaet http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/luftqualitaet-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/luftqualitaet-cli/releases) instead of
`latest`: `…/luftqualitaet-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/luftqualitaet-mcp:<version> --repo maschinenlesbar-org/luftqualitaet-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findStations` | The numeric station ids every other tool needs, from a town, a Land, a station type or setting, or a point (nearest first); closed stations left out and counted. |
| `getAirQualityReport` | A station's air-quality index over CET days, decoded: the level in words and the driving pollutant per hour, the worst level and when, the hours per level, the newest complete hour, a line per day. By station id, or by a place with one station (several are reported, never guessed). |
| `rankStations` | Stations ranked by a pollutant's figure for a year (limit-value exceedances or the annual mean), with names, towns, types and Länder, read against the EU limit. |
| `getMeasurements` | One pollutant's measured values at a station, in one averaging, newest first, with the minimum, maximum and mean. |
| `getIndexBands` | The concentration bands behind each index level of a pollutant. |
| `listComponents` | The pollutants with their ids, formulas and units, and the averaging scopes. |

Times are CET (UTC+1) all year and hour-ending, as the API sends them: in summer German clocks are
an hour ahead. The index is a worst-case scale from 0 (very good) to 4 (very poor): the tools give
the worst level and its driving pollutant, never an average. An unknown station id is looked up in
the station catalogue and said to be one; an empty window does not mean clean air. The catalogue
(about 540 KB) is downloaded once an hour, not on every call. A completed year
is ranked on the annual balance (UBA's final data, published in June of the following year), the
running year on the preliminary exceedance table; the two are never mixed, and the column is chosen
by UBA's own text, not by its position.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data; an answer a redirect fetched from another
host says so there: "… (answered by https://other.example after a redirect)", and a WARN record
names both) and the data licence. A text over 2000 characters is cut and ends in `…[cut, N
characters in all]`, and the answer says `truncated`. An answer over `--max-result-chars` first
loses entries from the end of its page (then `nextOffset` says where to go on), then has its longest
texts cut further (each with that mark) or, when that isn't enough, its other lists shortened
(`reason` names them); a list keeps its first entry, `notes` stay whole (as do the lists a tool
keeps whole, a part of which would be wrong data), and the answer says `truncated`. One that can't
be cut down so far is a tool error that says to ask for less. An answer from the source over 16 MiB,
the most the server reads, is a tool error that says so: narrower options don't make it smaller. A
failure is a tool error that says what to change (one over 5000 characters loses its middle, never
its end, where the reason is).

The API's version 3 is to be retired on 1 February 2027; until then it answers some requests with
HTTP 410 (a "brownout"). The server asks such a request once more; a second 410 is a tool error
that says it is the brownout: call again.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API host (default https://luftdaten.umweltbundesamt.de; the client adds /api/air-data/v3)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After
  asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool
  that has read part of its answer by then may answer with that part, and says so). A request those
  limits would hold longer than it or its call may wait is not sent: the call fails at once, naming
  the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes
  equal to another stays, as `name~2`), but it is still other people's text: a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/luftqualitaet-cli/blob/main/LICENSING.md)).
Data: the Umweltbundesamt's, under the
[Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0)
(dl-de/by-2-0): commercial and non-commercial use, copying, distribution and modification are
allowed, provided the source is credited with the provider, the licence and its link, and a
reference to the data, and changes are disclosed
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/luftqualitaet-cli/blob/main/DATA_LICENSE.md)).
Every result carries that Quellenvermerk in its `licence` field, with "eigene Bearbeitung": the
tools decode, summarise and rank the data. Current-year data is provisional (vorläufig geprüft);
the checked data follows in June of the next year. We provide the tool, not the data.

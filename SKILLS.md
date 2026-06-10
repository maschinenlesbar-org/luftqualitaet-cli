# luftqualitaet-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
German air-quality intelligence, all powered by the **[luftqualitaet](README.md)** CLI
over the open [Umweltbundesamt Air Data API](https://www.umweltbundesamt.de/api/air_data/v3)
(`umweltbundesamt.de`).

Each skill teaches Claude how to drive the `luftqualitaet` CLI to answer a specific,
real-world question — "which station covers Berlin?", "what's the air quality there
right now?", "which cities had the worst NO₂ last year?" — and to report the answer with
evidence rather than guesswork. They encode the parts that are easy to get wrong (the
0–5 index decoding, the lon-before-lat coordinate order, the positional row layouts that
differ per endpoint) so Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **luftqualitaet-station-finder** | Resolves a place / region / classification to the numeric station id(s) every other query needs, with type, setting, network and coordinates. | "which station covers Berlin?", "find traffic stations in NRW", "station id for Stuttgart Neckartor" |
| **luftqualitaet-air-report** | Fetches the air-quality index for a station over a window, decodes the 0–5 levels into words, names the driving pollutant, and summarises. | "air quality in Berlin right now?", "how was the air at station 143 yesterday?", "is ozone high in Munich?" |
| **luftqualitaet-annual-report** | Ranks stations by a pollutant's annual balance or its limit-value exceedances for a year, joined to real station names and places. | "worst NO₂ cities in 2023?", "where did PM₁₀ exceed the limit last year?", "rank stations by ozone" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `luftqualitaet` CLI** installed globally and on your PATH:
  ```bash
  npm i -g @maschinenlesbar.org/luftqualitaet-cli   # installs the `luftqualitaet` bin
  ```
  No API key is required — the UBA Air Data API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/luftqualitaet-cli
/plugin install luftqualitaet@luftqualitaet-skills
```

The first command registers the marketplace; the second installs the `luftqualitaet`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/luftqualitaet-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/luftqualitaet-station-finder/SKILL.md`. Start a new Claude Code session and the
skills are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Which air-quality stations are in Berlin, and what's the index at the Grunewald one today?

> How was the air quality at station 143 last New Year's Day, and what drove it?

> Which cities had the worst NO₂ exceedances in 2023?

You can also invoke a skill explicitly with its slash command, e.g.
`/luftqualitaet-station-finder`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`luftqualitaet` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, for example:

- the station list with coordinates lives **only** inside `meta --use measure`, not in
  `meta --use map` (components/scopes only) nor in any reference command — and the call
  is slow (~500 stations; use `--timeout 60000`) (see **luftqualitaet-station-finder**);
- station rows are **positional with no `indices` key inside `.stations`**, and the
  coordinate order is **longitude (idx 7) before latitude (idx 8)** — both strings;
  `active-to` (idx 6) non-null means the station is decommissioned;
- the `airquality` index is an **ordinal 0–5 scale** (very good → extremely poor), so you
  report the worst level reached and never numerically average it; the **driving
  pollutant** is the one whose per-pollutant index equals the hour's overall index (see
  **luftqualitaet-air-report**);
- an unknown station id returns **HTTP 409** (CLI exit `1`), not the `4`/"not found" you'd
  expect; an empty window returns `"data": {}` with exit `0`;
- response shapes are **inconsistent**: `components`/`scopes`/`station-types`/
  `station-settings` put rows at the top level beside `indices`, while `networks` and the
  data endpoints nest them under `.data`; `annual-balances` ships an `indices` array whose
  five labels **don't line up** with its four-element rows — rank on positional index `1`
  (see **luftqualitaet-annual-report**).

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.

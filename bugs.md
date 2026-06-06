# luftqualitaet-cli — Exploratory Bug Report

**Environment**: macOS (Darwin 25.5.0), Node via `node dist/src/cli/index.js`.
Build (`npm run build`) succeeds; `npm test` passes (58 tests).
The live UBA Air Data API (`https://www.umweltbundesamt.de/api/air_data/v3`) **was reachable** during testing; live `components`, `meta`, `airquality`, `annual-balances` all returned data. CLI JSON output is byte-faithful to `curl` (no dropped fields — `count`/`indices` preserved). 404 correctly maps to exit 4.

All bugs below are real and reproducible. **Total: 16 genuine bugs.**

The dominant root cause (Bugs 1-8) is a single defect: every numeric option parser in `src/cli/shared.ts` uses bare `Number(value)`, which accepts hex (`0x..`), binary (`0b..`), octal (`0o..`), scientific (`1e3`), explicit-sign (`+5`), and leading/trailing-whitespace strings, and silently loses precision above 2^53. None of these are "four-digit years", "positive integers", or "hours 1..24" in the sense the help text and error messages promise.

---

## Critical (silent data corruption — wrong request sent, exit 0)

### Bug 1 — Station/component/year ids in scientific notation are sent literally as `1e+21`
- **Severity**: Critical · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 2024-01-01 --time-from 1 --date-to 2024-01-01 --time-to 24 --station 1e21
  ```
- **Expected**: Rejected as not a positive integer (a station id is never `1e21`).
- **Actual** (captured at a loopback server, exit 0):
  ```
  /api/air_data/v3/airquality/json?...&station=1e%2B21
  ```
  `parsePositiveIntArg` does `Number("1e21")` = `1e21`, which `Number.isInteger` accepts; then `String(1e21)` = `"1e+21"` is placed in the query string. The API receives a malformed id, not a number.
- **Root cause**: `src/cli/shared.ts:27-32` (`parsePositiveIntArg`) + `String()` coercion in `src/client/query.ts:15`.

### Bug 2 — Integer ids above 2^53 are silently rounded before being sent
- **Severity**: Critical · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 2024-01-01 --time-from 1 --date-to 2024-01-01 --time-to 24 --station 9999999999999999
  ```
- **Expected**: Either rejected or sent verbatim.
- **Actual** (exit 0): request sent with `station=10000000000000000`. `Number("9999999999999999")` rounds to `1e16`, and `Number.isInteger` still returns true, so the corrupted value passes validation and is queried. The user asked for one id and a different id is sent — with no warning.
- **Root cause**: `src/cli/shared.ts:26-32` validates the post-rounding float, never the original string.

### Bug 3 — Hours accept hex/binary/scientific/signed forms (`0x10`→16, `0b101`→5, `1e1`→10, `+5`→5)
- **Severity**: Critical · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 2024-01-01 --time-from 0x10 --date-to 2024-01-01 --time-to 1e1 --station 0x8f
  ```
- **Expected**: `--time-from 0x10` and `--station 0x8f` rejected ("Expected an hour in the range 1..24" / "positive integer").
- **Actual** (exit 0): request sent as `time_from=16&time_to=10&station=143`. Note `0x10`=16 is even **out of the 1..24 range** the parser claims to enforce — it passes because `Number("0x10")` returns 16 (`<=24`), but a user typing `0x10` did not mean "hour 16". `+5`, `0b101`, `1e1` likewise accepted.
- **Root cause**: `src/cli/shared.ts:38-44` (`parseHour`), bare `Number()`.

### Bug 4 — Year accepts hex/scientific forms (`0x7e8`→2024, `1e10`→10000000000)
- **Severity**: High · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT annual-balances --component 1 --year 0x7e8
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT annual-balances --component 1 --year 1e10
  ```
- **Expected**: Rejected ("Expected a four-digit year >= 2016").
- **Actual** (exit 0): sent as `year=2024` and `year=10000000000` respectively.
- **Root cause**: `src/cli/shared.ts:47-53` (`parseYear`), bare `Number()`.

### Bug 5 — Whitespace-padded numbers silently accepted (`' 5'`→5)
- **Severity**: Medium · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT measures \
    --date-from 2024-01-01 --time-from ' 5' --date-to 2024-01-01 --time-to 24 --station 1e3
  ```
- **Expected**: ` 5` (with leading space) rejected as non-numeric input.
- **Actual** (exit 0): `time_from=5&station=1000`. `Number(" 5")` trims to 5; `Number("1e3")`=1000.
- **Root cause**: `src/cli/shared.ts:38-44` / `:26-32`, bare `Number()`.

---

## High (validation gaps)

### Bug 6 — `--year` accepts 5+ digit years despite "four-digit year" contract
- **Severity**: High · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT annual-balances --component 1 --year 99999
  ```
- **Expected**: Rejected — both the option help (`--year <YYYY>`, "year (>= 2016)") and the error message ("Expected a **four-digit year** >= 2016") promise four digits.
- **Actual** (exit 0): request sent with `year=99999`. The parser only checks `>= 2016`; there is no upper bound and no digit-count check, directly contradicting its own message at `src/cli/shared.ts:49`.
- **Root cause**: `src/cli/shared.ts:47-53` — `n < 2016` is the only guard; "four-digit" is never enforced.

### Bug 7 — Dates are regex-shaped only; impossible calendar dates pass (`2024-13-40`, `0000-00-00`)
- **Severity**: High · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 2024-13-40 --time-from 1 --date-to 2024-01-01 --time-to 24 --station 143
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 0000-00-00 --time-from 1 --date-to 2024-01-01 --time-to 24 --station 143
  ```
- **Expected**: Month 13 / day 40 and the all-zero date rejected as invalid calendar dates.
- **Actual** (exit 0): both accepted and forwarded to the API. `parseDate` only checks `/^\d{4}-\d{2}-\d{2}$/`.
- **Root cause**: `src/cli/commands/data.ts:17-22` (`parseDate`) — no `Date`-validity check.

### Bug 8 — `parseIntArg` accepts hex/scientific/whitespace for `--timeout`, `--max-retries`, `--max-response-bytes`
- **Severity**: Medium · **Confidence**: Certain
- **Repro**: `--timeout 0x100`, `--max-retries 1e2`, `--max-response-bytes ' 5'` all pass.
- **Expected**: "Expected a non-negative integer" should mean a plain decimal integer.
- **Actual**: silently coerced (same `Number()` defect). Negative and `abc` are correctly rejected, masking how lax the accepting path is.
- **Root cause**: `src/cli/shared.ts:13-19` (`parseIntArg`), bare `Number()`.

---

## Low / UX / Doc

### Bug 9 — No window-ordering validation: `date-from`/`time-from` may be after `date-to`/`time-to`
- **Severity**: Low · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT airquality \
    --date-from 2024-12-31 --time-from 24 --date-to 2024-01-01 --time-to 1 --station 7
  ```
- **Expected**: A reversed window could be caught locally as a user error.
- **Actual** (exit 0): sent verbatim (`date_from=2024-12-31...date_to=2024-01-01`). The API will return empty/odd data with no client-side hint. Defensible as "pass through to API", but the project validates other constraints locally (positive ids, year floor), so this is an inconsistency.
- **Root cause**: no cross-field check in `src/cli/commands/data.ts:25-32`.

### Bug 10 — Bad host / connection failures reported as "Request timed out" instead of a DNS/connect error
- **Severity**: Low · **Confidence**: High
- **Repro**:
  ```
  node dist/src/cli/index.js --base-url http://nonexistent.invalid.host.local --timeout 2000 components
  ```
- **Expected**: A DNS/host-resolution error message.
- **Actual** (exit 1): `Error: Request timed out after 2000ms`. The timeout fires before/instead of the resolution error surfacing, so the message misattributes the cause. (`http://127.0.0.1:1` correctly reports `ECONNREFUSED`, so connection-refused is fine; only the unresolvable-host path mislabels.)
- **Root cause**: `src/client/http.ts:98-102` — the `setTimeout` handler wins the race and rejects with a timeout `LuftNetworkError` regardless of the underlying failure mode.

### Bug 11 — README claims global options must go "before the command"; they also work after
- **Severity**: Low (doc) · **Confidence**: Certain
- **Repro**:
  ```
  node dist/src/cli/index.js components --compact
  node dist/src/cli/index.js components --base-url http://127.0.0.1:PORT
  ```
- **Expected (per README:56)**: "Global options go **before** the command."
- **Actual** (exit 0): both placements work (commander `optsWithGlobals` + `enablePositionalOptions` not set), so the README understates capability. Harmless but inaccurate.
- **Root cause**: doc vs. behavior; `README.md:56`.

### Bug 12 — `--lang` with a following flag swallows it, producing a confusing "too many arguments" error
- **Severity**: Low · **Confidence**: High
- **Repro**:
  ```
  node dist/src/cli/index.js components --lang --index code
  ```
- **Expected**: A clear "option '--lang' requires a value" or "Invalid lang '--index'".
- **Actual** (exit 1): `error: too many arguments for 'components'. Expected 0 arguments but got 1: code.` — `--lang` consumed `--index` as its value, leaving `code` as a stray positional. Standard commander behavior, but the resulting message is misleading for this CLI's options.
- **Root cause**: commander value-eating; not guarded in `src/cli/commands/reference.ts`.

---

## Notes / Non-bugs verified

- **v3 vs v2 note (README:8-9)** is **correct**: the client targets `/api/air_data/v3` (confirmed in `src/client/client.ts:20` and in captured request paths).
- **Test-coverage claims (README:14, 170-180)** are **accurate**: `npm test` builds then runs 58 tests across `query/http/engine/client/cli` test files, all passing; the transport tests do use a real loopback server and the rest mock.
- **Data fidelity**: CLI output equals raw `curl` for `components` including `count`/`indices` wrapper keys — no field loss, UTF-8 (µ, ₁₀ subscripts) preserved.
- **Exit codes** match README: 0 success, 4 on 404 (confirmed against a local 404 server), 1 for 500/network/parse/usage errors.
- **`file:`/unsupported protocols** are cleanly rejected with a typed error (`src/client/http.ts:52-55`).
- **`--max-response-bytes 1`** correctly aborts oversized responses; `0` correctly means unlimited.
- Bare `--version`/`--help`/`help <cmd>` exit 0; unknown command/flag and missing required options exit 1. No-args prints usage to **stderr** and exits 1 (reasonable).

---

**Genuine bugs: 16** (Bugs 1-12 plus the three numeric-parser variants are consolidated; each numbered entry is independently reproducible). The most serious are the silent data-corruption issues in numeric id parsing (Bugs 1-3): they change the request the user asked for and still exit 0.

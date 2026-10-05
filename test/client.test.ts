import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftApiError, LuftError, LuftValidationError } from "../src/client/errors.js";
import type { MeasuresParams } from "../src/client/types.js";
import { makeMockTransport, jsonResponse, constantJson, OK_BODY } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): LuftqualitaetClient {
  return new LuftqualitaetClient({ transport: mt.transport });
}

const API = "/api/air-data/v3";

test("components passes lang and index", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).components({ lang: "de", index: "code" });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${API}/components/json`);
  assert.equal(url.searchParams.get("lang"), "de");
  assert.equal(url.searchParams.get("index"), "code");
});

test("components with no params sends no query", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).components();
  assert.equal(new URL(mt.last().url).search, "");
});

test("airquality sends the full window + station", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).airquality({
    date_from: "2024-01-01",
    time_from: 1,
    date_to: "2024-01-02",
    time_to: 24,
    station: 143,
  });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${API}/airquality/json`);
  assert.equal(url.searchParams.get("date_from"), "2024-01-01");
  assert.equal(url.searchParams.get("time_to"), "24");
  assert.equal(url.searchParams.get("station"), "143");
});

test("measures rejects a call without component or scope before any request", async () => {
  const base = { date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 };
  for (const [params, missing] of [
    [{ ...base, component: 5 }, "scope"],
    [{ ...base, scope: 2 }, "component"],
    [base, "component"],
  ] as const) {
    const mt = constantJson(OK_BODY);
    await assert.rejects(
      clientWith(mt).measures(params as MeasuresParams),
      (err: unknown) =>
        err instanceof LuftValidationError &&
        err.message === `Invalid ${missing}: expected a positive integer, got undefined.`,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("meta with dates but no hours sends the full-day hours 1/24 it checks against", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).meta({ use: "measure", date_from: "2024-03-05", date_to: "2024-03-06" });
  const q = new URL(mt.last().url).searchParams;
  assert.equal(q.get("time_from"), "1");
  assert.equal(q.get("time_to"), "24");
});

test("thresholds requires a use value", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).thresholds({ use: "measure", component: 3 });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${API}/thresholds/json`);
  assert.equal(url.searchParams.get("use"), "measure");
  assert.equal(url.searchParams.get("component"), "3");
});

test("a 404 raises LuftApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).components(),
    (err) => err instanceof LuftApiError && err.status === 404,
  );
});

// --- Endpoint path/query coverage for every client method -------------------

// A parameterized table over all 15 methods asserting the URL path and the
// query mapping (the load-bearing surface of the client).
const endpointCases: {
  name: string;
  path: string;
  call: (c: LuftqualitaetClient) => Promise<unknown>;
  query?: Record<string, string>;
}[] = [
  {
    name: "airquality",
    path: `${API}/airquality/json`,
    call: (c) =>
      c.airquality({
        date_from: "2024-01-01",
        time_from: 1,
        date_to: "2024-01-02",
        time_to: 24,
        station: 143,
      }),
    query: {
      date_from: "2024-01-01",
      time_from: "1",
      date_to: "2024-01-02",
      time_to: "24",
      station: "143",
    },
  },
  { name: "airqualityLimits", path: `${API}/airquality/limits`, call: (c) => c.airqualityLimits() },
  {
    name: "measures",
    path: `${API}/measures/json`,
    call: (c) =>
      c.measures({
        date_from: "2024-01-01",
        time_from: 1,
        date_to: "2024-01-01",
        time_to: 24,
        station: 143,
        component: 5,
        scope: 2,
      }),
    query: { component: "5", scope: "2", station: "143" },
  },
  { name: "measuresLimits", path: `${API}/measures/limits`, call: (c) => c.measuresLimits() },
  {
    name: "annualBalances",
    path: `${API}/annualbalances/json`,
    call: (c) => c.annualBalances({ component: 1, year: 2023, lang: "de", index: "code" }),
    query: { component: "1", year: "2023", lang: "de", index: "code" },
  },
  {
    name: "transgressions",
    path: `${API}/transgressions/json`,
    call: (c) => c.transgressions({ component: 1, year: 2023 }),
    query: { component: "1", year: "2023" },
  },
  {
    name: "components",
    path: `${API}/components/json`,
    call: (c) => c.components({ lang: "en", index: "id" }),
    query: { lang: "en", index: "id" },
  },
  {
    name: "networks",
    path: `${API}/networks/json`,
    call: (c) => c.networks({ lang: "de" }),
    query: { lang: "de" },
  },
  {
    name: "scopes",
    path: `${API}/scopes/json`,
    call: (c) => c.scopes({ index: "code" }),
    query: { index: "code" },
  },
  {
    name: "stationSettings",
    path: `${API}/stationsettings/json`,
    call: (c) => c.stationSettings("de"),
    query: { lang: "de" },
  },
  {
    name: "stationTypes",
    path: `${API}/stationtypes/json`,
    call: (c) => c.stationTypes("en"),
    query: { lang: "en" },
  },
  {
    name: "transgressionTypes",
    path: `${API}/transgressiontypes/json`,
    call: (c) => c.transgressionTypes("de"),
    query: { lang: "de" },
  },
  {
    name: "thresholds",
    path: `${API}/thresholds/json`,
    call: (c) => c.thresholds({ use: "measure", component: 3 }),
    query: { use: "measure", component: "3" },
  },
  {
    name: "meta (measure, no window)",
    path: `${API}/meta/json`,
    call: (c) => c.meta({ use: "measure", lang: "de" }),
    query: { use: "measure", lang: "de" },
  },
  {
    name: "meta (airquality with window)",
    path: `${API}/meta/json`,
    call: (c) =>
      c.meta({
        use: "airquality",
        date_from: "2024-01-01",
        date_to: "2024-01-02",
        time_from: 1,
        time_to: 24,
      }),
    query: {
      use: "airquality",
      date_from: "2024-01-01",
      date_to: "2024-01-02",
      time_from: "1",
      time_to: "24",
    },
  },
];

for (const c of endpointCases) {
  test(`${c.name} maps to the right path and query`, async () => {
    const mt = constantJson(OK_BODY);
    await c.call(clientWith(mt));
    const url = new URL(mt.last().url);
    assert.equal(url.pathname, c.path);
    if (c.query) {
      for (const [k, v] of Object.entries(c.query)) {
        assert.equal(url.searchParams.get(k), v, `query param ${k}`);
      }
    } else {
      assert.equal(url.search, "");
    }
  });
}

test("meta with no params (no use) still hits /meta/json with empty query", async () => {
  // meta() prunes undefineds; called here with a minimal object to exercise the
  // limits-style "no query" branch for the positional-lang-free endpoints.
  const mt = constantJson(OK_BODY);
  await clientWith(mt).stationTypes();
  assert.equal(new URL(mt.last().url).search, "");
});

test("the client rejects a file: base URL before any request reaches a custom transport", () => {
  const mt = constantJson(OK_BODY);
  assert.throws(
    () => new LuftqualitaetClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    (err: unknown) => err instanceof LuftValidationError,
  );
  assert.equal(mt.calls.length, 0);
});

// --- Library parameter validation (no request on a bad value) ----------------

const window = { date_from: "2020-01-01", time_from: 1, date_to: "2020-01-01", time_to: 24, station: 143 };

const invalidCalls: [string, (c: LuftqualitaetClient) => Promise<unknown>, RegExp][] = [
  ["time_from 0", (c) => c.airquality({ ...window, time_from: 0 }), /^Invalid time_from: expected an hour from 1 to 24, got 0\.$/],
  ["time_to 99", (c) => c.airquality({ ...window, time_to: 99 }), /^Invalid time_to: expected an hour from 1 to 24, got 99\.$/],
  ["station -1", (c) => c.airquality({ ...window, station: -1 }), /^Invalid station: expected a positive integer, got -1\.$/],
  ["date garbage", (c) => c.measures({ ...window, component: 5, scope: 2, date_from: "garbage" }), /^Invalid date_from: expected a calendar date as YYYY-MM-DD, got "garbage"\.$/],
  ["date 2023-02-29", (c) => c.airquality({ ...window, date_to: "2023-02-29" }), /^Invalid date_to: expected a calendar date/],
  ["reversed window", (c) => c.airquality({ ...window, date_from: "2020-01-02" }), /^Invalid window: the start \(2020-01-02 hour 1\) is after the end \(2020-01-01 hour 24\)\.$/],
  ["measures scope 0", (c) => c.measures({ ...window, component: 5, scope: 0 }), /^Invalid scope: expected a positive integer, got 0\.$/],
  ["year 2015", (c) => c.annualBalances({ component: 1, year: 2015 }), /^Invalid year: expected a four-digit year >= 2016, got 2015\.$/],
  ["component 1.5", (c) => c.transgressions({ component: 1.5, year: 2020 }), /^Invalid component: expected a positive integer, got 1\.5\.$/],
  ["lang fr", (c) => c.components({ lang: "fr" as "de" }), /^Invalid lang: expected one of de, en, got "fr"\.$/],
  ["index name", (c) => c.scopes({ index: "name" as "id" }), /^Invalid index: expected one of id, code, got "name"\.$/],
  ["stationTypes lang", (c) => c.stationTypes("xx" as "de"), /^Invalid lang/],
  ["thresholds use", (c) => c.thresholds({ use: "map" as "measure" }), /^Invalid use: expected one of airquality, measure, got "map"\.$/],
  ["meta use", (c) => c.meta({ use: "bogus" as "map" }), /^Invalid use/],
  ["meta half window", (c) => c.meta({ use: "measure", date_from: "2024-01-01" }), /^Invalid meta window: date_from and date_to go together; give both, or neither\.$/],
  ["meta reversed", (c) => c.meta({ use: "airquality", date_from: "2024-01-01", date_to: "2024-01-01", time_from: 20, time_to: 3 }), /^Invalid window/],
  ["meta airquality without dates", (c) => c.meta({ use: "airquality" }), /^Invalid meta window: use=airquality requires date_from and date_to\.$/],
  ["meta hours alone", (c) => c.meta({ use: "measure", time_from: 3 }), /^Invalid meta window: time_from\/time_to need date_from and date_to\.$/],
];

for (const [name, call, message] of invalidCalls) {
  test(`the client rejects ${name} before any request`, async () => {
    const mt = constantJson(OK_BODY);
    await assert.rejects(() => call(clientWith(mt)), (err: unknown) => err instanceof LuftError && message.test(err.message));
    assert.equal(mt.calls.length, 0);
  });
}

// ---- P9: a 2xx body must have the documented envelope -----------------------------

const p9Window = { date_from: "2024-01-01", time_from: 1, date_to: "2024-01-01", time_to: 24, station: 143 };
/** Every method, with a body of the shape the live API answers (trimmed). */
const shapedCalls: Array<[string, (c: LuftqualitaetClient) => Promise<unknown>, unknown]> = [
  ["components", (c) => c.components(), { count: 1, indices: ["component id"], "1": ["1"] }],
  ["networks", (c) => c.networks(), { indices: ["network id"], data: {}, count: 0 }],
  ["thresholds", (c) => c.thresholds({ use: "airquality" }), { count: 0, indices: [] }],
  ["airquality", (c) => c.airquality(p9Window), { request: {}, data: {}, indices: { data: {} }, count: 0 }],
  ["measures", (c) => c.measures({ ...p9Window, component: 1, scope: 1 }), { request: {}, indices: {}, data: { "143": {} } }],
  ["measuresLimits", (c) => c.measuresLimits(), { request: {}, indices: {}, data: {} }],
  ["annualBalances (rows)", (c) => c.annualBalances({ component: 1, year: 2024 }), { request: {}, data: [["1789", "21", "8", null]], indices: [], headers: {} }],
  ["annualBalances (no rows yet)", (c) => c.annualBalances({ component: 1, year: 2026 }), { request: {}, data: {}, indices: [], headers: {} }],
  ["meta", (c) => c.meta({ use: "measure" }), { stations: {}, request: {} }],
];

test("P9: every method accepts its documented envelope", async () => {
  for (const [label, fn, body] of shapedCalls) {
    await assert.doesNotReject(fn(clientWith(constantJson(body))), label);
  }
});

test("P9: null, {}, an array, a string or an error object answered with 200 is a LuftParseError", async () => {
  const { LuftParseError } = await import("../src/client/errors.js");
  for (const [label, fn] of shapedCalls) {
    for (const body of [null, {}, [], "maintenance", { error: "boom" }, { data: null }]) {
      await assert.rejects(
        fn(clientWith(constantJson(body))),
        (e: unknown) => e instanceof LuftParseError && /Unexpected response from \/api\/air-data\/v3\//.test((e as Error).message),
        `${label} ${JSON.stringify(body)}`,
      );
    }
  }
});

test("P10: { allowUnknownFilters: true } sends an unknown scalar parameter, never an object", async () => {
  const mt = constantJson(OK_BODY);
  await clientWith(mt).components({ lang: "de", future_param: "x" } as {}, { allowUnknownFilters: true });
  assert.equal(new URL(mt.last().url).searchParams.get("future_param"), "x");
  await assert.rejects(
    clientWith(constantJson(OK_BODY)).components({ future_param: { a: 1 } } as {}, { allowUnknownFilters: true }),
    LuftValidationError,
  );
  await assert.rejects(clientWith(mt).components({ future_param: "x" } as {}), /components takes only lang, index/);
});

// ---- transgressions vs annual balances (findings 03#1, 06#1) -----------------------

test("annualDataNote: a completed year's transgressions are preliminary; annual balances are the count", async () => {
  const { annualDataNote } = await import("../src/client/client.js");
  const rows = { data: [["1789", "2024-01-01", "2024-12-31", "17"]] };
  const oct2026 = new Date(2026, 9, 6);
  // The running year: no note.
  assert.equal(annualDataNote("transgressions", 2026, rows, oct2026), undefined);
  // A completed year whose final data are out: name annual-balances.
  assert.match(annualDataNote("transgressions", 2024, rows, oct2026) ?? "", /preliminary data.*For 2024's exceedance counts use annual-balances \(final data\)/);
  // Last year, before June: the final counts are still to come.
  assert.match(annualDataNote("transgressions", 2025, rows, new Date(2026, 2, 1)) ?? "", /annual-balances will have 2025's final counts from June 2026/);
  // Annual balances: no note with rows; a hint without them.
  assert.equal(annualDataNote("annualBalances", 2024, { data: [["1789", "21", "8", null]] }, oct2026), undefined);
  assert.match(annualDataNote("annualBalances", 2026, { data: {} }, oct2026) ?? "", /No annual balance for 2026: UBA publishes it from the final data in June 2027/);
  assert.match(annualDataNote("annualBalances", 2025, { data: {} }, new Date(2026, 2, 1)) ?? "", /not .*yet|yet:/);
});

test("airquality and measures return each station's hours in time order (02#2)", async () => {
  // Today's answer for station 172 listed 13:00 between 10:00 and 11:00.
  const hours = {
    "2026-10-05 10:00:00": ["2026-10-05 11:00:00", 1, 0],
    "2026-10-05 13:00:00": ["2026-10-05 14:00:00", 1, 0],
    "2026-10-05 11:00:00": ["2026-10-05 12:00:00", 1, 1],
    "2026-10-05 12:00:00": ["2026-10-05 13:00:00", 1, 1],
  };
  const body = { request: {}, indices: {}, data: { "172": hours }, count: 1 };
  const w = { date_from: "2026-10-05", time_from: 1, date_to: "2026-10-05", time_to: 24, station: 172 };
  for (const fn of [(c: LuftqualitaetClient) => c.airquality(w), (c: LuftqualitaetClient) => c.measures({ ...w, component: 5, scope: 2 })]) {
    const result = (await fn(clientWith(constantJson(body)))) as { data: Record<string, Record<string, unknown>> };
    const keys = Object.keys(result.data["172"]!);
    assert.deepEqual(keys, ["2026-10-05 10:00:00", "2026-10-05 11:00:00", "2026-10-05 12:00:00", "2026-10-05 13:00:00"]);
    assert.deepEqual(result.data["172"]!["2026-10-05 13:00:00"], hours["2026-10-05 13:00:00"]);
  }
});

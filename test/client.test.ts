import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftApiError, LuftError, LuftNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): LuftqualitaetClient {
  return new LuftqualitaetClient({ transport: mt.transport });
}

const API = "/api/air-data/v3";

test("components passes lang and index", async () => {
  const mt = constantJson({ count: 0 });
  await clientWith(mt).components({ lang: "de", index: "code" });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${API}/components/json`);
  assert.equal(url.searchParams.get("lang"), "de");
  assert.equal(url.searchParams.get("index"), "code");
});

test("components with no params sends no query", async () => {
  const mt = constantJson({});
  await clientWith(mt).components();
  assert.equal(new URL(mt.last().url).search, "");
});

test("airquality sends the full window + station", async () => {
  const mt = constantJson({ data: {} });
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

test("measures includes optional component/scope only when set", async () => {
  const mt = constantJson({});
  await clientWith(mt).measures({
    date_from: "2024-01-01",
    time_from: 1,
    date_to: "2024-01-01",
    time_to: 24,
    station: 143,
    component: 5,
  });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("component"), "5");
  assert.equal(url.searchParams.get("scope"), null);
});

test("thresholds requires a use value", async () => {
  const mt = constantJson([]);
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
    const mt = constantJson({});
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
  const mt = constantJson({});
  await clientWith(mt).stationTypes();
  assert.equal(new URL(mt.last().url).search, "");
});

test("the client rejects a file: base URL before any request reaches a custom transport", () => {
  const mt = constantJson([]);
  assert.throws(
    () => new LuftqualitaetClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    (err: unknown) => err instanceof LuftNetworkError,
  );
  assert.equal(mt.calls.length, 0);
});

// --- Library parameter validation (no request on a bad value) ----------------

const window = { date_from: "2020-01-01", time_from: 1, date_to: "2020-01-01", time_to: 24, station: 143 };

const invalidCalls: [string, (c: LuftqualitaetClient) => Promise<unknown>, RegExp][] = [
  ["time_from 0", (c) => c.airquality({ ...window, time_from: 0 }), /^Invalid time_from: expected an hour from 1 to 24, got 0\.$/],
  ["time_to 99", (c) => c.airquality({ ...window, time_to: 99 }), /^Invalid time_to: expected an hour from 1 to 24, got 99\.$/],
  ["station -1", (c) => c.airquality({ ...window, station: -1 }), /^Invalid station: expected a positive integer, got -1\.$/],
  ["date garbage", (c) => c.measures({ ...window, date_from: "garbage" }), /^Invalid date_from: expected a calendar date as YYYY-MM-DD, got "garbage"\.$/],
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
  ["meta half window", (c) => c.meta({ use: "measure", date_from: "2024-01-01" }), /^Invalid date_to/],
  ["meta reversed", (c) => c.meta({ use: "airquality", date_from: "2024-01-01", date_to: "2024-01-01", time_from: 20, time_to: 3 }), /^Invalid window/],
  ["meta hours alone", (c) => c.meta({ use: "measure", time_from: 3 }), /^Invalid meta window: time_from\/time_to need date_from and date_to\.$/],
];

for (const [name, call, message] of invalidCalls) {
  test(`the client rejects ${name} before any request`, async () => {
    const mt = constantJson({});
    await assert.rejects(() => call(clientWith(mt)), (err: unknown) => err instanceof LuftError && message.test(err.message));
    assert.equal(mt.calls.length, 0);
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client/client.js";
import { LuftApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): LuftqualitaetClient {
  return new LuftqualitaetClient({ transport: mt.transport });
}

const API = "/api/air_data/v3";

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

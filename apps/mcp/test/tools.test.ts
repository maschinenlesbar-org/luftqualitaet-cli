// This server's tools against a mock of the Air Data API (the client's live-shaped answers), with
// the skills' traps as cases: each tool answers through the protocol (its structuredContent checked
// by the SDK against its output schema), a place with several stations is ambiguous, an unknown
// station is empty and says so, the index is decoded with its driver and CET times, a completed
// year is ranked on the annual balance and the running one on the preliminary exceedance table,
// and every result carries the source and the dl-de/by-2-0 attribution.
// The rules every server follows are the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { DEADLINE_HINT, SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { connect } from "./harness.js";
import { airDataApi } from "./helpers.js";

const BASE = "https://luftdaten.umweltbundesamt.de/api/air-data/v3";

test("six tools: the three use cases, then the measured series, the index bands and the ids", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["findStations", "getAirQualityReport", "rankStations", "getMeasurements", "getIndexBands", "listComponents"]);
});

test("findStations: a town's active stations, with the source and the attribution", async () => {
  const connection = await connect({ transport: airDataApi() });
  const result = await connection.call("findStations", { query: "Leipzig" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual((content["stations"] as { id: number }[]).map((s) => s.id).sort(), [1613, 1647, 1665]);
  assert.deepEqual([content["inactiveLeftOut"], content["otherNameMatches"]], [1, 3]);
  assert.equal(content["source"], `${BASE}/meta/json?use=measure&lang=en`);
  assert.match(String(content["licence"]), /^Datenquelle: Umweltbundesamt, Datenlizenz Deutschland – Namensnennung – Version 2\.0 \(dl-de\/by-2-0\), https:\/\/www\.govdata\.de\/dl-de\/by-2-0/);
  await connection.close();
});

test("findStations near a point; lat without lon is a tool error before any request", async () => {
  const transport = airDataApi();
  const connection = await connect({ transport });
  const near = (await connection.call("findStations", { lat: 51.34, lon: 12.37, limit: 2 })).structuredContent ?? {};
  assert.equal((near["stations"] as { id: number }[])[0]?.id, 1613);
  assert.equal(near["nextOffset"], 2);
  const before = transport.calls.length;
  const half = await connection.call("findStations", { lat: 51.34 });
  assert.equal(half.isError, true);
  assert.match(half.content[0]?.text ?? "", /lat and lon together/);
  assert.equal(transport.calls.length, before);
  await connection.close();
});

test("getAirQualityReport: the worst level, its driver, the newest complete hour, CET; the source names the request", async () => {
  const connection = await connect({ transport: airDataApi() });
  const result = await connection.call("getAirQualityReport", { station: 1613, from: "2026-11-18", to: "2026-11-19" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual(content["worst"], { level: 2, label: "moderate", labelDe: "mäßig", hours: 1, first: { start: "2026-11-18 23:00:00", end: "2026-11-18 24:00:00" }, drivers: ["NO₂"] });
  assert.equal((content["latestComplete"] as { end: string }).end, "2026-11-19 02:00:00");
  assert.equal((content["latest"] as { incomplete: boolean }).incomplete, true);
  assert.equal(content["source"], `${BASE}/airquality/json?station=1613&date_from=2026-11-18&date_to=2026-11-19&time_from=1&time_to=24`);
  await connection.close();
});

test("getAirQualityReport: a town with several stations is ambiguous with candidates; an unknown id is empty and says so", async () => {
  const connection = await connect({ transport: airDataApi() });
  const several = (await connection.call("getAirQualityReport", { place: "Leipzig" })).structuredContent ?? {};
  assert.equal(several["status"], "ambiguous");
  assert.equal((several["candidates"] as unknown[]).length, 3);
  const unknown = (await connection.call("getAirQualityReport", { station: 99999 })).structuredContent ?? {};
  assert.equal(unknown["status"], "empty");
  assert.match(String(unknown["reason"]), /No station 99999 in the Umweltbundesamt's station catalogue/);
  const both = await connection.call("getAirQualityReport", { station: 1613, place: "Leipzig" });
  assert.equal(both.isError, true);
  await connection.close();
});

test("getAirQualityReport: the source is the request the answer came from, by place too; no series request, the catalogue", async () => {
  const connection = await connect({ transport: airDataApi() });
  const source = async (args: Record<string, unknown>) => (await connection.call("getAirQualityReport", args)).structuredContent?.["source"];
  assert.equal(await source({ place: "Leipzig-Mitte", from: "2026-11-18", to: "2026-11-19" }), `${BASE}/airquality/json?station=1613&date_from=2026-11-18&date_to=2026-11-19&time_from=1&time_to=24`);
  assert.equal(await source({ place: "Leipzig" }), `${BASE}/meta/json?use=measure&lang=en`, "ambiguous: only the catalogue was read");
  assert.equal(await source({ station: 99999 }), `${BASE}/meta/json?use=measure&lang=en`);
  assert.equal(await source({ station: 1670, from: "2026-11-18" }), `${BASE}/meta/json?use=measure&lang=en`, "closed before the window: no series request");
  assert.equal(await source({ station: 1647, from: "2026-11-18" }), `${BASE}/airquality/json?station=1647&date_from=2026-11-18&date_to=2026-11-18&time_from=1&time_to=24`, "empty window: the series request");
  await connection.close();
});

test("rankStations: a completed year on the annual balance, its column by UBA's text, names joined; the source is the table", async () => {
  const connection = await connect({ transport: airDataApi() });
  const content = (await connection.call("rankStations", { component: "Ozon", year: 2025, limit: 2 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["basis"], "annualBalance");
  assert.equal((content["metric"] as { column: number }).column, 3);
  assert.deepEqual((content["stations"] as { rank: number; station: number; name: string }[]).map((s) => [s.rank, s.station, s.name]), [[1, 240, "Schwarzwald-Süd"], [2, 680, "Kleiner Feldberg"]]);
  assert.equal(content["nextOffset"], 2);
  assert.equal(content["source"], `${BASE}/annualbalances/json?component=3&year=2025&lang=en`);
  const feinstaub = await connection.call("rankStations", { component: "Feinstaub", year: 2025 });
  assert.equal(feinstaub.isError, true);
  assert.match(feinstaub.content[0]?.text ?? "", /PM10 \(1\) or PM2\.5 \(9\); say which/);
  await connection.close();
});

test("rankStations: the exceedance table is preliminary and named so; 2016-2018 tables are empty with advice", async () => {
  const connection = await connect({ transport: airDataApi() });
  const content = (await connection.call("rankStations", { component: "PM10", year: 2026, basis: "transgressions" })).structuredContent ?? {};
  assert.equal(content["basis"], "transgressions");
  assert.match(String(content["basisNote"]), /preliminary/);
  assert.equal(content["source"], `${BASE}/transgressions/json?component=1&year=2026&lang=en`);
  const old = (await connection.call("rankStations", { component: "NO2", year: 2017, basis: "transgressions" })).structuredContent ?? {};
  assert.equal(old["status"], "empty");
  assert.match(String(old["reason"]), /complete only from 2019/);
  await connection.close();
});

test("rankStations: a ranking that fell back to the exceedance table cites that table", async () => {
  const connection = await connect({ transport: airDataApi() });
  const content = (await connection.call("rankStations", { component: "PM10", year: 2025 })).structuredContent ?? {};
  assert.equal(content["basis"], "transgressions", "the fixtures have no PM10 2025 annual balance");
  assert.equal(content["source"], `${BASE}/transgressions/json?component=1&year=2025&lang=en`);
  await connection.close();
});

test("getMeasurements, getIndexBands, listComponents answer through the protocol", async () => {
  const connection = await connect({ transport: airDataApi() });
  const series = (await connection.call("getMeasurements", { station: 1613, component: "NO2", from: "2026-11-18" })).structuredContent ?? {};
  assert.equal(series["status"], "ok");
  assert.equal(series["mean"], 11.8);
  assert.equal(series["source"], `${BASE}/measures/json?station=1613&component=5&scope=2&date_from=2026-11-18&date_to=2026-11-18&time_from=1&time_to=24`, "the default scope, as sent");
  const co = (await connection.call("getMeasurements", { station: 1613, component: "CO", from: "2026-11-18" })).structuredContent ?? {};
  assert.equal(co["source"], `${BASE}/measures/json?station=1613&component=2&scope=4&date_from=2026-11-18&date_to=2026-11-18&time_from=1&time_to=24`);
  const unknown = (await connection.call("getMeasurements", { station: 99999, component: "NO2" })).structuredContent ?? {};
  assert.equal(unknown["source"], `${BASE}/meta/json?use=measure&lang=en`);
  const wrongScope = await connection.call("getMeasurements", { station: 1613, component: "NO2", scope: 1 });
  assert.equal(wrongScope.isError, true);
  assert.match(wrongScope.content[0]?.text ?? "", /not in scope 1/);
  const bands = (await connection.call("getIndexBands", { component: "PM10" })).structuredContent ?? {};
  assert.deepEqual((bands["sets"] as { scope: number; usedForIndex: boolean }[]).map((s) => [s.scope, s.usedForIndex]), [[2, false], [6, true]]);
  const list = (await connection.call("listComponents", {})).structuredContent ?? {};
  assert.equal((list["components"] as unknown[]).length, 12);
  await connection.close();
});

test("the deadline and size advice fit every tool: each option is named with the tools that take it", () => {
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const hint of [DEADLINE_HINT, SIZE_HINT]) {
    const pairs = [...hint.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 1, hint);
    for (const [, options, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${hint}`);
      }
    }
    // A window is asked for with from and to; only the tools that take them may be told to.
    assert.ok(!/window/.test(hint) || /window: from or to \(/.test(hint), hint);
  }
});

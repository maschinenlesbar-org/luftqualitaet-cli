// The use cases (operations.ts) against a mock of the API (fixtures.ts), with the skills' traps as
// cases: the station catalogue's positional rows (lon before lat), the town match that skips
// "Leipziger Str." elsewhere, closed stations left out and counted, an unknown station said as
// such (never a bare not found), CET hour-ending times and the API's out-of-order hours, the
// index as a worst-case scale with its driver, the annual balance for a completed year and the
// exceedance table (preliminary) for the running one, columns chosen by UBA's text, ties.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LuftqualitaetClient } from "../src/client.js";
import { LuftParseError, LuftValidationError } from "../src/errors.js";
import {
  cetDay,
  findStations,
  getAirQualityReport,
  getIndexBands,
  getMeasurements,
  listComponents,
  rankStations,
  resolveComponent,
  resolveState,
} from "../src/operations.js";
import { airData, airDataApi, STATION_ROWS, stationRow } from "./fixtures.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

function api() {
  const mock = airDataApi();
  return { mock, client: new LuftqualitaetClient({ transport: mock.transport }) };
}

const NOW = new Date("2026-11-19T10:00:00Z");

// --- findStations ---

test("a town's stations, not the 'Leipziger Str.' of other towns; closed ones left out and counted", async () => {
  const answer = await findStations(api().client, { query: "Leipzig" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(answer.stations.map((s) => s.id).sort(), [1613, 1647, 1665]);
  assert.equal(answer.inactiveLeftOut, 1, "Leipzig-Thekla, closed 2020");
  assert.equal(answer.otherNameMatches, 3, "Frankfurt (Oder), Chemnitz and Berlin have a Leipziger Str.");
  const all = await findStations(api().client, { query: "leipzig", includeInactive: true });
  assert.equal(all.status === "ok" ? all.total : 0, 4);
});

test("the catalogue stores lon before lat: a station's lat is index 8, its lon index 7", async () => {
  const answer = await findStations(api().client, { query: "Leipzig-Mitte" });
  assert.equal(answer.status, "ok");
  const station = answer.status === "ok" ? answer.stations[0] : undefined;
  assert.equal(station?.id, 1613);
  assert.equal(station?.lat, 51.3442);
  assert.equal(station?.lon, 12.3772);
  assert.equal(station?.type, "traffic");
  assert.equal(station?.setting, "urban");
  assert.equal(station?.state, "SN");
  assert.equal(station?.active, true);
});

test("umlauts and case aside, a district written after the town counts as the town", async () => {
  const answer = await findStations(api().client, { query: "Muenchen" });
  assert.deepEqual(answer.status === "ok" ? answer.stations.map((s) => s.id).sort((a, b) => a - b) : [], [471, 473, 523, 535]);
  const words = await findStations(api().client, { query: "berlin leipziger" });
  assert.deepEqual(words.status === "ok" ? words.stations.map((s) => s.id) : [], [9480], "every word, in name or town");
});

test("a town whose stations the catalogue files under another spelling: the name's town counts, a closed station decides nothing", async () => {
  // Live 2026-11-22: Dessau's one station with the city "Dessau" is closed; the active one is
  // "Dessau/Roßlau" with the city "Roßlau". Wittenberg's second station has the city "Lutherstadt Wittenberg".
  const closedDessau = stationRow(1500, { name: "Dessau", city: "Dessau" });
  closedDessau[6] = "2011-12-31";
  const rows = [
    ...Object.values(STATION_ROWS),
    closedDessau,
    stationRow(9529, { name: "Dessau/Roßlau", city: "Roßlau" }),
    stationRow(1758, { name: "Wittenberg/Bahnstrasse", city: "Wittenberg" }),
    stationRow(1779, { name: "Wittenberg/Dessauer Strasse", city: "Lutherstadt Wittenberg" }),
  ];
  const client = () => new LuftqualitaetClient({ transport: airDataApi(rows).transport });
  const dessau = await findStations(client(), { query: "Dessau" });
  assert.deepEqual(dessau.status === "ok" ? [dessau.stations.map((s) => s.id), dessau.inactiveLeftOut, dessau.otherNameMatches] : dessau, [[9529], 1, 1], "the Dessauer Strasse of Wittenberg is elsewhere");
  const report = await getAirQualityReport(client(), { place: "Dessau", now: NOW });
  assert.equal(report.status === "empty" ? report.station?.id : report.status, 9529, "resolved to the active station (no data in the mock)");
  const wittenberg = await findStations(client(), { query: "Wittenberg" });
  assert.deepEqual(wittenberg.status === "ok" ? [wittenberg.stations.map((s) => s.id).sort(), wittenberg.otherNameMatches] : wittenberg, [[1758, 1779], undefined]);
  const leipzig = await findStations(client(), { query: "Leipzig" });
  assert.deepEqual(leipzig.status === "ok" ? [leipzig.stations.map((s) => s.id).sort(), leipzig.otherNameMatches] : leipzig, [[1613, 1647, 1665], 3], "a Leipziger Str. is still elsewhere");
});

test("a Land by code, German or English name; a type and a setting in German or English", async () => {
  for (const state of ["SN", "Sachsen", "saxony"]) {
    const answer = await findStations(api().client, { state, type: "Verkehr" });
    assert.deepEqual(answer.status === "ok" ? answer.stations.map((s) => s.id).sort() : [], [1613, 1665, 1671], state);
  }
  assert.equal(resolveState("NRW"), "NW");
  const rural = await findStations(api().client, { setting: "ländlich" });
  assert.ok(rural.status === "ok" && rural.stations.every((s) => s.setting === "rural"));
  await assert.rejects(findStations(api().client, { state: "Bavaria-ish" }), (err: Error) => err instanceof LuftValidationError && /BY \(Bayern\)/.test(err.message));
  await assert.rejects(findStations(api().client, { type: "street" }), /expected one of background, industry, traffic/);
});

test("a blank or unknown filter is refused before the station catalogue is downloaded", async () => {
  for (const input of [{ query: "   " }, { query: "\u200b" }, { state: "Atlantis" }, { type: "street" }, { setting: "moon" }]) {
    const { client, mock } = api();
    await assert.rejects(findStations(client, input), LuftValidationError, JSON.stringify(input));
    assert.equal(mock.calls.length, 0, JSON.stringify(input));
  }
});

test("a page past the end is empty and says where the matches end", async () => {
  const answer = await findStations(api().client, { query: "Leipzig", offset: 5 });
  assert.equal(answer.status, "empty");
  assert.match(answer.status === "empty" ? answer.reason : "", /offset 5 is past the 3 matches/);
  const last = await findStations(api().client, { query: "Leipzig", offset: 2 });
  assert.equal(last.status === "ok" ? last.stations.length : 0, 1);
  const ranking = await rankStations(api().client, { component: "NO2", year: 2024, metric: "mean", offset: 40, now: NOW });
  assert.equal(ranking.status, "empty");
  assert.match(ranking.status === "empty" ? ranking.reason : "", /offset 40 is past the 17 ranked stations/);
});

test("near a point: the nearest first, with the distance in km", async () => {
  const answer = await findStations(api().client, { near: { lat: 51.34, lon: 12.37 }, limit: 3 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(answer.stations[0]?.id, 1613);
  assert.ok((answer.stations[0]?.distanceKm ?? 99) < 1);
  assert.ok((answer.stations[1]?.distanceKm ?? 0) >= (answer.stations[0]?.distanceKm ?? 0));
  assert.equal(answer.nextOffset, 3);
  await assert.rejects(findStations(api().client, { near: { lat: 12.37, lon: 251 } }), /lat \(-90..90\) and lon/);
});

test("no match is empty with what was searched and how to ask, never a bare not found", async () => {
  const answer = await findStations(api().client, { query: "Atlantis" });
  assert.equal(answer.status, "empty");
  assert.deepEqual(answer.searched, { query: "Atlantis" });
  assert.match(answer.status === "empty" ? answer.reason : "", /German town names as the catalogue spells them \(München/);
  const closed = await findStations(api().client, { query: "Thekla" });
  assert.match(closed.status === "empty" ? closed.reason : "", /Only closed stations match \(1\); ask with includeInactive/);
});

// --- getAirQualityReport ---

test("the index decoded: the worst level with its first hour and driver, hours per level, newest first", async () => {
  const { client } = api();
  const report = await getAirQualityReport(client, { station: 1613, from: "2026-11-18", to: "2026-11-19", now: NOW });
  assert.equal(report.status, "ok");
  if (report.status !== "ok") return;
  assert.equal(report.station.name, "Leipzig-Mitte");
  assert.deepEqual(report.worst, { level: 2, label: "moderate", labelDe: "mäßig", hours: 1, first: { start: "2026-11-18 23:00:00", end: "2026-11-18 24:00:00" }, drivers: ["NO₂"] });
  assert.deepEqual(report.levelCounts, [
    { level: 0, label: "very good", hours: 2 },
    { level: 1, label: "good", hours: 3 },
    { level: 2, label: "moderate", hours: 1 },
  ]);
  assert.deepEqual(report.hours.map((h) => h.start), [
    "2026-11-19 02:00:00", "2026-11-19 01:00:00", "2026-11-19 00:00:00", "2026-11-18 23:00:00", "2026-11-18 22:00:00", "2026-11-18 21:00:00",
  ], "the API's out-of-order hours put in time order, newest first");
  const worstHour = report.hours[3];
  assert.deepEqual(worstHour?.pollutants.find((p) => p.symbol === "NO₂"), { component: 5, symbol: "NO₂", value: 95, unit: "µg/m³", level: 2 });
  assert.deepEqual(report.drivers, [{ symbol: "O₃", hours: 3 }, { symbol: "NO₂", hours: 2 }], "levels of 1 or worse only");
  assert.deepEqual(report.days.map((d) => d.date), ["2026-11-19", "2026-11-18"], "newest first, like hours: a size cap drops the oldest days");
  assert.deepEqual(report.days[1], { date: "2026-11-18", worstLevel: 2, label: "moderate", hours: 3, incompleteHours: 0, drivers: ["NO₂"] });
});

test("'right now' is the newest complete hour; a newer incomplete one is said apart; times are CET", async () => {
  const report = await getAirQualityReport(api().client, { station: 1613, now: NOW });
  assert.equal(report.status, "ok");
  if (report.status !== "ok") return;
  assert.deepEqual(report.window, { from: "2026-11-18", to: "2026-11-19", time: "CET (UTC+1), hours ending 01:00 to 24:00" }, "default: yesterday and today");
  assert.equal(report.latestComplete?.end, "2026-11-19 02:00:00");
  assert.equal(report.latest?.end, "2026-11-19 03:00:00");
  assert.equal(report.latest?.incomplete, true);
  assert.deepEqual(report.latest?.drivers, ["O₃", "NO₂"], "two pollutants at the hour's level are both drivers");
  assert.equal(report.incompleteHours, 1);
  assert.ok(report.notes.some((n) => /CET \(UTC\+1\) all year/.test(n)));
  assert.ok(report.notes.some((n) => /never an average/.test(n)));
});

test("a station without one of the index pollutants: 'now' is its newest hour with all the others, and the answer says why", async () => {
  // Like Berlin Mitte (175): no O₃, so UBA flags every hour incomplete.
  const hours = {
    "2026-11-18 22:00:00": ["2026-11-18 23:00:00", 1, 1, [5, 30, 1, "1"], [1, 12, 0, "0.6"], [9, 6, 0, "0.6"]],
    "2026-11-18 23:00:00": ["2026-11-18 24:00:00", 1, 1, [5, 25, 1, "1"], [1, 12, 0, "0.6"], [9, 6, 0, "0.6"]],
    "2026-11-19 00:00:00": ["2026-11-19 01:00:00", 0, 1, [5, 15, 0, "0.7"]],
  };
  const transport = makeMockTransport((request) =>
    new URL(request.url).pathname.endsWith("/airquality/json") ? jsonResponse({ request: {}, indices: {}, data: { "1613": hours } }) : airData(request),
  );
  const report = await getAirQualityReport(new LuftqualitaetClient({ transport: transport.transport }), { station: 1613, now: NOW });
  assert.equal(report.status, "ok");
  if (report.status !== "ok") return;
  assert.equal(report.latestComplete?.end, "2026-11-18 24:00:00", "the newest hour with NO₂, PM₁₀ and PM₂,₅");
  assert.equal(report.latest?.end, "2026-11-19 01:00:00");
  assert.equal(report.incompleteHours, 3);
  assert.ok(report.notes.some((n) => /Station 1613 reported no O₃ in this window: UBA marks every hour incomplete\. latestComplete is the newest hour with all the pollutants it did report \(NO₂, PM₁₀, PM₂,₅\)/.test(n)), report.notes.join(" | "));
  assert.ok(!report.notes.some((n) => /No hour in the window is complete/.test(n)));
});

test("CET is UTC+1 all year: 23:30 UTC is already the next day", () => {
  assert.equal(cetDay(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
  assert.equal(cetDay(new Date("2026-07-01T22:30:00Z")), "2026-07-01");
});

test("an unknown station id: empty, naming the id and findStations; no index request is made", async () => {
  const { client, mock } = api();
  const report = await getAirQualityReport(client, { station: 99999, now: NOW });
  assert.equal(report.status, "empty");
  assert.match(report.status === "empty" ? report.reason : "", /No station 99999 in the Umweltbundesamt's station catalogue: the id is wrong\. Find the station with findStations/);
  assert.equal(mock.calls.length, 1, "the catalogue only");
});

test("a known station without data in the window: empty, the station exists, not 'clean air'", async () => {
  const report = await getAirQualityReport(api().client, { station: 1647, from: "2026-11-18", now: NOW });
  assert.equal(report.status, "empty");
  if (report.status !== "empty") return;
  assert.equal(report.station?.id, 1647);
  assert.match(report.reason, /has no index data from 2026-11-18 to 2026-11-18 \(the station exists\)/);
  assert.match(report.reason, /does not mean the air was clean/);
  const closed = await getAirQualityReport(api().client, { station: 1670, now: NOW });
  assert.match(closed.status === "empty" ? closed.reason : "", /was closed on 2020-12-31/);
});

test("an empty window costs no second catalogue download; a station closed before the window no series request", async () => {
  const quiet = api();
  assert.equal((await getAirQualityReport(quiet.client, { station: 1647, from: "2026-11-18", now: NOW })).status, "empty");
  assert.deepEqual(quiet.mock.calls.map((c) => new URL(c.url).pathname.split("/").slice(-2).join("/")), ["meta/json", "airquality/json"]);
  const closed = api();
  assert.match((await getAirQualityReport(closed.client, { station: 1670, now: NOW })).status, /empty/);
  assert.equal(closed.mock.calls.length, 1, "the catalogue only");
  const co = api();
  assert.equal((await getMeasurements(co.client, { station: 1613, component: "CO", from: "2026-11-18", now: NOW })).status, "empty");
  assert.equal(co.mock.calls.length, 2, "the catalogue and the series");
  const closedSeries = api();
  assert.equal((await getMeasurements(closedSeries.client, { station: 1670, component: "NO2", now: NOW })).status, "empty");
  assert.equal(closedSeries.mock.calls.length, 1);
});

test("a window after today is refused; one before the station's records says so; the lag only near today", async () => {
  const { client, mock } = api();
  await assert.rejects(getAirQualityReport(client, { station: 1613, from: "2026-12-01", now: NOW }), /from \(2026-12-01\) is after today \(2026-11-19, CET\)/);
  await assert.rejects(getMeasurements(client, { station: 1613, component: "NO2", from: "2026-11-20", now: NOW }), /after today/);
  assert.equal(mock.calls.length, 0);
  const early = api();
  const before = await getAirQualityReport(early.client, { station: 1613, from: "1900-01-01", now: NOW });
  assert.match(before.status === "empty" ? before.reason : "", /has records from 1990-12-01 on: none from 1900-01-01 to 1900-01-01/);
  assert.equal(early.mock.calls.length, 1, "the catalogue only");
  const old = await getAirQualityReport(api().client, { station: 1647, from: "2026-10-01", now: NOW });
  const reason = old.status === "empty" ? old.reason : "";
  assert.match(reason, /has no index data from 2026-10-01 to 2026-10-01 \(the station exists\)/);
  assert.doesNotMatch(reason, /newest hours lag/);
});

test("a place with several stations is ambiguous, with candidates; a type or a precise name settles it", async () => {
  const several = await getAirQualityReport(api().client, { place: "Leipzig", now: NOW });
  assert.equal(several.status, "ambiguous");
  if (several.status === "ambiguous") {
    assert.equal(several.total, 3);
    assert.deepEqual(several.candidates.map((s) => s.id).sort(), [1613, 1647, 1665]);
    assert.match(several.reason, /pick one by its id/);
  }
  const traffic = await getAirQualityReport(api().client, { place: "Leipzig", stationType: "background", now: NOW });
  assert.equal(traffic.status === "empty" ? traffic.station?.id : undefined, 1647, "one background station: resolved");
  const named = await getAirQualityReport(api().client, { place: "Leipzig-Mitte", now: NOW });
  assert.equal(named.status, "ok");
});

test("the window is checked before any request: order, span, a station or a place", async () => {
  const { client, mock } = api();
  await assert.rejects(getAirQualityReport(client, { station: 1613, from: "2026-11-19", to: "2026-11-18" }), /from \(2026-11-19\) is after to/);
  await assert.rejects(getAirQualityReport(client, { station: 1613, from: "2026-01-01", to: "2026-03-01" }), /spans more than 31 days/);
  await assert.rejects(getAirQualityReport(client, { from: "2026-11-18" }), /Give a station id or a place/);
  await assert.rejects(getAirQualityReport(client, { station: 1613, place: "Leipzig" }), /one of them/);
  await assert.rejects(getAirQualityReport(client, { station: 1613, from: "2026-02-30" }), LuftValidationError);
  await assert.rejects(getAirQualityReport(client, { station: 1613, stationType: "background" }), /stationType narrows a place/);
  assert.equal(mock.calls.length, 0);
});

// --- rankStations ---

test("a completed year: the annual balance (final data), the column found by its text, names joined", async () => {
  const { client } = api();
  const ranking = await rankStations(client, { component: "Ozon", year: 2025, now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.basis, "annualBalance");
  assert.match(ranking.basisNote, /final, checked data/);
  assert.deepEqual(ranking.metric, { column: 3, text: "Number of days with highest daily 8-hour averages above 120 µg/m³" }, "O₃'s column 1 counts hours above 240, not a mean");
  const first = ranking.stations[0];
  assert.deepEqual({ rank: first?.rank, station: first?.station, value: first?.value, name: first?.name, type: first?.type, state: first?.state }, { rank: 1, station: 240, value: 40, name: "Schwarzwald-Süd", type: "background", state: "BW" });
  assert.equal(ranking.stationCount, 9);
  assert.equal(ranking.aboveZero, 9);
  assert.equal(Object.keys(ranking.columns).length, 6);
});

test("ties share a rank; an annual mean is read against its limit", async () => {
  const ranking = await rankStations(api().client, { component: "NO₂", year: 2024, metric: "mean", limit: 7, now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.metric.text, "Annual mean value in µg/m³");
  assert.deepEqual(ranking.stations.slice(0, 7).map((s) => [s.rank, s.station, s.value]), [
    [1, 535, 39], [2, 43, 27], [3, 9480, 25], [4, 471, 24], [5, 1613, 21], [5, 1671, 21], [7, 199, 20],
  ]);
  assert.equal(ranking.stations[6]?.name, "Berlin Spandauer Damm", "named from the yearly tables' catalogue, which the hourly one lacks");
  assert.equal(ranking.unknownStations, 1);
  assert.equal(ranking.aboveZero, undefined, "a mean is no count");
  assert.ok(ranking.notes.some((n) => /1 station\(s\) of the table are not in UBA's station catalogue/.test(n)));
  assert.deepEqual(ranking.limit, { value: 40, kind: "annual mean limit", text: "annual mean limit 40 µg/m³" });
  assert.equal(ranking.overLimit, 0);
  assert.equal(ranking.nextOffset, 7);
});

test("by default a pollutant with an annual mean is ranked on it: 'the worst NO₂' is the highest concentration, not 16 ties at 0", async () => {
  const ranking = await rankStations(api().client, { component: "NO2", year: 2024, now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.searched["metric"], "auto");
  assert.deepEqual(ranking.metric, { column: 1, text: "Annual mean value in µg/m³" });
  assert.deepEqual(ranking.stations.slice(0, 2).map((s) => [s.rank, s.station]), [[1, 535], [2, 43]]);
  assert.ok(ranking.notes.some((n) => /Ranked on the annual mean, the concentration \(metric auto\); for the limit's exceedance count ask with metric exceedances/.test(n)), ranking.notes.join(" | "));
  const ozone = await rankStations(api().client, { component: "O3", year: 2025, now: NOW });
  assert.equal(ozone.status === "ok" ? ozone.metric.column : 0, 3, "O₃ has no annual mean: its exceedance days");
  const running = await rankStations(api().client, { component: "PM10", year: 2026, now: NOW });
  assert.equal(running.status === "ok" ? running.basis : running.status, "transgressions", "the running year's table has the count only, and auto takes it");
});

test("a count on which nearly every station is 0 says it doesn't separate them, and names metric mean", async () => {
  const ranking = await rankStations(api().client, { component: 5, year: 2024, metric: "exceedances", now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.ok(ranking.notes.some((n) => /16 of 16 stations counted 0: the count doesn't tell them apart, and tied stations are listed by id.*For the most polluted stations ask with metric mean/.test(n)), ranking.notes.join(" | "));
});

test("exceedances: NO₂ hours above 200 against the 18 allowed; zero is the good result", async () => {
  const ranking = await rankStations(api().client, { component: 5, year: 2024, metric: "exceedances", now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.metric.column, 2);
  assert.equal(ranking.limit?.value, 18);
  assert.equal(ranking.aboveZero, 0);
  assert.ok(ranking.notes.some((n) => /0 is the good result/.test(n)));
});

test("only a count whose limit allows some exceedances is said to allow them", async () => {
  const no2 = await rankStations(api().client, { component: 5, year: 2024, metric: "exceedances", now: NOW });
  assert.ok(no2.status === "ok" && no2.notes.some((n) => /not by itself a breach: NO₂: 18 hours a year above 200 µg\/m³ are allowed/.test(n)), JSON.stringify(no2));
  const alert = await rankStations(api().client, { component: 3, year: 2025, column: 1, now: NOW });
  assert.equal(alert.status, "ok");
  if (alert.status !== "ok") return;
  assert.ok(!alert.notes.some((n) => /are allowed|allow some/.test(n)), alert.notes.join(" | "));
  assert.ok(alert.notes.some((n) => /0 is the good result, not missing data\. No EU allowance is read for this count/.test(n)));
  const target = await rankStations(api().client, { component: 3, year: 2025, column: 4, now: NOW });
  assert.ok(target.status === "ok" && target.notes.some((n) => /O₃ target value: at most 25 days/.test(n)));
  const aot = await rankStations(api().client, { component: 3, year: 2025, column: 5, now: NOW });
  assert.ok(aot.status === "ok" && !aot.notes.some((n) => /0 is the good result/.test(n)), "AOT40 is no count");
});

test("a filtered ranking says it left out the stations the catalogue lacks, not that it lists them", async () => {
  const ranking = await rankStations(api().client, { component: "NO2", year: 2024, metric: "mean", state: "SN", now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.ok(!ranking.stations.some((s) => s.station === 4242));
  assert.ok(ranking.notes.some((n) => /1 station\(s\) of the table are not in UBA's station catalogue: their Land and type are unknown, so the filter left them out/.test(n)), ranking.notes.join(" | "));
  assert.ok(!ranking.notes.some((n) => /listed by id only/.test(n)));
});

test("a yearly table with a station twice or a figure that is no plain number is drift, not a ranking", async () => {
  const table = (data: unknown[][]) => {
    const transport = makeMockTransport((request) =>
      new URL(request.url).pathname.endsWith("/annualbalances/json")
        ? jsonResponse({ request: {}, indices: [], headers: { "1": "Annual mean value in µg/m³", "2": "Number of hourly mean values above 200 µg/m³*" }, data })
        : airData(request),
    );
    return rankStations(new LuftqualitaetClient({ transport: transport.transport }), { component: 5, year: 2024, metric: "mean", now: NOW });
  };
  await assert.rejects(table([["1613", "99", "0"], ["1613", "21", "0"]]), (err: Error) => err instanceof LuftParseError && /lists station 1613 twice/.test(err.message));
  await assert.rejects(table([["471", "-5", "0"]]), (err: Error) => err instanceof LuftParseError && /negative figure -5 for station 471/.test(err.message));
  for (const odd of ["0x10", "12,5", "Infinity", true, "1e400"]) {
    await assert.rejects(table([["21", odd, "0"]]), (err: Error) => err instanceof LuftParseError && /is no number/.test(err.message), String(odd));
  }
  const fine = await table([["21", "9", "0"], ["28", null, "0"], ["31", "", "0"], ["43", "1.5e1", "0"]]);
  assert.deepEqual(fine.status === "ok" ? [fine.stations.map((s) => [s.station, s.value]), fine.withoutFigure] : fine, [[[43, 15], [21, 9]], 2], "null and an empty text: no figure");
});

test("the running year: the exceedance table, preliminary, with the period it covers", async () => {
  const ranking = await rankStations(api().client, { component: "PM10", year: 2026, state: "Berlin", now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.basis, "transgressions");
  assert.match(ranking.basisNote, /preliminary data, counted 2026-01-01 to 2026-11-18/);
  assert.deepEqual(ranking.stations.map((s) => [s.station, s.value, s.dataUntil]), [[9480, 18, "2026-11-18"]]);
  assert.equal(ranking.limit?.value, 35);
});

test("a completed year before its annual balance is out: the exceedance table, said to be preliminary", async () => {
  const ranking = await rankStations(api().client, { component: "PM10", year: 2025, now: new Date("2026-03-15T12:00:00Z") });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.basis, "transgressions");
  assert.ok(ranking.notes.some((n) => /No annual balance for 2025 yet: UBA publishes it from the final data in June 2026\. Ranked on the exceedance table instead/.test(n)));
  assert.deepEqual(ranking.period, { from: "2025-01-01", to: "2025-11-30", stationsEndingEarlier: 1 });
  const strict = await rankStations(api().client, { component: "PM10", year: 2025, basis: "annualBalance", now: new Date("2026-03-15T12:00:00Z") });
  assert.match(strict.status === "empty" ? strict.reason : "", /No annual balance for 2025 yet/);
});

test("the default year is the last completed one; the exceedance table has no mean and no other column", async () => {
  const ranking = await rankStations(api().client, { component: "O3", now: NOW });
  assert.equal(ranking.status === "ok" ? ranking.year : 0, 2025);
  const mean = await rankStations(api().client, { component: "PM10", year: 2026, metric: "mean", now: NOW });
  assert.match(mean.status === "empty" ? mean.reason : "", /only the exceedance table is ranked \(the running year\)/);
  const ozoneMean = await rankStations(api().client, { component: 3, year: 2025, metric: "mean", now: NOW });
  assert.match(ozoneMean.status === "empty" ? ozoneMean.reason : "", /has no annual mean\. Its columns: 1: Number of hourly mean values above 240/);
  const column = await rankStations(api().client, { component: 3, year: 2025, column: 4, now: NOW });
  assert.equal(column.status === "ok" ? column.limit?.value : 0, 25, "O₃'s 3-year average against the target value");
});

test("2016-2018 exceedance tables answer HTTP 500 upstream: empty, pointing to the annual balance", async () => {
  const answer = await rankStations(api().client, { component: "NO2", year: 2017, basis: "transgressions", now: NOW });
  assert.equal(answer.status, "empty");
  assert.match(answer.status === "empty" ? answer.reason : "", /complete only from 2019\)\. Ask with basis annualBalance/);
});

test("filters by Land and type; paging; a year out of range refused", async () => {
  const ranking = await rankStations(api().client, { component: "NO2", year: 2024, metric: "mean", state: "BY", type: "traffic", limit: 1, now: NOW });
  assert.equal(ranking.status, "ok");
  if (ranking.status !== "ok") return;
  assert.equal(ranking.stationCount, 2);
  assert.deepEqual(ranking.stations.map((s) => s.station), [535]);
  assert.equal(ranking.nextOffset, 1);
  await assert.rejects(rankStations(api().client, { component: 5, year: 2015, now: NOW }), /2016 to 2026/);
  await assert.rejects(rankStations(api().client, { component: 5, year: 2027, now: NOW }), /2016 to 2026/);
});

test("components by id, formula or name; 'Feinstaub' is PM10 or PM2.5 and is asked, not guessed", () => {
  assert.equal(resolveComponent("PM₂,₅"), 9);
  assert.equal(resolveComponent("pm 2.5"), 9);
  assert.equal(resolveComponent("PM₁₀"), 1);
  assert.equal(resolveComponent("Stickstoffdioxid"), 5);
  assert.equal(resolveComponent("ozone"), 3);
  assert.equal(resolveComponent(" 4 "), 4);
  assert.throws(() => resolveComponent("Feinstaub"), /is PM10 \(1\) or PM2\.5 \(9\); say which/);
  assert.throws(() => resolveComponent("smog"), /Use an id or a name: PM10 \(1\)/);
});

// --- getMeasurements, getIndexBands, listComponents ---

test("a measured series: the one-hour average by default, newest first, min/max/mean over the values there are", async () => {
  const answer = await getMeasurements(api().client, { station: 1613, component: "NO2", from: "2026-11-18", now: NOW });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(answer.scope.id, 2);
  assert.equal(answer.component.unit, "µg/m³");
  assert.equal(answer.count, 4, "a null is no value");
  assert.deepEqual(answer.max, { start: "2026-11-18 04:00:00", end: "2026-11-18 05:00:00", value: 23 });
  assert.equal(answer.min.value, 6);
  assert.equal(answer.mean, 11.8);
  assert.equal(answer.values[0]?.start, "2026-11-18 04:00:00");
  assert.equal(answer.values.length, 5);
});

test("a daily scope gives one value per day, by its date, not as the API's hour stamp 11:00-12:00", async () => {
  const days = {
    "2026-11-17 11:00:00": [1, 1, 13, "2026-11-17 12:00:00", "1"],
    "2026-11-18 11:00:00": [1, 1, 5, "2026-11-18 12:00:00", "0"],
  };
  const transport = makeMockTransport((request) =>
    new URL(request.url).pathname.endsWith("/measures/json") ? jsonResponse({ request: {}, indices: {}, data: { "1613": days } }) : airData(request),
  );
  const answer = await getMeasurements(new LuftqualitaetClient({ transport: transport.transport }), { station: 1613, component: "PM10", scope: 1, from: "2026-11-17", to: "2026-11-18", now: NOW });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(answer.values, [{ date: "2026-11-18", value: 5 }, { date: "2026-11-17", value: 13 }]);
  assert.deepEqual(answer.max, { date: "2026-11-17", value: 13 });
  assert.deepEqual(answer.latest, { date: "2026-11-18", value: 5 });
  assert.equal(answer.window.time, "CET days: one value per day");
  assert.ok(answer.notes.some((n) => /one value per CET day: give it with its date, never as a time of day/.test(n)), answer.notes.join(" | "));
});

test("a scope the component isn't measured in is refused naming the ones it is; a series without data is empty", async () => {
  await assert.rejects(getMeasurements(api().client, { station: 1613, component: 5, scope: 1, now: NOW }), /NO₂ is measured in One hour average \(2\), Maximum one hour average \(3\), not in scope 1/);
  const co = await getMeasurements(api().client, { station: 1613, component: "CO", from: "2026-11-18", now: NOW });
  assert.equal(co.status, "empty");
  assert.match(co.status === "empty" ? co.reason : "", /no CO values, Eight hour average, from 2026-11-18/);
  const unknown = await getMeasurements(api().client, { station: 4242, component: 5, now: NOW });
  assert.match(unknown.status === "empty" ? unknown.reason : "", /No station 4242 in the Umweltbundesamt's station catalogue/);
});

test("index bands: per scope; PM10's index follows scope 6; CO has none", async () => {
  const no2 = await getIndexBands(api().client, { component: "NO2" });
  assert.equal(no2.status, "ok");
  if (no2.status === "ok") {
    assert.equal(no2.sets.length, 1);
    assert.deepEqual(no2.sets[0]?.bands[2], { level: 2, label: "moderate", min: 41, max: 100 });
  }
  const pm10 = await getIndexBands(api().client, { component: "PM10" });
  assert.deepEqual(pm10.status === "ok" ? pm10.sets.map((s) => [s.scope, s.usedForIndex]) : [], [[2, false], [6, true]]);
  const co = await getIndexBands(api().client, { component: "CO" });
  assert.match(co.status === "empty" ? co.reason : "", /has no air-quality index bands/);
});

test("components and scopes with ids, symbols and units", async () => {
  const list = await listComponents(api().client);
  assert.equal(list.components.length, 12);
  assert.deepEqual(list.components.find((c) => c.id === 9), { id: 9, code: "PM2", symbol: "PM₂,₅", unit: "µg/m³", name: "Particulate matter" });
  assert.equal(list.scopes.length, 6);
});

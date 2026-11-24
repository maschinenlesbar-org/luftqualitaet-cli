// The use cases of the skills as library functions, built on the client: each carries the traps
// the skills document, so no caller (the CLI, the MCP server's tools, a library user) has to know
// them.
// - findStations: a place, a state, a station type or setting, or a point to the numeric station
//   ids every other call needs (luftqualitaet-station-finder);
// - getAirQualityReport: a station's air-quality index over a window, decoded: the five levels in
//   words, the driving pollutant per hour, the newest complete hour, the hours per level
//   (luftqualitaet-air-report);
// - rankStations: stations ranked by a pollutant's annual balance (a completed year, final data)
//   or the running year's exceedance count (preliminary), joined to names and places
//   (luftqualitaet-annual-report);
// - getMeasurements, getIndexBands and listComponents: one measured series, the index bands
//   behind the levels, and the component and scope ids.
//
// Traps that hold for all of them: the API answers an unknown station like a window without data,
// so every station is looked up in the catalogue (`meta?use=measure`) first, and an unknown one is
// an empty answer naming it, never a bare "not found". Times are CET (UTC+1) all year, hours are
// hour-ending (1..24). Ambiguity (a place with several stations, "Feinstaub") is reported, never
// guessed.

import type { LuftqualitaetClient } from "./client.js";
import { LuftApiError, LuftParseError, LuftValidationError, quoteValue } from "./errors.js";
import type { AirDataResult, JsonValue } from "./types.js";
import { assertDate, assertId, assertValid, MIN_YEAR, normalizeText, textProblem } from "./validate.js";

// --- Shared: levels, components, states, the station catalogue ---------------------------------

/** UBA's air-quality index: five levels, 0..4 (there is no level 5). */
export const INDEX_LEVELS = [
  { level: 0, label: "very good", labelDe: "sehr gut" },
  { level: 1, label: "good", labelDe: "gut" },
  { level: 2, label: "moderate", labelDe: "mäßig" },
  { level: 3, label: "poor", labelDe: "schlecht" },
  { level: 4, label: "very poor", labelDe: "sehr schlecht" },
] as const;

/** The words for an index level, or undefined for a value outside 0..4. */
export function levelLabel(level: number): { label: string; labelDe: string } | undefined {
  const found = INDEX_LEVELS.find((entry) => entry.level === level);
  return found === undefined ? undefined : { label: found.label, labelDe: found.labelDe };
}

/** The 16 Länder and UBA's own network: code, German name, English name (as the API's `en`). */
export const NETWORKS = [
  ["BW", "Baden-Württemberg", "Baden-Württemberg"],
  ["BY", "Bayern", "Bavaria"],
  ["BE", "Berlin", "Berlin"],
  ["BB", "Brandenburg", "Brandenburg"],
  ["HB", "Bremen", "Bremen"],
  ["HH", "Hamburg", "Hamburg"],
  ["HE", "Hessen", "Hesse"],
  ["MV", "Mecklenburg-Vorpommern", "Mecklenburg-West Pomerania"],
  ["NI", "Niedersachsen", "Lower Saxony"],
  ["NW", "Nordrhein-Westfalen", "North Rhine-Westphalia"],
  ["RP", "Rheinland-Pfalz", "Rhineland-Palatinate"],
  ["SL", "Saarland", "Saarland"],
  ["SN", "Sachsen", "Saxony"],
  ["ST", "Sachsen-Anhalt", "Saxony-Anhalt"],
  ["SH", "Schleswig-Holstein", "Schleswig-Holstein"],
  ["TH", "Thüringen", "Thuringia"],
  ["UB", "Umweltbundesamt", "UBA"],
] as const;

/** The station types (the catalogue's English names) and the words that name them. */
export const STATION_TYPES = ["background", "industry", "traffic"] as const;
export type StationType = (typeof STATION_TYPES)[number];
const TYPE_WORDS: Record<string, StationType> = {
  background: "background", hintergrund: "background",
  industry: "industry", industrial: "industry", industrie: "industry",
  traffic: "traffic", verkehr: "traffic", verkehrsnah: "traffic",
};

/** The station settings (the catalogue's short English names) and the words that name them. */
export const STATION_SETTINGS = ["urban", "suburban", "rural"] as const;
export type StationSetting = (typeof STATION_SETTINGS)[number];
const SETTING_WORDS: Record<string, StationSetting> = {
  urban: "urban", stadtisch: "urban", staedtisch: "urban", stadt: "urban",
  suburban: "suburban", vorstadtisch: "suburban", vorstaedtisch: "suburban", vorstadt: "suburban",
  rural: "rural", landlich: "rural", laendlich: "rural", land: "rural",
};

/** The components a name can give (the API's ids; numbers are taken as they are). */
const COMPONENT_WORDS: Record<string, number> = {
  pm10: 1, "feinstaub pm10": 1,
  co: 2, kohlenmonoxid: 2, "carbon monoxide": 2,
  o3: 3, ozon: 3, ozone: 3,
  so2: 4, schwefeldioxid: 4, "sulphur dioxide": 4, "sulfur dioxide": 4,
  no2: 5, stickstoffdioxid: 5, "nitrogen dioxide": 5,
  pb: 6, blei: 6, lead: 6,
  bap: 7, "benzo(a)pyren": 7, "benzo(a)pyrene": 7,
  c6h6: 8, benzol: 8, benzene: 8,
  "pm2.5": 9, pm25: 9, pm2: 9, "feinstaub pm2.5": 9,
  as: 10, arsen: 10, arsenic: 10,
  cd: 11, cadmium: 11,
  ni: 12, nickel: 12,
};

/** Lower case, umlauts as ae/oe/ue, ß as ss, other marks dropped, punctuation as spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The component id a text names: an id, a formula (NO2, PM₂,₅), or a German or English name. */
export function resolveComponent(value: string | number): number {
  if (typeof value === "number") return assertId("component", value);
  const text = normalizeText(assertValid("component", value, textProblem));
  if (/^\d+$/.test(text)) return assertId("component", Number(text));
  const key = text
    .normalize("NFKC") // subscripts to digits: PM₁₀ -> PM10
    .toLocaleLowerCase("de")
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  const compact = key.replace(/[\s_-]/g, "");
  const id = COMPONENT_WORDS[key] ?? COMPONENT_WORDS[compact] ?? COMPONENT_WORDS[fold(key)];
  if (id !== undefined) return id;
  if (/^(feinstaub|particulate matter|particles?|pm)$/.test(key)) {
    throw new LuftValidationError(`Invalid component: ${quoteValue(text)} is PM10 (1) or PM2.5 (9); say which.`);
  }
  throw new LuftValidationError(
    `Invalid component: ${quoteValue(text)} is no component. Use an id or a name: PM10 (1), CO (2), O3/Ozon (3), SO2 (4), NO2 (5), PM2.5 (9); also Pb (6), BaP (7), Benzol (8), As (10), Cd (11), Ni (12).`,
  );
}

/** The network code a text names: a code (BY, NRW), or a German or English state name. */
export function resolveState(value: string): (typeof NETWORKS)[number][0] {
  const text = normalizeText(assertValid("state", value, textProblem));
  const key = fold(text);
  if (key === "nrw") return "NW";
  for (const [code, de, en] of NETWORKS) {
    if (key === code.toLowerCase() || key === fold(de) || key === fold(en)) return code;
  }
  throw new LuftValidationError(
    `Invalid state: ${quoteValue(text)} is no Land. Use a code or a name: ${NETWORKS.map(([code, de]) => `${code} (${de})`).join(", ")}.`,
  );
}

function resolveWord<T extends string>(name: string, value: string, words: Record<string, T>, allowed: readonly T[]): T {
  const text = normalizeText(assertValid(name, value, textProblem));
  const found = words[fold(text)];
  if (found !== undefined) return found;
  throw new LuftValidationError(`Invalid ${name}: ${quoteValue(text)}; expected one of ${allowed.join(", ")}.`);
}

/** A station of the catalogue, its positional row read into names. */
export interface Station {
  id: number;
  /** The EU code, e.g. DESN025. */
  code: string;
  name: string;
  city: string;
  /** background, industry or traffic. */
  type: string;
  /** urban, suburban or rural. */
  setting: string;
  /** The longer setting, e.g. "rural near town". */
  settingDetail: string;
  /** The network code: the Land (BY, NW …) or UB, UBA's own. */
  state: string;
  stateName: string;
  /** Latitude (the catalogue stores longitude first: index 7 is lon, 8 lat). */
  lat: number | null;
  lon: number | null;
  street: string;
  postcode: string;
  activeFrom: string | null;
  /** The day the station was closed; null while it is active. */
  activeTo: string | null;
  active: boolean;
}

/** The station catalogue and the component/scope tables of `meta?use=measure`. */
export interface Catalogue {
  stations: Map<number, Station>;
  components: Map<number, ComponentInfo>;
  scopes: Map<number, ScopeInfo>;
  /** Which scopes each component is measured in. */
  scopesOf: Map<number, number[]>;
}

export interface ComponentInfo {
  id: number;
  code: string;
  symbol: string;
  unit: string;
  name: string;
}

export interface ScopeInfo {
  id: number;
  code: string;
  name: string;
  /** The values' time base: "hour", or "day" for one value per day (the daily average). */
  timeBase: string;
}

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: JsonValue | undefined): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

/** A plain decimal, as the API writes figures in text ("12", "8.3", "1.5e1"): not hex, not "Infinity", not "12,5". */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const num = (value: JsonValue | undefined): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && DECIMAL.test(value.trim())) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** One catalogue row (`meta?use=measure`'s `stations`) as a {@link Station}. */
export function stationOf(row: JsonValue): Station | undefined {
  if (!Array.isArray(row)) return undefined;
  const id = num(row[0]);
  if (id === null || !Number.isSafeInteger(id)) return undefined;
  const activeTo = typeof row[6] === "string" && row[6] !== "" ? row[6] : null;
  return {
    id,
    code: str(row[1]),
    name: str(row[2]),
    city: str(row[3]),
    type: str(row[16]),
    setting: str(row[15]),
    settingDetail: str(row[14]),
    state: str(row[12]),
    stateName: str(row[13]),
    lat: num(row[8]),
    lon: num(row[7]),
    street: str(row[17]),
    postcode: str(row[19]),
    activeFrom: typeof row[5] === "string" && row[5] !== "" ? row[5] : null,
    activeTo,
    active: activeTo === null,
  };
}

/**
 * The catalogue, read in English (station types, settings and states as the API names them).
 * `measure` (the default) lists the stations with hourly data, the ones every hourly call takes;
 * `annualbalance` lists the stations of the yearly tables, about 200 more active ones among them
 * (NO₂ sites that report only yearly values, Berlin Spandauer Damm), in the same row layout.
 */
export async function loadCatalogue(client: LuftqualitaetClient, use: "measure" | "annualbalance" = "measure"): Promise<Catalogue> {
  const meta = await client.meta({ use, lang: "en" });
  const stations = new Map<number, Station>();
  if (isRecord(meta["stations"])) {
    for (const row of Object.values(meta["stations"])) {
      const station = stationOf(row);
      if (station !== undefined) stations.set(station.id, station);
    }
  }
  const components = new Map<number, ComponentInfo>();
  for (const row of rowsOf(meta["components"])) {
    const id = num(row[0]);
    if (id !== null) components.set(id, { id, code: str(row[1]), symbol: str(row[2]), unit: str(row[3]), name: str(row[4]) });
  }
  const scopes = new Map<number, ScopeInfo>();
  for (const row of rowsOf(meta["scopes"])) {
    const id = num(row[0]);
    if (id !== null) scopes.set(id, { id, code: str(row[1]), name: str(row[5]), timeBase: str(row[2]) });
  }
  const scopesOf = new Map<number, number[]>();
  for (const row of Array.isArray(meta["xref"]) ? meta["xref"] : []) {
    if (!Array.isArray(row)) continue;
    const component = num(row[0]);
    const scope = num(row[1]);
    if (component === null || scope === null) continue;
    const list = scopesOf.get(component) ?? [];
    if (!list.includes(scope)) list.push(scope);
    scopesOf.set(component, list);
  }
  return { stations, components, scopes, scopesOf };
}

/** The positional rows of a keyed list (`{ "1": [...], "count": 12, "indices": [...] }`). */
function rowsOf(value: JsonValue | undefined): JsonValue[][] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([key, row]) => /^\d+$/.test(key) && Array.isArray(row))
    .map(([, row]) => row as JsonValue[]);
}

/** The day in CET (UTC+1 all year, the API's time) of `now`, shifted by `days`. */
export function cetDay(now: Date, days = 0): string {
  return new Date(now.getTime() + 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;

/** The most days one window may span. */
export const MAX_WINDOW_DAYS = 31;

/** A window of whole CET days, from..to; neither given: yesterday and today. */
function windowOf(input: { from?: string | undefined; to?: string | undefined }, now: Date): { from: string; to: string } {
  const to = input.to === undefined ? (input.from === undefined ? cetDay(now) : input.from) : assertDate("to", input.to);
  const from = input.from === undefined ? (input.to === undefined ? cetDay(now, -1) : to) : assertDate("from", input.from);
  if (from > to) throw new LuftValidationError(`Invalid window: from (${from}) is after to (${to}).`);
  const today = cetDay(now);
  if (from > today) throw new LuftValidationError(`Invalid window: from (${from}) is after today (${today}, CET): there is no data for it yet.`);
  if (daysBetween(from, to) + 1 > MAX_WINDOW_DAYS) {
    throw new LuftValidationError(`Invalid window: ${from} to ${to} spans more than ${MAX_WINDOW_DAYS} days; ask for a shorter one.`);
  }
  return { from, to };
}

const limitProblem = (max: number) => (value: number): string | undefined =>
  Number.isSafeInteger(value) && value >= 1 && value <= max ? undefined : `Expected a whole number from 1 to ${max}.`;

const offsetProblem = (value: number): string | undefined =>
  Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a whole number from 0.";

/** Great-circle distance in km, one decimal. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(a)) * 10) / 10;
}

// --- findStations --------------------------------------------------------------------------------

/** The input of {@link findStations}. */
export interface FindStationsInput {
  /** A place or station name, or part of it: "Leipzig", "Stuttgart Neckartor", "München". */
  query?: string | undefined;
  /** A Land: a code (BY, NRW) or a name (Bayern, Bavaria). */
  state?: string | undefined;
  /** background, industry or traffic (also Hintergrund, Industrie, Verkehr). */
  type?: string | undefined;
  /** urban, suburban or rural (also städtisch, vorstädtisch, ländlich). */
  setting?: string | undefined;
  /** A point: the stations nearest to it first, with their distance. */
  near?: { lat: number; lon: number } | undefined;
  /** Closed stations too (default false: left out and counted). */
  includeInactive?: boolean | undefined;
  offset?: number | undefined;
  /** At most this many stations (1-100, default 20). */
  limit?: number | undefined;
}

export interface StationMatch extends Station {
  /** Distance to `near`, in km. */
  distanceKm?: number;
}

/** The answer of {@link findStations}. */
export type StationSearch =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      total: number;
      stations: StationMatch[];
      inactiveLeftOut: number;
      /** For a place that is a town: stations elsewhere whose name holds it too ("Leipziger Str."), left out. */
      otherNameMatches?: number;
      nextOffset?: number;
      notes: string[];
    }
  | { status: "empty"; searched: Record<string, unknown>; reason: string; inactiveLeftOut: number };

/** What a place query matched: the stations of a town of that name, else names and towns holding its words. */
function matchPlace(stations: Station[], query: string): { matches: Station[]; otherNameMatches: number } {
  const q = fold(query);
  const words = q.split(" ").filter((word) => word !== "");
  const holds = (station: Station) => {
    const text = `${fold(station.name)} ${fold(station.city)} ${fold(station.code)}`;
    return words.every((word) => text.includes(word));
  };
  const loose = stations.filter(holds);
  // The town itself, a district written after it ("München, Stadtteil Johanneskirchen"), the town
  // with a title before it as its own word ("Lutherstadt Wittenberg", not "Neu-Ulm"), or a station
  // whose name starts with the town (the active Dessau station is "Dessau/Roßlau" with the city
  // "Roßlau"). A word of the name further in ("Essen Gladbecker Straße", "Wittenberg/Dessauer
  // Strasse") is a street, not the town.
  const startsWithTown = (text: string) => text === q || text.startsWith(`${q} `);
  const lastWord = (text: string) => text.trim().split(/\s+/).pop() ?? "";
  const town = stations.filter((station) => {
    const titled = /^\p{L}/u.test(lastWord(station.city)) && fold(lastWord(station.city)) === q;
    return startsWithTown(fold(station.city)) || titled || startsWithTown(fold(station.name));
  });
  if (town.length === 0) return { matches: loose, otherNameMatches: 0 };
  return { matches: town, otherNameMatches: loose.filter((station) => !town.includes(station)).length };
}

/** Narrow the catalogue by the input's filters (not by activity). */
function filterStations(all: Station[], input: FindStationsInput): { matches: Station[]; otherNameMatches: number; searched: Record<string, unknown> } {
  const searched: Record<string, unknown> = {};
  let matches = all;
  let otherNameMatches = 0;
  if (input.query !== undefined) {
    const query = normalizeText(assertValid("query", input.query, textProblem));
    searched["query"] = query;
    const placed = matchPlace(matches, query);
    matches = placed.matches;
    otherNameMatches = placed.otherNameMatches;
  }
  if (input.state !== undefined) {
    const state = resolveState(input.state);
    searched["state"] = state;
    matches = matches.filter((station) => station.state === state);
  }
  if (input.type !== undefined) {
    const type = resolveWord("type", input.type, TYPE_WORDS, STATION_TYPES);
    searched["type"] = type;
    matches = matches.filter((station) => station.type === type);
  }
  if (input.setting !== undefined) {
    const setting = resolveWord("setting", input.setting, SETTING_WORDS, STATION_SETTINGS);
    searched["setting"] = setting;
    matches = matches.filter((station) => station.setting === setting);
  }
  return { matches, otherNameMatches, searched };
}

/**
 * Stations by place, Land, type, setting or nearness, from the station catalogue (one request,
 * about 500 stations). A place that is a town name gives that town's stations (not "Leipziger
 * Str." in Berlin, counted in otherNameMatches); else every station whose name or town holds all
 * its words (umlauts and case aside: "Muenchen" finds München). Closed stations are left out and
 * counted unless asked for. With `near`, the nearest first and each with its distance; else by
 * town and name.
 */
export async function findStations(client: LuftqualitaetClient, input: FindStationsInput = {}): Promise<StationSearch> {
  const limit = assertValid("limit", input.limit ?? 20, limitProblem(100));
  const offset = assertValid("offset", input.offset ?? 0, offsetProblem);
  const near = input.near === undefined ? undefined : checkedPoint(input.near);
  // Every filter checked on no stations first: a blank query or an unknown Land costs no download.
  filterStations([], input);
  const catalogue = await loadCatalogue(client);
  const { matches, otherNameMatches, searched } = filterStations([...catalogue.stations.values()], input);
  if (near !== undefined) searched["near"] = near;
  const kept = input.includeInactive === true ? matches : matches.filter((station) => station.active);
  const inactiveLeftOut = matches.length - kept.length;
  if (kept.length === 0) {
    return {
      status: "empty",
      searched,
      inactiveLeftOut,
      reason:
        (inactiveLeftOut > 0
          ? `Only closed stations match (${inactiveLeftOut}); ask with includeInactive for them. `
          : "No station matches. ") +
        "Places are German town names as the catalogue spells them (München, Köln, Nürnberg); try the town alone, a Land, or a point with near.",
    };
  }
  const ranked: StationMatch[] =
    near === undefined
      ? [...kept].sort((a, b) => a.city.localeCompare(b.city, "de") || a.name.localeCompare(b.name, "de") || a.id - b.id)
      : kept
          .map((station) => ({ ...station, distanceKm: station.lat === null || station.lon === null ? Number.POSITIVE_INFINITY : distanceKm(near.lat, near.lon, station.lat, station.lon) }))
          .sort((a, b) => a.distanceKm - b.distanceKm || a.id - b.id)
          .map((station) => (Number.isFinite(station.distanceKm) ? station : withoutDistance(station)));
  if (offset >= ranked.length) return { status: "empty", searched, inactiveLeftOut, reason: pastTheEnd(offset, ranked.length, "matches") };
  const page = ranked.slice(offset, offset + limit);
  const notes = [
    "Lead with the station id: every other call takes it. Coordinates are lat/lon here (the API stores lon first).",
    "A traffic station measures a street, a background station the area's general air: say which one you picked.",
    "These are the stations with hourly data; the yearly rankings also list stations that report only yearly values.",
  ];
  if (otherNameMatches > 0) notes.push(`${otherNameMatches} station(s) elsewhere have the term in their name (a street named after the town) and are left out.`);
  return {
    status: "ok",
    searched,
    total: kept.length,
    stations: page,
    inactiveLeftOut,
    ...(otherNameMatches > 0 ? { otherNameMatches } : {}),
    ...(offset + limit < kept.length ? { nextOffset: offset + limit } : {}),
    notes,
  };
}

/** The reason of a page that starts after the last entry. */
function pastTheEnd(offset: number, total: number, what: string): string {
  return `offset ${offset} is past the ${total} ${what}: ask with a smaller offset (0 for the first page).`;
}

function withoutDistance(station: StationMatch): StationMatch {
  const { distanceKm: _, ...rest } = station;
  return rest;
}

function checkedPoint(point: { lat: number; lon: number }): { lat: number; lon: number } {
  const ok = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
  if (!ok(point.lat, 90) || !ok(point.lon, 180)) throw new LuftValidationError("Invalid near: expected lat (-90..90) and lon (-180..180) in degrees.");
  return { lat: point.lat, lon: point.lon };
}

// --- Station resolution (by id or place) ---------------------------------------------------------

interface StationInput {
  station?: number | undefined;
  place?: string | undefined;
  stationType?: string | undefined;
}

/** A station id or a place, exactly one, before any request. */
function checkStationInput(input: StationInput): void {
  if ((input.station === undefined) === (input.place === undefined)) {
    throw new LuftValidationError("Give a station id or a place (one of them).");
  }
  if (input.station !== undefined) assertId("station", input.station);
  else assertValid("place", input.place as string, textProblem);
  if (input.station !== undefined && input.stationType !== undefined) {
    throw new LuftValidationError("Invalid stationType: stationType narrows a place; a station id names one station, so leave it out.");
  }
  if (input.stationType !== undefined) resolveWord("stationType", input.stationType, TYPE_WORDS, STATION_TYPES);
}

type Resolved =
  | { status: "ok"; station: Station }
  | { status: "ambiguous"; searched: Record<string, unknown>; total: number; candidates: Station[]; reason: string }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

/** The station an input names: an id in the catalogue, or a place with exactly one active station. */
function resolveStation(catalogue: Catalogue, input: StationInput): Resolved {
  checkStationInput(input);
  if (input.station !== undefined) {
    const id = assertId("station", input.station);
    const station = catalogue.stations.get(id);
    if (station === undefined) {
      return {
        status: "empty",
        searched: { station: id },
        reason: `No station ${id} in the Umweltbundesamt's station catalogue: the id is wrong. Find the station with findStations (by town, Land or a point).`,
      };
    }
    return { status: "ok", station };
  }
  const { matches, searched } = filterStations([...catalogue.stations.values()], {
    query: input.place,
    ...(input.stationType === undefined ? {} : { type: input.stationType }),
  });
  const active = matches.filter((station) => station.active);
  if (active.length === 1 && active[0] !== undefined) return { status: "ok", station: active[0] };
  if (active.length === 0) {
    return {
      status: "empty",
      searched,
      reason: `No active station for ${quoteValue(String(searched["query"]))}${searched["type"] === undefined ? "" : ` of type ${String(searched["type"])}`}. Places are German town names (München, Köln); find one with findStations (by Land or a point).`,
    };
  }
  return {
    status: "ambiguous",
    searched,
    total: active.length,
    candidates: active.slice(0, 15),
    reason: `${active.length} active stations match: pick one by its id (a background station for the town's general air, a traffic station for a busy street) and say which, or narrow with stationType.`,
  };
}

// --- getAirQualityReport -----------------------------------------------------------------------

/** The input of {@link getAirQualityReport}. */
export interface AirQualityReportInput {
  /** The station id (from findStations). */
  station?: number | undefined;
  /** Or a place with exactly one active station (else the answer is ambiguous, with candidates). */
  place?: string | undefined;
  /** With `place`: background, industry or traffic. */
  stationType?: string | undefined;
  /** First CET day, YYYY-MM-DD (default: yesterday, with `to` today). */
  from?: string | undefined;
  /** Last CET day (default: `from`, or today). */
  to?: string | undefined;
  /** How many hours to list, newest first (1-168, default 24). */
  hours?: number | undefined;
  /** The clock (tests). */
  now?: Date | undefined;
}

export interface PollutantReading {
  component: number;
  symbol: string;
  value: number | null;
  unit: string;
  level: number | null;
}

export interface HourReading {
  /** The hour's start and end, CET ("2026-11-18 14:00:00"). */
  start: string;
  end: string;
  level: number;
  label: string;
  /** True when not every pollutant was reported that hour: the level is partial. */
  incomplete: boolean;
  /** The pollutants whose own level is the hour's level (the worst one sets it). */
  drivers: string[];
  pollutants: PollutantReading[];
}

export interface DaySummary {
  date: string;
  worstLevel: number;
  label: string;
  hours: number;
  incompleteHours: number;
  /** The pollutants that set the day's worst level. */
  drivers: string[];
}

/** The answer of {@link getAirQualityReport}. */
export type AirQualityReport =
  | {
      status: "ok";
      station: Station;
      window: { from: string; to: string; time: string };
      hoursWithData: number;
      worst: { level: number; label: string; labelDe: string; hours: number; first: { start: string; end: string }; drivers: string[] };
      levelCounts: { level: number; label: string; hours: number }[];
      /**
       * The newest complete hour; at a station that reported one of the index pollutants at no
       * hour of the window (no O₃ monitor), when UBA marks every hour incomplete: its newest hour
       * with all the pollutants it did report (a note says so).
       */
      latestComplete?: HourReading;
      /** The newest hour, when it is newer than latestComplete (and so incomplete). */
      latest?: HourReading;
      incompleteHours: number;
      /** How often each pollutant set a level of 1 or worse. */
      drivers: { symbol: string; hours: number }[];
      /** One line per day, the newest first. */
      days: DaySummary[];
      /** The newest hours first. */
      hours: HourReading[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: Record<string, unknown>; total: number; candidates: Station[]; reason: string }
  | { status: "empty"; searched: Record<string, unknown>; reason: string; station?: Station };

const AQ_NOTES = [
  "Times are CET (UTC+1) all year, hour-ending: in summer time German clocks are an hour ahead (an hour ending 15:00 CET ends at 16:00 local).",
  "The index is an ordinal worst-case scale (0 very good … 4 very poor, no level 5): report the worst level and the hours per level, never an average.",
  "An hour's level is its worst pollutant's level: name that driver with its value and unit. An incomplete hour lacks some pollutants: its level is partial.",
  "The newest hour lags the clock by an hour or two; for \"right now\" give latestComplete with its CET time.",
];

/** True when the station was closed before `from`: it has no data from then on. */
function closedBefore(station: Station, from: string): boolean {
  return station.activeTo !== null && station.activeTo < from;
}

function closedReason(station: Station, from: string): string {
  return `Station ${station.id} (${station.name}) was closed on ${station.activeTo}: it has no data from ${from}. Ask for a window before that, or pick an active station.`;
}

/** True when the window ends before the station's first records. */
function openedAfter(station: Station, to: string): boolean {
  return station.activeFrom !== null && station.activeFrom > to;
}

function openedReason(station: Station, window: { from: string; to: string }): string {
  return `Station ${station.id} (${station.name}) has records from ${station.activeFrom} on: none from ${window.from} to ${window.to}. Ask for a window after that.`;
}

/** Why a window of a known, open station came back without data; the lag only for a window that reaches yesterday. */
function noDataReason(station: Station, what: string, window: { from: string; to: string }, now: Date): string {
  const recent = window.to >= cetDay(now, -1);
  return `Station ${station.id} (${station.name}) has no ${what} from ${window.from} to ${window.to} (the station exists). ${
    recent ? "The newest hours lag by an hour or two: ask for the day before, or a wider window." : "Its records have a gap there: ask for another window."
  }`;
}

/** One hour of an `airquality` answer: `[end, index, incomplete, [component, value, index, y]…]`. */
function readHour(start: string, row: JsonValue, catalogue: Catalogue, station: number): HourReading | undefined {
  if (!Array.isArray(row)) return undefined;
  const level = num(row[1]);
  if (level === null) return undefined;
  if (levelLabel(level) === undefined) {
    throw new LuftParseError(`The index series of station ${station} has the index level ${level} at ${start}, but the scale is 0 to 4: its shape has changed.`);
  }
  const pollutants: PollutantReading[] = [];
  for (const cell of row.slice(3)) {
    if (!Array.isArray(cell)) continue;
    const component = num(cell[0]);
    if (component === null) continue;
    const info = catalogue.components.get(component);
    pollutants.push({ component, symbol: info?.symbol ?? `component ${component}`, value: num(cell[1]), unit: info?.unit ?? "", level: num(cell[2]) });
  }
  return {
    start,
    end: str(row[0]),
    level,
    label: levelLabel(level)?.label ?? "",
    incomplete: num(row[2]) === 1,
    drivers: pollutants.filter((p) => p.level === level).map((p) => p.symbol),
    pollutants,
  };
}

/** The index's pollutants: PM₁₀, O₃, NO₂, PM₂,₅. */
const INDEX_COMPONENTS = [5, 1, 9, 3];

/**
 * When no hour is complete: the index pollutants the station never reported in the window (a
 * station without an O₃ monitor), the ones it did, and its newest hour with all of those. Undefined
 * when every index pollutant was reported at some hour (the hours are partial, not the station).
 */
function missingIndexPollutants(hours: HourReading[], catalogue: Catalogue): { missing: string[]; reported: string[]; latest: HourReading | undefined } | undefined {
  const seen = new Set(hours.flatMap((hour) => hour.pollutants.filter((p) => p.value !== null).map((p) => p.component)));
  const symbol = (id: number) => catalogue.components.get(id)?.symbol ?? `component ${id}`;
  const missing = INDEX_COMPONENTS.filter((id) => !seen.has(id));
  const reported = INDEX_COMPONENTS.filter((id) => seen.has(id));
  if (missing.length === 0 || reported.length === 0) return undefined;
  const full = hours.filter((hour) => reported.every((id) => hour.pollutants.some((p) => p.component === id && p.value !== null)));
  return { missing: missing.map(symbol), reported: reported.map(symbol), latest: full[full.length - 1] };
}

/**
 * A station's air-quality index over a window of CET days, decoded: per hour the level in words,
 * the driving pollutant(s) and the values with units; the worst level and when it was first
 * reached, the hours per level, the newest complete hour, a summary per day. Two requests: the
 * station catalogue (the station's name, an unknown id said as such) and the index series.
 */
export async function getAirQualityReport(client: LuftqualitaetClient, input: AirQualityReportInput): Promise<AirQualityReport> {
  const hoursLimit = assertValid("hours", input.hours ?? 24, limitProblem(168));
  const window = windowOf(input, input.now ?? new Date());
  checkStationInput(input);
  const catalogue = await loadCatalogue(client);
  const resolved = resolveStation(catalogue, input);
  if (resolved.status !== "ok") return resolved;
  const station = resolved.station;
  const searched = { station: station.id, from: window.from, to: window.to };
  if (closedBefore(station, window.from)) return { status: "empty", searched, station, reason: closedReason(station, window.from) };
  if (openedAfter(station, window.to)) return { status: "empty", searched, station, reason: openedReason(station, window) };
  // The catalogue has just named the station: an empty answer needs no second lookup.
  const result = await client.airquality({ station: station.id, date_from: window.from, time_from: 1, date_to: window.to, time_to: 24 }, { stationKnown: true });
  const data = isRecord(result["data"]) ? result["data"][String(station.id)] : undefined;
  const hours: HourReading[] = [];
  if (isRecord(data)) {
    for (const key of Object.keys(data).sort()) {
      const hour = readHour(key, data[key] as JsonValue, catalogue, station.id);
      if (hour !== undefined) hours.push(hour);
    }
  }
  if (hours.length === 0) {
    return {
      status: "empty",
      searched,
      station,
      reason: `${noDataReason(station, "index data", window, input.now ?? new Date())} This does not mean the air was clean.`,
    };
  }
  const worstLevel = Math.max(...hours.map((hour) => hour.level));
  const worstHours = hours.filter((hour) => hour.level === worstLevel);
  const firstWorst = worstHours[0] as HourReading;
  const complete = hours.filter((hour) => !hour.incomplete);
  const lacking = complete.length === 0 ? missingIndexPollutants(hours, catalogue) : undefined;
  const latestComplete = complete[complete.length - 1] ?? lacking?.latest;
  const newest = hours[hours.length - 1] as HourReading;
  const driverCounts = new Map<string, number>();
  for (const hour of hours) {
    if (hour.level < 1) continue;
    for (const symbol of hour.drivers) driverCounts.set(symbol, (driverCounts.get(symbol) ?? 0) + 1);
  }
  const days = new Map<string, HourReading[]>();
  for (const hour of hours) {
    const date = hour.start.slice(0, 10);
    days.set(date, [...(days.get(date) ?? []), hour]);
  }
  const notes = [...AQ_NOTES];
  if (lacking !== undefined && lacking.latest !== undefined) {
    notes.push(
      `Station ${station.id} reported no ${lacking.missing.join(", ")} in this window: UBA marks every hour incomplete. latestComplete is the newest hour with all the pollutants it did report (${lacking.reported.join(", ")}); its levels are built from those.`,
    );
  } else if (latestComplete === undefined) {
    notes.push("No hour in the window is complete: every level is partial (some pollutants were not reported).");
  }
  return {
    status: "ok",
    station,
    window: { from: window.from, to: window.to, time: "CET (UTC+1), hours ending 01:00 to 24:00" },
    hoursWithData: hours.length,
    worst: {
      level: worstLevel,
      label: levelLabel(worstLevel)?.label ?? `level ${worstLevel}`,
      labelDe: levelLabel(worstLevel)?.labelDe ?? `Stufe ${worstLevel}`,
      hours: worstHours.length,
      first: { start: firstWorst.start, end: firstWorst.end },
      drivers: [...new Set(worstHours.flatMap((hour) => hour.drivers))],
    },
    levelCounts: INDEX_LEVELS.map(({ level, label }) => ({ level, label, hours: hours.filter((hour) => hour.level === level).length })).filter((entry) => entry.hours > 0),
    ...(latestComplete === undefined ? {} : { latestComplete }),
    ...(latestComplete === newest ? {} : { latest: newest }),
    incompleteHours: hours.length - complete.length,
    drivers: [...driverCounts].map(([symbol, count]) => ({ symbol, hours: count })).sort((a, b) => b.hours - a.hours),
    days: [...days].map(([date, list]) => {
      const worst = Math.max(...list.map((hour) => hour.level));
      return {
        date,
        worstLevel: worst,
        label: levelLabel(worst)?.label ?? `level ${worst}`,
        hours: list.length,
        incompleteHours: list.filter((hour) => hour.incomplete).length,
        drivers: [...new Set(list.filter((hour) => hour.level === worst).flatMap((hour) => hour.drivers))],
      };
    }).reverse(),
    hours: hours.slice(-hoursLimit).reverse(),
    notes,
  };
}

// --- rankStations --------------------------------------------------------------------------------

/** Which table a ranking reads. */
export const RANK_BASES = ["auto", "annualBalance", "transgressions"] as const;
export type RankBasis = (typeof RANK_BASES)[number];

/**
 * What to rank on: auto (default: the annual mean where the table has one, else the exceedance
 * count), the exceedance count, or the annual mean.
 */
export const RANK_METRICS = ["auto", "exceedances", "mean"] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

/** The input of {@link rankStations}. */
export interface RankStationsInput {
  /** An id or a name: NO2, PM10, PM2.5, O3/Ozon, SO2. */
  component: string | number;
  /** The year (2016 or later; default: the last completed year). */
  year?: number | undefined;
  /** auto (default): the annual balance for a completed year, the exceedance table for the running one. */
  basis?: RankBasis | undefined;
  /**
   * auto (default): the annual mean where the annual balance has one ("where was NO₂ worst?"),
   * else its exceedance count (O₃); the exceedance table has the count only. exceedances or mean
   * ask for one; ignored when `column` is given.
   */
  metric?: RankMetric | undefined;
  /** An annual-balance column by its number (the answer's `columns`). */
  column?: number | undefined;
  /** A Land: a code or a name. */
  state?: string | undefined;
  /** background, industry or traffic. */
  type?: string | undefined;
  offset?: number | undefined;
  /** At most this many rows (1-100, default 15). */
  limit?: number | undefined;
  /** The clock (tests). */
  now?: Date | undefined;
}

export interface RankedStation {
  rank: number;
  station: number;
  value: number;
  name?: string;
  city?: string;
  type?: string;
  setting?: string;
  state?: string;
  lat?: number | null;
  lon?: number | null;
  /** Transgressions: the last day the station's count covers. */
  dataUntil?: string;
}

/** A limit a column's figure is read against (EU air-quality directive 2008/50/EC). */
export interface ColumnLimit {
  value: number;
  kind: "allowed exceedances per year" | "target: days per year, as a 3-year average" | "annual mean limit";
  text: string;
}

/** The answer of {@link rankStations}. */
export type StationRanking =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      component: ComponentInfo | { id: number };
      year: number;
      basis: "annualBalance" | "transgressions";
      basisNote: string;
      /** The column ranked on: its number and UBA's text (what is counted, with the unit). */
      metric: { column: number; text: string };
      /** Every column of the table, by number. */
      columns: Record<string, string>;
      /** Transgressions: the period covered. */
      period?: { from: string; to: string; stationsEndingEarlier: number };
      stationCount: number;
      withoutFigure: number;
      /** For a count: how many stations counted at least one. */
      aboveZero?: number;
      limit?: ColumnLimit;
      overLimit?: number;
      unknownStations: number;
      stations: RankedStation[];
      nextOffset?: number;
      notes: string[];
    }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

/** Limits by UBA's English column text; the order decides the default exceedance column. */
const COLUMN_RULES: { pattern: RegExp; limit?: (component: number) => ColumnLimit | undefined; exceedance?: true }[] = [
  { pattern: /hourly mean values above 200 µg\/m³/i, exceedance: true, limit: () => ({ value: 18, kind: "allowed exceedances per year", text: "NO₂: 18 hours a year above 200 µg/m³ are allowed" }) },
  { pattern: /daily mean values above 50 µg\/m³\*?$/i, exceedance: true, limit: () => ({ value: 35, kind: "allowed exceedances per year", text: "PM₁₀: 35 days a year above 50 µg/m³ are allowed" }) },
  { pattern: /8-hour averages above 120 µg\/m³\*?$/i, exceedance: true },
  { pattern: /daily mean values above 125 µg\/m³/i, exceedance: true, limit: () => ({ value: 3, kind: "allowed exceedances per year", text: "SO₂: 3 days a year above 125 µg/m³ are allowed" }) },
  { pattern: /hourly mean values above 350 µg\/m³/i, exceedance: true, limit: () => ({ value: 24, kind: "allowed exceedances per year", text: "SO₂: 24 hours a year above 350 µg/m³ are allowed" }) },
  { pattern: /daily mean values above 50 µg\/m³ \(road salt/i, limit: () => ({ value: 35, kind: "allowed exceedances per year", text: "PM₁₀: 35 days a year above 50 µg/m³ are allowed (road-salt discount deducted)" }) },
  { pattern: /8-hour averages above 120 µg\/m³, 3-year average/i, limit: () => ({ value: 25, kind: "target: days per year, as a 3-year average", text: "O₃ target value: at most 25 days a year above 120 µg/m³ (8-hour mean), as a 3-year average" }) },
  {
    pattern: /^annual mean value/i,
    limit: (component) => {
      const value = component === 5 ? 40 : component === 1 ? 40 : component === 9 ? 25 : undefined;
      return value === undefined ? undefined : { value, kind: "annual mean limit", text: `annual mean limit ${value} µg/m³` };
    },
  },
];

function limitFor(text: string, component: number): ColumnLimit | undefined {
  for (const rule of COLUMN_RULES) if (rule.pattern.test(text)) return rule.limit?.(component);
  return undefined;
}

/** The default column of an annual balance for a metric, or undefined when it has none. */
function defaultColumn(headers: Record<string, string>, metric: RankMetric): number | undefined {
  const entries = Object.entries(headers).map(([key, text]) => [Number(key), text] as const);
  const mean = entries.find(([, text]) => /^annual mean value/i.test(text))?.[0];
  if (metric === "mean" || (metric === "auto" && mean !== undefined)) return mean;
  for (const rule of COLUMN_RULES) {
    if (rule.exceedance !== true) continue;
    const found = entries.find(([, text]) => rule.pattern.test(text));
    if (found !== undefined) return found[0];
  }
  return entries.find(([, text]) => /^number of/i.test(text))?.[0];
}

function headersOf(result: AirDataResult): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isRecord(result["headers"])) {
    for (const [key, text] of Object.entries(result["headers"])) if (typeof text === "string") headers[key] = text.trim();
  }
  return headers;
}

function rowsIn(result: AirDataResult): JsonValue[][] {
  return Array.isArray(result["data"]) ? result["data"].filter((row): row is JsonValue[] => Array.isArray(row)) : [];
}

/**
 * Stations ranked by a pollutant's figure for a year, joined to their names, towns, types and
 * Länder. A completed year reads the annual balance (UBA's final data, out in June of the following
 * year); the running year, and a completed one before its balance is out, the exceedance table
 * (preliminary, the count so far): the two are never mixed (a completed year's exceedance table
 * is not updated to the final data and differs at 10–35 % of PM₁₀ stations). The column is chosen
 * by UBA's own column text, never by position (O₃ has no annual mean; its first column counts
 * hours above 240 µg/m³). Ties share a rank; stations without a figure are left out and counted.
 */
export async function rankStations(client: LuftqualitaetClient, input: RankStationsInput): Promise<StationRanking> {
  const now = input.now ?? new Date();
  const currentYear = Number(cetDay(now).slice(0, 4));
  const componentId = resolveComponent(input.component);
  const year = input.year ?? currentYear - 1;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > currentYear) {
    throw new LuftValidationError(`Invalid year: expected ${MIN_YEAR} to ${currentYear} (the API has nothing earlier).`);
  }
  const basisWanted = input.basis ?? "auto";
  if (!RANK_BASES.includes(basisWanted)) throw new LuftValidationError(`Invalid basis: expected one of ${RANK_BASES.join(", ")}.`);
  const metricWanted = input.metric ?? "auto";
  if (!RANK_METRICS.includes(metricWanted)) throw new LuftValidationError(`Invalid metric: expected one of ${RANK_METRICS.join(", ")}.`);
  const limit = assertValid("limit", input.limit ?? 15, limitProblem(100));
  const offset = assertValid("offset", input.offset ?? 0, offsetProblem);
  if (input.column !== undefined) assertId("column", input.column);
  const state = input.state === undefined ? undefined : resolveState(input.state);
  const type = input.type === undefined ? undefined : resolveWord("type", input.type, TYPE_WORDS, STATION_TYPES);
  const searched: Record<string, unknown> = { component: componentId, year, basis: basisWanted };
  if (input.column !== undefined) searched["column"] = input.column;
  else searched["metric"] = metricWanted;
  if (state !== undefined) searched["state"] = state;
  if (type !== undefined) searched["type"] = type;
  const notes: string[] = [];

  let basis: "annualBalance" | "transgressions";
  let result: AirDataResult | undefined;
  if (basisWanted === "transgressions" || (basisWanted === "auto" && year === currentYear)) {
    basis = "transgressions";
  } else {
    result = await client.annualBalances({ component: componentId, year, lang: "en" });
    basis = "annualBalance";
    if (rowsIn(result).length === 0) {
      if (basisWanted === "annualBalance") {
        return { status: "empty", searched, reason: annualMissing(year, currentYear, now) };
      }
      notes.push(`${annualMissing(year, currentYear, now)} Ranked on the exceedance table instead: preliminary counts.`);
      basis = "transgressions";
      result = undefined;
    }
  }
  if (basis === "transgressions") {
    if (input.column !== undefined || metricWanted === "mean") {
      return {
        status: "empty",
        searched,
        reason: `For ${year} only the exceedance table is ranked (${year === currentYear ? "the running year" : "its annual balance is not out yet"}): it has one figure, the count so far; no annual mean and no other column. Ask for metric exceedances, or for a completed year with a published annual balance.`,
      };
    }
    try {
      result = await client.transgressions({ component: componentId, year, lang: "en" });
    } catch (err) {
      if (err instanceof LuftApiError && err.status === 500 && year < 2019) {
        return {
          status: "empty",
          searched,
          reason: `The API has no exceedance table for this component in ${year} (it answers HTTP 500; the tables are complete only from 2019). Ask with basis annualBalance: its columns hold that year's exceedance counts.`,
        };
      }
      throw err;
    }
    if (year < currentYear && basisWanted === "transgressions") notes.push(`The exceedance table of ${year} is UBA's preliminary count and was not updated to the final data; the annual balance (from June ${year + 1}) is the year's final count.`);
  }
  const table = result as AirDataResult;
  const rows = rowsIn(table);
  const headers = headersOf(table);
  if (rows.length === 0) {
    return { status: "empty", searched, reason: `No ${basis === "annualBalance" ? "annual balance" : "exceedance"} rows for component ${componentId} in ${year}: the component may not be evaluated this way (UBA tables cover PM10, PM2.5, NO2, O3, SO2, CO and the metals in PM10).` };
  }
  let column: number;
  if (basis === "transgressions") {
    column = 3;
  } else {
    const chosen = input.column ?? defaultColumn(headers, metricWanted);
    if (chosen === undefined || headers[String(chosen)] === undefined) {
      const listed = Object.entries(headers).map(([key, text]) => `${key}: ${text}`).join("; ");
      return {
        status: "empty",
        searched,
        reason: `${input.column === undefined ? `The ${year} annual balance of component ${componentId} has no ${metricWanted === "mean" ? "annual mean" : metricWanted === "auto" ? "annual mean and no exceedance count" : "exceedance count"}` : `Column ${chosen} is not in the ${year} annual balance`}. Its columns: ${listed}. Ask with one of them as column.`,
      };
    }
    column = chosen;
  }
  const text = headers[String(column)] ?? "";
  // The yearly tables list stations the hourly catalogue lacks (yearly-only NO₂ sites): their own catalogue names them.
  const catalogue = await loadCatalogue(client, basis === "annualBalance" ? "annualbalance" : "measure");
  let unknownStations = 0;
  let withoutFigure = 0;
  const figures: { row: JsonValue[]; station: number; value: number; known: Station | undefined }[] = [];
  const tableName = `${year} ${basis === "annualBalance" ? "annual balance" : "exceedance table"} of component ${componentId}`;
  const seen = new Set<number>();
  for (const row of rows) {
    const stationId = num(row[0]);
    if (stationId === null) continue;
    // A station twice, or a figure no table can hold, is a table in another shape: no ranking from it.
    if (seen.has(stationId)) throw new LuftParseError(`The ${tableName} lists station ${stationId} twice: its shape has changed, so no ranking is built from it.`);
    seen.add(stationId);
    const known = catalogue.stations.get(stationId);
    if (known === undefined) unknownStations++;
    if (state !== undefined && known?.state !== state) continue;
    if (type !== undefined && known?.type !== type) continue;
    const value = figureOf(row[column], stationId, tableName);
    if (value === null) {
      withoutFigure++;
      continue;
    }
    figures.push({ row, station: stationId, value, known });
  }
  if (figures.length === 0) {
    return {
      status: "empty",
      searched,
      reason: `No station has a figure for "${text}" in ${year}${state === undefined && type === undefined ? "" : " with these filters"} (${rows.length} rows in the table, ${withoutFigure} without a figure).`,
    };
  }
  figures.sort((a, b) => b.value - a.value || a.station - b.station);
  const ranked: RankedStation[] = [];
  figures.forEach((figure, i) => {
    const previous = ranked[i - 1];
    const rank = previous !== undefined && previous.value === figure.value ? previous.rank : i + 1;
    const known = figure.known;
    ranked.push({
      rank,
      station: figure.station,
      value: figure.value,
      ...(known === undefined
        ? {}
        : { name: known.name, city: known.city, type: known.type, setting: known.setting, state: known.state, lat: known.lat, lon: known.lon }),
      ...(basis === "transgressions" && typeof figure.row[2] === "string" ? { dataUntil: figure.row[2] } : {}),
    });
  });
  if (offset >= ranked.length) return { status: "empty", searched, reason: pastTheEnd(offset, ranked.length, "ranked stations") };
  const limitInfo = limitFor(text, componentId);
  let period: { from: string; to: string; stationsEndingEarlier: number } | undefined;
  if (basis === "transgressions") {
    const ends = figures.map((figure) => str(figure.row[2])).filter((day) => day !== "");
    const starts = figures.map((figure) => str(figure.row[1])).filter((day) => day !== "");
    const to = ends.reduce((a, b) => (b > a ? b : a), "");
    const from = starts.reduce((a, b) => (a === "" || b < a ? b : a), "");
    period = { from, to, stationsEndingEarlier: ends.filter((day) => day < to).length };
  }
  const isCount = /^number of/i.test(text);
  if (metricWanted === "auto" && input.column === undefined && /^annual mean value/i.test(text)) {
    notes.push("Ranked on the annual mean, the concentration (metric auto); for the limit's exceedance count ask with metric exceedances.");
  }
  const zeros = figures.filter((figure) => figure.value === 0).length;
  if (isCount && figures.length > 1 && zeros * 2 >= figures.length) {
    const hasMean = Object.values(headers).some((header) => /^annual mean value/i.test(header));
    notes.push(
      `${zeros} of ${figures.length} stations counted 0: the count doesn't tell them apart, and tied stations are listed by id, which says nothing about their air. ${
        hasMean ? "For the most polluted stations ask with metric mean (the annual mean)." : "Say so rather than call the first ones the worst."
      }`,
    );
  }
  notes.push(
    figureNote(text, limitInfo),
    "Show each station's type: traffic stations dominate NO₂ rankings by design, ozone is worst at rural background stations.",
    "Don't mix the annual balance and the exceedance table in one ranking; say which one this is.",
  );
  if (unknownStations > 0) {
    notes.push(
      state === undefined && type === undefined
        ? `${unknownStations} station(s) of the table are not in UBA's station catalogue: they are listed by id only.`
        : `${unknownStations} station(s) of the table are not in UBA's station catalogue: their Land and type are unknown, so the filter left them out.`,
    );
  }
  return {
    status: "ok",
    searched,
    component: catalogue.components.get(componentId) ?? { id: componentId },
    year,
    basis,
    basisNote:
      basis === "annualBalance"
        ? "annual balance (Jahresbilanz): UBA's final, checked data"
        : `exceedance table (Überschreitungen): preliminary data${period === undefined ? "" : `, counted ${period.from} to ${period.to}`}`,
    metric: { column, text },
    columns: headers,
    ...(period === undefined ? {} : { period }),
    stationCount: figures.length,
    withoutFigure,
    ...(isCount ? { aboveZero: figures.filter((figure) => figure.value > 0).length } : {}),
    ...(limitInfo === undefined ? {} : { limit: limitInfo, overLimit: figures.filter((figure) => figure.value > limitInfo.value).length }),
    unknownStations,
    stations: ranked.slice(offset, offset + limit),
    ...(offset + limit < ranked.length ? { nextOffset: offset + limit } : {}),
    notes,
  };
}

/** A table's figure: null for none (null or an empty text); a number, never negative; anything else is drift. */
function figureOf(cell: JsonValue | undefined, station: number, tableName: string): number | null {
  if (cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "")) return null;
  const value = num(cell);
  if (value === null) throw new LuftParseError(`The ${tableName} has ${quoteValue(typeof cell === "string" ? cell : JSON.stringify(cell))} as the figure of station ${station}, which is no number: its shape has changed.`);
  if (value < 0) throw new LuftParseError(`The ${tableName} has the negative figure ${value} for station ${station}, which no concentration or count can be: its shape has changed.`);
  return value;
}

/** What the ranked figure means: a count against its allowance (only where the limit allows some), a mean, another figure. */
function figureNote(text: string, limit: ColumnLimit | undefined): string {
  if (limit?.kind === "annual mean limit") return "A mean is a concentration: give it with its unit.";
  if (!/^number of/i.test(text)) return "Give the figure with what the column measures (metric.text) and its unit.";
  if (limit?.kind === "allowed exceedances per year") return `0 is the good result, not missing data. A count above zero is not by itself a breach: ${limit.text}.`;
  if (limit !== undefined) return `0 is the good result, not missing data. ${limit.text}.`;
  return "0 is the good result, not missing data. No EU allowance is read for this count: say what it counts (metric.text), not whether a limit was kept.";
}

function annualMissing(year: number, currentYear: number, now: Date): string {
  const month = Number(cetDay(now).slice(5, 7));
  const due = year >= currentYear || (currentYear === year + 1 && month < 6);
  return due
    ? `No annual balance for ${year} yet: UBA publishes it from the final data in June ${year + 1}.`
    : `No annual balance for ${year} for this component.`;
}

// --- getMeasurements -----------------------------------------------------------------------------

/** The input of {@link getMeasurements}. */
export interface MeasurementsInput {
  station: number;
  /** An id or a name: NO2, PM10, PM2.5, O3, SO2, CO. */
  component: string | number;
  /** The averaging (scope id; default: the one-hour average, else the component's first scope). */
  scope?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** How many values to list, newest first (1-744, default 72). */
  limit?: number | undefined;
  now?: Date | undefined;
}

/**
 * One value: of an hourly scope with its hour's start and end (CET, hour-ending); of a daily scope
 * (`scope.timeBase` "day") with its CET day only, since the API stamps a day's value with the hour
 * 11:00-12:00, which is no time of measurement.
 */
export interface MeasuredValue {
  start?: string;
  end?: string;
  date?: string;
  value: number | null;
}

/** The answer of {@link getMeasurements}. */
export type Measurements =
  | {
      status: "ok";
      station: Station;
      component: ComponentInfo;
      scope: ScopeInfo;
      window: { from: string; to: string; time: string };
      count: number;
      min: MeasuredValue;
      max: MeasuredValue;
      mean: number;
      latest: MeasuredValue;
      /** The newest first. */
      values: MeasuredValue[];
      notes: string[];
    }
  | { status: "empty"; searched: Record<string, unknown>; reason: string; station?: Station };

/**
 * One measured series of a station: a component in one averaging (scope), as concentrations
 * with their unit, newest first, with the window's minimum, maximum and mean. The component
 * and scope are checked against the catalogue's list of what is measured in which scope (the
 * API answers a wrong one like a window without data).
 */
export async function getMeasurements(client: LuftqualitaetClient, input: MeasurementsInput): Promise<Measurements> {
  const limit = assertValid("limit", input.limit ?? 72, limitProblem(744));
  const window = windowOf(input, input.now ?? new Date());
  const componentId = resolveComponent(input.component);
  checkStationInput({ station: input.station });
  if (input.scope !== undefined) assertId("scope", input.scope);
  const catalogue = await loadCatalogue(client);
  const resolved = resolveStation(catalogue, { station: input.station });
  if (resolved.status !== "ok") return resolved as Extract<Measurements, { status: "empty" }>;
  const station = resolved.station;
  const component = catalogue.components.get(componentId);
  const scopes = catalogue.scopesOf.get(componentId) ?? [];
  if (component === undefined || scopes.length === 0) {
    const listed = [...catalogue.components.values()].map((c) => `${c.symbol} (${c.id})`).join(", ");
    throw new LuftValidationError(`Invalid component: ${componentId} has no measured series; the measured components are ${listed}.`);
  }
  const scopeId = input.scope === undefined ? (scopes.includes(2) ? 2 : (scopes[0] as number)) : assertId("scope", input.scope);
  const scopeName = (id: number) => `${catalogue.scopes.get(id)?.name ?? "scope"} (${id})`;
  if (!scopes.includes(scopeId)) {
    throw new LuftValidationError(`Invalid scope: ${component.symbol} is measured in ${scopes.map(scopeName).join(", ")}, not in scope ${scopeId}.`);
  }
  const scope = catalogue.scopes.get(scopeId) ?? { id: scopeId, code: "", name: `scope ${scopeId}`, timeBase: "" };
  const daily = scope.timeBase === "day";
  const searched = { station: station.id, component: componentId, scope: scopeId, from: window.from, to: window.to };
  if (closedBefore(station, window.from)) return { status: "empty", searched, station, reason: closedReason(station, window.from) };
  if (openedAfter(station, window.to)) return { status: "empty", searched, station, reason: openedReason(station, window) };
  const result = await client.measures(
    { station: station.id, component: componentId, scope: scopeId, date_from: window.from, time_from: 1, date_to: window.to, time_to: 24 },
    { stationKnown: true },
  );
  const data = isRecord(result["data"]) ? result["data"][String(station.id)] : undefined;
  const values: MeasuredValue[] = [];
  if (isRecord(data)) {
    for (const key of Object.keys(data).sort()) {
      const row = data[key];
      if (!Array.isArray(row)) continue;
      values.push(daily ? { date: key.slice(0, 10), value: num(row[2]) } : { start: key, end: str(row[3]), value: num(row[2]) });
    }
  }
  const measured = values.filter((entry): entry is MeasuredValue & { value: number } => entry.value !== null);
  if (measured.length === 0) {
    return {
      status: "empty",
      searched,
      station,
      reason: `Station ${station.id} (${station.name}) has no ${component.symbol} values, ${scope.name}, from ${window.from} to ${window.to}: the station may not measure ${component.symbol} (not every station measures every pollutant), or the window has none. Try another station or an earlier window.`,
    };
  }
  const min = measured.reduce((a, b) => (b.value < a.value ? b : a));
  const max = measured.reduce((a, b) => (b.value > a.value ? b : a));
  const mean = Math.round((measured.reduce((sum, entry) => sum + entry.value, 0) / measured.length) * 10) / 10;
  return {
    status: "ok",
    station,
    component,
    scope,
    window: { from: window.from, to: window.to, time: daily ? "CET days: one value per day" : "CET (UTC+1), hour-ending" },
    count: measured.length,
    min,
    max,
    mean,
    latest: measured[measured.length - 1] as MeasuredValue,
    values: values.slice(-limit).reverse(),
    notes: [
      `Values are ${component.symbol} in ${component.unit}, ${scope.name}; cite them with the unit. ${
        daily ? "This is one value per CET day: give it with its date, never as a time of day." : "Times are CET all year."
      }`,
      "Current-year values are provisional (vorläufig geprüft); UBA publishes the checked data in June of the following year.",
    ],
  };
}

// --- getIndexBands -------------------------------------------------------------------------------

/** The answer of {@link getIndexBands}. */
export type IndexBands =
  | {
      status: "ok";
      component: number;
      sets: { scope: number; scopeName: string; usedForIndex: boolean; bands: { level: number; label: string; min: number | null; max: number | null }[] }[];
      notes: string[];
    }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

const SCOPE_NAMES: Record<number, string> = {
  1: "daily average",
  2: "one-hour average",
  3: "maximum one-hour average",
  4: "eight-hour average",
  5: "maximum eight-hour average",
  6: "daily average (hourly floating)",
};

/**
 * The concentration bands behind each air-quality index level of a component, per averaging
 * (scope): "NO₂ 95 µg/m³ sits in the 41–100 band = level 2". PM₁₀ and PM₂.₅ have two band sets;
 * the index follows scope 6 (the hourly floating daily average). CO has none.
 */
export async function getIndexBands(client: LuftqualitaetClient, input: { component: string | number }): Promise<IndexBands> {
  const component = resolveComponent(input.component);
  const result = await client.thresholds({ use: "airquality", component });
  const byScope = new Map<number, { level: number; label: string; min: number | null; max: number | null }[]>();
  for (const row of rowsOf(result)) {
    if (num(row[1]) !== component) continue;
    const scope = num(row[2]);
    const level = num(row[6]);
    if (scope === null || level === null) continue;
    const list = byScope.get(scope) ?? [];
    list.push({ level, label: levelLabel(level)?.label ?? `level ${level}`, min: num(row[4]), max: num(row[5]) });
    byScope.set(scope, list);
  }
  if (byScope.size === 0) {
    return { status: "empty", searched: { component }, reason: `Component ${component} has no air-quality index bands: it is not part of the index (CO has none, nor have the metals). getMeasurements gives its values.` };
  }
  const several = byScope.size > 1;
  return {
    status: "ok",
    component,
    sets: [...byScope]
      .sort(([a], [b]) => a - b)
      .map(([scope, bands]) => ({
        scope,
        scopeName: SCOPE_NAMES[scope] ?? `scope ${scope}`,
        usedForIndex: !several || scope === 6,
        bands: bands.sort((a, b) => a.level - b.level),
      })),
    notes: [
      "The bands differ per pollutant: quote the component's own bands.",
      ...(several ? ["The index follows the set with usedForIndex (scope 6, the daily average, hourly floating), not the hourly one."] : []),
    ],
  };
}

// --- listComponents ------------------------------------------------------------------------------

/** The answer of {@link listComponents}. */
export interface ComponentList {
  status: "ok";
  components: ComponentInfo[];
  scopes: ScopeInfo[];
  notes: string[];
}

/** Every component (pollutant) with its id, formula and unit, and the averaging scopes, in English. */
export async function listComponents(client: LuftqualitaetClient): Promise<ComponentList> {
  const components = await client.components({ lang: "en" });
  const scopes = await client.scopes({ lang: "en" });
  return {
    status: "ok",
    components: rowsOf(components).flatMap((row) => {
      const id = num(row[0]);
      return id === null ? [] : [{ id, code: str(row[1]), symbol: str(row[2]), unit: str(row[3]), name: str(row[4]) }];
    }),
    scopes: rowsOf(scopes).flatMap((row) => {
      const id = num(row[0]);
      return id === null ? [] : [{ id, code: str(row[1]), name: str(row[5]), timeBase: str(row[2]) }];
    }),
    notes: ["Not every component is in the air-quality index: getIndexBands says which have bands. The metals and benzene are lab values, not hourly ones."],
  };
}

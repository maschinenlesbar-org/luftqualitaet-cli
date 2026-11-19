// A mock of the Air Data API for the use cases (operations.ts) and the MCP server tests: live-shaped
// answers (recorded on 2026-11-19 and trimmed to a few stations), routed by path and query as
// the API answers them. An unknown station gets data {} (as the API answers), a window without
// rows too; the 2017 NO2 exceedance table answers HTTP 500, as the live API does for 2016-2018.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { JsonValue } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

// Station catalogue rows (meta?use=measure, lang=en), as the API sends them: lon at 7, lat at 8.
export const STATION_ROWS: Record<string, JsonValue[]> = {
  "21": ["21","DEBB021","Potsdam-Zentrum","Potsdam","PDBA","2009-04-15",null,"13.0602","52.4014","4","1","1","BB","Brandenburg","urban area","urban","background","Am Bassinplatz","","14467"],
  "28": ["28","DEBB029","Schwedt (Oder)","Schwedt/Oder","SWHE","1993-04-06",null,"14.2851","53.0643","4","2","2","BB","Brandenburg","suburban area","suburban","industry","Helbigstr.","","16303"],
  "31": ["31","DEBB032","Eisenhüttenstadt","Eisenhüttenstadt","EHST","1993-04-20",null,"14.6382","52.1463","4","2","2","BB","Brandenburg","suburban area","suburban","industry","Karl-Marx-Str.","35","15890"],
  "43": ["43","DEBB045","Frankfurt (Oder), Leipziger Str.","Frankfurt (Oder)","FFLS","1995-08-01",null,"14.5386","52.3373","4","1","3","BB","Brandenburg","urban area","urban","traffic","Leipziger Str.","","15232"],
  "240": ["240","DEBW031","Schwarzwald-Süd","Münstertal","Kälbelescheuer","1984-01-01",null,"7.7645","47.8099","1","5","1","BW","Baden-Württemberg","rural regional","rural","background","Nähe Kälbelescheuer/Kl. Kaibenkopf","","79244"],
  "680": ["680","DEHE052","Kleiner Feldberg","Glashütten","","1992-03-12",null,"8.4461","50.2219","7","3","1","HE","Hesse","rural area","rural","background","Feldweg","","61479"],
  "1613": ["1613","DESN025","Leipzig-Mitte","Leipzig","","1990-12-01",null,"12.3772","51.3442","13","1","3","SN","Saxony","urban area","urban","traffic","Willy-Brandt-Platz/Am Hallischen Tor","","04109"],
  "1647": ["1647","DESN059","Leipzig-West","Leipzig","","1994-09-01",null,"12.2974","51.3179","13","2","1","SN","Saxony","suburban area","suburban","background","Nikolai-Rumjanzew-Str.","100","04207"],
  "1665": ["1665","DESN077","Leipzig Lützner Str.","Leipzig","","2001-01-01",null,"12.3347","51.3359","13","1","3","SN","Saxony","urban area","urban","traffic","Lützner Str.","34/36","04177"],
  "1670": ["1670","DESN082","Leipzig-Thekla","Leipzig","","2004-04-01","2020-12-31","12.4257","51.3760","13","2","1","SN","Saxony","suburban area","suburban","background","Kiebitzstr.","","04349"],
  "1671": ["1671","DESN083","Chemnitz-Leipziger Str.","Chemnitz","","2016-04-01",null,"12.9034","50.8457","13","1","3","SN","Saxony","urban area","urban","traffic","Leipziger Str.","","09113"],
  "9480": ["9480","DEBE125","Berlin Leipziger Straße (MC)","Berlin","","2020-03-26",null,"13.3824","52.5098","3","1","3","BE","Berlin","urban area","urban","traffic","Leipziger Straße","5","10117"],
  "471": ["471","DEBY037","München/Stachus","München","","1978-01-01",null,"11.5649","48.1373","2","1","3","BY","Bavaria","urban area","urban","traffic","Sonnenstraße","","80335"],
  "473": ["473","DEBY039","München/Lothstraße","München","","1978-01-01",null,"11.5547","48.1545","2","1","1","BY","Bavaria","urban area","urban","background","Lothstraße","62","80335"],
  "523": ["523","DEBY089","München/Johanneskirchen","München, Stadtteil Johanneskirchen","","1993-07-01",null,"11.6480","48.1732","2","2","1","BY","Bavaria","suburban area","suburban","background","Nußstraße","","81929"],
  "535": ["535","DEBY115","München/Landshuter Allee","München","","2004-07-01",null,"11.5365","48.1496","2","1","3","BY","Bavaria","urban area","urban","traffic","Landshuter Allee","31","80637"],
};

// The rest of the catalogue: scopes, which component is measured in which scope, components, networks.
export const META_TABLES: Record<string, JsonValue> = {"scopes":{"1":["1","1TMW","day","86400","0","Daily average"],"2":["2","1SMW","hour","3600","0","One hour average"],"3":["3","1SMW_MAX","hour","3600","1","Maximum one hour average"],"4":["4","8SMW","hour","28800","0","Eight hour average"],"5":["5","8SMW_MAX","hour","28800","1","Maximum eight hour average"],"6":["6","1TMWGL","hour","3600","0","Daily average (hourly floating)"]},"xref":[["1","1","1","1","0"],["1","2","1","1","1"],["1","6","0","1","1"],["2","4","1","0","1"],["2","5","1","0","0"],["3","2","1","1","1"],["3","3","1","1","0"],["3","4","1","1","1"],["3","5","1","1","0"],["4","1","1","0","0"],["4","2","1","0","1"],["4","3","1","0","0"],["5","2","1","1","1"],["5","3","1","1","0"],["9","1","1","0","0"],["9","2","1","0","1"],["9","6","0","0","1"]],"components":{"1":["1","PM10","PM₁₀","µg/m³","Particulate matter"],"2":["2","CO","CO","mg/m³","Carbon monoxide"],"3":["3","O3","O₃","µg/m³","Ozone"],"4":["4","SO2","SO₂","µg/m³","Sulphur dioxide"],"5":["5","NO2","NO₂","µg/m³","Nitrogen dioxide"],"9":["9","PM2","PM₂,₅","µg/m³","Particulate matter"]},"networks":{"1":["1","BW","Baden-Württemberg"],"2":["2","BY","Bavaria"],"3":["3","BE","Berlin"],"4":["4","BB","Brandenburg"],"5":["5","HB","Bremen"],"6":["6","HH","Hamburg"],"7":["7","HE","Hesse"],"8":["8","MV","Mecklenburg-West Pomerania"],"9":["9","NI","Lower Saxony"],"10":["10","NW","North Rhine-Westphalia"],"11":["11","RP","Rhineland-Palatinate"],"12":["12","SL","Saarland"],"13":["13","SN","Saxony"],"14":["14","ST","Saxony-Anhalt"],"15":["15","SH","Schleswig-Holstein"],"16":["16","TH","Thuringia"],"17":["17","UB","UBA"]}};

/** The catalogue answer. */
export function metaAnswer(): Record<string, JsonValue> {
  return { stations: STATION_ROWS, ...META_TABLES, limits: {}, request: { use: "measure", lang: "en", recent: false, index: "id" } };
}

/** Annual balances (lang=en), by "component/year". */
export const ANNUAL: Record<string, { headers: Record<string, string>; data: JsonValue[][] }> = {
  "3/2025": {
    headers: { "1": "Number of hourly mean values above 240 µg/m³", "2": "Number of hourly mean values above 180 µg/m³", "3": "Number of days with highest daily 8-hour averages above 120 µg/m³", "4": "Number of days with highest daily 8-hour averages above 120 µg/m³, 3-year average", "5": "AOT40* in µg/m³h", "6": "AOT40* in µg/m³h, 5-year average" },
    data: [["21","0","0","8","11",null,null],["28","0","0","5","7.3","8530","11236"],["31","0","0","9","9","10672","14044"],["240","0","0","40","33","17167","15646"],["473","0","0","25","22",null,null],["523","0","0","23","17","19734","16612"],["680","0","14","37","38","19056","18875"],["1613","0","0","4","1.7",null,null],["1647","0","0","10","9.3","10845","11299"]],
  },
  "5/2024": {
    headers: { "1": "Annual mean value in µg/m³", "2": "Number of hourly mean values above 200 µg/m³*" },
    data: [["21","9","0"],["28","7","0"],["31","7","0"],["43","27","0"],["240","2","0"],["471","24","0"],["473","17","0"],["523","13","0"],["535","39","0"],["680","4","0"],["1613","21","0"],["1647","9","0"],["1665","19","0"],["1671","21","0"],["9480","25","0"]],
  },
};

/** Exceedance tables (lang=en), by "component/year". */
export const TRANSGRESSIONS: Record<string, { headers: Record<string, string>; data: JsonValue[][] }> = {
  // A completed year's preliminary table before its annual balance is out; one station stops early.
  "1/2025": {
    headers: { "3": "Number of daily mean values above 50 µg/m³" },
    data: [
      ["1613", "2025-01-01", "2025-11-30", "12", "3", "3", "6"],
      ["535", "2025-01-01", "2025-11-30", "14", "9", "1", "4"],
      ["21", "2025-01-01", "2025-10-31", "4", "3", "1"],
    ],
  },
  "1/2026": {
    headers: { "3": "Number of daily mean values above 50 µg/m³" },
    data: [["21","2026-01-01","2026-11-18","5","3","1","1","0","0","0","0","0","0","0","0"],["28","2026-01-01","2026-11-18","3","2","0","1","0","0","0","0","0","0","0","0"],["31","2026-01-01","2026-11-18","8","4","3","0","0","0","0","0","0","1","0","0"],["43","2026-01-01","2026-11-18","8","4","1","3","0","0","0","0","0","0","0","0"],["240","2026-01-01","2026-11-18","2","0","0","2","0","0","0","0","0","0","0","0"],["471","2026-01-01","2026-11-18","7","6","0","1","0","0","0","0","0","0","0","0"],["473","2026-01-01","2026-11-18","5","4","0","1","0","0","0","0","0","0","0","0"],["523","2026-01-01","2026-11-18","2","2","0","0","0","0","0","0","0","0","0","0"],["535","2026-01-01","2026-11-18","11","9","1","1","0","0","0","0","0","0","0","0"],["680","2026-01-01","2026-11-18","0","0","0","0","0","0","0","0","0","0","0","0"],["1613","2026-01-01","2026-11-18","7","3","3","1","0","0","0","0","0","0","0","0"],["1647","2026-01-01","2026-11-18","5","3","1","1","0","0","0","0","0","0","0","0"],["1665","2026-01-01","2026-11-18","12","3","3","6","0","0","0","0","0","0","0","0"],["1671","2026-01-01","2026-11-18","2","0","1","1","0","0","0","0","0","0","0","0"],["9480","2026-01-01","2026-11-18","18","4","4","10","0","0","0","0","0","0","0","0"]],
  },
};

/** The index series of station 1613 on 18-19 Nov 2026 (CET), trimmed: the API's key order, 02:00 listed before 00:00. */
export const AIRQUALITY_1613: Record<string, JsonValue[]> = {
  "2026-11-18 21:00:00": ["2026-11-18 22:00:00", 0, 0, [3, 47, 0, "0.783"], [5, 20, 0, "1"], [1, 6, 0, "0.3"], [9, 3, 0, "0.3"]],
  "2026-11-18 22:00:00": ["2026-11-18 23:00:00", 1, 0, [3, 64, 1, "1.051"], [5, 6, 0, "0.3"], [1, 12, 0, "0.6"], [9, 6, 0, "0.6"]],
  "2026-11-18 23:00:00": ["2026-11-18 24:00:00", 2, 0, [3, 64, 1, "1.051"], [5, 95, 2, "2.1"], [1, 12, 0, "0.6"], [9, 6, 0, "0.6"]],
  "2026-11-19 02:00:00": ["2026-11-19 03:00:00", 1, 1, [3, 70, 1, "1.1"], [5, 25, 1, "1.2"]],
  "2026-11-19 00:00:00": ["2026-11-19 01:00:00", 1, 0, [3, 62, 1, "1.017"], [5, 17, 0, "0.85"], [1, 6, 0, "0.3"], [9, 3, 0, "0.3"]],
  "2026-11-19 01:00:00": ["2026-11-19 02:00:00", 0, 0, [3, 55, 0, "0.917"], [5, 7, 0, "0.35"], [1, 12, 0, "0.6"], [9, 6, 0, "0.6"]],
};

/** NO2, one-hour averages, at station 1613 on 18 Nov 2026: [component, scope, value, end, index]. */
export const MEASURES_1613_NO2: Record<string, JsonValue[]> = {
  "2026-11-18 00:00:00": [5, 2, 11, "2026-11-18 01:00:00", "0"],
  "2026-11-18 01:00:00": [5, 2, 7, "2026-11-18 02:00:00", "0"],
  "2026-11-18 02:00:00": [5, 2, null, "2026-11-18 03:00:00", "0"],
  "2026-11-18 03:00:00": [5, 2, 6, "2026-11-18 04:00:00", "0"],
  "2026-11-18 04:00:00": [5, 2, 23, "2026-11-18 05:00:00", "1"],
};

export const COMPONENTS: Record<string, JsonValue> = {"1":["1","PM10","PM₁₀","µg/m³","Particulate matter"],"2":["2","CO","CO","mg/m³","Carbon monoxide"],"3":["3","O3","O₃","µg/m³","Ozone"],"4":["4","SO2","SO₂","µg/m³","Sulphur dioxide"],"5":["5","NO2","NO₂","µg/m³","Nitrogen dioxide"],"6":["6","PM10PB","Pb","µg/m³","Lead in particulate matter"],"7":["7","PM10BAP","BaP","ng/m³","Benzo(a)pyrene in particulate matter"],"8":["8","CHB","C₆H₆","µg/m³","Benzene"],"9":["9","PM2","PM₂,₅","µg/m³","Particulate matter"],"10":["10","PM10AS","As","ng/m³","Arsenic in particulate matter"],"11":["11","PM10CD","Cd","ng/m³","Cadmium in particulate matter"],"12":["12","PM10NI","Ni","ng/m³","Nickel in particulate matter"],"count":12,"indices":["component id","component code","component symbol","component unit","component name"]};
export const SCOPES: Record<string, JsonValue> = {"1":["1","1TMW","day","86400","0","Daily average"],"2":["2","1SMW","hour","3600","0","One hour average"],"3":["3","1SMW_MAX","hour","3600","1","Maximum one hour average"],"4":["4","8SMW","hour","28800","0","Eight hour average"],"5":["5","8SMW_MAX","hour","28800","1","Maximum eight hour average"],"6":["6","1TMWGL","hour","3600","0","Daily average (hourly floating)"],"count":6,"indices":["scope id","scope code","scope time base","scope time scope","scope time is max","scope name"]};

/** Index bands (thresholds?use=airquality), by component: NO2 one set, PM10 two (scopes 2 and 6), CO none. */
export const BANDS: Record<string, Record<string, JsonValue>> = {
  "5": {"1":["1","5","2","aq","0","20","0"],"2":["2","5","2","aq","21","40","1"],"3":["3","5","2","aq","41","100","2"],"4":["4","5","2","aq","101","200","3"],"5":["5","5","2","aq","201","1000","4"],"count":5,"indices":["threshold id","component id","scope id","threshold type","threshold min","threshold max","threshold index"]},
  "1": {
    "1": ["1", "1", "2", "aq", "0", "20", "0"], "2": ["2", "1", "2", "aq", "21", "35", "1"], "3": ["3", "1", "2", "aq", "36", "50", "2"], "4": ["4", "1", "2", "aq", "51", "100", "3"], "5": ["5", "1", "2", "aq", "101", "1000", "4"],
    "6": ["6", "1", "6", "aq", "0", "20", "0"], "7": ["7", "1", "6", "aq", "21", "35", "1"], "8": ["8", "1", "6", "aq", "36", "50", "2"], "9": ["9", "1", "6", "aq", "51", "100", "3"], "10": ["10", "1", "6", "aq", "101", "1000", "4"],
    count: 10,
    indices: ["threshold id", "component id", "scope id", "threshold type", "threshold min", "threshold max", "threshold index"],
  },
  "2": { count: 0, indices: ["threshold id", "component id", "scope id", "threshold type", "threshold min", "threshold max", "threshold index"] },
};

const API = "/api/air-data/v3/";

/** Keep the hours of `series` whose day lies in the request's window. */
function inWindow(series: Record<string, JsonValue[]>, from: string | null, to: string | null): Record<string, JsonValue[]> {
  return Object.fromEntries(Object.entries(series).filter(([key]) => (from === null || key.slice(0, 10) >= from) && (to === null || key.slice(0, 10) <= to)));
}

/** The answer the API gives `request`, from the fixtures above. */
export function airData(request: HttpRequest): HttpResponse {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
  const q = (name: string) => url.searchParams.get(name);
  const request_ = Object.fromEntries(url.searchParams);
  switch (path) {
    case "meta/json":
      return jsonResponse(metaAnswer());
    case "airquality/json": {
      const data = q("station") === "1613" ? { "1613": inWindow(AIRQUALITY_1613, q("date_from"), q("date_to")) } : {};
      const empty = Object.values(data).every((hours) => Object.keys(hours).length === 0);
      return jsonResponse({ request: request_, data: empty ? {} : data, indices: {}, count: 0 });
    }
    case "measures/json": {
      const hit = q("station") === "1613" && q("component") === "5" && q("scope") === "2";
      const hours = hit ? inWindow(MEASURES_1613_NO2, q("date_from"), q("date_to")) : {};
      return jsonResponse({ request: request_, indices: {}, data: Object.keys(hours).length === 0 ? {} : { "1613": hours } });
    }
    case "annualbalances/json": {
      const table = ANNUAL[`${q("component")}/${q("year")}`];
      return jsonResponse({ request: request_, data: table?.data ?? {}, indices: ["station id", "component id", "year", "value", "transgression type id"], headers: table?.headers ?? {} });
    }
    case "transgressions/json": {
      if (q("component") === "5" && q("year") === "2017") return jsonResponse({ error: "Internal Server Error" }, 500);
      const table = TRANSGRESSIONS[`${q("component")}/${q("year")}`];
      return jsonResponse({ request: request_, indices: ["station id", "day_first", "day_recent", "value of year", "4-16 values of months"], data: table?.data ?? {}, headers: table?.headers ?? {} });
    }
    case "thresholds/json":
      return jsonResponse(BANDS[q("component") ?? ""] ?? BANDS["2"]);
    case "components/json":
      return jsonResponse(COMPONENTS);
    case "scopes/json":
      return jsonResponse(SCOPES);
    default:
      return jsonResponse({ error: `no fixture for ${path}` }, 404);
  }
}

/** A mock transport over the fixtures: every request answered as the API would. */
export function airDataApi(): MockTransport {
  return makeMockTransport(airData);
}

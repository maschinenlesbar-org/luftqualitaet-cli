// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings, and the runtime meaning of an option given as undefined.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LuftqualitaetClient } from "../src/index.js";
import { OK_BODY, constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "luftqualitaet-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { LuftqualitaetClient, type EngineOptions, type FilterOptions, type ListParams, type MetaParams, type ThresholdParams, type YearComponentParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const filters: FilterOptions = allUndefined<FilterOptions>();",
        "export const list: ListParams = allUndefined<ListParams>();",
        "export const meta: MetaParams = { use: \"measure\", lang: undefined, date_from: undefined, date_to: undefined, time_from: undefined, time_to: undefined };",
        "export const thresholds: ThresholdParams = { use: \"measure\", lang: undefined, component: undefined, scope: undefined };",
        "export const annual: YearComponentParams = { component: 5, year: 2024, lang: undefined, index: undefined };",
        "export const client = new LuftqualitaetClient({ baseUrl: process.env.LUFTQUALITAET_BASE_URL, timeoutMs: 15_000 });",
        "export const components = (): Promise<unknown> => client.components({ lang: undefined }, { allowUnknownFilters: undefined });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson(OK_BODY);
  const client = new LuftqualitaetClient({
    baseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.components({ lang: undefined, index: undefined }, { allowUnknownFilters: undefined });
  assert.equal(mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/components/json");
  assert.equal(mt.last().headers?.["User-Agent"], "luftqualitaet-cli");
  await client.thresholds({ use: "measure", lang: undefined, component: undefined, scope: undefined });
  assert.equal(mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/thresholds/json?use=measure");
  await client.meta({ use: "measure", lang: undefined, date_from: undefined, date_to: undefined, time_from: undefined, time_to: undefined });
  assert.equal(mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/meta/json?use=measure");
  await client.annualBalances({ component: 5, year: 2024, lang: undefined, index: undefined });
  assert.equal(mt.last().url, "https://luftdaten.umweltbundesamt.de/api/air-data/v3/annualbalances/json?component=5&year=2024");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { LuftqualitaetClient, baseUrlApiPathProblem } from "../src/client/client.js";
import { LuftError, LuftValidationError } from "../src/client/errors.js";
import {
  assertValid,
  baseUrlWhitespaceProblem,
  headerValueProblem,
  nonBlankProblem,
  type Problem,
} from "../src/client/validate.js";
import * as root from "../src/index.js";
import type { CliDeps } from "../src/cli/io.js";
import { jsonResponse, makeMockTransport, parity } from "./helpers.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("lang", "de", nonBlank), "de");
});

test("assertValid throws LuftValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("lang", " ", nonBlank),
    (err: unknown) =>
      err instanceof LuftValidationError &&
      err instanceof LuftError &&
      err.name === "LuftValidationError" &&
      err.message === "Invalid lang: Expected a non-empty value.",
  );
});

test("LuftValidationError and assertValid are exported from the package root", () => {
  assert.equal(root.LuftValidationError, LuftValidationError);
  assert.equal(root.assertValid, assertValid);
});

test("a library parameter check rejects with LuftValidationError and sends nothing", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const client = new LuftqualitaetClient({ transport: mt.transport });
  await assert.rejects(client.components({ lang: "fr" as "de" }), LuftValidationError);
  assert.equal(mt.calls.length, 0);
});

function cliWith(createClient: CliDeps["createClient"]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, createClient };
  return { deps, out, err };
}

test("run() maps a LuftValidationError raised in an action to the usage exit code 1", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  class Rejecting extends LuftqualitaetClient {
    override async networks(): Promise<never> {
      throw new LuftValidationError("Invalid index: expected one of id, code, got \"x\".");
    }
  }
  const cli = cliWith((opts) => new Rejecting({ ...opts, transport: mt.transport }));
  const code = await run(["networks"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.join("\n"), 'Error: Invalid index: expected one of id, code, got "x".');
  assert.equal(mt.calls.length, 0);
});

test("run() maps a LuftValidationError from building the client to exit code 1", async () => {
  const cli = cliWith(() => {
    throw new LuftValidationError("Invalid baseUrl: Expected a valid URL.");
  });
  const code = await run(["networks"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.err.join("\n"), "Error: Invalid baseUrl: Expected a valid URL.");
});

test("parity() runs one input through the CLI and the library on one transport", async () => {
  const { cli, lib } = await parity(
    ["--compact", "components", "--lang", "en"],
    (transport) => new LuftqualitaetClient({ transport }).components({ lang: "en" }),
    () => jsonResponse({ count: 0 }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, '{"count":0}');
  assert.ok(lib.ok);
  assert.deepEqual(lib.value, { count: 0 });
  assert.equal(cli.requests.length, 1);
  assert.deepEqual(cli.requests, lib.requests);
});

test("nonBlankProblem rejects a non-string and a blank string", () => {
  assert.equal(nonBlankProblem("x"), undefined);
  assert.equal(nonBlankProblem(""), "Expected a non-empty value.");
  assert.equal(nonBlankProblem(" \t"), "Expected a non-empty value.");
  assert.equal(nonBlankProblem(5), "Expected a string.");
});

test("headerValueProblem allows tab and Latin-1, rejects blank, controls, DEL and > U+00FF", () => {
  assert.equal(headerValueProblem("my-app/1.0"), undefined);
  assert.equal(headerValueProblem("a\tb"), undefined);
  assert.equal(headerValueProblem("café ÿ"), undefined);
  assert.equal(headerValueProblem("  "), "Expected a non-empty value.");
  for (const bad of ["a\r\nb", "a\nb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  for (const bad of ["€", "日本", "aĀ"]) {
    assert.equal(headerValueProblem(bad), "Value contains characters outside Latin-1 (above U+00FF).", bad);
  }
});

test("the client constructor rejects a bad userAgent with LuftValidationError", () => {
  assert.throws(
    () => new LuftqualitaetClient({ userAgent: "a\r\nX-Evil: 1" }),
    (err: unknown) =>
      err instanceof LuftValidationError && err.message === "Invalid userAgent: Value contains control characters.",
  );
  assert.equal(root.assertHeaderValue("User-Agent", "ok/1"), "ok/1");
});

test("baseUrlWhitespaceProblem rejects surrounding and inner whitespace and controls", () => {
  assert.equal(baseUrlWhitespaceProblem("https://h.example/p/"), undefined);
  assert.equal(baseUrlWhitespaceProblem(" https://h.example"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlWhitespaceProblem("https://h.example/\n"), "A base URL cannot have surrounding whitespace.");
  for (const bad of ["https://h.example/a b", "https://h.example/a\tb", "https://h.example/a\u0000b", "https://h.example/a\u007fb"]) {
    assert.equal(baseUrlWhitespaceProblem(bad), "A base URL cannot contain whitespace or control characters.", JSON.stringify(bad));
  }
});

test("baseUrlApiPathProblem rejects a path ending in the API path, either spelling", () => {
  assert.equal(baseUrlApiPathProblem("https://luftdaten.umweltbundesamt.de"), undefined);
  assert.equal(baseUrlApiPathProblem("http://mirror.test/uba/"), undefined);
  assert.equal(baseUrlApiPathProblem("notaurl"), undefined);
  assert.equal(
    baseUrlApiPathProblem("https://user:pw@h.example/x/api/air_data/v3//"),
    "Leave out /api/air_data/v3: the base URL is the host, and the client adds /api/air-data/v3 itself (try https://h.example/x).",
  );
});

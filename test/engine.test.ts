import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { LuftApiError, LuftNetworkError, LuftParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

// Built via char codes so no raw control bytes ever appear in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("api/"), "https://example.test/api/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("buildUrl rejects a malformed base URL with a clear, base-only message", () => {
  const e = new RequestEngine({ baseUrl: "notaurl" });
  assert.throws(
    () => e.buildUrl("/api/air_data/v3/components/json"),
    (err: unknown) =>
      err instanceof LuftNetworkError &&
      /Invalid base URL: "notaurl"/.test(err.message) &&
      // the diagnostic must NOT carry the request path (which read as if at fault)
      !/components/.test(err.message),
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws LuftParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), LuftParseError);
});

test("a 503 is retried up to maxRetries then surfaces as LuftApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof LuftApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a same-origin redirect is followed and headers are preserved", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      return { status: 302, headers: { location: "/moved" }, body: Buffer.from("") };
    }
    assert.match(req.url, /\/moved$/);
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/start"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a cross-origin redirect strips headers down to benign defaults", async () => {
  let calls = 0;
  let secondHeaders: Record<string, string> | undefined;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 302,
        headers: { location: "https://evil.test/x" },
        body: Buffer.from(""),
      };
    }
    secondHeaders = req.headers as Record<string, string>;
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://a.test",
    transport: mt.transport,
    userAgent: "ua/1",
  });
  await e.getJson("/start");
  assert.equal(calls, 2);
  // Only Accept and User-Agent should survive the cross-origin hop.
  assert.deepEqual(Object.keys(secondHeaders ?? {}).sort(), ["Accept", "User-Agent"]);
  assert.equal(secondHeaders?.["User-Agent"], "ua/1");
});

test("error detail is stripped of terminal control characters", async () => {
  // ESC + CSI + BEL interleaved with printable text in an attacker-controlled body.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof LuftApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints raw to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("an unparsable redirect Location surfaces as a typed LuftNetworkError", async () => {
  const mt = makeMockTransport(() => ({
    status: 302,
    headers: { location: "http://[garbage" },
    body: Buffer.from(""),
  }));
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/start"),
    (err: unknown) =>
      err instanceof LuftNetworkError && /Invalid redirect Location/.test(err.message),
  );
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

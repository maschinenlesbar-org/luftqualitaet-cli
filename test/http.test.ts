import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { LuftNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/o/autobahn/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/o/autobahn/" });
    },
  );
});

test("rejects an unsupported protocol with LuftNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    LuftNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        LuftNetworkError,
      );
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("a slow-drip response is bounded by the wall-clock deadline", async () => {
  // The server dribbles one byte every 20ms and never ends. Each byte resets the
  // idle-socket timeout, so without a separate wall-clock deadline the request
  // would hang forever while staying under maxResponseBytes. The deadline must
  // still fire and surface a LuftNetworkError.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const t = setInterval(() => res.write("x"), 20);
      timers.push(t);
      res.on("close", () => clearInterval(t));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 80 }),
        (err: unknown) => {
          assert.ok(err instanceof LuftNetworkError);
          // The wall-clock deadline, not the idle timeout, is what caught it.
          assert.match(err.message, /deadline/);
          return true;
        },
      );
    },
  );
  for (const t of timers) clearInterval(t);
});

test("reused keep-alive sockets do not collect lookup/connect listeners", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const warnings: Error[] = [];
  const onWarning = (w: Error): void => {
    warnings.push(w);
  };
  process.on("warning", onWarning);
  const ports = new Set<number>();
  try {
    await withServer(
      (req, res) => {
        ports.add(req.socket.remotePort ?? 0);
        res.setHeader("content-type", "application/json");
        res.end("{}");
      },
      async (baseUrl) => {
        const transport = (url: string) =>
          new Promise<void>((resolve, reject) => {
            // Route through a dedicated keep-alive agent so the socket is reused.
            const saved = http.globalAgent;
            http.globalAgent = agent;
            nodeHttpTransport({ method: "GET", url, timeoutMs: 5000 })
              .then(() => resolve(), reject)
              .finally(() => {
                http.globalAgent = saved;
              });
          });
        for (let i = 0; i < 15; i++) await transport(`${baseUrl}/x${i}`);
        const free = Object.values(agent.freeSockets).flat();
        assert.equal(free.length, 1);
        const socket = free[0]!;
        assert.equal(socket.listenerCount("lookup"), 0);
        assert.equal(socket.listenerCount("connect"), 0);
      },
    );
  } finally {
    process.off("warning", onWarning);
    agent.destroy();
  }
  assert.equal(ports.size, 1, "the socket was reused");
  assert.deepEqual(
    warnings.filter((w) => w.name === "MaxListenersExceededWarning"),
    [],
  );
});

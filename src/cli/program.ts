// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { API_PATH, LuftqualitaetClient } from "../client/client.js";
import { DEFAULT_BASE_URL, MAX_RETRIES } from "../client/engine.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { parseBaseUrl, parseBoundedInt, parseIntArg } from "./shared.js";
import { registerReferenceCommands } from "./commands/reference.js";
import { registerDataCommands } from "./commands/data.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new LuftqualitaetClient(options),
};

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("luftqualitaet")
    .description(
      "CLI for the open Umweltbundesamt Air Data API " +
        `(${DEFAULT_BASE_URL}${API_PATH})`,
    )
    .version(VERSION)
    .option(
      "--base-url <url>",
      `API host; the CLI adds ${API_PATH} itself`,
      parseBaseUrl,
      DEFAULT_BASE_URL,
    )
    .option(
      "--timeout <ms>",
      `per-request timeout in milliseconds (0..${MAX_TIMEOUT_MS})`,
      parseBoundedInt(0, MAX_TIMEOUT_MS),
    )
    .option("--user-agent <ua>", "User-Agent header value")
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses (0..${MAX_RETRIES}; each waits the server's Retry-After, up to 30 s)`,
      parseBoundedInt(0, MAX_RETRIES),
    )
    .option("--max-redirects <n>", "HTTP redirects to follow (0 = none; default 5)", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerReferenceCommands(program, deps);
  registerDataCommands(program, deps);

  return program;
}

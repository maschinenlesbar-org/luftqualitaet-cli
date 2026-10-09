#!/usr/bin/env node
// Binary entry point. Thin shim around run(); all logic lives in run.ts/program.ts.

import { handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
// Node's own process warnings are records too, not plain lines.
installWarningLog(process, log);
handleOutputErrors(process, undefined, log);
try {
  process.exitCode = await run(argv);
} catch (err) {
  // run() reports its own errors; this is the last resort, a log record all the same.
  log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

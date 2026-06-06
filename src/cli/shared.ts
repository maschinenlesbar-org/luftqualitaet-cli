// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { LuftError } from "../client/errors.js";
import type { EngineOptions } from "../client/engine.js";
import { IndexValues, LangValues } from "../client/enums.js";
import type { IndexKind, Lang } from "../client/enums.js";

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser: a positive integer (>= 1). Used for ids — station,
 * component and scope ids are 1-based in this API, so `0` is a user error that
 * should be caught locally rather than sent.
 */
export function parsePositiveIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("Expected a positive integer (>= 1).");
  }
  return n;
}

/**
 * commander value-parser: an hour in the API's hour-ending range `1..24`.
 * (The UBA API uses hour-ending times; `0` and `> 24` are invalid.)
 */
export function parseHour(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new InvalidArgumentError("Expected an hour in the range 1..24.");
  }
  return n;
}

/** commander value-parser: a four-digit year, `>= 2016` (the API's earliest). */
export function parseYear(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2016) {
    throw new InvalidArgumentError("Expected a four-digit year >= 2016.");
  }
  return n;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a LuftError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new LuftError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Resolve and validate the optional `--lang` option shared by many commands. */
export function lang(opts: Record<string, unknown>): Lang | undefined {
  return opts["lang"] === undefined
    ? undefined
    : assertEnum(String(opts["lang"]), LangValues, "lang");
}

/** Resolve and validate the optional `--index` option shared by many commands. */
export function index(opts: Record<string, unknown>): IndexKind | undefined {
  return opts["index"] === undefined
    ? undefined
    : assertEnum(String(opts["index"]), IndexValues, "index");
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

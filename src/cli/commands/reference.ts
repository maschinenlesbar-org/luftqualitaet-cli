import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, index, lang, renderJson } from "../shared.js";

export function registerReferenceCommands(program: Command, deps: CliDeps): void {
  const indexed: { name: string; method: "components" | "networks" | "scopes"; desc: string }[] = [
    { name: "components", method: "components", desc: "List measured components (pollutants)" },
    { name: "networks", method: "networks", desc: "List measurement networks" },
    { name: "scopes", method: "scopes", desc: "List measurement scopes" },
  ];
  for (const { name, method, desc } of indexed) {
    program
      .command(name)
      .description(desc)
      .option("--lang <lang>", "de | en")
      .option("--index <index>", "id | code")
      .action(
        action(deps, async ({ client, global, opts }) => {
          renderJson(deps, global, await client[method]({ lang: lang(opts), index: index(opts) }));
        }),
      );
  }

  const simple: {
    name: string;
    method: "stationTypes" | "stationSettings" | "transgressionTypes";
    desc: string;
  }[] = [
    { name: "station-types", method: "stationTypes", desc: "List station types" },
    { name: "station-settings", method: "stationSettings", desc: "List station settings" },
    { name: "transgression-types", method: "transgressionTypes", desc: "List exceedance types" },
  ];
  for (const { name, method, desc } of simple) {
    program
      .command(name)
      .description(desc)
      .option("--lang <lang>", "de | en")
      .action(
        action(deps, async ({ client, global, opts }) => {
          renderJson(deps, global, await client[method](lang(opts)));
        }),
      );
  }
}

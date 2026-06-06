import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  assertEnum,
  index,
  lang,
  parseHour,
  parsePositiveIntArg,
  parseYear,
  renderJson,
} from "../shared.js";
import { MetaUseValues, ThresholdUseValues } from "../../client/enums.js";
import { LuftError } from "../../client/errors.js";

/** commander value-parser: a calendar date in `YYYY-MM-DD` form. */
function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidArgumentError("Expected a date in YYYY-MM-DD format.");
  }
  return value;
}

/** Add the shared time-window + station options required by the data endpoints. */
function addWindowOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--date-from <YYYY-MM-DD>", "window start date", parseDate)
    .requiredOption("--time-from <1-24>", "window start hour", parseHour)
    .requiredOption("--date-to <YYYY-MM-DD>", "window end date", parseDate)
    .requiredOption("--time-to <1-24>", "window end hour", parseHour)
    .requiredOption("--station <id>", "station id", parsePositiveIntArg);
}

export function registerDataCommands(program: Command, deps: CliDeps): void {
  addWindowOptions(
    program.command("airquality").description("Air-quality index data for a station/window"),
  ).action(
    action(deps, async ({ client, global, opts }) => {
      renderJson(
        deps,
        global,
        await client.airquality({
          date_from: String(opts["dateFrom"]),
          time_from: opts["timeFrom"] as number,
          date_to: String(opts["dateTo"]),
          time_to: opts["timeTo"] as number,
          station: opts["station"] as number,
        }),
      );
    }),
  );

  program
    .command("airquality-limits")
    .description("Available date range per station for air-quality data")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.airqualityLimits());
      }),
    );

  addWindowOptions(
    program
      .command("measures")
      .description("Raw measurements for a station/window")
      .option("--component <id>", "component id", parsePositiveIntArg)
      .option("--scope <id>", "scope id", parsePositiveIntArg),
  ).action(
    action(deps, async ({ client, global, opts }) => {
      renderJson(
        deps,
        global,
        await client.measures({
          date_from: String(opts["dateFrom"]),
          time_from: opts["timeFrom"] as number,
          date_to: String(opts["dateTo"]),
          time_to: opts["timeTo"] as number,
          station: opts["station"] as number,
          component: opts["component"] as number | undefined,
          scope: opts["scope"] as number | undefined,
        }),
      );
    }),
  );

  program
    .command("measures-limits")
    .description("Available date range per scope/component/station")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.measuresLimits());
      }),
    );

  const yearComponent: {
    name: string;
    method: "annualBalances" | "transgressions";
    desc: string;
  }[] = [
    {
      name: "annual-balances",
      method: "annualBalances",
      desc: "Annual tabulations for a component and year",
    },
    {
      name: "transgressions",
      method: "transgressions",
      desc: "Exceedances for a component and year",
    },
  ];
  for (const { name, method, desc } of yearComponent) {
    program
      .command(name)
      .description(desc)
      .requiredOption("--component <id>", "component id", parsePositiveIntArg)
      .requiredOption("--year <YYYY>", "year (>= 2016)", parseYear)
      .option("--lang <lang>", "de | en")
      .option("--index <index>", "id | code")
      .action(
        action(deps, async ({ client, global, opts }) => {
          renderJson(
            deps,
            global,
            await client[method]({
              component: opts["component"] as number,
              year: opts["year"] as number,
              lang: lang(opts),
              index: index(opts),
            }),
          );
        }),
      );
  }

  program
    .command("thresholds")
    .description("Thresholds for a use (airquality | measure)")
    .requiredOption("--use <use>", `${ThresholdUseValues.join(" | ")}`)
    .option("--lang <lang>", "de | en")
    .option("--component <id>", "component id", parsePositiveIntArg)
    .option("--scope <id>", "scope id", parsePositiveIntArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          await client.thresholds({
            use: assertEnum(String(opts["use"]), ThresholdUseValues, "use"),
            lang: lang(opts),
            component: opts["component"] as number | undefined,
            scope: opts["scope"] as number | undefined,
          }),
        );
      }),
    );

  program
    .command("meta")
    .description("Combined metadata for a use")
    .requiredOption("--use <use>", `${MetaUseValues.join(" | ")}`)
    .option("--lang <lang>", "de | en")
    .option("--date-from <YYYY-MM-DD>", "required when use=airquality", parseDate)
    .option("--date-to <YYYY-MM-DD>", "required when use=airquality", parseDate)
    .option("--time-from <1-24>", "window start hour", parseHour)
    .option("--time-to <1-24>", "window end hour", parseHour)
    .action(
      action(deps, async ({ client, global, opts }) => {
        const use = assertEnum(String(opts["use"]), MetaUseValues, "use");
        const dateFrom = opts["dateFrom"] as string | undefined;
        const dateTo = opts["dateTo"] as string | undefined;
        if (use === "airquality" && (dateFrom === undefined || dateTo === undefined)) {
          throw new LuftError("meta --use airquality requires --date-from and --date-to.");
        }
        renderJson(
          deps,
          global,
          await client.meta({
            use,
            lang: lang(opts),
            date_from: dateFrom,
            date_to: dateTo,
            time_from: opts["timeFrom"] as number | undefined,
            time_to: opts["timeTo"] as number | undefined,
          }),
        );
      }),
    );
}

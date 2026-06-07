import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  assertEnum,
  index,
  lang,
  parseHour,
  parseIndexArg,
  parseLangArg,
  parsePositiveIntArg,
  parseYear,
  renderJson,
} from "../shared.js";
import { MetaUseValues, ThresholdUseValues } from "../../client/enums.js";
import { LuftError } from "../../client/errors.js";

/** commander value-parser: a real calendar date in `YYYY-MM-DD` form. */
function parseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new InvalidArgumentError("Expected a date in YYYY-MM-DD format.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject impossible calendar dates (e.g. 2024-13-40, 0000-00-00). Round-tripping
  // through Date catches month/day overflow including leap-year boundaries.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidArgumentError(`Expected a valid calendar date, got "${value}".`);
  }
  return value;
}

/**
 * Reject a reversed time window (start after end) locally, consistent with the
 * other client-side guards (positive ids, year floor). The window is ordered by
 * date first, then by hour-ending within the same date.
 */
function assertWindowOrdered(
  dateFrom: string,
  timeFrom: number,
  dateTo: string,
  timeTo: number,
): void {
  if (dateFrom > dateTo || (dateFrom === dateTo && timeFrom > timeTo)) {
    throw new LuftError(
      `Window start (${dateFrom} ${timeFrom}:00) is after window end (${dateTo} ${timeTo}:00).`,
    );
  }
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
      assertWindowOrdered(
        String(opts["dateFrom"]),
        opts["timeFrom"] as number,
        String(opts["dateTo"]),
        opts["timeTo"] as number,
      );
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
      assertWindowOrdered(
        String(opts["dateFrom"]),
        opts["timeFrom"] as number,
        String(opts["dateTo"]),
        opts["timeTo"] as number,
      );
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
      .option("--lang <lang>", "de | en", parseLangArg)
      .option("--index <index>", "id | code", parseIndexArg)
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
    .option("--lang <lang>", "de | en", parseLangArg)
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
    .option("--lang <lang>", "de | en", parseLangArg)
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

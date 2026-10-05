import { InvalidArgumentError, type Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  parseHour,
  parseIndexArg,
  parseLangArg,
  parsePositiveIntArg,
  parseUseArg,
  parseYear,
  renderJson,
} from "../shared.js";
import {
  MetaUseValues,
  ThresholdUseValues,
  type IndexKind,
  type Lang,
  type MetaUse,
  type ThresholdUse,
} from "../../client/enums.js";
import {
  DEFAULT_META_TIME_FROM,
  DEFAULT_META_TIME_TO,
  annualDataNote,
  stationDataNote,
} from "../../client/client.js";
import type { AirDataResult } from "../../client/types.js";
import { LuftApiError } from "../../client/errors.js";

/**
 * From this year on `transgressions` works for every component; before it, the API
 * answers some components (NO₂, PM₁₀ in 2016-2018) with HTTP 500.
 */
const TRANSGRESSIONS_COMPLETE_FROM = 2019;

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
 * Run a station query. The API answers most unknown station ids with an empty `data` and
 * HTTP 200, like a window without data, and ids far outside the catalogue with HTTP 409 (an
 * HTML page, no detail): name the likely cause on stderr either way. The empty case is a
 * note after the (printed) result, exit 0; the 409 a hint before the error.
 */
async function withStationHint(
  deps: CliDeps,
  station: number,
  query: () => Promise<AirDataResult>,
): Promise<{ result: AirDataResult; note: string | undefined }> {
  try {
    const result = await query();
    return { result, note: stationDataNote(result, station) };
  } catch (err) {
    if (err instanceof LuftApiError && err.status === 409) {
      deps.io.err(
        `Hint: the API answers an unknown station id with HTTP 409. Check that station ` +
          `${station} exists (meta --use measure lists them) and has data in this window ` +
          `(airquality-limits / measures-limits).`,
      );
    }
    throw err;
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
      const { result, note } = await withStationHint(deps, opts["station"] as number, () =>
        client.airquality({
          date_from: String(opts["dateFrom"]),
          time_from: opts["timeFrom"] as number,
          date_to: String(opts["dateTo"]),
          time_to: opts["timeTo"] as number,
          station: opts["station"] as number,
        }),
      );
      renderJson(deps, global, result);
      if (note !== undefined) deps.io.err(`Note: ${note}`);
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
      .description("Raw measurements of one component/scope series for a station/window")
      // Both are required: the response holds one series (one value per hour), so
      // leaving either out does not return "all" — the API picks one for you.
      .requiredOption("--component <id>", "component id", parsePositiveIntArg)
      .requiredOption("--scope <id>", "scope id (averaging, see `scopes`)", parsePositiveIntArg),
  ).action(
    action(deps, async ({ client, global, opts }) => {
      const { result, note } = await withStationHint(deps, opts["station"] as number, () =>
        client.measures({
          date_from: String(opts["dateFrom"]),
          time_from: opts["timeFrom"] as number,
          date_to: String(opts["dateTo"]),
          time_to: opts["timeTo"] as number,
          station: opts["station"] as number,
          component: opts["component"] as number,
          scope: opts["scope"] as number,
        }),
      );
      renderJson(deps, global, result);
      if (note !== undefined) deps.io.err(`Note: ${note}`);
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
      desc: "Annual tabulations for a component and year (final data; the year's exceedance counts)",
    },
    {
      name: "transgressions",
      method: "transgressions",
      desc: "Exceedance table for a component and year (running year, preliminary data)",
    },
  ];
  for (const { name, method, desc } of yearComponent) {
    program
      .command(name)
      .description(desc)
      .requiredOption("--component <id>", "component id", parsePositiveIntArg)
      .requiredOption("--year <YYYY>", "year (>= 2016)", parseYear)
      .option("--lang <lang>", "de | en", parseLangArg)
      // Accepted and sent, but the rows are arrays led by the station id, so the
      // payload is the same either way (only the echoed `request` differs).
      .option("--index <index>", "id | code (no effect on these rows; kept for compatibility)", parseIndexArg)
      .action(
        action(deps, async ({ client, global, opts }) => {
          const year = opts["year"] as number;
          let result;
          try {
            result = await client[method]({
              component: opts["component"] as number,
              year,
              lang: opts["lang"] as Lang | undefined,
              index: opts["index"] as IndexKind | undefined,
            });
          } catch (err) {
            // Upstream has no transgressions for some components before 2019 (NO₂ and
            // PM₁₀ 2016-2018; O₃ 2018 works) and answers with a bare HTML 500.
            if (
              method === "transgressions" &&
              year < TRANSGRESSIONS_COMPLETE_FROM &&
              err instanceof LuftApiError &&
              err.status === 500
            ) {
              deps.io.err(
                `Hint: the API has no transgressions for some components before ` +
                  `${TRANSGRESSIONS_COMPLETE_FROM} and answers with HTTP 500; try --year ` +
                  `${TRANSGRESSIONS_COMPLETE_FROM} or later, or annual-balances for ${year}.`,
              );
            }
            throw err;
          }
          renderJson(deps, global, result);
          // Which of the two annual figures to trust, and why a year may have none yet.
          const note = annualDataNote(method, year, result);
          if (note !== undefined) deps.io.err(`Note: ${note}`);
        }),
      );
  }

  program
    .command("thresholds")
    .description("Thresholds for a use (airquality | measure)")
    .requiredOption("--use <use>", `${ThresholdUseValues.join(" | ")}`, parseUseArg)
    .option("--lang <lang>", "de | en", parseLangArg)
    .option("--component <id>", "component id", parsePositiveIntArg)
    .option("--scope <id>", "scope id", parsePositiveIntArg)
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          await client.thresholds({
            use: opts["use"] as ThresholdUse,
            lang: opts["lang"] as Lang | undefined,
            component: opts["component"] as number | undefined,
            scope: opts["scope"] as number | undefined,
          }),
        );
      }),
    );

  program
    .command("meta")
    .description("Combined metadata for a use")
    .requiredOption("--use <use>", `${MetaUseValues.join(" | ")}`, parseUseArg)
    .option("--lang <lang>", "de | en", parseLangArg)
    .option(
      "--date-from <YYYY-MM-DD>",
      "window start date (required for use=airquality; for other uses it narrows the station list)",
      parseDate,
    )
    .option("--date-to <YYYY-MM-DD>", "window end date (given together with --date-from)", parseDate)
    .option("--time-from <1-24>", `window start hour (needs the dates; default ${DEFAULT_META_TIME_FROM})`, parseHour)
    .option("--time-to <1-24>", `window end hour (needs the dates; default ${DEFAULT_META_TIME_TO})`, parseHour)
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(
          deps,
          global,
          // The library checks the use, the window (both dates or neither, hours
          // only with dates, in order) and fills in the default hours.
          await client.meta({
            use: opts["use"] as MetaUse,
            lang: opts["lang"] as Lang | undefined,
            date_from: opts["dateFrom"] as string | undefined,
            date_to: opts["dateTo"] as string | undefined,
            time_from: opts["timeFrom"] as number | undefined,
            time_to: opts["timeTo"] as number | undefined,
          }),
        );
      }),
    );
}

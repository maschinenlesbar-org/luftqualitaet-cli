// Enum-like value sets. These const arrays double as runtime CLI choice
// validators and as TS union types.

/** Response language. */
export const LangValues = ["de", "en"] as const;
export type Lang = (typeof LangValues)[number];

/** How reference lists are keyed in the response. */
export const IndexValues = ["id", "code"] as const;
export type IndexKind = (typeof IndexValues)[number];

/** `use` values for the combined metadata endpoint. */
export const MetaUseValues = [
  "airquality",
  "measure",
  "transgression",
  "annualbalance",
  "map",
] as const;
export type MetaUse = (typeof MetaUseValues)[number];

/** `use` values for the thresholds endpoint. */
export const ThresholdUseValues = ["airquality", "measure"] as const;
export type ThresholdUse = (typeof ThresholdUseValues)[number];

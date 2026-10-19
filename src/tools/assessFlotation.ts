// This file is the tool the agent calls to hold a customer's flotation readings up against one plant's own history.
// It compares and it warns. It never says what is normal, because one plant's record is not a standard.

import { z } from "zod";
import { toolError } from "../agent/toolError";
import { andList } from "../shared/text";
import { column, dataset, IRON, PLANT, SILICA } from "../flotation/data";
import {
  correlates,
  PERCENTILE_METHOD,
  percentileRank,
  QUARTILE_METHOD,
  shareWorseBoth,
  shareWorseIron,
  shareWorseSilica,
  summary,
} from "../flotation/stats";

export const AssessFlotationReadingsInput = z.strictObject({
  silica_concentrate_pct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("The % silica in the customer's concentrate, if they stated it. Higher is worse."),
  iron_concentrate_pct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("The % iron in the customer's concentrate, if they stated it. Lower is worse."),
});

const round = (value: number, places: number) => Number(value.toFixed(places));

const CAVEATS = [
  "This is one iron ore plant's own hours from 2017, not an industry benchmark. Another plant with different ore could sit somewhere else.",
  "These readings only moved together. None of them is proof of cause.",
];

const WEAK = " Every link was weak, so none of them explains the silica on its own.";
const WEAK_BELOW = 0.3;

const PLAIN: Array<[RegExp, string]> = [
  [/^Flotation Column \d+ Air Flow$/, "column air flows"],
  [/^Flotation Column \d+ Level$/, "column levels"],
  [/^Amina Flow$/, "amine dosing"],
  [/^Starch Flow$/, "starch dosing"],
  [/^Ore Pulp pH$/, "pulp pH"],
  [/^Ore Pulp Density$/, "pulp density"],
  [/^Ore Pulp Flow$/, "pulp flow"],
  [/^% Iron Feed$/, "iron in the feed"],
  [/^% Silica Feed$/, "silica in the feed"],
];

const plainName = (variable: string) => PLAIN.find(([pattern]) => pattern.test(variable))?.[1] ?? variable;

function correlatesSummary(top: Array<{ variable: string; spearman_rho: number }>, weak: boolean): string {
  const named = (sign: number) => [
    ...new Set(top.filter((item) => Math.sign(item.spearman_rho) === sign).map((item) => plainName(item.variable))),
  ];
  const moved = [named(1).length ? `higher ${andList(named(1))}` : "", named(-1).length ? `lower ${andList(named(-1))}` : ""];
  const both = moved.filter(Boolean);
  if (!both.length) return "Nothing in that plant's process readings moved with its silica.";
  return `At that plant, ${andList(both)} went with higher silica.${weak ? WEAK : ""}`;
}

function verdictFor(shareWorsePct: number): string {
  if (shareWorsePct < 10) return "worse than nearly every hour at that plant";
  if (shareWorsePct < 25) return "on the bad side for that plant";
  if (shareWorsePct <= 75) return "ordinary for that plant";
  return "better than most hours at that plant";
}

let counter = 0;

function reading(name: string, value: number, values: number[], worse: number, direction: "at or above" | "at or below") {
  const plant = summary(values);
  return {
    name,
    value,
    percentile_rank: round(percentileRank(values, value), 1),
    share_worse: round(100 * worse, 1),
    verdict: verdictFor(round(100 * worse, 1)),
    share_worse_means: `the share of that plant's hours with ${name} ${direction} ${value}`,
    plant_median: round(plant.median, 2),
    plant_q1: round(plant.q1, 2),
    plant_q3: round(plant.q3, 2),
  };
}

export function assessFlotationReadings(input: unknown) {
  const parsed = AssessFlotationReadingsInput.safeParse(input);
  if (!parsed.success) return toolError("assess_flotation_readings", "validation", z.prettifyError(parsed.error));
  const { silica_concentrate_pct: silicaPct, iron_concentrate_pct: ironPct } = parsed.data;

  try {
    const data = dataset();
    const silica = column(SILICA);
    const iron = column(IRON);
    const readings = [
      silicaPct != null
        ? reading(SILICA, silicaPct, silica, shareWorseSilica(silica, silicaPct), "at or above")
        : undefined,
      ironPct != null ? reading(IRON, ironPct, iron, shareWorseIron(iron, ironPct), "at or below") : undefined,
    ].filter((item) => item != null);

    const top = correlates(data.columns).map(({ variable, rho, n }) => ({ variable, spearman_rho: round(rho, 3), n }));
    const strongest = Math.max(...top.map((item) => Math.abs(item.spearman_rho)));

    return {
      kind: "flotation_assessment" as const,
      assessment_id: `FLT-${++counter}`,
      dataset: { rows: data.rows, from: data.from, to: data.to, plant: PLANT },
      readings,
      ...(silicaPct != null &&
        ironPct != null && { joint_share_worse: round(100 * shareWorseBoth(silica, iron, silicaPct, ironPct), 1) }),
      correlates: top,
      correlates_summary: correlatesSummary(top, strongest < WEAK_BELOW),
      caveats: CAVEATS,
      methods: { percentile: PERCENTILE_METHOD, quartiles: QUARTILE_METHOD },
    };
  } catch (error) {
    return toolError("assess_flotation_readings", "runtime", error instanceof Error ? error.message : String(error));
  }
}
